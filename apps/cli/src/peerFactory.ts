/**
 * Peer factory with automatic fallback.
 *
 * Priority:
 *   1. node-datachannel (libdatachannel C++) — fastest, lowest CPU
 *   2. werift            (pure TypeScript)    — zero native deps, slower
 *
 * The factory is async so it can dynamically import whichever is available.
 * On a fresh install node-datachannel might not have pre-built binaries for
 * the current platform; in that case the import throws and we fall back.
 */

import type { PeerConnection } from "@dropbeam/transfer";

export interface PeerFactoryOptions {
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  /** Force a specific adapter; useful for testing. */
  adapter?: "node-datachannel" | "werift" | "auto";
}

export async function makePeer(opts: PeerFactoryOptions = {}): Promise<PeerConnection> {
  const preferred = opts.adapter ?? "auto";

  if (preferred === "werift") return weriftFallback(opts);

  // --- try node-datachannel (C++ native) ---
  if (preferred === "auto" || preferred === "node-datachannel") {
    try {
      const { makeNodeDCPeer } = await import("./nodeDCAdapter.js");
      const pc = makeNodeDCPeer({ iceServers: opts.iceServers });
      return pc;
    } catch (e) {
      if (preferred === "node-datachannel") {
        throw new Error(`node-datachannel unavailable: ${(e as Error).message}`);
      }
      process.stderr.write(
        `[dropbeam] node-datachannel unavailable (${(e as Error).message}), falling back to werift\n`,
      );
    }
  }

  return weriftFallback(opts);
}

async function weriftFallback(opts: PeerFactoryOptions): Promise<PeerConnection> {
  const { makeWeriftPeer } = await import("./weriftAdapter.js");
  return makeWeriftPeer({ iceServers: opts.iceServers as never });
}
