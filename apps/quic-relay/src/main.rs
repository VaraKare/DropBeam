mod protocol;
mod receiver;
mod sender;
mod tls;

use clap::{Parser, Subcommand};
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

/// DropBeam QUIC — LAN file transfer at native UDP speed.
///
/// Uses QUIC (TLS 1.3 over UDP) for sub-millisecond handshake and
/// zero-copy transfers. Falls back automatically to WebRTC if QUIC
/// is unavailable (the TS CLI handles fallback detection).
#[derive(Parser)]
#[command(name = "dropbeam-quic", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Listen for an incoming QUIC file transfer.
    Recv {
        /// UDP port to listen on.
        #[arg(long, default_value = "9898")]
        port: u16,
        /// Room token for authentication (from signaling server).
        #[arg(long, env = "DROPBEAM_TOKEN")]
        token: String,
        /// Directory to save received files into.
        #[arg(long, default_value = ".")]
        out: PathBuf,
    },
    /// Send files to a remote receiver.
    Send {
        /// Receiver's IP address.
        #[arg(long)]
        host: String,
        #[arg(long, default_value = "9898")]
        port: u16,
        /// Room token for authentication.
        #[arg(long, env = "DROPBEAM_TOKEN")]
        token: String,
        /// Transfer ID (any unique string).
        #[arg(long, default_value = "quic-tx")]
        transfer_id: String,
        /// Number of parallel QUIC streams (lanes).
        #[arg(long, default_value = "4")]
        lanes: u8,
        /// Chunk size in bytes.
        #[arg(long, default_value = "65536")]
        chunk_size: usize,
        /// Files to transfer.
        files: Vec<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let cli = Cli::parse();
    match cli.cmd {
        Cmd::Recv { port, token, out } => {
            receiver::run_receiver(receiver::RecvArgs { port, token, out_dir: out }).await?;
        }
        Cmd::Send { host, port, token, transfer_id, lanes, chunk_size, files } => {
            sender::run_sender(sender::SendArgs {
                host,
                port,
                token,
                transfer_id,
                files,
                lanes,
                chunk_size,
            })
            .await?;
        }
    }
    Ok(())
}
