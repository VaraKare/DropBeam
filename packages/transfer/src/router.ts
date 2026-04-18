/**
 * Smart routing engine — picks the best transport for the current
 * conditions. Only the decision logic lives here; the actual transports
 * are implemented separately.
 *
 *   1. SAME_HOST           → loopback (e.g. browser tab ↔ tab via localhost)
 *   2. SAME_LAN            → mDNS / direct LAN socket
 *   3. NEARBY_NO_LAN       → WiFi Direct / Bluetooth handshake → upgrade to WiFi
 *   4. INTERNET_DIRECT     → WebRTC P2P (host/srflx ICE candidates)
 *   5. INTERNET_RELAYED    → WebRTC TURN relay
 *   6. RESUME_INTERRUPTED  → reconnect via signaling, resume from chunk
 */

export type Transport =
  | "loopback"
  | "lan-quic"   // Rust/quinn QUIC — zero-RTT UDP on LAN, fastest
  | "lan"        // WebRTC over LAN (QUIC unavailable fallback)
  | "wifi-direct"
  | "p2p-direct"
  | "p2p-relayed";

export interface NetworkProbe {
  /** Both peers reachable on same private IP range. */
  sameLan: boolean;
  /** ICE gathering produced at least one host or srflx candidate pair. */
  directReachable: boolean;
  /** Bluetooth + WiFi Direct stacks present (mobile native). */
  nearbyAvailable: boolean;
  /** Either peer is actively behind a symmetric NAT / strict firewall. */
  needsRelay: boolean;
  /** Loopback hint (same host, useful for tests). */
  sameHost: boolean;
  /** dropbeam-quic binary present AND UDP reachable on LAN peer. */
  quicAvailable: boolean;
}

export interface ModeHint {
  /** From the UI tab the user picked. */
  preferred?: "nearby" | "remote" | "hybrid" | "bulk" | "vault";
  /** For BULK mode we keep more lanes open. */
  largePayload?: boolean;
}

export interface RouteDecision {
  transport: Transport;
  /** Number of parallel WebRTC datachannels for data lanes. */
  lanes: number;
  /** Bytes per chunk frame on the wire. */
  chunkSize: number;
  /** Whether to enable application-layer AES-GCM in addition to DTLS. */
  appLayerEncryption: boolean;
  rationale: string;
}

const KB = 1024;

export function decideRoute(probe: NetworkProbe, hint: ModeHint = {}): RouteDecision {
  const bulk = hint.preferred === "bulk" || hint.largePayload;

  if (probe.sameHost) {
    return {
      transport: "loopback",
      lanes: 1,
      chunkSize: 256 * KB,
      appLayerEncryption: false,
      rationale: "same host — loopback",
    };
  }

  if (hint.preferred === "nearby" || (probe.sameLan && hint.preferred !== "remote")) {
    if (probe.sameLan) {
      // QUIC is strictly better than WebRTC on LAN: zero-RTT, pure UDP, no STUN dance.
      if (probe.quicAvailable) {
        return {
          transport: "lan-quic",
          lanes: bulk ? 8 : 4,
          chunkSize: bulk ? 128 * KB : 64 * KB,
          appLayerEncryption: hint.preferred === "vault",
          rationale: "LAN + QUIC binary available — zero-RTT UDP",
        };
      }
      return {
        transport: "lan",
        lanes: bulk ? 8 : 4,
        chunkSize: bulk ? 128 * KB : 64 * KB,
        appLayerEncryption: hint.preferred === "vault",
        rationale: "same LAN, QUIC unavailable → WebRTC LAN",
      };
    }
    if (probe.nearbyAvailable) {
      return {
        transport: "wifi-direct",
        lanes: 2,
        chunkSize: 64 * KB,
        appLayerEncryption: hint.preferred === "vault",
        rationale: "nearby no-LAN — wifi direct handshake",
      };
    }
  }

  if (!probe.needsRelay && probe.directReachable) {
    return {
      transport: "p2p-direct",
      lanes: bulk ? 6 : 4,
      chunkSize: bulk ? 128 * KB : 64 * KB,
      appLayerEncryption: hint.preferred === "vault",
      rationale: "WebRTC P2P direct via ICE",
    };
  }

  return {
    transport: "p2p-relayed",
    lanes: bulk ? 4 : 2,
    chunkSize: 64 * KB,
    appLayerEncryption: hint.preferred === "vault" || true /* relay is a third party */,
    rationale: "TURN relay (NAT/firewall) — application encryption recommended",
  };
}
