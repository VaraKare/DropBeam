import { describe, expect, test } from "bun:test";
import { decideRoute } from "../src/router.ts";

describe("decideRoute", () => {
  test("loopback wins when same host", () => {
    expect(
      decideRoute({
        sameHost: true,
        sameLan: true,
        directReachable: true,
        nearbyAvailable: true,
        needsRelay: false,
      }).transport,
    ).toBe("loopback");
  });

  test("LAN preferred for nearby hint", () => {
    const r = decideRoute(
      { sameHost: false, sameLan: true, directReachable: true, nearbyAvailable: false, needsRelay: false },
      { preferred: "nearby" },
    );
    expect(r.transport).toBe("lan");
  });

  test("relay always when needsRelay", () => {
    const r = decideRoute({
      sameHost: false,
      sameLan: false,
      directReachable: false,
      nearbyAvailable: false,
      needsRelay: true,
    });
    expect(r.transport).toBe("p2p-relayed");
    expect(r.appLayerEncryption).toBe(true);
  });

  test("p2p-direct when reachable and no relay needed", () => {
    const r = decideRoute({
      sameHost: false,
      sameLan: false,
      directReachable: true,
      nearbyAvailable: false,
      needsRelay: false,
    });
    expect(r.transport).toBe("p2p-direct");
  });

  test("bulk hint bumps lanes + chunk size", () => {
    const r = decideRoute(
      {
        sameHost: false,
        sameLan: false,
        directReachable: true,
        nearbyAvailable: false,
        needsRelay: false,
      },
      { preferred: "bulk" },
    );
    expect(r.lanes).toBeGreaterThan(4);
    expect(r.chunkSize).toBeGreaterThan(64 * 1024);
  });

  test("vault hint enables app-layer encryption on LAN", () => {
    const r = decideRoute(
      { sameHost: false, sameLan: true, directReachable: true, nearbyAvailable: false, needsRelay: false },
      { preferred: "vault" },
    );
    expect(r.appLayerEncryption).toBe(true);
  });
});
