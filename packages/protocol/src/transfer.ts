/**
 * Transfer protocol — runs on top of WebRTC datachannels between two
 * paired peers. Two channel kinds:
 *
 *   1. "control"  (ordered, reliable, JSON strings)
 *   2. "data-N"   (ordered, reliable, binary frames; N is the lane index)
 *
 * Files are split into chunks; each chunk is sent as one binary frame
 * on a data channel. The control channel carries manifest + lifecycle
 * + acks. Multiple data channels enable parallel lanes for throughput.
 */

import { DROPBEAM_MAGIC, PROTOCOL_VERSION } from "./index.js";

/**
 * Default chunk payload size: 64 KiB minus 64 bytes. A frame is the 16-byte
 * header + payload (+ 28 bytes IV/tag when encrypted), and the whole message
 * must fit in 64 KiB — the DataChannel max-message-size every WebRTC stack
 * guarantees when the peer doesn't advertise a larger one. A plain 64 KiB
 * payload overflowed that by 16–44 bytes.
 */
export const DEFAULT_CHUNK_SIZE = 64 * 1024 - 64;

/** High-water mark before pausing reads to respect bufferedAmount. */
export const DEFAULT_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
export const DEFAULT_BUFFER_LOW_WATER = 1 * 1024 * 1024;

/** Number of parallel data lanes (datachannels) per session. */
export const DEFAULT_PARALLEL_LANES = 4;

/** AES-GCM IV (12) + tag (16) added to each encrypted payload. */
export const ENCRYPTION_OVERHEAD = 28;

/**
 * Largest plaintext chunk a peer may announce: header + payload + encryption
 * overhead must still fit one 64 KiB DataChannel message.
 */
export const MAX_CHUNK_SIZE = 64 * 1024 - 16 - ENCRYPTION_OVERHEAD;

/**
 * Flow control (ADR-001). The receiver lets the sender have at most this many
 * encoded frame bytes in flight (sent but not yet written to disk), so its
 * memory stays bounded however fast the network or slow the disk.
 */
export const DEFAULT_FLOW_WINDOW = 16 * 1024 * 1024;
/** The receiver reports progress (a `credit`) at least every this many bytes. */
export const CREDIT_STEP = 1024 * 1024;
/**
 * Smallest window a receiver may advertise. Liveness needs
 * window − one max frame ≥ the credit step (window / 4), i.e. ≥ ~87 KiB.
 */
export const MIN_FLOW_WINDOW = 256 * 1024;

/** Manifest limits enforced by the receiver before it touches the disk. */
export const MAX_FILES_PER_TRANSFER = 10_000;
export const MAX_FILE_NAME_LENGTH = 1024;
export const MAX_RELATIVE_PATH_LENGTH = 4096;
export const MAX_LANES = 16;

// ─── control channel messages ─────────────────────────────────────────────

export interface FileEntry {
  /** Per-transfer file id; assigned by sender, 1..2^32-1. */
  id: number;
  name: string;
  size: number;
  /** Best-guess MIME; receiver may override. */
  mime?: string;
  /** SHA-256 of the full plaintext file, hex. Optional pre-compute. */
  sha256?: string;
  /** Relative path under the "transfer root" for folder uploads. */
  relativePath?: string;
  /**
   * Source file's last-modified time (ms since epoch). Part of the partial
   * file's identity so a re-send resumes but a different file never does.
   */
  lastModified?: number;
}

export interface Manifest {
  type: "manifest";
  /** Wire protocol version (PROTOCOL_VERSION). Absent = v1. */
  protocol?: number;
  transferId: string;
  files: FileEntry[];
  totalBytes: number;
  chunkSize: number;
  lanes: number;
  /** If present, payloads are AES-GCM(key) encrypted (key out-of-band). */
  encryption?: { algo: "aes-gcm-256"; salt: string };
  createdAt: number;
}

export interface ManifestAck {
  type: "manifest-ack";
  transferId: string;
  accept: boolean;
  /**
   * For resume: per-fileId, the number of leading bytes the receiver already
   * has. The sender restarts at the chunk containing that byte offset.
   */
  resumeFrom?: Record<number, number>;
  /** Flow-control window in encoded frame bytes (ADR-001). Required in v2. */
  window?: number;
  reason?: string;
}

/**
 * Receiver → sender flow control (ADR-001): cumulative encoded frame bytes
 * the receiver has finished processing (written, or deliberately skipped).
 */
export interface CreditMsg {
  type: "credit";
  transferId: string;
  consumed: number;
}

export interface FileStart {
  type: "file-start";
  transferId: string;
  fileId: number;
}

export interface FileEnd {
  type: "file-end";
  transferId: string;
  fileId: number;
  sha256: string;
}

export interface ChunkAck {
  type: "chunk-ack";
  transferId: string;
  fileId: number;
  chunkIndex: number;
}

export interface TransferComplete {
  type: "complete";
  transferId: string;
}

/**
 * Receiver → sender: every file has been fully written (and closed) on the
 * receiving side. The sender must not report success or tear down the
 * connection before this arrives — `file-end` / `complete` travel on the
 * control channel, which is *not* ordered with respect to the data lanes.
 */
export interface TransferCompleteAck {
  type: "complete-ack";
  transferId: string;
}

export interface TransferAbort {
  type: "abort";
  transferId: string;
  reason: string;
}

export interface PauseMsg {
  type: "pause";
  transferId: string;
}

export interface ResumeMsg {
  type: "resume";
  transferId: string;
}

/** Free-form chat sent over control channel during a transfer. */
export interface ChatMsg {
  type: "chat";
  transferId: string;
  from: string;
  text: string;
  at: number;
}

export type ControlMsg =
  | Manifest
  | ManifestAck
  | FileStart
  | FileEnd
  | ChunkAck
  | TransferComplete
  | TransferCompleteAck
  | TransferAbort
  | CreditMsg
  | PauseMsg
  | ResumeMsg
  | ChatMsg;

// ─── binary chunk frame format ────────────────────────────────────────────
//
// Fixed-size little-endian header (16 bytes):
//   [0]    u8   magic = 0xDB
//   [1]    u8   version
//   [2]    u8   flags  (bit0 = encrypted, bit1 = last-chunk-of-file)
//   [3]    u8   reserved
//   [4..8] u32  fileId
//   [8..12]u32  chunkIndex
//   [12..16]u32 payloadLength (bytes of payload that follow header)
//
// Payload: `payloadLength` bytes. If encrypted, the first 12 bytes of payload
// are the AES-GCM IV, followed by ciphertext+tag.

export const FRAME_HEADER_SIZE = 16;

export const FRAME_FLAG_ENCRYPTED = 0b0000_0001;
export const FRAME_FLAG_LAST = 0b0000_0010;

export interface FrameHeader {
  fileId: number;
  chunkIndex: number;
  payloadLength: number;
  encrypted: boolean;
  last: boolean;
}

export function encodeFrame(
  header: Omit<FrameHeader, "encrypted" | "last"> & {
    encrypted?: boolean;
    last?: boolean;
  },
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = DROPBEAM_MAGIC;
  out[1] = PROTOCOL_VERSION;
  let flags = 0;
  if (header.encrypted) flags |= FRAME_FLAG_ENCRYPTED;
  if (header.last) flags |= FRAME_FLAG_LAST;
  out[2] = flags;
  out[3] = 0;
  view.setUint32(4, header.fileId, true);
  view.setUint32(8, header.chunkIndex, true);
  view.setUint32(12, payload.byteLength, true);
  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

export function decodeFrame(buf: Uint8Array): {
  header: FrameHeader;
  payload: Uint8Array;
} {
  if (buf.byteLength < FRAME_HEADER_SIZE) {
    throw new Error(`frame too short: ${buf.byteLength}`);
  }
  if (buf[0] !== DROPBEAM_MAGIC) {
    throw new Error(`bad magic: 0x${buf[0]?.toString(16)}`);
  }
  if (buf[1] !== PROTOCOL_VERSION) {
    throw new Error(`unsupported version: ${buf[1]}`);
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[2] ?? 0;
  const fileId = view.getUint32(4, true);
  const chunkIndex = view.getUint32(8, true);
  const payloadLength = view.getUint32(12, true);
  if (FRAME_HEADER_SIZE + payloadLength > buf.byteLength) {
    throw new Error("frame payload length exceeds buffer");
  }
  return {
    header: {
      fileId,
      chunkIndex,
      payloadLength,
      encrypted: (flags & FRAME_FLAG_ENCRYPTED) !== 0,
      last: (flags & FRAME_FLAG_LAST) !== 0,
    },
    payload: buf.subarray(
      FRAME_HEADER_SIZE,
      FRAME_HEADER_SIZE + payloadLength,
    ),
  };
}
