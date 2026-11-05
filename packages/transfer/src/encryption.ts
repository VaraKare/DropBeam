/**
 * Optional application-layer encryption (AES-GCM-256). Off by default —
 * WebRTC's DTLS already encrypts in transit. Use this when you also
 * distrust the relay/TURN provider, or for sender-pre-encrypted blobs.
 *
 * Key is derived (PBKDF2) from a passphrase + 16-byte salt. The salt is
 * sent in the `Manifest`; the passphrase is shared out-of-band (room code +
 * extra secret).
 */

const PBKDF2_ITERATIONS = 200_000;

export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    // Web Crypto only exists on https:// or localhost pages.
    throw new Error("passphrase-unavailable: passphrase encryption needs the page to be opened over https://");
  }
  const salt = base64ToBytes(saltB64);
  const km = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    km,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function randomSaltB64(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return bytesToBase64(buf);
}

/**
 * Associated data binding a chunk to its exact position (protocol v2). A chunk
 * moved to another file, index or transfer fails authentication instead of
 * being written in the wrong place.
 */
export function chunkAad(transferId: string, fileId: number, chunkIndex: number): Uint8Array {
  return new TextEncoder().encode(`dropbeam/v2|${transferId}|${fileId}|${chunkIndex}`);
}

/** Encrypt one chunk; returns IV(12) || ciphertext+tag. */
export async function encryptChunk(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as unknown as BufferSource };
  if (aad) params.additionalData = aad as unknown as BufferSource;
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(params, key, plaintext as unknown as BufferSource),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decryptChunk(key: CryptoKey, framed: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (framed.byteLength < 28) throw new Error("encrypted chunk too short");
  const iv = framed.subarray(0, 12);
  const ct = framed.subarray(12);
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as unknown as BufferSource };
  if (aad) params.additionalData = aad as unknown as BufferSource;
  const pt = await crypto.subtle.decrypt(params, key, ct as unknown as BufferSource);
  return new Uint8Array(pt);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(b: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
