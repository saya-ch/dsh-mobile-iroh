//! Host test driver for the actual Android transport crate, not another client implementation.
use std::{io::Write as _, net::SocketAddr, path::PathBuf, time::Duration};

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use dsh_mobile_iroh_android_transport::{connect_endpoint, TransportOptions};
use dsh_mobile_iroh_core::{load_or_create_secret, write_private, ALPN};
use iroh::{endpoint::presets, Endpoint, EndpointAddr, EndpointId};

#[derive(Parser)]
struct Cli {
    #[arg(long, global = true, default_value = "en")]
    lang: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run only on loopback, using explicit addresses and the Android production transport.
    PhoneSim {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        peer: EndpointId,
        #[arg(long, required = true)]
        peer_address: Vec<SocketAddr>,
        #[arg(long)]
        code: Option<String>,
        #[arg(long, default_value = "android-core-smoke")]
        name: String,
        #[arg(long, default_value = "127.0.0.1:25443")]
        proxy_listen: SocketAddr,
        #[arg(long)]
        local_only: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let Cli { command, .. } = Cli::parse();
    let Command::PhoneSim {
        data_dir,
        peer,
        peer_address,
        code,
        name,
        proxy_listen,
        local_only,
    } = command;
    if !local_only
        || !proxy_listen.ip().is_loopback()
        || proxy_listen.port() < 1024
        || peer_address
            .iter()
            .any(|address| !address.ip().is_loopback() || address.port() == 0)
    {
        bail!(
            "this test driver requires explicit loopback addresses and a non-privileged fixed port"
        );
    }
    let secret = load_or_create_secret(&data_dir.join("identity.key"))?;
    let endpoint = Endpoint::builder(presets::Minimal)
        .clear_ip_transports()
        .bind_addr("127.0.0.1:0".parse::<SocketAddr>()?)?
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?;
    let peer = peer_address
        .into_iter()
        .fold(EndpointAddr::new(peer), |peer, address| {
            peer.with_ip_addr(address)
        });
    let session = connect_endpoint(
        endpoint,
        peer,
        code.as_deref(),
        &name,
        TransportOptions {
            local_port: proxy_listen.port(),
            ..TransportOptions::default()
        },
    )
    .await?;
    write_private(
        &data_dir.join("transport-metadata.json"),
        session.connection_metadata().as_bytes(),
    )?;
    println!(
        "{{\"version\":1,\"type\":\"proxy-ready\",\"origin\":\"{}\"}}",
        session.local_url()
    );
    std::io::stdout().flush()?;
    let (stdin_done, mut stdin_closed) = tokio::sync::oneshot::channel();
    // A detached OS stdin reader must not pin Tokio's blocking pool after remote close.
    std::thread::spawn(move || {
        use std::io::Read as _;
        let mut byte = [0u8; 1];
        let result = std::io::stdin().read(&mut byte);
        let _ = stdin_done.send(result);
    });
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
