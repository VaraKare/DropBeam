import { describe, expect, test } from "bun:test";
import { parseClientMsg } from "../../../packages/protocol/src/index.ts";
import { clientIp } from "../src/config.ts";

describe("clientIp (ADR-003)", () => {
  test("ignores X-Forwarded-For unless proxies are trusted (audit #11)", () => {
    expect(clientIp("198.51.100.1", "1.2.3.4", 0)).toBe("198.51.100.1");
  });
  test("with one trusted proxy, uses the right-most entry, not the spoofable left-most", () => {
    expect(clientIp("10.0.0.1", "6.6.6.6, 198.51.100.9", 1)).toBe("198.51.100.9");
  });
  test("with two trusted proxies, uses the second from the right", () => {
    expect(clientIp("10.0.0.1", "6.6.6.6, 198.51.100.9, 10.1.1.1", 2)).toBe("198.51.100.9");
  });
  test("falls back to the socket address when the chain is too short or missing", () => {
    expect(clientIp("10.0.0.1", "198.51.100.9", 2)).toBe("10.0.0.1");
    expect(clientIp("10.0.0.1", null, 1)).toBe("10.0.0.1");
    expect(clientIp(undefined, null, 0)).toBe("unknown");
  });
});

describe("parseClientMsg", () => {
  const device = { deviceId: "d", name: "n", kind: "browser" };
  test("strips unknown device fields", () => {
    const m = parseClientMsg({ type: "create-room", device: { ...device, evil: "x".repeat(10) } });
    expect(m as unknown).toEqual({ type: "create-room", device });
  });
  test("clamps TTL into [60 s, 4 h]", () => {
    expect(parseClientMsg({ type: "create-room", device, ttlSeconds: 1 })).toMatchObject({ ttlSeconds: 60 });
    expect(parseClientMsg({ type: "create-room", device, ttlSeconds: 1e9 })).toMatchObject({ ttlSeconds: 14_400 });
  });
  test("rejects non-finite TTL, bad kinds, oversized fields", () => {
    expect(parseClientMsg({ type: "create-room", device, ttlSeconds: "x" })).toBeNull();
    expect(parseClientMsg({ type: "create-room", device, ttlSeconds: Infinity })).toBeNull();
    expect(parseClientMsg({ type: "create-room", device: { ...device, kind: "toaster" } })).toBeNull();
    expect(parseClientMsg({ type: "join-room", device, roomIdOrCode: "x".repeat(65) })).toBeNull();
    expect(parseClientMsg({ type: "signal", to: "p" })).toBeNull();
    expect(parseClientMsg({ type: "nope" })).toBeNull();
    expect(parseClientMsg(null)).toBeNull();
  });
});
