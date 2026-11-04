import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Sha256 } from "../src/checksum.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ref = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("pure-TS streaming SHA-256", () => {
  test("known vectors", () => {
    expect(hex(new Sha256().digest())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(new Sha256().update(new TextEncoder().encode("abc")).digest())).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("matches node:crypto across block boundaries", () => {
    for (const len of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 65_536, 100_003]) {
      const data = randomBytes(len);
      expect(hex(new Sha256().update(data).digest())).toBe(ref(data));
    }
  });

  test("result is independent of how the input is split", () => {
    const data = randomBytes(300_001);
    for (const step of [1, 3, 63, 64, 65, 4096, 65_472]) {
      const h = new Sha256();
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, i + step));
      expect(hex(h.digest())).toBe(ref(data));
    }
  });
});
