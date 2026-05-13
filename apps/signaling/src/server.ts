import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import {
  isClientMsg,
  type ClientToServerMsg,
  type ServerToClientMsg,
} from "@dropbeam/protocol";
import { RateLimiter } from "./rateLimit.js";
import { RoomManager, type PeerSlot, type Room } from "./room.js";

interface SocketData {
  remoteAddr: string;
  /** Set after the socket joins/creates a room. */
  room?: Room;
  peer?: PeerSlot;
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const MAX_MESSAGE_BYTES = Number(process.env.MAX_MSG_BYTES ?? 64 * 1024);

/**
 * Optional: serve a static directory for unknown paths. Set
 *   WEB_ROOT=../web/dist
 * after running `bun --cwd apps/web run build` to make this single Bun
 * process host the web UI on the same port as signaling — handy for the
 * no-internet LAN flow (one URL, one process).
 */
const WEB_ROOT = process.env.WEB_ROOT
  ? resolve(process.cwd(), process.env.WEB_ROOT)
  : null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map":  "application/json",
  ".wasm": "application/wasm",
};

async function serveStatic(root: string, urlPath: string): Promise<Response | null> {
  const safePath = normalize(urlPath.split("?")[0] ?? "/").replace(/^\/+/, "");
  let filePath = join(root, safePath);
  if (!filePath.startsWith(root)) return new Response("forbidden", { status: 403 });
  try {
    if (!existsSync(filePath)) {
      // SPA fallback to index.html for paths without an extension.
      if (!extname(safePath)) filePath = join(root, "index.html");
      else return null;
    } else if (statSync(filePath).isDirectory()) {
      filePath = join(filePath, "index.html");
    }
    if (!existsSync(filePath)) return null;
    const file = Bun.file(filePath);
    const ext = extname(filePath).toLowerCase();
    const headers: Record<string, string> = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control":
        ext === ".html" || safePath === "" ? "no-cache" : "public, max-age=3600",
    };
    return new Response(file, { headers });
  } catch {
    return null;
  }
}

const rooms = new RoomManager({
  defaultTtlMs: 30 * 60 * 1000, // 30 min
  maxTtlMs: 4 * 60 * 60 * 1000, // 4 h
  maxRooms: Number(process.env.MAX_ROOMS ?? 10_000),
  defaultCapacity: Number(process.env.ROOM_CAPACITY ?? 8),
});

// Per-IP message-rate limiter: 30 msg/s burst, refill 15/s.
const msgLimiter = new RateLimiter(30, 15);
// Per-IP create-room limiter: 5 burst, refill 1 / 10s.
const createLimiter = new RateLimiter(5, 0.1);

setInterval(() => {
  rooms.prune();
  msgLimiter.prune(60_000);
  createLimiter.prune(5 * 60_000);
}, 30_000).unref?.();

function jsonSend(
  ws: { send(s: string): number | void },
  msg: ServerToClientMsg,
): void {
  ws.send(JSON.stringify(msg));
}

const server = Bun.serve<SocketData, {}>({
  hostname: HOST,
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return new Response(
        JSON.stringify({ ok: true, rooms: rooms.count(), uptimeMs: process.uptime() * 1000 }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname === "/ws") {
      const remoteAddr =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        srv.requestIP(req)?.address ??
        "unknown";
      const ok = srv.upgrade(req, { data: { remoteAddr } satisfies SocketData });
      if (ok) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    // Optional: serve the static web app from $WEB_ROOT.
    if (WEB_ROOT) {
      const r = await serveStatic(WEB_ROOT, url.pathname);
      if (r) return r;
    }

    return new Response("DropBeam signaling. WS at /ws, health at /healthz.", {
      status: 200,
    });
  },
  websocket: {
    maxPayloadLength: MAX_MESSAGE_BYTES,
    open(ws) {
      // No-op; client must create or join a room next.
    },
    message(ws, raw) {
      const ip = ws.data.remoteAddr;
      if (!msgLimiter.consume(ip)) {
        jsonSend(ws, {
          type: "error",
          code: "rate-limited",
          message: "Too many messages.",
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        jsonSend(ws, {
          type: "error",
          code: "invalid-message",
          message: "JSON parse error.",
        });
        return;
      }
      if (!isClientMsg(parsed)) {
        jsonSend(ws, {
          type: "error",
          code: "invalid-message",
          message: "Unknown message type.",
        });
        return;
      }
      handle(ws, parsed);
    },
    close(ws) {
      const { room, peer } = ws.data;
      if (room && peer) {
        rooms.leave(room, peer.peerId);
        broadcast(room, peer.peerId, {
          type: "peer-left",
          peerId: peer.peerId,
          reason: "disconnect",
        });
      }
    },
  },
});

console.log(
  `[dropbeam-signaling] listening on ws://${server.hostname}:${server.port}/ws`,
);
if (WEB_ROOT) {
  console.log(`[dropbeam-signaling] serving web app from ${WEB_ROOT}`);
}

// ─── handlers ─────────────────────────────────────────────────────────────

type WS = Parameters<NonNullable<Parameters<typeof Bun.serve<SocketData, {}>>[0]["websocket"]>["message"]>[0];

function handle(ws: WS, msg: ClientToServerMsg): void {
  switch (msg.type) {
    case "ping":
      jsonSend(ws, { type: "pong", t: msg.t });
      return;

    case "create-room": {
      if (!createLimiter.consume(ws.data.remoteAddr)) {
        jsonSend(ws, {
          type: "error",
          code: "rate-limited",
          message: "Too many room creations.",
        });
        return;
      }
      try {
        const { room, peer } = rooms.create(msg.device, msg.ttlSeconds);
        peer.send = (m) => jsonSend(ws, m);
        ws.data.room = room;
        ws.data.peer = peer;
        jsonSend(ws, {
          type: "room-created",
          roomId: room.roomId,
          code: room.code,
          peerId: peer.peerId,
          token: peer.token,
          expiresAt: room.expiresAt,
        });
      } catch (e) {
        jsonSend(ws, {
          type: "error",
          code: "internal",
          message: (e as Error).message,
        });
      }
      return;
    }

    case "join-room": {
      try {
        const found = rooms.find(msg.roomIdOrCode);
        if (!found) {
          jsonSend(ws, {
            type: "error",
            code: "room-not-found",
            message: "Room not found or expired.",
          });
          return;
        }
        const { room, peer } = rooms.join(found.roomId, msg.device);
        peer.send = (m) => jsonSend(ws, m);
        ws.data.room = room;
        ws.data.peer = peer;

        const others = [...room.peers.values()]
          .filter((p) => p.peerId !== peer.peerId)
          .map((p) => ({ peerId: p.peerId, device: p.device }));

        jsonSend(ws, {
          type: "room-joined",
          roomId: room.roomId,
          peerId: peer.peerId,
          token: peer.token,
          peers: others,
          expiresAt: room.expiresAt,
        });

        broadcast(room, peer.peerId, {
          type: "peer-joined",
          peerId: peer.peerId,
          device: peer.device,
        });
      } catch (e) {
        const m = (e as Error).message;
        jsonSend(ws, {
          type: "error",
          code:
            m === "room-not-found"
              ? "room-not-found"
              : m === "room-full"
                ? "room-full"
                : "internal",
          message: m,
        });
      }
      return;
    }

    case "signal": {
      const { room, peer } = ws.data;
      if (!room || !peer) {
        jsonSend(ws, {
          type: "error",
          code: "not-in-room",
          message: "Join a room first.",
        });
        return;
      }
      const target = room.peers.get(msg.to);
      if (!target || !target.send) {
        jsonSend(ws, {
          type: "error",
          code: "peer-not-found",
          message: `Peer ${msg.to} not connected.`,
        });
        return;
      }
      target.send({ type: "signal", from: peer.peerId, data: msg.data });
      return;
    }

    case "leave-room": {
      const { room, peer } = ws.data;
      if (room && peer) {
        rooms.leave(room, peer.peerId);
        broadcast(room, peer.peerId, {
          type: "peer-left",
          peerId: peer.peerId,
          reason: "leave",
        });
        ws.data.room = undefined;
        ws.data.peer = undefined;
      }
      return;
    }
  }
}

function broadcast(room: Room, exceptPeerId: string, msg: ServerToClientMsg): void {
  for (const p of room.peers.values()) {
    if (p.peerId === exceptPeerId) continue;
    p.send?.(msg);
  }
}

// graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[dropbeam-signaling] ${sig} received, shutting down`);
    server.stop();
    process.exit(0);
  });
}

export { server };
