/**
 * DropBeam signaling server for Bun (Docker, Render, Koyeb, LAN mode).
 * All room logic lives in `hub.ts`, shared with the Cloudflare Worker.
 */

import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { clientIp, loadConfig, originAllowed } from "./config.js";
import { Hub, type HubSocket } from "./hub.js";

const config = loadConfig(process.env);
const hub = new Hub(config);

interface SocketData extends HubSocket {
  ip: string;
}

/**
 * Optional: serve a static directory for unknown paths. Set
 *   WEB_ROOT=../web/dist
 * after running `bun --cwd apps/web run build` to make this single Bun
 * process host the web UI on the same port as signaling — handy for the
 * no-internet LAN flow (one URL, one process).
 */
const WEB_ROOT = config.webRoot ? resolve(process.cwd(), config.webRoot) : null;

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

const json = (body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...extra } });

const server = Bun.serve<SocketData>({
  hostname: config.host,
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const ip = () => clientIp(srv.requestIP(req)?.address, req.headers.get("x-forwarded-for"), config.trustProxyHops);

    if (url.pathname === "/healthz") return json(hub.health());
    if (url.pathname === "/whoami") {
      // Deploy check for TRUST_PROXY_HOPS (ADR-003): shows callers only their
      // own address as the rate limiter sees it. Not logged, not stored.
      return json({ ip: ip(), trustProxyHops: config.trustProxyHops }, { "cache-control": "no-store" });
    }
    if (url.pathname === "/ws") {
      if (!originAllowed(config.allowedOrigins, req.headers.get("origin"))) {
        return new Response("origin not allowed", { status: 403 });
      }
      const addr = ip();
      const refused = hub.admit(addr);
      if (refused) return new Response(refused.reason, { status: refused.status });
      const data: SocketData = { ip: addr, send: () => {} };
      if (srv.upgrade(req, { data })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }

    // Optional: serve the static web app from $WEB_ROOT.
    if (WEB_ROOT) {
      const r = await serveStatic(WEB_ROOT, url.pathname);
      if (r) return r;
    }
    return new Response("DropBeam signaling. WS at /ws, health at /healthz.", { status: 200 });
  },
  websocket: {
    maxPayloadLength: config.maxMessageBytes,
    open(ws) {
      ws.data.send = (text) => {
        ws.send(text);
      };
      hub.onOpen(ws.data);
    },
    message(ws, raw) {
      hub.onMessage(ws.data, typeof raw === "string" ? raw : raw.toString());
    },
    close(ws) {
      hub.onClose(ws.data);
    },
  },
});

console.log(`[dropbeam-signaling] listening on ws://${server.hostname}:${server.port}/ws`);
if (WEB_ROOT) console.log(`[dropbeam-signaling] serving web app from ${WEB_ROOT}`);

// graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[dropbeam-signaling] ${sig} received, shutting down`);
    server.stop();
    process.exit(0);
  });
}

export { server };
