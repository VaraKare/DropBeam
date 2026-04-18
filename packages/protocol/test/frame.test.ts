import { describe, expect, test } from "bun:test";
import {
  decodeFrame,
  encodeFrame,
  FRAME_FLAG_ENCRYPTED,
  FRAME_FLAG_LAST,
  FRAME_HEADER_SIZE,
} from "../src/transfer.ts";

describe("frame codec", () => {
  test("round-trips header + payload", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const enc = encodeFrame(
      { fileId: 7, chunkIndex: 42, payloadLength: payload.byteLength, encrypted: true, last: true },
      payload,
    );
    expect(enc.byteLength).toBe(FRAME_HEADER_SIZE + payload.byteLength);
    const { header, payload: out } = decodeFrame(enc);
    expect(header.fileId).toBe(7);
    expect(header.chunkIndex).toBe(42);
    expect(header.payloadLength).toBe(5);
    expect(header.encrypted).toBe(true);
    expect(header.last).toBe(true);
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
  });

  test("flags default to false", () => {
    const enc = encodeFrame(
      { fileId: 1, chunkIndex: 0, payloadLength: 0 },
      new Uint8Array(),
    );
    const { header } = decodeFrame(enc);
    expect(header.encrypted).toBe(false);
    expect(header.last).toBe(false);
  });

  test("rejects bad magic", () => {
    const buf = new Uint8Array(FRAME_HEADER_SIZE + 1);
    buf[0] = 0xff;
    buf[1] = 1;
    expect(() => decodeFrame(buf)).toThrow(/magic/);
  });

  test("rejects truncated frame", () => {
    expect(() => decodeFrame(new Uint8Array(4))).toThrow(/too short/);
  });

  test("flag bits independent", () => {
    const enc = encodeFrame(
      { fileId: 1, chunkIndex: 0, payloadLength: 0, encrypted: true, last: false },
      new Uint8Array(),
    );
    expect(enc[2]! & FRAME_FLAG_ENCRYPTED).toBe(FRAME_FLAG_ENCRYPTED);
    expect(enc[2]! & FRAME_FLAG_LAST).toBe(0);
  });
});
