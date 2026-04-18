/**
 * Runtime-agnostic peer abstraction. The transfer engine consumes this
 * interface and never touches `RTCPeerConnection` directly. Concrete
 * adapters (browser native, werift on Node) implement `PeerConnection`.
 */

import type { IceCandidate, SessionDescription } from "./types.js";

export type DataChannelKind = "control" | `data-${number}`;

export interface DataChannel {
  /** Channel label used to disambiguate control vs data lanes. */
  readonly label: string;
  /** True if the underlying transport is currently writable. */
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  /** Bytes queued in the local send buffer. */
  readonly bufferedAmount: number;

  bufferedAmountLowThreshold: number;
  binaryType?: "arraybuffer" | "blob";

  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;

  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: Error) => void) | null;
  onmessage: ((data: string | ArrayBuffer) => void) | null;
  onbufferedamountlow: (() => void) | null;
}

export interface PeerConnection {
  createDataChannel(label: string, init?: { ordered?: boolean; maxRetransmits?: number }): DataChannel;

  createOffer(): Promise<SessionDescription>;
  createAnswer(): Promise<SessionDescription>;
  setLocalDescription(desc: SessionDescription): Promise<void>;
  setRemoteDescription(desc: SessionDescription): Promise<void>;
  addIceCandidate(c: IceCandidate): Promise<void>;
  close(): void;

  onicecandidate: ((c: IceCandidate | null) => void) | null;
  ondatachannel: ((ch: DataChannel) => void) | null;
  oniceconnectionstatechange: ((state: string) => void) | null;
  onconnectionstatechange: ((state: string) => void) | null;
}

/**
 * Wait for `bufferedAmount` to drop below `low`, using the channel's
 * native event when available, falling back to polling. This is what
 * makes large transfers memory-safe under backpressure.
 */
export function waitForDrain(ch: DataChannel, low: number): Promise<void> {
  if (ch.bufferedAmount <= low) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      ch.onbufferedamountlow = null;
      clearInterval(timer);
    };
    ch.bufferedAmountLowThreshold = low;
    ch.onbufferedamountlow = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    // Poll fallback for adapters that don't fire the event reliably.
    const timer = setInterval(() => {
      if (settled) return;
      if (ch.readyState !== "open") {
        settled = true;
        cleanup();
        reject(new Error(`channel ${ch.readyState} during drain`));
        return;
      }
      if (ch.bufferedAmount <= low) {
        settled = true;
        cleanup();
        resolve();
      }
    }, 50);
  });
}

export function waitForOpen(ch: DataChannel, timeoutMs = 30_000): Promise<void> {
  if (ch.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      ch.onopen = null;
      ch.onerror = null;
      reject(new Error(`datachannel open timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    ch.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ch.onerror = (e) => {
      clearTimeout(t);
      reject(e);
    };
  });
}
