import { describe, expect, test } from "bun:test";
import { isPrivateAddress, parseCandidate, sameNetwork } from "../src/ice.js";

describe("parseCandidate", () => {
  test("reads address and type", () => {
    expect(parseCandidate("candidate:1 1 udp 2122260223 a148-c9.local 57780 typ host generation 0")).toEqual({ address: "a148-c9.local", type: "host" });
    expect(parseCandidate("a=candidate:2 1 udp 1686052607 86.29.10.20 63729 typ srflx raddr 0.0.0.0 rport 0")).toEqual({ address: "86.29.10.20", type: "srflx" });
    expect(parseCandidate("candidate:3 1 udp 41885439 2a00:1450::1 3478 typ relay")?.type).toBe("relay");
  });
  test("garbage is ignored", () => {
    expect(parseCandidate("")).toBeNull();
    expect(parseCandidate("candidate:1 1 udp 5 1.2.3.4 9")).toBeNull();
  });
});

describe("Same Wi-Fi network guard", () => {
  const own = new Set(["86.29.10.20"]);
  test("private, link-local, CGNAT, ULA and mDNS addresses count as local", () => {
    for (const a of ["10.0.0.5", "192.168.1.9", "172.16.0.1", "172.31.255.1", "169.254.3.3", "100.64.0.1", "127.0.0.1", "fd12::1", "fe80::1", "x.local"]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
  });
  test("public addresses are not local", () => {
    for (const a of ["86.29.10.20", "172.32.0.1", "100.128.0.1", "8.8.8.8", "2a00:1450::1"]) {
      expect(isPrivateAddress(a)).toBe(false);
    }
  });
  test("our own router's public address is the same network", () => {
    expect(sameNetwork("86.29.10.20", own)).toBe(true);
  });
  test("another network's public address is refused", () => {
    expect(sameNetwork("81.2.3.4", own)).toBe(false);
    expect(sameNetwork("81.2.3.4", new Set())).toBe(false);
  });
});
