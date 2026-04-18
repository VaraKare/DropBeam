import { describe, expect, test } from "bun:test";
import { makeRoomCode, normalizeCode } from "../src/codes.ts";

describe("room codes", () => {
  test("makeRoomCode matches XX-XXX-XXXX-ish format", () => {
    const c = makeRoomCode();
    expect(c).toMatch(/^[0-9A-Z]{2}-[0-9A-Z]{3}-[0-9A-Z]{4}$/);
  });

  test("normalizeCode strips dashes/lowercase/whitespace", () => {
    expect(normalizeCode(" k7-9p3-mx2a ")).toBe("K79P3MX2A");
    expect(normalizeCode("K7 9P3 MX2A")).toBe("K79P3MX2A");
  });

  test("two codes are different", () => {
    const a = makeRoomCode();
    const b = makeRoomCode();
    expect(a).not.toBe(b);
  });
});
