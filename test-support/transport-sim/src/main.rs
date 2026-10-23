//! Host test driver for the actual Android transport crate, not another client implementation.
use std::{io::Write as _, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use dsh_mobile_iroh_android_transport::{connect_endpoint, TransportOptions};
use dsh_mobile_iroh_core::{load_or_create_secret, write_private, ALPN};
use iroh::{
    address_lookup::{DnsAddressLookup, PkarrError, PkarrResolver},
    endpoint::presets,
    Endpoint, EndpointAddr, EndpointId, RelayMode,
};
use n0_future::StreamExt as _;
use serde_json::{json, Value};

#[derive(Parser)]
struct Cli {
    #[arg(long, global = true, default_value = "en")]
    lang: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Inspect public lookup results without creating persistent identity or pairing state.
    LookupProbe {
        #[arg(long, value_parser = parse_full_endpoint_id)]
        peer: EndpointId,
        #[arg(long, default_value_t = 12_000, value_parser = clap::value_parser!(u64).range(100..=30_000))]
        timeout_ms: u64,
    },
    /// Drive the Android transport with explicit local or opt-in public addressing.
    PhoneSim {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        peer: EndpointId,
        #[arg(long)]
        peer_address: Vec<SocketAddr>,
        #[arg(long)]
        code: Option<String>,
        #[arg(long, default_value = "android-core-smoke")]
        name: String,
        #[arg(long, default_value = "127.0.0.1:25443")]
        proxy_listen: SocketAddr,
        #[arg(long, conflicts_with = "relay_only")]
        local_only: bool,
        #[arg(long, conflicts_with = "local_only")]
        relay_only: bool,
        #[arg(long, default_value_t = 30_000, value_parser = clap::value_parser!(u64).range(100..=30_000))]
        connect_timeout_ms: u64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let Cli { command, .. } = Cli::parse();
    if let Command::LookupProbe { peer, timeout_ms } = command {
        return lookup_probe(peer, Duration::from_millis(timeout_ms)).await;
    }
    let Command::PhoneSim {
        data_dir,
        peer,
        peer_address,
        code,
        name,
        proxy_listen,
        local_only,
        relay_only,
        connect_timeout_ms,
    } = command
    else {
        bail!("phone command required");
    };
    validate_mode(local_only, relay_only, proxy_listen, &peer_address)?;
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let builder = if local_only {
        Endpoint::builder(presets::Minimal)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0".parse::<SocketAddr>()?)?
    } else if relay_only {
        // N0 keeps its public address lookup and relays; no UDP/IP transport can win.
        Endpoint::builder(presets::N0).clear_ip_transports()
    } else {
        Endpoint::builder(presets::N0)
    };
    let endpoint = builder
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?;
    let peer = peer_address
        .into_iter()
        .fold(EndpointAddr::new(peer), |peer, address| {
            peer.with_ip_addr(address)
        });
    let (stdin_done, mut stdin_closed) = tokio::sync::oneshot::channel();
    // This OS reader cannot pin Tokio's blocking pool after setup cancellation.
    std::thread::spawn(move || {
        use std::io::Read as _;
        let mut byte = [0u8; 1];
        let result = std::io::stdin().read(&mut byte);
        let _ = stdin_done.send(result);
    });
    eprintln!("transport-sim: connection setup started");
    let session = tokio::select! {
        result = connect_endpoint(
            endpoint.clone(),
            peer,
            code.as_deref(),
            &name,
            TransportOptions {
                local_port: proxy_listen.port(),
                connect_timeout: Duration::from_millis(connect_timeout_ms),
                ..TransportOptions::default()
            },
        ) => result?,
        read = &mut stdin_closed => {
            read??;
            let _ = tokio::time::timeout(Duration::from_secs(3), endpoint.close()).await;
            return Ok(());
        },
    };
    write_private(
        &data_dir.join("transport-metadata.json"),
        session.connection_metadata().as_bytes(),
    )?;
    println!(
        "{{\"version\":1,\"type\":\"proxy-ready\",\"origin\":\"{}\"}}",
        session.local_url()
    );
    std::io::stdout().flush()?;
    let mut monitor = tokio::time::interval(Duration::from_millis(100));
    let result = loop {
        tokio::select! {
            read = &mut stdin_closed => { read??; break Ok(()) },
            _ = tokio::signal::ctrl_c() => break Ok(()),
            _ = monitor.tick() => {
                if session.is_closed() { break Err(anyhow::anyhow!("Android transport owner closed")) }
            },
        }
    };
    session.close().await;
    result
}

fn parse_full_endpoint_id(value: &str) -> std::result::Result<EndpointId, &'static str> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("a complete lowercase hexadecimal EndpointId is required");
    }
    value.parse().map_err(|_| "invalid EndpointId")
}

fn lookup_source(source: &str) -> &'static str {
    match source {
        "pkarr" => "pkarr",
        "dns" => "dns",
        _ => "other",
    }
}

// Only typed failures and fixed labels are emitted: source chains can contain URLs.
fn lookup_error(error: &(dyn std::error::Error + 'static)) -> Value {
    let mut cause = Some(error);
    for _ in 0..16 {
        let Some(current) = cause else { break };
        if let Some(pkarr) = current.downcast_ref::<PkarrError>() {
            let (class, status) = match pkarr {
                PkarrError::HttpRequest { status, .. } => ("http_status", Some(status.as_u16())),
                PkarrError::HttpSend { .. } => ("http_send_failed", None),
                PkarrError::HttpPayload { .. } => ("http_payload_failed", None),
                PkarrError::Verify { .. } => ("signature_invalid", None),
                _ => ("record_invalid", None),
            };
            return json!({ "source": "pkarr", "class": class, "httpStatus": status });
        }
        if current.is::<iroh::dns::LookupError>()
            || current.is::<iroh::dns::DnsError>()
            || current.is::<iroh::dns::StaggeredError<iroh::dns::LookupError>>()
        {
            return json!({ "source": "dns", "class": "dns_lookup_failed" });
        }
        cause = current.source();
    }
    json!({ "source": "other", "class": "lookup_failed" })
}

async fn lookup_probe(peer: EndpointId, budget: Duration) -> Result<()> {
    let deadline = tokio::time::Instant::now() + budget;
    // Keep N0's public resolver and TLS defaults, without publishing an ephemeral
    // identity or registering a relay. Only the requested peer is looked up.
    let builder = Endpoint::builder(presets::N0)
        .clear_address_lookup()
        .address_lookup(PkarrResolver::n0_dns())
        .address_lookup(DnsAddressLookup::n0_dns())
        .relay_mode(RelayMode::Disabled)
        .clear_ip_transports()
        .bind_addr("127.0.0.1:0".parse::<SocketAddr>()?)?;
    let endpoint = match tokio::time::timeout_at(deadline, builder.bind()).await {
        Ok(Ok(endpoint)) => endpoint,
        outcome => {
            let class = if outcome.is_err() {
                "bind_timeout"
            } else {
                "bind_failed"
            };
            println!(
                "{}",
                json!({ "version": 1, "type": "lookup-probe", "status": class,
                "endpointClosed": false, "records": [], "errors": [] })
            );
            bail!("lookup probe could not create its endpoint");
        }
    };
    let mut records = Vec::new();
    let mut errors = Vec::new();
    let mut stream_finished = false;
    let mut result_limit = false;
    let work = async {
        let lookup = endpoint.address_lookup().map_err(|_| ())?;
        let stream = lookup.resolve(peer);
        tokio::pin!(stream);
        while let Some(item) = stream.next().await {
            if records.len() + errors.len() >= 8 {
                result_limit = true;
                break;
            }
            match item {
                Ok(Ok(item)) if item.endpoint_id() == peer => {
                    let source = lookup_source(item.provenance());
                    let address = item.to_endpoint_addr();
                    records.push(json!({ "source": source,
                        "signatureVerified": source == "pkarr",
                        "relayAddresses": address.relay_urls().count(),
                        "directAddresses": address.ip_addrs().count() }));
                }
                Ok(Ok(_)) => {
                    errors.push(json!({ "source": "other", "class": "endpoint_mismatch" }))
                }
                Ok(Err(error)) => errors.push(lookup_error(&error)),
                Err(_) => {
                    errors.push(json!({ "source": "aggregate", "class": "no_address_results" }))
                }
            }
        }
        stream_finished = !result_limit;
        Ok::<_, ()>(())
    };
    let timed_out = tokio::time::timeout_at(deadline, work).await.is_err();
    // No filesystem root exists to clean. Report close timeout as incomplete,
    // never as a successful probe; the caller must also observe process exit.
    let endpoint_closed = tokio::time::timeout(Duration::from_secs(3), endpoint.close())
        .await
        .is_ok();
    let usable_records = records
        .iter()
        .filter(|item| {
            item["relayAddresses"].as_u64().unwrap_or(0)
                + item["directAddresses"].as_u64().unwrap_or(0)
                > 0
        })
        .count();
    let verified_records = records
        .iter()
        .filter(|item| item["signatureVerified"] == true)
        .count();
    let status = if !endpoint_closed {
        "close_timeout"
    } else if timed_out {
        "lookup_timeout"
    } else if result_limit {
        "result_limit"
    } else if !stream_finished {
        "lookup_unavailable"
    } else if usable_records == 0 {
        "no_usable_addresses"
    } else {
        "resolved"
    };
    println!(
        "{}",
        json!({ "version": 1, "type": "lookup-probe", "status": status,
        "endpointClosed": endpoint_closed, "lookupFinished": stream_finished,
        "recordCount": records.len(), "verifiedRecordCount": verified_records,
        "usableRecordCount": usable_records, "records": records, "errors": errors })
    );
    std::io::stdout().flush()?;
    if status != "resolved" {
        bail!("lookup probe did not complete with usable addresses");
    }
    Ok(())
}

fn validate_mode(
    local_only: bool,
    relay_only: bool,
    proxy_listen: SocketAddr,
    peer_address: &[SocketAddr],
) -> Result<()> {
    if local_only && relay_only
        || !proxy_listen.ip().is_loopback()
        || proxy_listen.port() < 1024
        || local_only && peer_address.is_empty()
        || !local_only && !peer_address.is_empty()
        || peer_address
            .iter()
            .any(|address| !address.ip().is_loopback() || address.port() == 0)
    {
        bail!(
            "local mode requires loopback peer addresses; public modes require EndpointId only; the proxy port must stay fixed and non-privileged"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_cli_requires_complete_endpoint_and_bounded_budget_without_state_path() {
        let peer = iroh::SecretKey::from_bytes(&[7; 32]).public().to_string();
        let base = ["transport-sim", "lookup-probe", "--peer", peer.as_str()];
        assert!(Cli::try_parse_from(base).is_ok());
        for budget in ["0", "99", "30001"] {
            let mut args = base.to_vec();
            args.extend(["--timeout-ms", budget]);
            assert!(Cli::try_parse_from(args).is_err());
        }
        for extra in ["--data-dir", "--code", "--relay-only"] {
            let mut args = base.to_vec();
            args.push(extra);
            assert!(Cli::try_parse_from(args).is_err());
        }
        assert!(parse_full_endpoint_id("short").is_err());
        assert!(parse_full_endpoint_id(&peer.to_uppercase()).is_err());
    }

    #[test]
    fn lookup_output_does_not_include_unrecognized_source_or_error_text() {
        assert_eq!(lookup_source("unsafe-secret-source"), "other");
        let error = std::io::Error::other("https://user:secret@example.test/private-identity");
        assert_eq!(
            lookup_error(&error),
            json!({ "source": "other", "class": "lookup_failed" })
        );
    }

    #[test]
    fn public_modes_are_endpoint_id_only_and_local_mode_requires_addresses() {
        let port = "127.0.0.1:25443".parse().unwrap();
        let peer = "127.0.0.1:32000".parse().unwrap();
        assert!(validate_mode(false, false, port, &[]).is_ok());
        assert!(validate_mode(false, true, port, &[]).is_ok());
        assert!(validate_mode(true, false, port, &[peer]).is_ok());
        assert!(validate_mode(true, false, port, &[]).is_err());
        assert!(validate_mode(false, true, port, &[peer]).is_err());
        assert!(validate_mode(false, false, port, &[peer]).is_err());
        assert!(validate_mode(true, true, port, &[peer]).is_err());
    }

    #[test]
    fn proxy_ports_and_local_peer_addresses_stay_loopback_and_fixed() {
        let peer = "127.0.0.1:32000".parse().unwrap();
        for port in ["127.0.0.1:0", "127.0.0.1:443", "0.0.0.0:25443"] {
            assert!(validate_mode(true, false, port.parse().unwrap(), &[peer]).is_err());
        }
        let port = "127.0.0.1:25443".parse().unwrap();
        for peer in ["127.0.0.1:0", "8.8.8.8:32000"] {
            assert!(validate_mode(true, false, port, &[peer.parse().unwrap()]).is_err());
        }
    }

    #[test]
    fn cli_rejects_conflicting_modes_and_out_of_range_setup_budgets() {
        let peer = iroh::SecretKey::from_bytes(&[7; 32]).public().to_string();
        let base = [
            "transport-sim",
            "phone-sim",
            "--data-dir",
            "unused",
            "--peer",
            peer.as_str(),
        ];
        assert!(Cli::try_parse_from(base).is_ok());
        let mut args = base.to_vec();
        args.extend(["--relay-only", "--local-only"]);
        assert!(Cli::try_parse_from(args).is_err());
        for budget in ["0", "99", "30001"] {
            let mut args = base.to_vec();
            args.extend(["--connect-timeout-ms", budget]);
            assert!(Cli::try_parse_from(args).is_err());
        }
    }
}
