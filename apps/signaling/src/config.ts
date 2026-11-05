/**
 * Environment configuration, validated once at startup. A typo such as
 * MAX_ROOMS=10k must stop the server with a clear message instead of running
 * with NaN limits (audit #9).
 */

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[dropbeam-signaling] invalid ${name}=${JSON.stringify(raw)}: expected an integer from ${min} to ${max}`);
  }
  return n;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
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

export function loadConfig(): SignalingConfig {
  return {
    port: intEnv("PORT", 8787, 0, 65_535),
    host: process.env.HOST?.trim() || "0.0.0.0",
    maxMessageBytes: intEnv("MAX_MSG_BYTES", 64 * 1024, 1024, 1024 * 1024),
    maxRooms: intEnv("MAX_ROOMS", 10_000, 1, 1_000_000),
    roomCapacity: intEnv("ROOM_CAPACITY", 2, 2, 16),
    trustProxyHops: intEnv("TRUST_PROXY_HOPS", 0, 0, 5),
    maxConnections: intEnv("MAX_CONNECTIONS", 20_000, 1, 1_000_000),
    maxConnectionsPerIp: intEnv("MAX_CONNECTIONS_PER_IP", 64, 1, 100_000),
    allowedOrigins: listEnv("ALLOWED_ORIGINS"),
    webRoot: process.env.WEB_ROOT?.trim() || null,
  };
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
