//! Android-side iroh transport core.
//!
//! This crate owns the endpoint, authenticated control stream, and loopback
//! byte proxy. Android/JNI bindings are deliberately kept outside this core so
//! the protocol and proxy can be tested on the host before native packaging.

use std::path::Path;

use anyhow::{bail, Context as _, Result};
use dsh_mobile_iroh_core::{
    decode_wire, encode_wire, load_or_create_secret, pair_fail_text, read_line_bounded, write_line,
    Wire, ALPN, MAX_LINE,
};
use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointId};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const PROXY_PORT_BASE: u16 = 20_000;
const PROXY_PORT_SPAN: u16 = 12_000;

/// One connected Android-side endpoint and its local HTTP byte proxy.
pub struct AndroidTransportSession {
    endpoint: Endpoint,
    connection: Connection,
    proxy_task: JoinHandle<()>,
    port: u16,
}

impl AndroidTransportSession {
    /// Return the loopback URL that the WebView can load for this host.
    pub fn local_url(&self) -> String {
        format!("http://127.0.0.1:{}/", self.port)
    }

    /// Stop the proxy and close the authenticated iroh connection.
    pub async fn close(self) {
        self.proxy_task.abort();
        self.connection.close(0u8.into(), b"client closed");
        self.endpoint.close().await;
    }
}

/// Connect to a paired host. Supplying a code performs first-time pairing;
/// omitting it uses the persisted host-side peer authorization.
pub async fn connect(
    data_dir: &Path,
    peer: EndpointId,
    code: Option<&str>,
    device_name: &str,
) -> Result<AndroidTransportSession> {
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .context("failed to start the Android iroh endpoint")?;
    let connection = endpoint
        .connect(peer, ALPN)
        .await
        .context("failed to connect to the paired host")?;
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .context("failed to open the iroh control stream")?;
    let first = match code {
        Some(code) => {
            if !is_pairing_code(code) {
                bail!("pairing code must contain six decimal digits")
            }
            Wire::Pair {
                code: code.to_string(),
                name: device_name.trim().to_string(),
            }
        }
        None => Wire::Hello {
            name: device_name.trim().to_string(),
        },
    };
    write_line(&mut send, &encode_wire(&first)?).await?;
    if code.is_some() {
        let response = decode_wire(&read_line_bounded(&mut recv, MAX_LINE).await?)?;
        match response {
            Wire::PairOk => {}
            Wire::PairFail { reason } => bail!("{}{}", "pairing failed: ", pair_fail_text(&reason)),
            _ => bail!("pairing response did not follow the protocol"),
        }
    }
    let port = proxy_port_for(&peer);
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(_) => TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("failed to bind the Android loopback proxy")?,
    };
    let port = listener.local_addr()?.port();
    let proxy_connection = connection.clone();
    let proxy_task = tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let connection = proxy_connection.clone();
            tokio::spawn(async move {
                let Ok((mut send, recv)) = connection.open_bi().await else {
                    return;
                };
                let Ok(proxy) = encode_wire(&Wire::Proxy) else {
                    return;
                };
                if write_line(&mut send, &proxy).await.is_err() {
                    return;
                }
                let mut stream = tokio::io::join(recv, send);
                let _ = copy_bidirectional(&mut tcp, &mut stream).await;
            });
        }
    });
    Ok(AndroidTransportSession {
        endpoint,
        connection,
        proxy_task,
        port,
    })
}

/// Keep host selection stable so WebView storage survives reconnects.
pub fn proxy_port_for(peer: &EndpointId) -> u16 {
    let bytes = peer.as_bytes();
    PROXY_PORT_BASE + u16::from_be_bytes([bytes[0], bytes[1]]) % PROXY_PORT_SPAN
}

fn is_pairing_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_ports_are_stable_and_reserved() {
        let peer = iroh::SecretKey::generate().public();
        let port = proxy_port_for(&peer);
        assert!((PROXY_PORT_BASE..PROXY_PORT_BASE + PROXY_PORT_SPAN).contains(&port));
        assert_eq!(port, proxy_port_for(&peer));
    }

    #[test]
    fn pairing_code_requires_six_ascii_digits() {
        assert!(is_pairing_code("123456"));
        assert!(!is_pairing_code("12345"));
        assert!(!is_pairing_code("１２３４５６"));
    }
}
