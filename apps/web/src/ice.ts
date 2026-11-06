/**
 * ICE candidate helpers for Same Wi-Fi mode (see setMode / createLink in
 * main.ts). Same Wi-Fi uses STUN (never TURN) and only accepts a path whose
 * far end is a private address or our own router's public address, so file
 * data never leaves the local network.
 */

/** `candidate:… <proto> <prio> <address> <port> typ <type> …` → address + type. */
export function parseCandidate(line: string): { address: string; type: string } | null {
  const f = line.replace(/^a=/, "").split(" ");
  const t = f.indexOf("typ");
  const address = f[4];
  const type = t >= 0 ? f[t + 1] : undefined;
  if (!address || !type) return null;
  return { address, type };
}

/** RFC 1918 / CGNAT / link-local / ULA / loopback / mDNS names. */
export function isPrivateAddress(a: string): boolean {
  if (a.endsWith(".local")) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a)) return true;
  return /^(fc|fd|fe80:|::1$)/i.test(a);
}

/** True when a remote address is on this network: private, or our router's public IP. */
export function sameNetwork(remoteAddress: string, ownPublic: ReadonlySet<string>): boolean {
  return isPrivateAddress(remoteAddress) || ownPublic.has(remoteAddress);
}
