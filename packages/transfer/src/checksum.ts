/** Streaming SHA-256 with WebCrypto-only fallback to incremental Node crypto. */

export interface IncrementalHash {
  update(b: Uint8Array): void;
  digestHex(): Promise<string>;
}

export async function makeSha256(): Promise<IncrementalHash> {
  // WebCrypto (browser + Bun + modern Node) doesn't expose incremental hashing,
  // so we use Node's `crypto` if available — this module is deliberately
  // isomorphic and async-tolerant.
  try {
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256");
    return {
      update(b) {
        h.update(b);
      },
      async digestHex() {
        return h.digest("hex");
      },
    };
  } catch {
    // Fallback: buffer everything. Slow for large files but correct in pure browser.
    const parts: Uint8Array[] = [];
    return {
      update(b) {
        parts.push(b);
      },
      async digestHex() {
        let total = 0;
        for (const p of parts) total += p.byteLength;
        const merged = new Uint8Array(total);
        let off = 0;
        for (const p of parts) {
          merged.set(p, off);
          off += p.byteLength;
        }
        const buf = await crypto.subtle.digest("SHA-256", merged);
        return [...new Uint8Array(buf)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      },
    };
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
