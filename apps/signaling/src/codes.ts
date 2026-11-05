/**
 * Ids, tokens and human room codes. Uses only Web Crypto
 * (`crypto.getRandomValues`), so the same code runs on Bun and on
 * Cloudflare Workers without Node compatibility shims.
 */

/** Base32 (Crockford) without I, L, O, U for human input. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makeRoomId(): string {
  // 128-bit URL-safe id.
  return base64url(randomBytes(16));
}

export function makePeerId(): string {
  return base64url(randomBytes(8));
}

export function makeToken(): string {
  return base64url(randomBytes(24));
}

/**
 * Short human code, e.g. "K7-9P3-MX2A". 9 alphabet chars (~45 bits) is enough
 * entropy for ephemeral rooms with brute-force protection from rate limiting.
 * 256 is a multiple of 32, so `byte % 32` is unbiased.
 */
export function makeRoomCode(): string {
  const bytes = randomBytes(9);
  let out = "";
  for (let i = 0; i < 9; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i === 1 || i === 4) out += "-";
  }
  return out;
}

/** Normalize user-typed codes: uppercase, strip spaces/dashes. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}
