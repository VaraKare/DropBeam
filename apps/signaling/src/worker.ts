/**
 * DropBeam signaling on Cloudflare Workers (ADR-007).
 *
 * The Worker routes /ws and /healthz to ONE Durable Object ("global") that
 * runs the same `Hub` as the Bun server, so rooms behave identically. The
 * object uses standard (non-hibernating) WebSockets on purpose: rooms live
 * in memory, and a non-hibernating object stays resident while any socket is
 * open, so room state can never be wiped under a connected user. One
 * always-on object fits the free plan's daily duration allowance.
 *
 * Public stats (/stats): aggregate per-day counters live in memory and are
 * written to this object's SQLite storage at most about once a minute (an
 * alarm), plus once when the last socket closes, and loaded on start. One
 * row per UTC day; nothing about users is stored.
 *
 * Client address: Cloudflare's edge sets `CF-Connecting-IP` itself and
 * overwrites any client-supplied value, so it can't be spoofed (audit #11).
 */

import { DurableObject } from "cloudflare:workers";
import { loadConfig, originAllowed, type EnvSource, type SignalingConfig } from "./config.js";
import { Hub, type HubSocket } from "./hub.js";
import { Stats, statsHeaders, type DayCounters } from "./stats.js";

export interface Env {
  HUB: DurableObjectNamespace<SignalingHub>;
  ROOM_CAPACITY?: string;
  MAX_ROOMS?: string;
  MAX_CONNECTIONS?: string;
  MAX_CONNECTIONS_PER_IP?: string;
  MAX_MSG_BYTES?: string;
  ALLOWED_ORIGINS?: string;
}

/** String-valued Worker vars only (bindings like HUB are skipped). */
function vars(env: Env): EnvSource {
  const out: EnvSource = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

const json = (body: unknown, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...extra } });

const clientIpOf = (req: Request): string => req.headers.get("cf-connecting-ip") ?? "unknown";

/**
 * `/stats` must not cost a Durable Object request per page view (the free
 * plan's daily DO request quota is shared with /ws). Body cached for 60 s in
 * this isolate, then in the edge cache (a no-op on workers.dev), and only on a
 * miss fetched from the object. CORS headers are added per request.
 */
const STATS_TTL_MS = 60_000;
let statsMemo: { body: string; expires: number } | null = null;

async function statsCached(req: Request, env: Env): Promise<Response> {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const headers = statsHeaders(loadConfig(vars(env)).allowedOrigins, req.headers.get("origin"));
  if (statsMemo && statsMemo.expires > Date.now()) return new Response(statsMemo.body, { headers });
  const cacheKey = new Request(new URL("/stats", req.url).toString(), { method: "GET" });
  const edge = caches.default;
  let body: string | null = null;
  try {
    const hit = await edge.match(cacheKey);
    if (hit) body = await hit.text();
  } catch { /* Cache API unavailable */ }
  if (body === null) {
    const res = await env.HUB.get(env.HUB.idFromName("global")).fetch(cacheKey);
    if (!res.ok) return new Response("stats unavailable", { status: 503 });
    body = await res.text();
    try {
      await edge.put(cacheKey, new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=60" } }));
    } catch { /* ignore */ }
  }
  statsMemo = { body, expires: Date.now() + STATS_TTL_MS };
  return new Response(body, { headers });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/whoami") {
      // Deploy check: the address limits are keyed on. Not logged, not stored.
      return json({ ip: clientIpOf(req), source: "cf-connecting-ip" }, { "cache-control": "no-store" });
    }
    if (url.pathname === "/stats") return statsCached(req, env);
    if (url.pathname === "/ws" || url.pathname === "/healthz") {
      const hub = env.HUB.get(env.HUB.idFromName("global"));
      return hub.fetch(req);
    }
    return new Response("DropBeam signaling. WS at /ws, health at /healthz, stats at /stats.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

const FLUSH_EVERY_MS = 60_000;
/** Don't write on every "last socket closed" when connections churn. */
const MIN_IDLE_FLUSH_GAP_MS = 10_000;

export class SignalingHub extends DurableObject<Env> {
  private readonly config: SignalingConfig;
  private readonly hub: Hub;
  private readonly stats: Stats;
  private alarmSet = false;
  private lastFlush = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadConfig(vars(env));
    this.stats = new Stats(Date.now, () => this.scheduleFlush());
    this.hub = new Hub(this.config, this.stats);
    ctx.blockConcurrencyWhile(async () => {
      try {
        const sql = ctx.storage.sql;
        sql.exec(`CREATE TABLE IF NOT EXISTS daily_stats (
          date TEXT PRIMARY KEY,
          rooms_created INTEGER NOT NULL DEFAULT 0,
          rooms_paired INTEGER NOT NULL DEFAULT 0,
          transfers INTEGER NOT NULL DEFAULT 0,
          bytes INTEGER NOT NULL DEFAULT 0,
          files INTEGER NOT NULL DEFAULT 0,
          direct INTEGER NOT NULL DEFAULT 0,
          lan INTEGER NOT NULL DEFAULT 0,
          relay INTEGER NOT NULL DEFAULT 0
        )`);
        const rows = sql
          .exec<Record<string, string | number>>(
            `SELECT date, rooms_created, rooms_paired, transfers, bytes, files, direct, lan, relay FROM daily_stats`,
          )
          .toArray();
        this.stats.load(
          rows.map((r) => ({
            date: String(r.date),
            roomsCreated: Number(r.rooms_created),
            roomsPaired: Number(r.rooms_paired),
            transfers: Number(r.transfers),
            bytes: Number(r.bytes),
            files: Number(r.files),
            direct: Number(r.direct),
            lan: Number(r.lan),
            relay: Number(r.relay),
          })),
        );
      } catch (e) {
        // Stats must never take signaling down.
        console.error("[stats] load failed", (e as Error).message);
      }
    });
  }

  private scheduleFlush(): void {
    if (this.alarmSet) return;
    this.alarmSet = true;
    void this.ctx.storage.setAlarm(Date.now() + FLUSH_EVERY_MS).catch(() => {
      this.alarmSet = false;
    });
  }

  override async alarm(): Promise<void> {
    this.alarmSet = false;
    this.flush();
  }

  private flush(): void {
    const rows: DayCounters[] = this.stats.takeDirty();
    if (!rows.length) return;
    this.lastFlush = Date.now();
    try {
      for (const r of rows) {
        // Memory holds absolute per-day values (loaded on start), so upsert them.
        this.ctx.storage.sql.exec(
          `INSERT INTO daily_stats (date, rooms_created, rooms_paired, transfers, bytes, files, direct, lan, relay)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET rooms_created = excluded.rooms_created,
             rooms_paired = excluded.rooms_paired, transfers = excluded.transfers, bytes = excluded.bytes,
             files = excluded.files, direct = excluded.direct, lan = excluded.lan, relay = excluded.relay`,
          r.date, r.roomsCreated, r.roomsPaired, r.transfers, r.bytes, r.files, r.direct, r.lan, r.relay,
        );
      }
    } catch (e) {
      console.error("[stats] flush failed", (e as Error).message);
      this.stats.markDirty(rows.map((r) => r.date));
      this.scheduleFlush();
    }
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json(this.hub.health(), { "cache-control": "no-store" });
    if (url.pathname === "/stats") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return new Response(JSON.stringify(this.hub.statsSnapshot()), {
        headers: statsHeaders(this.config.allowedOrigins, req.headers.get("origin")),
      });
    }

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    if (!originAllowed(this.config.allowedOrigins, req.headers.get("origin"))) {
      return new Response("origin not allowed", { status: 403 });
    }
    const ip = clientIpOf(req);
    const refused = this.hub.admit(ip);
    if (refused) return new Response(refused.reason, { status: refused.status });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const sock: HubSocket = { ip, send: (text) => server.send(text) };
    this.hub.onOpen(sock);

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.hub.onClose(sock);
      // The object may be evicted soon after the last socket goes, before the
      // alarm: persist now (rate-limited) so counts aren't lost.
      if (
        this.stats.hasDirty &&
        this.hub.health().connections === 0 &&
        Date.now() - this.lastFlush > MIN_IDLE_FLUSH_GAP_MS
      ) {
        this.flush();
      }
    };
    server.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") {
        this.hub.onMessage(sock, ""); // binary isn't part of the protocol → invalid-message
        return;
      }
      if (ev.data.length > this.config.maxMessageBytes) {
        server.close(1009, "message too big");
        end();
        return;
      }
      this.hub.onMessage(sock, ev.data);
    });
    server.addEventListener("close", () => {
      end();
      try {
        server.close(1000, "bye");
      } catch {
        /* already closed */
      }
    });
    server.addEventListener("error", end);

    return new Response(null, { status: 101, webSocket: client });
  }
}
