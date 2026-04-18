use crate::DROPBEAM_MAGIC;
use crate::PROTOCOL_VERSION;

pub const FRAME_HEADER_SIZE: usize = 16;
pub const FLAG_ENCRYPTED: u8 = 0b0000_0001;
pub const FLAG_LAST: u8 = 0b0000_0010;

pub fn encode_frame(
    file_id: u32,
    chunk_index: u32,
    payload: &[u8],
    encrypted: bool,
    last: bool,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(FRAME_HEADER_SIZE + payload.len());
    let mut flags: u8 = 0;
    if encrypted { flags |= FLAG_ENCRYPTED; }
    if last      { flags |= FLAG_LAST; }
    out.push(DROPBEAM_MAGIC);
    out.push(PROTOCOL_VERSION);
    out.push(flags);
    out.push(0); // reserved
    out.extend_from_slice(&file_id.to_le_bytes());
    out.extend_from_slice(&chunk_index.to_le_bytes());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub struct DecodedFrame<'a> {
    pub file_id: u32,
    pub chunk_index: u32,
    pub payload_length: u32,
    pub encrypted: bool,
    pub last: bool,
    pub payload: &'a [u8],
}

pub fn decode_frame(buf: &[u8]) -> Result<DecodedFrame<'_>, String> {
    if buf.len() < FRAME_HEADER_SIZE {
        return Err(format!("frame too short: {}", buf.len()));
    }
    if buf[0] != DROPBEAM_MAGIC {
        return Err(format!("bad magic: 0x{:02x}", buf[0]));
    }
    if buf[1] != PROTOCOL_VERSION {
        return Err(format!("unsupported version: {}", buf[1]));
    }
    let flags = buf[2];
    let file_id = u32::from_le_bytes(buf[4..8].try_into().unwrap());
    let chunk_index = u32::from_le_bytes(buf[8..12].try_into().unwrap());
    let payload_length = u32::from_le_bytes(buf[12..16].try_into().unwrap());
    let end = FRAME_HEADER_SIZE + payload_length as usize;
    if end > buf.len() {
        return Err("frame payload length exceeds buffer".into());
    }
    Ok(DecodedFrame {
        file_id,
        chunk_index,
        payload_length,
        encrypted: (flags & FLAG_ENCRYPTED) != 0,
        last: (flags & FLAG_LAST) != 0,
        payload: &buf[FRAME_HEADER_SIZE..end],
    })
}
