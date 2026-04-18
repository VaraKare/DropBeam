//! QUIC receiver: listens, authenticates, receives frames, writes to disk.

use std::path::PathBuf;
use std::collections::HashMap;
use anyhow::Result;
use tokio::io::AsyncWriteExt;
use tracing::info;

use crate::protocol::{send_json, recv_json, Hello, HelloAck};
use dropbeam_transfer_core::{decode_frame, sha256_hex, IncrementalHasher};

pub struct RecvArgs {
    pub port: u16,
    pub token: String,
    pub out_dir: PathBuf,
}

pub async fn run_receiver(args: RecvArgs) -> Result<()> {
    let (server_cfg, _fingerprint) = crate::tls::make_server_config()?;
    let endpoint = quinn::Endpoint::server(server_cfg, format!("0.0.0.0:{}", args.port).parse()?)?;
    info!("[quic-recv] listening on UDP 0.0.0.0:{}", args.port);

    tokio::fs::create_dir_all(&args.out_dir).await?;

    // Accept one connection (1:1 transfer per invocation)
    let incoming = endpoint.accept().await.ok_or_else(|| anyhow::anyhow!("no connection"))?;
    let conn = incoming.await?;
    info!("[quic-recv] connection from {}", conn.remote_address());

    // Control stream
    let (mut ctrl_tx, mut ctrl_rx) = conn.accept_bi().await?;

    // Authenticate
    let hello: Hello = recv_json(&mut ctrl_rx).await?;
    if hello.token != args.token {
        send_json(&mut ctrl_tx, &HelloAck { ok: false, reason: Some("bad token".into()) }).await?;
        anyhow::bail!("bad token from {}", conn.remote_address());
    }
    send_json(&mut ctrl_tx, &HelloAck { ok: true, reason: None }).await?;
    info!("[quic-recv] authenticated transfer_id={} lanes={}", hello.transfer_id, hello.lanes);

    // Receive control messages + data streams concurrently
    let out_dir = args.out_dir.clone();
    let transfer_id = hello.transfer_id.clone();
    let lanes = hello.lanes as usize;

    // Spawn data stream consumers
    let mut data_handles: Vec<tokio::task::JoinHandle<Result<()>>> = Vec::new();
    for _ in 0..lanes {
        let out = out_dir.clone();
        let conn2 = conn.clone();
        data_handles.push(tokio::spawn(async move {
            let mut stream = conn2.accept_uni().await?;
            receive_data_stream(&mut stream, &out).await
        }));
    }

    // Drive control stream (quinn's own read_to_end with size limit)
    let buf = ctrl_rx.read_to_end(16 * 1024 * 1024).await?;
    for line in buf.split(|&b| b == b'\n').filter(|l| !l.is_empty()) {
        let msg: serde_json::Value = serde_json::from_slice(line).unwrap_or_default();
        let t = msg["type"].as_str().unwrap_or("");
        match t {
            "complete" => {
                info!("[quic-recv] transfer complete");
                break;
            }
            "file-end" => {
                info!(
                    "[quic-recv] file {} sha={}",
                    msg["fileId"],
                    msg["sha256"].as_str().unwrap_or("")
                );
            }
            _ => {}
        }
    }

    // Wait for data streams
    for h in data_handles { h.await??; }
    conn.close(0u32.into(), b"done");
    Ok(())
}

async fn receive_data_stream(
    stream: &mut quinn::RecvStream,
    out_dir: &PathBuf,
) -> Result<()> {
    let header_size = 16usize;
    let mut files: HashMap<u32, (tokio::fs::File, IncrementalHasher)> = HashMap::new();
    let mut pending: Vec<u8> = Vec::new();

    loop {
        let mut tmp = vec![0u8; 64 * 1024 + header_size];
        match stream.read(&mut tmp).await? {
            None => break,
            Some(n) => {
                pending.extend_from_slice(&tmp[..n]);
            }
        }
        // Process all complete frames from pending buffer
        while pending.len() >= header_size {
            let payload_len = u32::from_le_bytes(pending[12..16].try_into().unwrap()) as usize;
            let frame_len = header_size + payload_len;
            if pending.len() < frame_len { break; }
            let frame_bytes = pending[..frame_len].to_vec();
            pending.drain(..frame_len);

            let decoded = decode_frame(&frame_bytes)
                .map_err(|e| anyhow::anyhow!("frame decode: {e}"))?;

            let entry = if let Some(e) = files.get_mut(&decoded.file_id) {
                e
            } else {
                // Lazy-create output file
                let path = out_dir.join(format!("file-{}.bin", decoded.file_id));
                let f = tokio::fs::OpenOptions::new()
                    .write(true).create(true).truncate(true)
                    .open(&path).await?;
                files.insert(decoded.file_id, (f, IncrementalHasher::new()));
                files.get_mut(&decoded.file_id).unwrap()
            };

            // positional write
            use tokio::io::AsyncSeekExt;
            let offset = decoded.chunk_index as u64 * 64 * 1024; // must match sender chunk_size
            entry.0.seek(std::io::SeekFrom::Start(offset)).await?;
            entry.0.write_all(decoded.payload).await?;
            entry.1.update(decoded.payload);
        }
    }
    Ok(())
}
