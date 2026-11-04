/**
 * Streaming SHA-256.
 *
 * WebCrypto has no incremental digest API, and buffering a whole file to
 * call `crypto.subtle.digest` once would need RAM equal to the file size
 * (a 5 GB send would crash the tab). So browsers / workers use the small
 * pure-TS implementation below: constant memory, ~150–300 MB/s in V8,
 * comfortably faster than WebRTC can move bytes.
 *
 * Node / Bun use `node:crypto` (native, faster). The import specifier is
 * kept in a variable so browser bundlers don't try to resolve it.
 */

export interface IncrementalHash {
  update(b: Uint8Array): void;
  digestHex(): Promise<string>;
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Pure-TS incremental SHA-256 (FIPS 180-4). Exported for tests. */
export class Sha256 {
  private readonly h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  /** Total message length in bytes (safe up to 2^53). */
  private length = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("sha256: update after digest");
    this.length += data.byteLength;
    let i = 0;
    // Top up a partially-filled block first.
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.byteLength);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    // Whole blocks straight from the input, no copy.
    for (; i + 64 <= data.byteLength; i += 64) this.compress(data, i);
    if (i < data.byteLength) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.byteLength - i;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("sha256: digest called twice");
    this.finished = true;
    const bitLenHi = Math.floor(this.length / 0x20000000);
    const bitLenLo = (this.length * 8) >>> 0;
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen);
    const dv = new DataView(this.block.buffer);
    dv.setUint32(56, bitLenHi);
    dv.setUint32(60, bitLenLo);
    this.compress(this.block, 0);
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let j = 0; j < 8; j++) odv.setUint32(j * 4, this.h[j]!);
    return out;
  }

  private compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const p = off + t * 4;
      w[t] = (buf[p]! << 24) | (buf[p + 1]! << 16) | (buf[p + 2]! << 8) | buf[p + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    const h = this.h;
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }
}

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

type NodeHash = { update(b: Uint8Array): NodeHash; digest(enc: "hex"): string };
type NodeCrypto = { createHash(alg: "sha256"): NodeHash };

let nodeCrypto: Promise<NodeCrypto | null> | null = null;
function loadNodeCrypto(): Promise<NodeCrypto | null> {
  if (!nodeCrypto) {
    const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
    const spec = "node:crypto";
    nodeCrypto = isNode
      ? (import(/* @vite-ignore */ spec) as Promise<NodeCrypto>).catch(() => null)
      : Promise.resolve(null);
  }
  return nodeCrypto;
}

export async function makeSha256(): Promise<IncrementalHash> {
  const nc = await loadNodeCrypto();
  if (nc) {
    const h = nc.createHash("sha256");
    return {
      update(b) {
        h.update(b);
      },
      async digestHex() {
        return h.digest("hex");
      },
    };
  }
  const h = new Sha256();
  return {
    update(b) {
      h.update(b);
    },
    async digestHex() {
      return toHex(h.digest());
    },
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await makeSha256();
  h.update(bytes);
  return h.digestHex();
}

/** Hash an async stream of chunks with constant memory. */
export async function sha256OfStream(
  stream: AsyncIterable<Uint8Array>,
  onProgress?: (bytesDone: number) => void,
): Promise<string> {
  const h = await makeSha256();
  let done = 0;
  for await (const chunk of stream) {
    h.update(chunk);
    done += chunk.byteLength;
    onProgress?.(done);
  }
  return h.digestHex();
}
