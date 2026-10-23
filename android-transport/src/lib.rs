//! Android-side authenticated iroh transport and owned loopback byte proxy.
//!
//! Loopback TLS and HTTP CONNECT listeners forward opaque bytes to the paired host.
//! The WebView uses the host's pinned HTTPS authority, not a cleartext carrier URL.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use dsh_mobile_iroh_core::{
    decode_wire, encode_wire, load_or_create_secret, pair_fail_text, read_line_bounded, write_line,
    Wire, ALPN, MAX_LINE,
};
use iroh::endpoint::{presets, Connection, ConnectionError, SendStream};
use iroh::{Endpoint, EndpointAddr, EndpointId};
use tokio::io::{copy_bidirectional, AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::timeout;

#[cfg(any(target_os = "android", test))]
mod jni_bridge;
#[cfg(any(target_os = "android", test))]
mod session_owner;

/// One active transport owns this port. Full peer hostnames isolate browser storage.
pub const DEFAULT_PROXY_PORT: u16 = 25_443;

/// Setup, stream count and stream-open budgets for one transport owner.
#[derive(Clone, Debug)]
pub struct TransportOptions {
    /// Fixed carrier port. A collision fails instead of changing the paired origin.
    pub local_port: u16,
    /// Includes addressing, handshake and local listener setup.
    pub connect_timeout: Duration,
    /// Per accepted loopback socket, before byte forwarding starts.
    pub stream_open_timeout: Duration,
    /// Maximum simultaneous TCP proxy streams.
    pub max_proxy_streams: usize,
    /// Shutdown grace after proxy children have stopped.
    pub shutdown_timeout: Duration,
}

impl Default for TransportOptions {
    fn default() -> Self {
        Self {
            local_port: DEFAULT_PROXY_PORT,
            connect_timeout: Duration::from_secs(30),
            stream_open_timeout: Duration::from_secs(10),
            max_proxy_streams: 32,
            shutdown_timeout: Duration::from_secs(3),
        }
    }
}

impl TransportOptions {
    fn validate(&self) -> Result<()> {
        if self.local_port < 1024
            || self.connect_timeout.is_zero()
            || self.stream_open_timeout.is_zero()
            || self.shutdown_timeout.is_zero()
            || !(1..=256).contains(&self.max_proxy_streams)
        {
            bail!("invalid Android transport budgets")
        }
        Ok(())
    }
}

/// One authenticated connection and its owned listener, control and proxy children.
pub struct AndroidTransportSession {
    endpoint: Endpoint,
    connection: Connection,
    proxy_task: Option<JoinHandle<()>>,
    stop: Option<oneshot::Sender<()>>,
    port: u16,
    connect_proxy_port: u16,
    peer: EndpointId,
    shutdown_timeout: Duration,
}

/// Only an authenticated host's exact application-close signal means revocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportStatus {
    Ready,
    Revoked,
    Disconnected,
}

fn transport_status(reason: Option<ConnectionError>, owner_finished: bool) -> TransportStatus {
    match reason {
        Some(ConnectionError::ApplicationClosed(close))
            if close.error_code == 1u8.into() && close.reason.as_ref() == b"revoked" =>
        {
            TransportStatus::Revoked
        }
        Some(_) => TransportStatus::Disconnected,
        None if owner_finished => TransportStatus::Disconnected,
        None => TransportStatus::Ready,
    }
}

impl AndroidTransportSession {
    /// Internal TCP carrier URL, not an authenticated WebView origin.
    pub fn local_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    /// Metadata contains no credential and never substitutes a loopback URL for HTTPS trust.
    pub fn connection_metadata(&self) -> String {
        format!(
            "{{\"version\":1,\"peerId\":\"{}\",\"localPort\":{},\"connectProxyPort\":{}}}",
            self.peer, self.port, self.connect_proxy_port
        )
    }

    /// Exact HTTPS authority accepted by the native-auth CONNECT proxy.
    pub fn https_authority(&self) -> String {
        peer_authority(&self.peer, self.port)
    }

    /// Whether the control owner has ended or QUIC has closed.
    pub fn is_closed(&self) -> bool {
        self.status() != TransportStatus::Ready
    }

    /// Query the local QUIC owner without performing network I/O.
    pub fn status(&self) -> TransportStatus {
        transport_status(
            self.connection.close_reason(),
            self.proxy_task.as_ref().is_none_or(JoinHandle::is_finished),
        )
    }

    /// Stop accepting, close QUIC, join every proxy child and close the endpoint.
    pub async fn close(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.connection.close(0u8.into(), b"client closed");
        if let Some(mut task) = self.proxy_task.take() {
            if timeout(self.shutdown_timeout, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
        let _ = timeout(self.shutdown_timeout, self.endpoint.close()).await;
    }
}

impl Drop for AndroidTransportSession {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.connection.close(0u8.into(), b"client dropped");
        if let Some(task) = self.proxy_task.take() {
            // Dropping the owner's JoinSet aborts its proxy children as well.
            task.abort();
        }
    }
}

/// Endpoint handles alone do not promise prompt QUIC shutdown when setup is aborted.
struct SetupEndpoint {
    endpoint: Option<Endpoint>,
    shutdown_timeout: Duration,
    cleanup: Option<EndpointCleanup>,
}

/// Cleanup created while an aborted setup future is dropping, joined by its native supervisor.
#[derive(Clone, Default)]
pub(crate) struct EndpointCleanup(Arc<Mutex<Vec<JoinHandle<()>>>>);

impl EndpointCleanup {
    #[cfg(any(target_os = "android", test))]
    pub(crate) async fn finish(&self) {
        let tasks = std::mem::take(&mut *self.0.lock().unwrap_or_else(|error| error.into_inner()));
        for task in tasks {
            let _ = task.await;
        }
    }
}

impl Drop for SetupEndpoint {
    fn drop(&mut self) {
        if let Some(endpoint) = self.endpoint.take() {
            let budget = self.shutdown_timeout;
            // Setup runs inside a Tokio runtime; cancellation drops this guard there.
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let task = runtime.spawn(async move {
                    let _ = timeout(budget, endpoint.close()).await;
                });
                if let Some(cleanup) = &self.cleanup {
                    cleanup
                        .0
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .push(task);
                }
            }
        }
    }
}

/// Connect using production iroh addressing. Dropping this future cancels setup.
pub async fn connect(
    data_dir: &Path,
    peer: EndpointId,
    code: Option<&str>,
    device_name: &str,
) -> Result<AndroidTransportSession> {
    connect_with_options(
        data_dir,
        peer,
        code,
        device_name,
        TransportOptions::default(),
    )
    .await
}

/// Connect with explicit deployment budgets while retaining production discovery.
pub async fn connect_with_options(
    data_dir: &Path,
    peer: EndpointId,
    code: Option<&str>,
    device_name: &str,
    options: TransportOptions,
) -> Result<AndroidTransportSession> {
    connect_with_options_tracked(data_dir, peer, code, device_name, options, None).await
}

pub(crate) async fn connect_with_options_tracked(
    data_dir: &Path,
    peer: EndpointId,
    code: Option<&str>,
    device_name: &str,
    options: TransportOptions,
    cleanup: Option<EndpointCleanup>,
) -> Result<AndroidTransportSession> {
    options.validate()?;
    validate_pairing(code, device_name)?;
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    timeout(options.connect_timeout, async {
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .context("failed to start the Android iroh endpoint")?;
        connect_endpoint_tracked(
            endpoint,
            peer.into(),
            code,
            device_name,
            options.clone(),
            cleanup,
        )
        .await
    })
    .await
    .context("Android iroh connection timed out")?
}

/// Connect through an explicit endpoint for isolated direct-path tests.
/// The endpoint is consumed by the session; no caller may reuse it afterwards.
pub async fn connect_endpoint(
    endpoint: Endpoint,
    peer: EndpointAddr,
    code: Option<&str>,
    device_name: &str,
    options: TransportOptions,
) -> Result<AndroidTransportSession> {
    connect_endpoint_tracked(endpoint, peer, code, device_name, options, None).await
}

async fn connect_endpoint_tracked(
    endpoint: Endpoint,
    peer: EndpointAddr,
    code: Option<&str>,
    device_name: &str,
    options: TransportOptions,
    tracked: Option<EndpointCleanup>,
) -> Result<AndroidTransportSession> {
    let mut cleanup = SetupEndpoint {
        endpoint: Some(endpoint.clone()),
        shutdown_timeout: options.shutdown_timeout,
        cleanup: tracked,
    };
    options.validate()?;
    validate_pairing(code, device_name)?;
    let result = timeout(options.connect_timeout, async {
        let connection = endpoint
            .connect(peer.clone(), ALPN)
            .await
            .context("failed to connect to the paired host")?;
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .context("failed to open the iroh control stream")?;
        let name = device_name.trim().to_string();
        let first = match code {
            Some(code) => Wire::Pair {
                code: code.to_string(),
                name,
            },
            None => Wire::Hello { name },
        };
        write_line(&mut send, &encode_wire(&first)?).await?;
        let response = decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await?)?;
        match (code.is_some(), response) {
            (true, Wire::PairOk) | (false, Wire::HelloOk) => {}
            (_, Wire::PairFail { reason }) => bail!("pairing failed: {}", pair_fail_text(&reason)),
            _ => bail!("host readiness response did not follow the protocol"),
        }
        let listener = TcpListener::bind(("127.0.0.1", options.local_port))
            .await
            .context("the fixed Android loopback proxy port is unavailable")?;
        let port = listener.local_addr()?.port();
        let connect_listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("failed to bind the native HTTPS CONNECT proxy")?;
        let connect_proxy_port = connect_listener.local_addr()?.port();
        let (stop, stopped) = oneshot::channel();
        let proxy_task = tokio::spawn(own_proxy(ProxyOwner {
            listener,
            connect_listener,
            authority: peer_authority(&peer.id, port),
            connection: connection.clone(),
            control_send: send,
            control_recv: recv,
            stopped,
            options: options.clone(),
        }));
        Ok(AndroidTransportSession {
            endpoint: endpoint.clone(),
            connection,
            proxy_task: Some(proxy_task),
            stop: Some(stop),
            port,
            connect_proxy_port,
            peer: peer.id,
            shutdown_timeout: options.shutdown_timeout,
        })
    })
    .await
    .context("Android iroh connection timed out")
    .and_then(|result| result);
    if result.is_err() {
        let _ = timeout(options.shutdown_timeout, endpoint.close()).await;
    }
    cleanup.endpoint.take();
    result
}

/// Resources that share the authenticated connection and its teardown.
struct ProxyOwner<R> {
    listener: TcpListener,
    connect_listener: TcpListener,
    authority: String,
    connection: Connection,
    control_send: SendStream,
    control_recv: R,
    stopped: oneshot::Receiver<()>,
    options: TransportOptions,
}

async fn own_proxy<R: AsyncRead + Unpin>(owner: ProxyOwner<R>) {
    let ProxyOwner {
        listener,
        connect_listener,
        authority,
        connection,
        control_send: _control_send,
        mut control_recv,
        mut stopped,
        options,
    } = owner;
    let mut children = JoinSet::new();
    let control = read_line_bounded(&mut control_recv, MAX_LINE);
    tokio::pin!(control);
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            _ = connection.closed() => break,
            // Minimal carrier v1 has no unsolicited controls after readiness.
            _ = &mut control => break,
            Some(_) = children.join_next(), if !children.is_empty() => {},
            accepted = listener.accept(), if children.len() < options.max_proxy_streams => {
                let Ok((mut tcp, _)) = accepted else { break };
                let connection = connection.clone();
                let budget = options.stream_open_timeout;
                children.spawn(async move {
                    forward_socket(&mut tcp, connection, budget, None).await;
                });
            }
            accepted = connect_listener.accept(), if children.len() < options.max_proxy_streams => {
                let Ok((mut tcp, _)) = accepted else { break };
                let connection = connection.clone();
                let budget = options.stream_open_timeout;
                let authority = authority.clone();
                children.spawn(async move {
                    forward_socket(&mut tcp, connection, budget, Some(&authority)).await;
                });
            }
        }
    }
    drop(listener);
    drop(connect_listener);
    // A local close replaces the recorded remote application-close reason.
    if connection.close_reason().is_none() {
        connection.close(0u8.into(), b"control ended");
    }
    children.abort_all();
    while children.join_next().await.is_some() {}
}

async fn forward_socket(
    tcp: &mut TcpStream,
    connection: Connection,
    budget: Duration,
    authority: Option<&str>,
) {
    let opened = timeout(budget, async {
        if let Some(authority) = authority {
            if !read_connect_head(tcp, authority).await? {
                tcp.write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await?;
                bail!("CONNECT authority rejected")
            }
        }
        let (mut send, recv) = connection.open_bi().await?;
        write_line(&mut send, &encode_wire(&Wire::Proxy)?).await?;
        if authority.is_some() {
            tcp.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
        }
        Ok::<_, anyhow::Error>((send, recv))
    })
    .await;
    if let Ok(Ok((send, recv))) = opened {
        let mut stream = tokio::io::join(recv, send);
        let _ = copy_bidirectional(tcp, &mut stream).await;
    }
}

async fn read_connect_head(tcp: &mut TcpStream, authority: &str) -> Result<bool> {
    let mut bytes = Vec::with_capacity(512);
    // Read only the header bytes; pipelined TLS bytes must remain in the socket.
    while bytes.len() < 8192 {
        bytes.push(tcp.read_u8().await?);
        if bytes.ends_with(b"\r\n\r\n") {
            let Ok(head) = std::str::from_utf8(&bytes) else {
                return Ok(false);
            };
            return Ok(accepts_connect_head(head, authority));
        }
    }
    Ok(false)
}

fn accepts_connect_head(head: &str, authority: &str) -> bool {
    let Some(head) = head.strip_suffix("\r\n\r\n") else {
        return false;
    };
    let mut lines = head.split("\r\n");
    if lines.next() != Some(format!("CONNECT {authority} HTTP/1.1").as_str()) {
        return false;
    }
    let mut host = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        let name = name.to_ascii_lowercase();
        let value = value.trim();
        if value.bytes().any(|byte| !(0x20..=0x7e).contains(&byte)) {
            return false;
        }
        match name.as_str() {
            "host" if !host && value == authority => host = true,
            "user-agent" | "accept" => {}
            "proxy-connection" | "connection"
                if value.eq_ignore_ascii_case("keep-alive")
                    || value.eq_ignore_ascii_case("close") => {}
            _ => return false,
        }
    }
    host
}

fn peer_authority(peer: &EndpointId, port: u16) -> String {
    let hex = peer.to_string();
    format!("{}.{}.iroh.localhost:{port}", &hex[..32], &hex[32..])
}

fn validate_pairing(code: Option<&str>, name: &str) -> Result<()> {
    if code.is_some_and(|code| !is_pairing_code(code)) {
        bail!("pairing code must contain six decimal digits")
    }
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        bail!("device name must contain 1 to 64 characters without control characters")
    }
    Ok(())
}

fn is_pairing_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::endpoint::RecvStream;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn endpoint() -> Endpoint {
        Endpoint::builder(presets::Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind_addr("127.0.0.1:0")
            .unwrap()
            .bind()
            .await
            .unwrap()
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
    }

    fn test_options() -> TransportOptions {
        // Select a test-specific port instead of contending for the product's fixed port.
        let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let local_port = reservation.local_addr().unwrap().port();
        drop(reservation);
        TransportOptions {
            local_port,
            connect_timeout: Duration::from_secs(5),
            ..TransportOptions::default()
        }
    }

    #[test]
    fn proxy_port_is_fixed_and_cannot_silently_select_a_different_origin() {
        assert_eq!(TransportOptions::default().local_port, 25_443);
        assert!(TransportOptions {
            local_port: 0,
            ..TransportOptions::default()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn pairing_and_budget_inputs_are_checked_before_networking() {
        assert!(validate_pairing(Some("123456"), " phone ").is_ok());
        assert!(validate_pairing(Some("１２３４５６"), "phone").is_err());
        assert!(validate_pairing(None, "  ").is_err());
        assert!(validate_pairing(None, "bad\nname").is_err());
        assert!(validate_pairing(None, &"x".repeat(65)).is_err());
        assert!(TransportOptions {
            max_proxy_streams: 0,
            ..TransportOptions::default()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn only_exact_authenticated_revocation_code_and_reason_mean_removed() {
        let close = |code: u8, reason: &[u8]| {
            ConnectionError::ApplicationClosed(iroh::endpoint::ApplicationClose {
                error_code: code.into(),
                reason: reason.to_vec().into(),
            })
        };
        assert_eq!(
            transport_status(Some(close(1, b"revoked")), false),
            TransportStatus::Revoked
        );
        assert_eq!(
            transport_status(Some(close(0, b"revoked")), false),
            TransportStatus::Disconnected
        );
        assert_eq!(
            transport_status(Some(close(1, b"replaced")), false),
            TransportStatus::Disconnected
        );
        assert_eq!(
            transport_status(Some(ConnectionError::LocallyClosed), false),
            TransportStatus::Disconnected
        );
        assert_eq!(transport_status(None, true), TransportStatus::Disconnected);
        assert_eq!(transport_status(None, false), TransportStatus::Ready);
    }

    #[test]
    fn real_quic_host_revocation_remains_distinct_from_a_network_disconnect() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let (revoke, revoked) = oneshot::channel();
            let (close_observed, observation) = oneshot::channel();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                write_line(&mut send, &encode_wire(&Wire::HelloOk).unwrap())
                    .await
                    .unwrap();
                revoked.await.unwrap();
                connection.close(1u8.into(), b"revoked");
                // Host shutdown is not part of device revocation.
                let _ = observation.await;
                host.close().await;
            });
            let mut session =
                connect_endpoint(endpoint().await, address, None, "phone", test_options())
                    .await
                    .unwrap();
            assert_eq!(session.status(), TransportStatus::Ready);
            revoke.send(()).unwrap();
            let observed = timeout(Duration::from_secs(5), session.connection.closed()).await;
            let mut proxy_owner = session.proxy_task.take().unwrap();
            let owner_finished = timeout(Duration::from_secs(5), &mut proxy_owner).await;
            if owner_finished.is_err() {
                proxy_owner.abort();
                let _ = proxy_owner.await;
            }
            let status = session.status();
            let _ = close_observed.send(());
            session.close().await;
            let served = timeout(Duration::from_secs(5), serving).await;
            let observed = observed.unwrap();
            eprintln!(
                "revocation observed before Host teardown: close={observed:?}, status={status:?}"
            );
            assert!(matches!(observed, ConnectionError::ApplicationClosed(close)
                if close.error_code == 1u8.into() && close.reason.as_ref() == b"revoked"));
            assert_eq!(status, TransportStatus::Revoked);
            owner_finished.unwrap().unwrap();
            served.unwrap().unwrap();
        });
    }

    #[test]
    fn real_quic_control_eof_before_revocation_remains_disconnected() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let (finish_control, finish) = oneshot::channel();
            let (close_observed, observation) = oneshot::channel();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                write_line(&mut send, &encode_wire(&Wire::HelloOk).unwrap())
                    .await
                    .unwrap();
                finish.await.unwrap();
                send.finish().unwrap();
                let _ = observation.await;
                let reason = timeout(Duration::from_secs(5), connection.closed()).await;
                connection.close(1u8.into(), b"revoked");
                host.close().await;
                reason.unwrap()
            });
            let session =
                connect_endpoint(endpoint().await, address, None, "phone", test_options())
                    .await
                    .unwrap();
            assert_eq!(session.status(), TransportStatus::Ready);
            finish_control.send(()).unwrap();
            let observed = timeout(Duration::from_secs(5), session.connection.closed()).await;
            let status = session.status();
            let _ = close_observed.send(());
            session.close().await;
            let served = timeout(Duration::from_secs(5), serving).await;
            let observed = observed.unwrap();
            let host_reason = served.unwrap().unwrap();
            eprintln!(
                "control EOF before revocation: phone={observed:?}, host={host_reason:?}, status={status:?}"
            );
            assert!(matches!(observed, ConnectionError::LocallyClosed));
            assert_eq!(status, TransportStatus::Disconnected);
        });
    }

    #[test]
    fn connect_proxy_accepts_only_its_exact_peer_authority_without_bodies() {
        let peer = iroh::SecretKey::generate().public();
        let authority = peer_authority(&peer, DEFAULT_PROXY_PORT);
        let head = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: Java/17\r\nProxy-Connection: keep-alive\r\n\r\n");
        assert!(accepts_connect_head(&head, &authority));
        assert!(accepts_connect_head(
            &head.replace("Proxy-Connection: keep-alive", "Connection: close"),
            &authority
        ));
        assert!(accepts_connect_head(
            &head.replace("Proxy-Connection: keep-alive", "Proxy-Connection: close"),
            &authority
        ));
        assert!(!accepts_connect_head(
            &head.replace("Proxy-Connection: keep-alive", "Connection: upgrade"),
            &authority
        ));
        assert!(!accepts_connect_head(
            &head.replace("CONNECT", "GET"),
            &authority
        ));
        assert!(!accepts_connect_head(
            &head.replace(&authority, "example.com:443"),
            &authority
        ));
        assert!(!accepts_connect_head(
            &head.replace("User-Agent: Java/17", "Content-Length: 1"),
            &authority
        ));
        assert!(!accepts_connect_head(
            &head.replace("User-Agent: Java/17", &format!("Host: {authority}")),
            &authority
        ));
        assert!(!accepts_connect_head(
            &head.replace("User-Agent: Java/17", "Transfer-Encoding: chunked"),
            &authority
        ));
    }

    #[test]
    fn native_connect_proxy_rejects_other_destinations_and_preserves_tls_bytes() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut control_send, mut control_recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut control_recv, MAX_LINE)
                    .await
                    .unwrap();
                write_line(&mut control_send, &encode_wire(&Wire::HelloOk).unwrap())
                    .await
                    .unwrap();
                // The invalid CONNECT must not have opened an iroh proxy stream.
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                assert!(matches!(
                    decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await.unwrap()).unwrap(),
                    Wire::Proxy
                ));
                let mut tls = [0; 6];
                recv.read_exact(&mut tls).await.unwrap();
                assert_eq!(tls, [0x16, 3, 3, 0, 1, 0xff]);
                send.write_all(&tls).await.unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let session =
                connect_endpoint(endpoint().await, address, None, "phone", test_options())
                    .await
                    .unwrap();
            let proxy = format!("127.0.0.1:{}", session.connect_proxy_port);
            let mut rejected = tokio::net::TcpStream::connect(&proxy).await.unwrap();
            rejected
                .write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
                .await
                .unwrap();
            let mut denied = Vec::new();
            timeout(Duration::from_secs(5), rejected.read_to_end(&mut denied))
                .await
                .unwrap()
                .unwrap();
            assert!(denied.starts_with(b"HTTP/1.1 403"));
            let mut tcp = tokio::net::TcpStream::connect(&proxy).await.unwrap();
            let authority = session.https_authority();
            let mut bytes =
                format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").into_bytes();
            bytes.extend_from_slice(&[0x16, 3, 3, 0, 1, 0xff]);
            tcp.write_all(&bytes).await.unwrap();
            let expected = b"HTTP/1.1 200 Connection Established\r\n\r\n";
            let mut response = vec![0; expected.len() + 6];
            timeout(Duration::from_secs(5), tcp.read_exact(&mut response))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&response[..expected.len()], expected);
            assert_eq!(&response[expected.len()..], &[0x16, 3, 3, 0, 1, 0xff]);
            session.close().await;
            assert!(tokio::net::TcpStream::connect(proxy).await.is_err());
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
        });
    }

    #[test]
    fn incomplete_native_connect_header_releases_its_stream_slot_on_budget() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                write_line(&mut send, &encode_wire(&Wire::HelloOk).unwrap())
                    .await
                    .unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let options = TransportOptions {
                stream_open_timeout: Duration::from_millis(100),
                ..test_options()
            };
            let session = connect_endpoint(endpoint().await, address, None, "phone", options)
                .await
                .unwrap();
            let mut tcp = tokio::net::TcpStream::connect(("127.0.0.1", session.connect_proxy_port))
                .await
                .unwrap();
            tcp.write_all(b"CONNECT ").await.unwrap();
            let mut byte = [0];
            assert!(matches!(
                timeout(Duration::from_secs(5), tcp.read(&mut byte))
                    .await
                    .unwrap(),
                Ok(0) | Err(_)
            ));
            session.close().await;
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
        });
    }

    #[test]
    fn hello_readiness_control_lifetime_proxy_and_close_use_real_quic() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let (proxy_seen, proxy_seen_rx) = oneshot::channel();
            let (control_held, control_held_rx) = oneshot::channel();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                assert!(matches!(decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await.unwrap()).unwrap(), Wire::Hello { name } if name == "phone"));
                write_line(&mut send, &encode_wire(&Wire::HelloOk).unwrap()).await.unwrap();
                let (mut proxy_send, mut proxy_recv) = timeout(Duration::from_secs(5), connection.accept_bi()).await.unwrap().unwrap();
                assert!(matches!(decode_wire(&read_line_bounded(&mut proxy_recv, MAX_LINE).await.unwrap()).unwrap(), Wire::Proxy));
                let mut body = [0; 6];
                proxy_recv.read_exact(&mut body).await.unwrap();
                assert_eq!(body, [0x16, 3, 3, 0, 1, 0xff]);
                proxy_send.write_all(&body).await.unwrap();
                proxy_seen.send(()).unwrap();
                // connect() has returned, but its first control stream must remain alive.
                assert!(timeout(Duration::from_millis(100), recv.read_u8()).await.is_err());
                control_held.send(()).unwrap();
                timeout(Duration::from_secs(5), connection.closed()).await.unwrap();
                host.close().await;
            });
            let session = connect_endpoint(endpoint().await, address, None, "phone", test_options()).await.unwrap();
            let local = format!("127.0.0.1:{}", session.port);
            let mut tcp = tokio::net::TcpStream::connect(&local).await.unwrap();
            tcp.write_all(&[0x16, 3, 3, 0, 1, 0xff]).await.unwrap();
            let mut reply = [0; 6];
            timeout(Duration::from_secs(5), tcp.read_exact(&mut reply)).await.unwrap().unwrap();
            assert_eq!(reply, [0x16, 3, 3, 0, 1, 0xff]);
            proxy_seen_rx.await.unwrap();
            assert!(!session.is_closed());
            control_held_rx.await.unwrap();
            session.close().await;
            assert!(tokio::net::TcpStream::connect(local).await.is_err());
            timeout(Duration::from_secs(5), serving).await.unwrap().unwrap();
        });
    }

    #[test]
    fn host_control_eof_closes_accepted_proxy_children_and_listener() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let (finish_control, finish_control_rx) = oneshot::channel();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                assert!(matches!(
                    decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await.unwrap()).unwrap(),
                    Wire::Pair { .. }
                ));
                write_line(&mut send, &encode_wire(&Wire::PairOk).unwrap())
                    .await
                    .unwrap();
                let (_proxy_send, mut proxy_recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut proxy_recv, MAX_LINE).await.unwrap();
                finish_control_rx.await.unwrap();
                send.finish().unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let session = connect_endpoint(
                endpoint().await,
                address,
                Some("123456"),
                "phone",
                test_options(),
            )
            .await
            .unwrap();
            let local = format!("127.0.0.1:{}", session.port);
            let mut tcp = tokio::net::TcpStream::connect(&local).await.unwrap();
            tcp.write_all(b"keep-open").await.unwrap();
            finish_control.send(()).unwrap();
            let mut byte = [0];
            let read = timeout(Duration::from_secs(5), tcp.read(&mut byte))
                .await
                .unwrap();
            assert!(matches!(read, Ok(0) | Err(_)));
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
            assert!(session.is_closed());
            assert!(tokio::net::TcpStream::connect(local).await.is_err());
            session.close().await;
        });
    }

    #[test]
    fn occupied_fixed_port_does_not_fall_back_to_another_origin() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let options = TransportOptions {
                local_port: occupied.local_addr().unwrap().port(),
                ..test_options()
            };
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                write_line(&mut send, &encode_wire(&Wire::HelloOk).unwrap())
                    .await
                    .unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let result = connect_endpoint(endpoint().await, address, None, "phone", options).await;
            assert!(result
                .err()
                .unwrap()
                .to_string()
                .contains("fixed Android loopback proxy port"));
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
        });
    }

    #[test]
    fn missing_readiness_ack_obeys_connection_budget() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (_send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let options = TransportOptions {
                connect_timeout: Duration::from_secs(2),
                ..test_options()
            };
            let result = connect_endpoint(endpoint().await, address, None, "phone", options).await;
            assert!(result.err().unwrap().to_string().contains("timed out"));
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
        });
    }

    #[test]
    fn aborting_connect_before_readiness_closes_the_remote_connection() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let (entered, entered_rx) = oneshot::channel();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (_send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                entered.send(()).unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let cleanup = EndpointCleanup::default();
            let connecting = tokio::spawn(connect_endpoint_tracked(
                endpoint().await,
                address,
                None,
                "phone",
                test_options(),
                Some(cleanup.clone()),
            ));
            timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap();
            connecting.abort();
            assert!(matches!(connecting.await, Err(error) if error.is_cancelled()));
            timeout(Duration::from_secs(5), cleanup.finish())
                .await
                .unwrap();
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
        });
    }

    #[test]
    fn control_size_bound_survives_fragmented_input_and_interleaved_proxy_events() {
        use std::pin::Pin;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::task::{Context, Poll};
        use tokio::io::ReadBuf;
        use tokio::sync::Notify;

        struct Observed {
            reader: RecvStream,
            bytes: Arc<AtomicUsize>,
            progress: Arc<Notify>,
        }
        impl AsyncRead for Observed {
            fn poll_read(
                mut self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buffer: &mut ReadBuf<'_>,
            ) -> Poll<std::io::Result<()>> {
                let before = buffer.filled().len();
                let result = Pin::new(&mut self.reader).poll_read(cx, buffer);
                let count = buffer.filled().len() - before;
                if count > 0 {
                    self.bytes.fetch_add(count, Ordering::SeqCst);
                    self.progress.notify_one();
                }
                result
            }
        }

        runtime().block_on(async {
            let host = endpoint().await;
            let client = endpoint().await;
            let accepting = tokio::spawn({
                let host = host.clone();
                async move { host.accept().await.unwrap().await.unwrap() }
            });
            let connection = client.connect(host.addr(), ALPN).await.unwrap();
            let (mut control_send, control_recv) = connection.open_bi().await.unwrap();
            write_line(
                &mut control_send,
                &encode_wire(&Wire::Hello {
                    name: "phone".into(),
                })
                .unwrap(),
            )
            .await
            .unwrap();
            let host_connection = accepting.await.unwrap();
            let (mut remote_control, mut remote_recv) = host_connection.accept_bi().await.unwrap();
            read_line_bounded(&mut remote_recv, MAX_LINE).await.unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let local = listener.local_addr().unwrap();
            let connect_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (_stop, stopped) = oneshot::channel();
            let bytes = Arc::new(AtomicUsize::new(0));
            let progress = Arc::new(Notify::new());
            let owner = tokio::spawn(own_proxy(ProxyOwner {
                listener,
                connect_listener,
                authority: peer_authority(&host.id(), local.port()),
                connection,
                control_send,
                control_recv: Observed {
                    reader: control_recv,
                    bytes: bytes.clone(),
                    progress: progress.clone(),
                },
                stopped,
                options: test_options(),
            }));
            let fragment = vec![b'x'; MAX_LINE / 2 + 1];
            remote_control.write_all(&fragment).await.unwrap();
            timeout(Duration::from_secs(5), async {
                while bytes.load(Ordering::SeqCst) < fragment.len() {
                    progress.notified().await;
                }
            })
            .await
            .unwrap();
            // Selecting accept discards a newly-created line reader's partial buffer.
            let mut tcp = tokio::net::TcpStream::connect(local).await.unwrap();
            tcp.write_all(b"x").await.unwrap();
            let (_send, mut recv) = host_connection.accept_bi().await.unwrap();
            assert!(matches!(
                decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await.unwrap()).unwrap(),
                Wire::Proxy
            ));
            remote_control.write_all(&fragment).await.unwrap();
            timeout(Duration::from_secs(5), host_connection.closed())
                .await
                .unwrap();
            timeout(Duration::from_secs(5), owner)
                .await
                .unwrap()
                .unwrap();
            assert!(tokio::net::TcpStream::connect(local).await.is_err());
            client.close().await;
            host.close().await;
        });
    }

    #[test]
    fn raw_and_native_connect_proxy_share_one_stream_quota() {
        runtime().block_on(async {
            let host = endpoint().await;
            let address = host.addr();
            let (first_opened, first_opened_rx) = oneshot::channel();
            let (quota_checked, quota_checked_rx) = oneshot::channel();
            let (second_opened, second_opened_rx) = oneshot::channel();
            let serving = tokio::spawn(async move {
                let connection = host.accept().await.unwrap().await.unwrap();
                let (mut control_send, mut control_recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut control_recv, MAX_LINE)
                    .await
                    .unwrap();
                write_line(&mut control_send, &encode_wire(&Wire::HelloOk).unwrap())
                    .await
                    .unwrap();
                let (mut send, mut recv) = connection.accept_bi().await.unwrap();
                read_line_bounded(&mut recv, MAX_LINE).await.unwrap();
                first_opened.send(()).unwrap();
                assert!(timeout(Duration::from_millis(100), connection.accept_bi())
                    .await
                    .is_err());
                quota_checked.send(()).unwrap();
                let _ = timeout(Duration::from_secs(5), recv.read_to_end(1024))
                    .await
                    .unwrap()
                    .unwrap();
                send.finish().unwrap();
                let (_send, mut recv) = timeout(Duration::from_secs(5), connection.accept_bi())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(matches!(
                    decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await.unwrap()).unwrap(),
                    Wire::Proxy
                ));
                second_opened.send(()).unwrap();
                timeout(Duration::from_secs(5), connection.closed())
                    .await
                    .unwrap();
                host.close().await;
            });
            let options = TransportOptions {
                max_proxy_streams: 1,
                ..test_options()
            };
            let session = connect_endpoint(endpoint().await, address, None, "phone", options)
                .await
                .unwrap();
            let mut first = tokio::net::TcpStream::connect(("127.0.0.1", session.port))
                .await
                .unwrap();
            first.write_all(b"first").await.unwrap();
            first_opened_rx.await.unwrap();
            let mut second =
                tokio::net::TcpStream::connect(("127.0.0.1", session.connect_proxy_port))
                    .await
                    .unwrap();
            let authority = session.https_authority();
            second
                .write_all(
                    format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes(),
                )
                .await
                .unwrap();
            quota_checked_rx.await.unwrap();
            drop(first);
            timeout(Duration::from_secs(5), second_opened_rx)
                .await
                .unwrap()
                .unwrap();
            session.close().await;
            timeout(Duration::from_secs(5), serving)
                .await
                .unwrap()
                .unwrap();
        });
    }
}
