/**
 * The QR encoder is verified by an independent decoder (jsQR), not by
 * snapshots: a snapshot of a wrong symbol is still wrong (audit #5).
 */

import { describe, expect, test } from "bun:test";
import jsQR from "jsqr";
import { encodeQr, qrToSvg, type QrMatrix } from "../src/qr.ts";

/** Rasterize with a 4-module quiet zone at `scale` px per module. */
function rasterize(q: QrMatrix, scale = 4, quiet = 4): { data: Uint8ClampedArray; width: number; height: number } {
  const n = (q.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.modules[y]![x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx;
          data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, width: n, height: n };
}

function decode(text: string): { version: number; decoded: string | null } {
  const q = encodeQr(text);
  const img = rasterize(q);
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
  return { version: (q.size - 17) / 4, decoded: r ? r.data : null };
}

// Byte-mode capacities at ECC level M for versions 1..10.
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

describe("QR encoder (decoded by jsQR)", () => {
  test("share codes and join links decode exactly", () => {
    for (const text of [
      "K7-9P3-MX2A",
      "https://dropbeam.com/?c=K7-9P3-MX2A",
      "http://192.168.1.20:5173/?c=AB-CDE-FGHJ",
    ]) {
      expect(decode(text).decoded).toBe(text);
    }
  });

  test("every version 1–10 decodes at its smallest and largest payload", () => {
    const seen = new Set<number>();
    let prev = 0;
    for (const cap of CAPACITY_M) {
      for (const len of [prev + 1, cap]) {
        const text = Array.from({ length: len }, (_, i) => "ABCDEFGHJKMNPQRSTVWXYZ0123456789-/?=."[i % 37]).join("");
        const r = decode(text);
        seen.add(r.version);
        expect({ len, version: r.version, ok: r.decoded === text }).toEqual({ len, version: r.version, ok: true });
      }
      prev = cap;
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("Unicode (UTF-8 bytes) round-trips", () => {
    const text = "https://dropbeam.com/?n=Café-日本-🚀";
    expect(decode(text).decoded).toBe(text);
  });

  test("payloads beyond version 10 are refused, not silently corrupted", () => {
    expect(() => encodeQr("x".repeat(214))).toThrow(/too long/);
  });

  test("SVG output has the standard 4-module quiet zone", () => {
    const q = encodeQr("K7-9P3-MX2A");
    const svg = qrToSvg(q);
    expect(svg).toContain(`viewBox="0 0 ${q.size + 8} ${q.size + 8}"`);
  });
});
