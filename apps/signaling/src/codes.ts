import { randomBytes } from "node:crypto";

/** Base32 (Crockford) without I, L, O, U for human input. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function makeRoomId(): string {
  // 128-bit URL-safe id.
  return randomBytes(16).toString("base64url");
}

export function makePeerId(): string {
  return randomBytes(8).toString("base64url");
}

export function makeToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Short human code, e.g. "K7-9P3-MX2". 9 alphabet chars (~45 bits) is enough
 * entropy for ephemeral rooms with brute-force protection from rate limiting.
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
