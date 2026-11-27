import { describe, expect, test } from "bun:test";
import { parseClientMsg } from "../../../packages/protocol/src/index.ts";
import { Hub, type HubSocket } from "../src/hub.ts";
import { Stats, statsHeaders, utcDay } from "../src/stats.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

describe("Stats counters", () => {
  test("counts per UTC day and keeps all-time totals", () => {
    let now = T0;
    const s = new Stats(() => now);
    s.roomCreated();
    s.roomPaired();
    s.transfer(1000, 2, "direct");
    now += DAY;
    s.transfer(500, 1, "relay");
    s.transfer(10, 1, "lan");

    const snap = s.snapshot();
    expect(snap.today).toMatchObject({ date: utcDay(now), transfers: 2, bytes: 510, files: 2, relay: 1, lan: 1, direct: 0 });
    expect(snap.allTime).toMatchObject({ transfers: 3, bytes: 1510, files: 4, direct: 1, relay: 1, lan: 1, roomsCreated: 1, roomsPaired: 1, since: utcDay(T0) });
    expect(snap.last30Days).toHaveLength(30);
    expect(snap.last30Days.at(-1)).toEqual({ date: utcDay(now), transfers: 2, bytes: 510 });
    expect(snap.last30Days.at(-2)).toEqual({ date: utcDay(T0), transfers: 1, bytes: 1000 });
    expect(snap.last30Days[0]).toEqual({ date: utcDay(now - 29 * DAY), transfers: 0, bytes: 0 });
  });

  test("dirty days round-trip through load (persist → restart)", () => {
    const changes: number[] = [];
    const a = new Stats(() => T0, () => changes.push(1));
    a.transfer(42, 1, "lan");
    expect(changes.length).toBe(1);
    const rows = a.takeDirty();
    expect(rows).toHaveLength(1);
    expect(a.takeDirty()).toHaveLength(0);

    const b = new Stats(() => T0);
    b.load(rows);
    b.transfer(8, 1, "direct");
    expect(b.snapshot().allTime).toMatchObject({ transfers: 2, bytes: 50, lan: 1, direct: 1 });
    expect(b.takeDirty()[0]).toMatchObject({ transfers: 2, bytes: 50 });
  });

  test("load ignores bad dates and bad numbers", () => {
    const s = new Stats(() => T0);
    s.load([
      { date: "nope", roomsCreated: 1, roomsPaired: 1, transfers: 9, bytes: 9, files: 9, direct: 9, lan: 0, relay: 0 },
      { date: "2026-11-01", roomsCreated: -5, roomsPaired: Number.NaN, transfers: 3, bytes: 7, files: 3, direct: 3, lan: 0, relay: 0 },
    ]);
    expect(s.snapshot().allTime).toMatchObject({ transfers: 3, bytes: 7, roomsCreated: 0, roomsPaired: 0, since: "2026-11-01" });
  });

  test("CORS: * without an allow-list, echo only allowed origins", () => {
    expect(statsHeaders([], "https://x.test")["access-control-allow-origin"]).toBe("*");
    expect(statsHeaders(["https://a.test"], "https://a.test")["access-control-allow-origin"]).toBe("https://a.test");
    expect(statsHeaders(["https://a.test"], "https://evil.test")["access-control-allow-origin"]).toBeUndefined();
    expect(statsHeaders([], null)["cache-control"]).toBe("public, max-age=60");
  });
});

describe("stats message validation", () => {
  const ok = { type: "stats", bytes: 100, files: 1, path: "direct" };
  test("accepts a well-formed report and strips extra fields", () => {
    expect(parseClientMsg({ ...ok, name: "secret.pdf" })).toEqual(ok as never);
  });
  test.each([
    ["bytes over 1 TiB", { ...ok, bytes: 2 ** 40 + 1 }],
    ["negative bytes", { ...ok, bytes: -1 }],
    ["fractional bytes", { ...ok, bytes: 1.5 }],
    ["bytes as string", { ...ok, bytes: "100" }],
    ["zero files", { ...ok, files: 0 }],
    ["too many files", { ...ok, files: 10_001 }],
    ["unknown path", { ...ok, path: "carrier-pigeon" }],
    ["missing path", { type: "stats", bytes: 1, files: 1 }],
  ])("rejects %s", (_name, msg) => {
    expect(parseClientMsg(msg)).toBeNull();
  });
});

describe("hub accepts stats only from a paired room, once", () => {
  const device = { deviceId: "d", name: "n", kind: "browser" };
  const opts = { maxRooms: 10, roomCapacity: 2, maxConnections: 100, maxConnectionsPerIp: 100 };
  let ipN = 0;
  function sock(hub: Hub): HubSocket & { inbox: Array<Record<string, unknown>> } {
    const inbox: Array<Record<string, unknown>> = [];
    const s = { ip: `10.0.0.${++ipN}`, inbox, send: (t: string) => inbox.push(JSON.parse(t)) };
    hub.onOpen(s);
    return s;
  }
  const report = JSON.stringify({ type: "stats", bytes: 1234, files: 3, path: "relay" });

  test("no room → ignored, no reply", () => {
    const hub = new Hub(opts);
    const a = sock(hub);
    hub.onMessage(a, report);
    expect(hub.statsSnapshot().allTime.transfers).toBe(0);
    expect(a.inbox).toHaveLength(0);
  });

  test("room created but never paired → ignored", () => {
    const hub = new Hub(opts);
    const a = sock(hub);
    hub.onMessage(a, JSON.stringify({ type: "create-room", device }));
    hub.onMessage(a, report);
    const snap = hub.statsSnapshot();
    expect(snap.allTime.transfers).toBe(0);
    expect(snap.allTime.roomsCreated).toBe(1);
    expect(snap.allTime.roomsPaired).toBe(0);
  });

  test("paired room → counted once; duplicates (either peer) ignored; forged values rejected", () => {
    const hub = new Hub(opts);
    const a = sock(hub);
    const b = sock(hub);
    hub.onMessage(a, JSON.stringify({ type: "create-room", device }));
    const code = a.inbox.find((m) => m.type === "room-created")!.code as string;
    hub.onMessage(b, JSON.stringify({ type: "join-room", roomIdOrCode: code, device }));

    hub.onMessage(a, JSON.stringify({ type: "stats", bytes: 2 ** 41, files: 1, path: "direct" }));
    expect(a.inbox.at(-1)).toMatchObject({ type: "error", code: "invalid-message" });
    expect(hub.statsSnapshot().allTime.transfers).toBe(0);

    hub.onMessage(a, report);
    hub.onMessage(a, report);
    hub.onMessage(b, report);
    const all = hub.statsSnapshot().allTime;
    expect(all).toMatchObject({ transfers: 1, bytes: 1234, files: 3, relay: 1, roomsCreated: 1, roomsPaired: 1 });
  });

  test("sender may report after the receiver already left (room stays paired)", () => {
    const hub = new Hub(opts);
    const a = sock(hub);
    const b = sock(hub);
    hub.onMessage(a, JSON.stringify({ type: "create-room", device }));
    const code = a.inbox.find((m) => m.type === "room-created")!.code as string;
    hub.onMessage(b, JSON.stringify({ type: "join-room", roomIdOrCode: code, device }));
    hub.onClose(b);
    hub.onMessage(a, report);
    expect(hub.statsSnapshot().allTime.transfers).toBe(1);
  });

  test("a socket that left its room can't report for it", () => {
    const hub = new Hub(opts);
    const a = sock(hub);
    const b = sock(hub);
    hub.onMessage(a, JSON.stringify({ type: "create-room", device }));
    const code = a.inbox.find((m) => m.type === "room-created")!.code as string;
    hub.onMessage(b, JSON.stringify({ type: "join-room", roomIdOrCode: code, device }));
    hub.onMessage(b, JSON.stringify({ type: "leave-room" }));
    hub.onMessage(b, report);
    expect(hub.statsSnapshot().allTime.transfers).toBe(0);
  });
});

describe("Stats saturation (audit)", () => {
  test("bytes never exceed MAX_SAFE_INTEGER and survive a reload", () => {
    const s = new Stats(() => T0);
    for (let i = 0; i < 9000; i++) s.transfer(2 ** 40, 1, "direct");
    const snap = s.snapshot();
    expect(snap.allTime.bytes).toBe(Number.MAX_SAFE_INTEGER);
    const b = new Stats(() => T0);
    b.load(s.takeDirty());
    expect(b.snapshot().allTime.bytes).toBe(Number.MAX_SAFE_INTEGER);
    b.load([{ date: "2026-01-01", roomsCreated: 0, roomsPaired: 0, transfers: 1, bytes: 2 ** 60, files: 1, direct: 1, lan: 0, relay: 0 }]);
    expect(b.snapshot().allTime.bytes).toBe(Number.MAX_SAFE_INTEGER);
  });
});
