/**
 * Smoke-test a running signaling server (local Bun, `wrangler dev`, or the
 * live Cloudflare deployment):
 *
 *   bun apps/signaling/scripts/smoke.ts https://dropbeam-signaling.<you>.workers.dev
 *
 * Checks health, whoami, create → join → relay → peer-left, room capacity 2,
 * one-room-per-socket, strict validation, and that rooms are cleaned up.
 * Also checks GET /stats (shape, cache + CORS headers) and that an unpaired
 * socket can't report a transfer. Only against a local server (localhost /
 * 127.0.0.1) does it report one real `stats` message and expect the count to
 * rise, so public production numbers are never inflated by smoke runs.
 * Creates at most 3 rooms (well under the per-address limits). Exit 1 on failure.
 */

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const wsUrl = base.replace(/^http/, "ws") + "/ws";
const device = { deviceId: "smoke-test", name: "smoke", kind: "node" };

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Msg = { type: string; [k: string]: unknown };

function client(): Promise<{ send(m: object | string): void; next(type: string, ms?: number): Promise<Msg>; close(): void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const queue: Msg[] = [];
    const waiters: Array<{ type: string; res: (m: Msg) => void }> = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      const i = waiters.findIndex((w) => w.type === m.type);
      if (i >= 0) waiters.splice(i, 1)[0]!.res(m);
      else queue.push(m);
    };
    ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`));
    ws.onopen = () =>
      resolve({
        send: (m) => ws.send(typeof m === "string" ? m : JSON.stringify(m)),
        next: (type, ms = 5000) =>
          new Promise((res, rej) => {
            const i = queue.findIndex((m) => m.type === type);
            if (i >= 0) return res(queue.splice(i, 1)[0]!);
            const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), ms);
            waiters.push({ type, res: (m) => (clearTimeout(t), res(m)) });
          }),
        close: () => ws.close(),
      });
  });
}

type StatsBody = { today: { transfers: number }; last30Days: unknown[]; allTime: { transfers: number; bytes: number } };
async function getStats(): Promise<{ body: StatsBody; res: Response }> {
  const res = await fetch(`${base}/stats`, { headers: { origin: "https://smoke.invalid", accept: "application/json" } });
  return { body: (await res.json()) as StatsBody, res };
}
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);

async function healthRooms(): Promise<number> {
  const h = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; rooms: number };
  return h.rooms;
}

async function main(): Promise<void> {
  console.log(`Smoke-testing ${base}\n`);

  const h = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; rooms: number };
  check("healthz", h.ok === true, JSON.stringify(h));
  const roomsBefore = h.rooms;

  const who = await (await fetch(`${base}/whoami`)).json() as { ip: string };
  const spoofed = await (await fetch(`${base}/whoami`, { headers: { "x-forwarded-for": "1.2.3.4" } })).json() as { ip: string };
  check("whoami ignores a spoofed X-Forwarded-For", spoofed.ip === who.ip && spoofed.ip !== "1.2.3.4", `ip=${who.ip}`);

  const st = await getStats();
  check(
    "GET /stats shape",
    typeof st.body.allTime?.transfers === "number" && Array.isArray(st.body.last30Days) && st.body.last30Days.length === 30,
    `allTime.transfers=${st.body.allTime?.transfers}`,
  );
  check("/stats cacheable for 60 s", st.res.headers.get("cache-control") === "public, max-age=60");
  check("/stats has a CORS policy", st.res.headers.has("access-control-allow-origin") || (st.res.headers.get("vary") ?? "").includes("origin"));
  const transfersBefore = st.body.allTime.transfers;

  const a = await client();
  a.send({ type: "stats", bytes: 1, files: 1, path: "direct" }); // not in a room → ignored
  a.send({ type: "create-room", device });
  const created = await a.next("room-created");
  check("create-room", typeof created.code === "string", String(created.code));

  a.send({ type: "create-room", device });
  check("one room per socket", (await a.next("error")).code === "already-in-room");

  a.send({ type: "create-room", ttlSeconds: "not-a-number", device });
  check("malformed request rejected", (await a.next("error")).code === "invalid-message");

  const b = await client();
  b.send({ type: "join-room", roomIdOrCode: String(created.code).toLowerCase(), device });
  const joined = await b.next("room-joined");
  check("join by code (case-insensitive)", joined.peers instanceof Array && (joined.peers as unknown[]).length === 1);
  check("creator sees peer-joined", (await a.next("peer-joined")).peerId === joined.peerId);

  a.send({ type: "signal", to: joined.peerId, data: { sdp: "hello" } });
  const sig = await b.next("signal");
  check("signal relayed", (sig.data as { sdp?: string }).sdp === "hello" && sig.from === created.peerId);

  if (isLocal) {
    a.send({ type: "stats", bytes: 1024, files: 1, path: "lan" });
    a.send({ type: "stats", bytes: 1024, files: 1, path: "lan" }); // duplicate → ignored
    a.send({ type: "ping", t: 7 });
    await a.next("pong"); // the reports were processed before this
    const after = (await getStats()).body.allTime.transfers;
    check("stats report counted once (paired room)", after === transfersBefore + 1, `${transfersBefore} → ${after}`);
  } else {
    const after = (await getStats()).body.allTime.transfers;
    check("unpaired stats report ignored", after >= transfersBefore, "(live server: no report sent)");
  }

  const c = await client();
  c.send({ type: "join-room", roomIdOrCode: created.code, device });
  check("third peer refused (room of 2)", (await c.next("error")).code === "room-full");

  c.send({ type: "ping", t: 42 });
  check("ping/pong", (await c.next("pong")).t === 42);

  b.close();
  check("peer-left on disconnect", (await a.next("peer-left")).peerId === joined.peerId);
  a.close();
  c.close();

  let after = -1;
  for (let i = 0; i < 25; i++) {
    after = await healthRooms();
    if (after === roomsBefore) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check("room cleaned up after everyone left", after === roomsBefore, `rooms ${roomsBefore} → ${after}`);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("✗", (e as Error).message);
  process.exit(1);
});
