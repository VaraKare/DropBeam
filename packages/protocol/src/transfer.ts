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

/** Default chunk size — 64 KiB. Datachannel max message is ~256 KiB; we stay well under. */
export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** High-water mark before pausing reads to respect bufferedAmount. */
export const DEFAULT_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
export const DEFAULT_BUFFER_LOW_WATER = 1 * 1024 * 1024;

/** Number of parallel data lanes (datachannels) per session. */
export const DEFAULT_PARALLEL_LANES = 4;

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
}

export interface Manifest {
  type: "manifest";
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
  /** For resume: per-fileId, the next chunk index the receiver wants. */
  resumeFrom?: Record<number, number>;
  reason?: string;
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
  | TransferAbort
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
