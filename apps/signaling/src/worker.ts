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
 * Client address: Cloudflare's edge sets `CF-Connecting-IP` itself and
 * overwrites any client-supplied value, so it can't be spoofed (audit #11).
 */

import { DurableObject } from "cloudflare:workers";
import { loadConfig, originAllowed, type EnvSource, type SignalingConfig } from "./config.js";
import { Hub, type HubSocket } from "./hub.js";

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/whoami") {
      // Deploy check: the address limits are keyed on. Not logged, not stored.
      return json({ ip: clientIpOf(req), source: "cf-connecting-ip" }, { "cache-control": "no-store" });
    }
    if (url.pathname === "/ws" || url.pathname === "/healthz") {
      const hub = env.HUB.get(env.HUB.idFromName("global"));
      return hub.fetch(req);
    }
    return new Response("DropBeam signaling. WS at /ws, health at /healthz.", { status: 200 });
  },
} satisfies ExportedHandler<Env>;

export class SignalingHub extends DurableObject<Env> {
  private readonly config: SignalingConfig;
  private readonly hub: Hub;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadConfig(vars(env));
    this.hub = new Hub(this.config);
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json(this.hub.health(), { "cache-control": "no-store" });

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
