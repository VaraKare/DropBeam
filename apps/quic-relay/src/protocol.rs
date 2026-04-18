//! DropBeam QUIC session protocol.
//!
//! After the QUIC handshake, the sender opens:
//!   stream 0 (bidirectional): control JSON (manifest → ack → complete/abort)
//!   streams 1..N (unidirectional send): one per lane, binary frames
//!
//! Frame format is identical to the WebRTC datachannel format so the same
//! frame codec crate works for both transports.

use serde::{Deserialize, Serialize};

/// Sent by sender immediately after connection, before manifest.
#[derive(Serialize, Deserialize, Debug)]
pub struct Hello {
    /// Must match the room token from the signaling server.
    pub token: String,
    pub transfer_id: String,
    pub lanes: u8,
}

/// Sent by receiver after verifying token.
#[derive(Serialize, Deserialize, Debug)]
pub struct HelloAck {
    pub ok: bool,
    pub reason: Option<String>,
}

pub fn write_len_prefixed(buf: &mut Vec<u8>, msg: &[u8]) {
    let len = msg.len() as u32;
    buf.extend_from_slice(&len.to_le_bytes());
    buf.extend_from_slice(msg);
}

pub async fn send_json<T: Serialize>(
    stream: &mut quinn::SendStream,
    msg: &T,
) -> anyhow::Result<()> {
    use tokio::io::AsyncWriteExt;
    let bytes = serde_json::to_vec(msg)?;
    let len = bytes.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

pub async fn recv_json<T: for<'de> Deserialize<'de>>(
    stream: &mut quinn::RecvStream,
) -> anyhow::Result<T> {
    use tokio::io::AsyncReadExt;
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    anyhow::ensure!(len < 1024 * 1024, "control message too large: {len}");
    let mut buf = vec![0u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(serde_json::from_slice(&buf)?)
}
