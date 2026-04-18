/**
 * End-to-end integration test for the signaling server.
 * Boots a server on a random port, then drives two clients through
 * create-room → join-room → signal relay → leave.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  DeviceInfo,
  RoomCreatedMsg,
  RoomJoinedMsg,
  ServerToClientMsg,
} from "../../../packages/protocol/src/index.ts";

const PORT = 18787 + Math.floor(Math.random() * 100);
process.env.PORT = String(PORT);

let serverModule: { server: { stop(): void } };

beforeAll(async () => {
  serverModule = await import("../src/server.ts");
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => {
  serverModule.server.stop();
});

const URL = `ws://localhost:${PORT}/ws`;

function client(): {
  ws: WebSocket;
  ready: Promise<void>;
  next: <T extends ServerToClientMsg>(pred: (m: ServerToClientMsg) => m is T) => Promise<T>;
  send: (m: object) => void;
  close: () => void;
} {
  const ws = new WebSocket(URL);
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
    const r = await fetch(`http://localhost:${PORT}/healthz`);
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
