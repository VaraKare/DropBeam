//! QUIC sender: connects to a receiver and streams files over parallel QUIC streams.

use std::path::PathBuf;
use anyhow::Result;
use tokio::io::AsyncReadExt;
use tracing::{info, warn};

use crate::protocol::{send_json, recv_json, Hello, HelloAck};
use dropbeam_transfer_core::{encode_frame, sha256_hex};

pub struct SendArgs {
    pub host: String,
    pub port: u16,
    pub token: String,
    pub transfer_id: String,
    pub files: Vec<PathBuf>,
    pub lanes: u8,
    pub chunk_size: usize,
}

pub async fn run_sender(args: SendArgs) -> Result<()> {
    let endpoint = {
        let client_cfg = crate::tls::make_client_config_insecure();
        let mut ep = quinn::Endpoint::client("0.0.0.0:0".parse()?)?;
        ep.set_default_client_config(client_cfg);
        ep
    };

    let addr = format!("{}:{}", args.host, args.port).parse()?;
    info!("[quic-sender] connecting to {addr}");
    let conn = endpoint
        .connect(addr, "dropbeam-lan")?
        .await?;
    info!("[quic-sender] QUIC connection established");

    // Control stream (bidirectional stream 0)
    let (mut ctrl_tx, mut ctrl_rx) = conn.open_bi().await?;

    // Authenticate
    send_json(&mut ctrl_tx, &Hello {
        token: args.token.clone(),
        transfer_id: args.transfer_id.clone(),
        lanes: args.lanes,
    }).await?;
    let ack: HelloAck = recv_json(&mut ctrl_rx).await?;
    if !ack.ok {
        anyhow::bail!("receiver rejected: {}", ack.reason.unwrap_or_default());
    }
    info!("[quic-sender] authenticated; {} lane(s)", args.lanes);

    let total_bytes: u64 = {
        let mut sum = 0u64;
        for f in &args.files {
            sum += tokio::fs::metadata(f).await?.len();
        }
        sum
    };

    // Build manifest JSON and send over control stream
    let manifest = build_manifest(&args, total_bytes);
    ctrl_tx.write_all_from(serde_json::to_vec(&manifest)?.as_slice()).await?;

    // Open N unidirectional data streams (one per lane)
    let mut data_streams: Vec<quinn::SendStream> = Vec::with_capacity(args.lanes as usize);
    for _ in 0..args.lanes {
        data_streams.push(conn.open_uni().await?);
    }

    let mut total_sent = 0u64;
    let started = std::time::Instant::now();

    for (file_idx, path) in args.files.iter().enumerate() {
        let file_id = (file_idx + 1) as u32;
        let file_size = tokio::fs::metadata(path).await?.len();
        let mut fh = tokio::fs::File::open(path).await?;
        let mut chunk_index = 0u32;
        let mut chunk_buf = vec![0u8; args.chunk_size];
        let mut file_hasher = dropbeam_transfer_core::IncrementalHasher::new();

        loop {
            let n = fh.read(&mut chunk_buf).await?;
            if n == 0 { break; }
            let chunk = &chunk_buf[..n];
            file_hasher.update(chunk);
            let pos = chunk_index as u64 * args.chunk_size as u64;
            let is_last = pos + n as u64 >= file_size;
            let frame = encode_frame(file_id, chunk_index, chunk, false, is_last);
            let lane_idx = chunk_index as usize % data_streams.len();
            use tokio::io::AsyncWriteExt;
            data_streams[lane_idx].write_all(&frame).await?;
            total_sent += n as u64;
            chunk_index += 1;

            let elapsed = started.elapsed().as_secs_f64();
            if elapsed > 0.0 {
                let mbps = (total_sent as f64 * 8.0) / elapsed / 1e6;
                let pct = total_sent as f64 / total_bytes as f64 * 100.0;
                eprint!("\r[quic] {pct:.1}%  {mbps:.1} Mbps    ");
            }
        }
        let sha = file_hasher.finalize_hex();
        let file_end = serde_json::json!({
            "type": "file-end",
            "transferId": args.transfer_id,
            "fileId": file_id,
            "sha256": sha,
        });
        ctrl_tx.write_all_from(serde_json::to_vec(&file_end)?.as_slice()).await?;
        info!("\n[quic-sender] file {file_id} done sha={sha}");
    }

    // Finish all data streams
    for mut s in data_streams { s.finish()?; }

    let complete = serde_json::json!({ "type": "complete", "transferId": args.transfer_id });
    ctrl_tx.write_all_from(serde_json::to_vec(&complete)?.as_slice()).await?;
    ctrl_tx.finish()?;

    // Wait for receiver to close
    conn.closed().await;
    info!("[quic-sender] done");
    Ok(())
}

fn build_manifest(args: &SendArgs, total_bytes: u64) -> serde_json::Value {
    let files: Vec<_> = args.files.iter().enumerate().map(|(i, p)| {
        serde_json::json!({
            "id": i + 1,
            "name": p.file_name().unwrap_or_default().to_string_lossy(),
            "size": std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        })
    }).collect();
    serde_json::json!({
        "type": "manifest",
        "transferId": args.transfer_id,
        "files": files,
        "totalBytes": total_bytes,
        "chunkSize": args.chunk_size,
        "lanes": args.lanes,
        "createdAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis(),
    })
}

trait WriteFrom {
    async fn write_all_from(&mut self, data: &[u8]) -> anyhow::Result<()>;
}
impl WriteFrom for quinn::SendStream {
    async fn write_all_from(&mut self, data: &[u8]) -> anyhow::Result<()> {
        use tokio::io::AsyncWriteExt;
        self.write_all(data).await?;
        Ok(())
    }
}
