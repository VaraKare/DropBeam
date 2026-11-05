/**
 * Runtime validation for everything that arrives from the network.
 *
 * TypeScript types are erased at runtime, so `JSON.parse(x) as T` trusts the
 * remote side completely. These hand-written guards are the trust boundary:
 * anything that fails them is dropped (control messages) or rejected with a
 * protocol error (manifests, signaling requests). Zero dependencies on purpose.
 */

import type {
  ClientToServerMsg,
  DeviceInfo,
  DeviceKind,
} from "./signaling.js";
import {
  MAX_CHUNK_SIZE,
  MAX_FILE_NAME_LENGTH,
  MAX_FILES_PER_TRANSFER,
  MAX_LANES,
  MAX_RELATIVE_PATH_LENGTH,
  type ControlMsg,
  type Manifest,
} from "./transfer.js";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const isSafeUint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optional = <T>(v: unknown, check: (x: unknown) => x is T): boolean => v === undefined || check(v);

const MAX_ID = 128;
const MAX_REASON = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ─── transfer control channel ─────────────────────────────────────────────

/**
 * Check a manifest before the receiver opens a single file. Returns a short
 * machine-readable reason, or null if it is acceptable.
 */
export function validateManifest(m: Manifest): string | null {
  if (!isStr(m.transferId, MAX_ID, 1)) return "bad-manifest: transferId";
  if (!Array.isArray(m.files)) return "bad-manifest: files";
  if (m.files.length > MAX_FILES_PER_TRANSFER) return "bad-manifest: too many files";
  if (!isSafeUint(m.chunkSize) || m.chunkSize < 1 || m.chunkSize > MAX_CHUNK_SIZE) {
    return "bad-manifest: chunkSize";
  }
  if (!isSafeUint(m.lanes) || m.lanes < 1 || m.lanes > MAX_LANES) return "bad-manifest: lanes";
  if (!isSafeUint(m.totalBytes)) return "bad-manifest: totalBytes";
  if (m.encryption !== undefined) {
    if (!isObj(m.encryption) || m.encryption.algo !== "aes-gcm-256" || !isStr(m.encryption.salt, 64, 1)) {
      return "bad-manifest: encryption";
    }
  }
  const ids = new Set<number>();
  let sum = 0;
  for (const f of m.files as unknown[]) {
    if (!isObj(f)) return "bad-manifest: file entry";
    if (!isSafeUint(f.id) || f.id > 0xffff_ffff) return "bad-manifest: file id";
    if (ids.has(f.id)) return "bad-manifest: duplicate file id";
    ids.add(f.id);
    if (!isStr(f.name, MAX_FILE_NAME_LENGTH, 1)) return "bad-manifest: file name";
    if (!isSafeUint(f.size)) return "bad-manifest: file size";
    // Chunk index is a u32 on the wire; the file must be addressable.
    if (Math.ceil(f.size / m.chunkSize) > 0xffff_ffff) return "bad-manifest: file too large";
    if (!optional(f.mime, (x): x is string => isStr(x, 255))) return "bad-manifest: mime";
    if (!optional(f.relativePath, (x): x is string => isStr(x, MAX_RELATIVE_PATH_LENGTH))) {
      return "bad-manifest: relativePath";
    }
    if (!optional(f.lastModified, isSafeUint)) return "bad-manifest: lastModified";
    if (!optional(f.sha256, (x): x is string => typeof x === "string" && SHA256_HEX.test(x))) {
      return "bad-manifest: sha256";
    }
    sum += f.size;
    if (!Number.isSafeInteger(sum)) return "bad-manifest: totalBytes";
  }
  if (sum !== m.totalBytes) return "bad-manifest: totalBytes mismatch";
  return null;
}

/**
 * Parse one control-channel text message. Returns null for anything that is
 * not well-formed JSON of a known type with correctly typed fields. Manifest
 * *contents* are checked separately by `validateManifest` so the receiver can
 * answer with a reason instead of silently ignoring it.
 */
export function parseControlMsg(text: string): ControlMsg | null {
  if (text.length > 4 * 1024 * 1024) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v) || !isStr(v.transferId, MAX_ID, 1)) return null;
  switch (v.type) {
    case "manifest":
      if (!Array.isArray(v.files) || !optional(v.protocol, isSafeUint)) return null;
      return v as unknown as ControlMsg;
    case "manifest-ack": {
      if (typeof v.accept !== "boolean") return null;
      if (!optional(v.reason, (x): x is string => isStr(x, MAX_REASON))) return null;
      if (!optional(v.window, isSafeUint)) return null;
      if (v.resumeFrom !== undefined) {
        if (!isObj(v.resumeFrom)) return null;
        for (const [k, off] of Object.entries(v.resumeFrom)) {
          if (!/^\d+$/.test(k) || !isSafeUint(off)) return null;
        }
      }
      return v as unknown as ControlMsg;
    }
    case "file-start":
      return isSafeUint(v.fileId) ? (v as unknown as ControlMsg) : null;
    case "file-end":
      return isSafeUint(v.fileId) && typeof v.sha256 === "string" && SHA256_HEX.test(v.sha256)
        ? (v as unknown as ControlMsg)
        : null;
    case "credit":
      return isSafeUint(v.consumed) ? (v as unknown as ControlMsg) : null;
    case "complete":
    case "complete-ack":
    case "pause":
    case "resume":
      return v as unknown as ControlMsg;
    case "abort":
      return isStr(v.reason, MAX_REASON) ? (v as unknown as ControlMsg) : null;
    default:
      return null;
  }
}

// ─── signaling (client → server) ──────────────────────────────────────────

const DEVICE_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>([
  "browser", "ios", "android", "macos", "windows", "linux", "node", "unknown",
]);

export const SIGNALING_LIMITS = {
  deviceId: 64,
  deviceName: 64,
  userAgent: 256,
  code: 64,
  peerId: 64,
  minTtlSeconds: 60,
  maxTtlSeconds: 4 * 60 * 60,
} as const;

function parseDevice(v: unknown): DeviceInfo | null {
  if (!isObj(v)) return null;
  if (!isStr(v.deviceId, SIGNALING_LIMITS.deviceId, 1)) return null;
  if (!isStr(v.name, SIGNALING_LIMITS.deviceName)) return null;
  if (typeof v.kind !== "string" || !DEVICE_KINDS.has(v.kind as DeviceKind)) return null;
  if (!optional(v.userAgent, (x): x is string => isStr(x, SIGNALING_LIMITS.userAgent))) return null;
  // Rebuild so unknown extra fields are never stored or forwarded to peers.
  const d: DeviceInfo = { deviceId: v.deviceId, name: v.name, kind: v.kind as DeviceKind };
  if (v.userAgent !== undefined) d.userAgent = v.userAgent as string;
  return d;
}

/**
 * Strictly parse a client → server signaling message. Returns null if any
 * field is missing, mistyped or out of bounds. The result is a fresh object
 * containing only known fields.
 */
export function parseClientMsg(v: unknown): ClientToServerMsg | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case "create-room": {
      const device = parseDevice(v.device);
      if (!device) return null;
      if (v.ttlSeconds === undefined) return { type: "create-room", device };
      if (!isFiniteNum(v.ttlSeconds)) return null;
      const ttl = Math.min(
        SIGNALING_LIMITS.maxTtlSeconds,
        Math.max(SIGNALING_LIMITS.minTtlSeconds, Math.floor(v.ttlSeconds)),
      );
      return { type: "create-room", device, ttlSeconds: ttl };
    }
    case "join-room": {
      const device = parseDevice(v.device);
      if (!device || !isStr(v.roomIdOrCode, SIGNALING_LIMITS.code, 1)) return null;
      return { type: "join-room", roomIdOrCode: v.roomIdOrCode, device };
    }
    case "signal":
      if (!isStr(v.to, SIGNALING_LIMITS.peerId, 1) || !("data" in v)) return null;
      return { type: "signal", to: v.to, data: v.data };
    case "leave-room":
      return { type: "leave-room" };
    case "ping":
      return isFiniteNum(v.t) ? { type: "ping", t: v.t } : null;
    default:
      return null;
  }
}

/** @deprecated use parseClientMsg — kept for callers that only need a boolean. */
export function isClientMsg(v: unknown): v is ClientToServerMsg {
  return parseClientMsg(v) !== null;
}
