/**
 * End-to-end integration test for the signaling server.
 * Boots a server on a random port, then drives two clients through
 * create-room → join-room → signal relay → leave.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type {
  DeviceInfo,
  RoomCreatedMsg,
  RoomJoinedMsg,
  ServerToClientMsg,
} from "../../../packages/protocol/src/index.ts";

let serverModule: { server: { stop(): void; port?: number } };
let url: string;

beforeAll(async () => {
  process.env.PORT = String(await getFreePort());
  // Behave as if behind one trusted proxy so each test client can present
  // its own address via X-Forwarded-For (ADR-003).
  process.env.TRUST_PROXY_HOPS = "1";
  process.env.MAX_CONNECTIONS_PER_IP = "8";
  serverModule = await import("../src/server.ts");
  if (!serverModule.server.port) throw new Error("test server did not expose a port");
  url = `ws://localhost:${serverModule.server.port}/ws`;
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => {
  serverModule?.server.stop();
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no test port assigned")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function client(ip = freshIp()): {
  ws: WebSocket;
  ready: Promise<void>;
  next: <T extends ServerToClientMsg>(pred: (m: ServerToClientMsg) => m is T) => Promise<T>;
  send: (m: object) => void;
  close: () => void;
} {
  // Bun's WebSocket accepts request headers (not part of the DOM typings).
  const ws = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(url, {
    headers: { "x-forwarded-for": `203.0.113.7, ${ip}` },
  });
  const queue: ServerToClientMsg[] = [];
  const waiters: Array<(m: ServerToClientMsg) => boolean> = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data as string) as ServerToClientMsg;
    queue.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!(m)) waiters.splice(i, 1);
    }
  });
  const ready = new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
  return {
    ws,
    ready,
    next<T extends ServerToClientMsg>(pred: (m: ServerToClientMsg) => m is T): Promise<T> {
      const found = queue.find(pred);
      if (found) {
        queue.splice(queue.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise<T>((res) => {
        waiters.push((m) => {
          if (pred(m)) {
            res(m as T);
            queue.splice(queue.indexOf(m), 1);
            return true;
          }
          return false;
        });
      });
    },
    send(m) {
      ws.send(JSON.stringify(m));
    },
    close() {
      ws.close();
    },
  };
}

const device: DeviceInfo = {
  deviceId: "test-device",
  name: "test",
  kind: "node",
};

describe("signaling server", () => {
  test("health endpoint responds", async () => {
    const r = await fetch(`http://localhost:${serverModule.server.port}/healthz`);
    expect(r.ok).toBe(true);
    const j = (await r.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
  });

  test("create + join + relay", async () => {
    const a = client();
    await a.ready;
    a.send({ type: "create-room", device: { ...device, deviceId: "A" } });
    const created = await a.next((m): m is RoomCreatedMsg => m.type === "room-created");
    expect(created.code).toMatch(/^[0-9A-Z\-]+$/);

    const b = client();
    await b.ready;
    b.send({ type: "join-room", roomIdOrCode: created.code, device: { ...device, deviceId: "B" } });
    const joined = await b.next((m): m is RoomJoinedMsg => m.type === "room-joined");
    expect(joined.peers.length).toBe(1);
    expect(joined.peers[0]!.peerId).toBe(created.peerId);

    const aGotPeer = await a.next((m) => m.type === "peer-joined") as Extract<ServerToClientMsg, { type: "peer-joined" }>;
    expect(aGotPeer.peerId).toBe(joined.peerId);

    // signal relay A -> B
    a.send({ type: "signal", to: joined.peerId, data: { hello: "world" } });
    const relayed = await b.next((m) => m.type === "signal") as Extract<ServerToClientMsg, { type: "signal" }>;
    expect(relayed.from).toBe(created.peerId);
    expect((relayed.data as { hello: string }).hello).toBe("world");

    a.close();
    b.close();
  });

  test("join with bad code → room-not-found", async () => {
    const c = client();
    await c.ready;
    c.send({ type: "join-room", roomIdOrCode: "ZZ-ZZZ-ZZZZ", device });
    const err = await c.next((m) => m.type === "error") as Extract<ServerToClientMsg, { type: "error" }>;
    expect(err.code).toBe("room-not-found");
    c.close();
  });

  test("invalid JSON → invalid-message", async () => {
    const c = client();
    await c.ready;
    c.ws.send("not-json");
    const err = await c.next((m) => m.type === "error") as Extract<ServerToClientMsg, { type: "error" }>;
    expect(err.code).toBe("invalid-message");
    c.close();
  });
});

// ─── audit 2026-11-05 regressions (#9, #10, #11, #12) ─────────────────────

type ErrMsg = Extract<ServerToClientMsg, { type: "error" }>;
const isErr = (m: ServerToClientMsg): m is ErrMsg => m.type === "error";
const isCreated = (m: ServerToClientMsg): m is RoomCreatedMsg => m.type === "room-created";
const isJoined = (m: ServerToClientMsg): m is RoomJoinedMsg => m.type === "room-joined";

async function roomCount(): Promise<number> {
  const r = await fetch(`http://localhost:${serverModule.server.port}/healthz`);
  return ((await r.json()) as { rooms: number }).rooms;
}

async function waitForRooms(n: number): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const c = await roomCount();
    if (c === n) return c;
    await new Promise((r) => setTimeout(r, 20));
  }
  return roomCount();
}

describe("signaling hardening", () => {
  test("#9 malformed create-room requests are rejected and create nothing", async () => {
    const before = await roomCount();
    const c = client();
    await c.ready;
    for (const bad of [
      { type: "create-room", ttlSeconds: "not-a-number", device },
      { type: "create-room" },
      { type: "create-room", device: { ...device, kind: "toaster" } },
      { type: "create-room", device: { ...device, name: "x".repeat(500) } },
      { type: "join-room", device },
      { type: "signal", to: 5, data: {} },
    ]) {
      c.send(bad);
      expect((await c.next(isErr)).code).toBe("invalid-message");
    }
    expect(await roomCount()).toBe(before);
    c.close();
  });

  test("#9 an absurd TTL is clamped, never NaN or infinite", async () => {
    const c = client();
    await c.ready;
    c.send({ type: "create-room", device, ttlSeconds: 1e12 });
    const created = await c.next(isCreated);
    expect(Number.isFinite(created.expiresAt)).toBe(true);
    expect(created.expiresAt - Date.now()).toBeLessThanOrEqual(4 * 60 * 60 * 1000 + 1000);
    c.close();
  });

  test("#10 one membership per socket; nothing leaks after disconnect", async () => {
    const before = await roomCount();
    const c = client();
    await c.ready;
    c.send({ type: "create-room", device });
    await c.next(isCreated);
    c.send({ type: "create-room", device });
    expect((await c.next(isErr)).code).toBe("already-in-room");
    c.send({ type: "join-room", roomIdOrCode: "ANY", device });
    expect((await c.next(isErr)).code).toBe("already-in-room");
    // leave-room then create again is allowed
    c.send({ type: "leave-room" });
    c.send({ type: "create-room", device });
    await c.next(isCreated);
    c.close();
    expect(await waitForRooms(before)).toBe(before);
  });

  test("#12 rooms hold exactly two peers", async () => {
    const a = client();
    await a.ready;
    a.send({ type: "create-room", device });
    const created = await a.next(isCreated);
    const b = client();
    await b.ready;
    b.send({ type: "join-room", roomIdOrCode: created.code, device });
    await b.next(isJoined);
    const third = client();
    await third.ready;
    third.send({ type: "join-room", roomIdOrCode: created.code, device });
    expect((await third.next(isErr)).code).toBe("room-full");
    a.close();
    b.close();
    third.close();
  });

  test("#10 churn: 300 create/join/leave/disconnect cycles leave zero rooms", async () => {
    const before = await roomCount();
    const batch = async (i: number) => {
      const a = client();
      const b = client();
      await Promise.all([a.ready, b.ready]);
      a.send({ type: "create-room", device });
      const created = await a.next(isCreated);
      b.send({ type: "join-room", roomIdOrCode: created.code, device });
      await b.next(isJoined);
      if (i % 3 === 0) b.send({ type: "leave-room" });
      if (i % 2 === 0) a.send({ type: "leave-room" });
      a.close();
      b.close();
    };
    for (let i = 0; i < 300; i += 20) {
      await Promise.all(Array.from({ length: 20 }, (_, k) => batch(i + k)));
    }
    expect(await waitForRooms(before)).toBe(before);
  }, 30_000);

  test("#11 /whoami reports the address the limiter uses (trusted hop only)", async () => {
    const r = await fetch(`http://localhost:${serverModule.server.port}/whoami`, {
      headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.23" },
    });
    // TRUST_PROXY_HOPS=1 in this test server: the client-written 6.6.6.6 is ignored.
    expect(await r.json()).toEqual({ ip: "198.51.100.23", trustProxyHops: 1 });
  });

  test("per-address connection cap", async () => {
    const ip = freshIp();
    const ok = Array.from({ length: 8 }, () => client(ip));
    await Promise.all(ok.map((c) => c.ready));
    const ninth = client(ip);
    await expect(ninth.ready).rejects.toThrow();
    for (const c of ok) c.close();
  });
});
