/**
 * WASM-backed implementations of the hot-path crypto + frame operations.
 * Falls back silently to the pure-TS implementations if WASM isn't available
 * (e.g. old browsers without WebAssembly, or import resolution failures).
 *
 * Usage:
 *   const core = await loadCore();
 *   const hash = await core.sha256Hex(bytes);
 */

import {
  decodeFrame as tsDecodeFrame,
  encodeFrame as tsEncodeFrame,
  type FrameHeader,
} from "@dropbeam/protocol";
import { sha256Hex as tsSha256Hex, makeSha256 as tsMakeSha256 } from "./checksum.js";
import { encryptChunk as tsEncrypt, decryptChunk as tsDecrypt } from "./encryption.js";

export interface TransferCore {
  /** Encode a binary frame header + payload into a single Uint8Array. */
  encodeFrame(
    header: { fileId: number; chunkIndex: number; encrypted?: boolean; last?: boolean },
    payload: Uint8Array,
  ): Uint8Array;

  decodeFrame(buf: Uint8Array): { header: FrameHeader; payload: Uint8Array };

  sha256Hex(data: Uint8Array): Promise<string>;

  /** Returns a new incremental hasher. */
  makeHasher(): IncrementalHasher;

  /** Encrypt: returns IV(12) || ciphertext+tag. key must be 32 raw bytes. */
  encryptChunk(keyBytes: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;

  /** Decrypt IV(12) || ciphertext+tag → plaintext. */
  decryptChunk(keyBytes: Uint8Array, framed: Uint8Array): Promise<Uint8Array>;

  /** PBKDF2-HMAC-SHA256 (200k iterations) → raw 32-byte key. Sync. */
  pbkdf2DeriveSync(passphrase: Uint8Array, salt: Uint8Array): Uint8Array;

  readonly kind: "wasm" | "ts";
}

export interface IncrementalHasher {
  update(data: Uint8Array): void;
  finalizeHex(): Promise<string>;
}

// ─── WASM implementation ──────────────────────────────────────────────────

async function loadWasm(): Promise<TransferCore> {
  // Dynamic import so the bundle doesn't break if WASM isn't present.
  const wasm = await import("../../transfer-core/pkg/dropbeam_transfer_core.js" as string);
  await (wasm as { default?: () => Promise<void> }).default?.();

  return {
    kind: "wasm",

    encodeFrame(header, payload) {
      const raw = wasm.encode_frame(
        header.fileId,
        header.chunkIndex,
        payload,
        header.encrypted ?? false,
        header.last ?? false,
      ) as Uint8Array;
      return raw;
    },

    decodeFrame(buf) {
      const fileId = wasm.decode_frame_file_id(buf) as number;
      const chunkIndex = wasm.decode_frame_chunk_index(buf) as number;
      const encrypted = wasm.decode_frame_encrypted(buf) as boolean;
      const last = wasm.decode_frame_last(buf) as boolean;
      const payload = wasm.decode_frame_payload(buf) as Uint8Array;
      return {
        header: { fileId, chunkIndex, payloadLength: payload.byteLength, encrypted, last },
        payload,
      };
    },

    async sha256Hex(data) {
      return wasm.sha256_hex(data) as string;
    },

    makeHasher() {
      const h = new (wasm.Sha256Hasher as new () => {
        update(d: Uint8Array): void;
        finalize_hex(): string;
      })();
      return {
        update(data) { h.update(data); },
        async finalizeHex() { return h.finalize_hex(); },
      };
    },

    async encryptChunk(keyBytes, plaintext) {
      return wasm.aes_gcm_encrypt(keyBytes, plaintext) as Uint8Array;
    },

    async decryptChunk(keyBytes, framed) {
      return wasm.aes_gcm_decrypt(keyBytes, framed) as Uint8Array;
    },

    pbkdf2DeriveSync(passphrase, salt) {
      return wasm.pbkdf2_derive(passphrase, salt) as Uint8Array;
    },
  };
}

// ─── Pure-TS fallback ─────────────────────────────────────────────────────

function buildTsCore(): TransferCore {
  return {
    kind: "ts",

    encodeFrame(header, payload) {
      return tsEncodeFrame(
        {
          fileId: header.fileId,
          chunkIndex: header.chunkIndex,
          payloadLength: payload.byteLength,
          encrypted: header.encrypted,
          last: header.last,
        },
        payload,
      );
    },

    decodeFrame: tsDecodeFrame,

    async sha256Hex(data) { return tsSha256Hex(data); },

    makeHasher() {
      let hasher: Awaited<ReturnType<typeof tsMakeSha256>> | null = null;
      const init = tsMakeSha256().then((h) => { hasher = h; });
      return {
        update(data) { hasher ? hasher.update(data) : init.then(() => hasher!.update(data)); },
        async finalizeHex() { await init; return hasher!.digestHex(); },
      };
    },

    async encryptChunk(keyBytes, plaintext) {
      const key = await crypto.subtle.importKey("raw", keyBytes as unknown as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
      return tsEncrypt(key, plaintext);
    },

    async decryptChunk(keyBytes, framed) {
      const key = await crypto.subtle.importKey("raw", keyBytes as unknown as BufferSource, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      return tsDecrypt(key, framed);
    },

    pbkdf2DeriveSync(_p, _s) {
      throw new Error("pbkdf2DeriveSync not available in TS core — use async WebCrypto API");
    },
  };
}

// ─── Singleton loader ─────────────────────────────────────────────────────

let cached: TransferCore | null = null;

export async function loadCore(): Promise<TransferCore> {
  if (cached) return cached;
  try {
    cached = await loadWasm();
    return cached;
  } catch {
    cached = buildTsCore();
    return cached;
  }
}

/** Synchronously return TS core (useful for test environments without WASM). */
export function tsCore(): TransferCore { return buildTsCore(); }
