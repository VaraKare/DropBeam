/**
 * Environment configuration, validated once at startup. A typo such as
 * MAX_ROOMS=10k must stop the server with a clear message instead of running
 * with NaN limits (audit #9).
 */

/** Environment variables, from `process.env` (Bun) or Worker bindings (Cloudflare). */
export type EnvSource = Record<string, string | undefined>;

function intEnv(env: EnvSource, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[dropbeam-signaling] invalid ${name}=${JSON.stringify(raw)}: expected an integer from ${min} to ${max}`);
  }
  return n;
}

function listEnv(env: EnvSource, name: string): string[] {
  return (env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface SignalingConfig {
  port: number;
  host: string;
  /** Max bytes in one WebSocket message (SDP fits comfortably in 64 KiB). */
  maxMessageBytes: number;
  maxRooms: number;
  /** Peers per room. 2 = one sender + one receiver (audit #12). */
  roomCapacity: number;
  /**
   * How many reverse proxies in front of us append to X-Forwarded-For.
   * 0 = ignore the header and use the socket address (ADR-003).
   */
  trustProxyHops: number;
  maxConnections: number;
  maxConnectionsPerIp: number;
  /** Optional allow-list of browser Origins; empty = allow any. */
  allowedOrigins: string[];
  webRoot: string | null;
}

export function loadConfig(env: EnvSource): SignalingConfig {
  return {
    port: intEnv(env, "PORT", 8787, 0, 65_535),
    host: env.HOST?.trim() || "0.0.0.0",
    maxMessageBytes: intEnv(env, "MAX_MSG_BYTES", 64 * 1024, 1024, 1024 * 1024),
    maxRooms: intEnv(env, "MAX_ROOMS", 10_000, 1, 1_000_000),
    roomCapacity: intEnv(env, "ROOM_CAPACITY", 2, 2, 16),
    trustProxyHops: intEnv(env, "TRUST_PROXY_HOPS", 0, 0, 5),
    maxConnections: intEnv(env, "MAX_CONNECTIONS", 20_000, 1, 1_000_000),
    maxConnectionsPerIp: intEnv(env, "MAX_CONNECTIONS_PER_IP", 64, 1, 100_000),
    allowedOrigins: listEnv(env, "ALLOWED_ORIGINS"),
    webRoot: env.WEB_ROOT?.trim() || null,
  };
}

/** True if the browser Origin is allowed (empty allow-list = allow any). */
export function originAllowed(allowed: string[], origin: string | null): boolean {
  if (!allowed.length) return true;
  return !!origin && allowed.includes(origin);
}

/**
 * The client address to rate-limit on (ADR-003).
 *
 * With `trustProxyHops = 0` the forwarding header is ignored entirely — any
 * client can write it. With N trusted proxies, each appends the address it
 * received the connection from, so the N-th entry from the right is the one
 * our outermost proxy saw; anything further left is client-controlled.
 */
export function clientIp(
  socketAddr: string | undefined,
  forwardedFor: string | null,
  trustProxyHops: number,
): string {
  const fallback = socketAddr || "unknown";
  if (trustProxyHops <= 0 || !forwardedFor) return fallback;
  const hops = forwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hops.length < trustProxyHops) return fallback;
  return hops[hops.length - trustProxyHops] || fallback;
}
