/**
 * In-process paired DataChannel + PeerConnection mocks. Used by tests
 * to exercise the real sender/receiver code paths without needing a
 * WebRTC stack. NOT for production.
 */

import type { DataChannel, PeerConnection } from "./peer.js";
import type { IceCandidate, SessionDescription } from "./types.js";

class MemChannel implements DataChannel {
  readonly label: string;
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  partner!: MemChannel;

  /**
   * Simulated network latency for this channel. Bytes leave `bufferedAmount`
   * immediately (like handing them to SCTP) but reach the partner later, so a
   * fast channel can overtake a slow one — exactly like real WebRTC, where
   * separate DataChannels are not ordered relative to each other.
   */
  constructor(label: string, private readonly latencyMs = 0) {
    this.label = label;
  }

  open(): void {
    this.readyState = "open";
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") throw new Error(`send on ${this.readyState}`);
    let payload: string | ArrayBuffer;
    let size: number;
    if (typeof data === "string") {
      payload = data;
      size = data.length;
    } else if (data instanceof ArrayBuffer) {
      // copy so the caller can reuse the buffer
      payload = data.slice(0);
      size = data.byteLength;
    } else {
      const view = data;
      const ab = new ArrayBuffer(view.byteLength);
      new Uint8Array(ab).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      payload = ab;
      size = view.byteLength;
    }
    this.bufferedAmount += size;
    if (this.latencyMs > 0) {
      queueMicrotask(() => {
        this.bufferedAmount -= size;
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.onbufferedamountlow?.();
      });
      // setTimeout with an equal delay preserves FIFO order within the channel.
      setTimeout(() => this.partner.onmessage?.(payload), this.latencyMs);
      return;
    }
    queueMicrotask(() => {
      this.partner.onmessage?.(payload);
      this.bufferedAmount -= size;
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
        this.onbufferedamountlow?.();
      }
    });
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    queueMicrotask(() => {
      this.onclose?.();
      if (this.partner.readyState !== "closed") this.partner.close();
    });
  }
}

class MemPeerConnection implements PeerConnection {
  onicecandidate: ((c: IceCandidate | null) => void) | null = null;
  ondatachannel: ((ch: DataChannel) => void) | null = null;
  oniceconnectionstatechange: ((state: string) => void) | null = null;
  onconnectionstatechange: ((state: string) => void) | null = null;

  partner!: MemPeerConnection;
  channels: MemChannel[] = [];

  constructor(private readonly dataLaneLatencyMs = 0) {}

  createDataChannel(label: string): DataChannel {
    const latency = label.startsWith("data-") ? this.dataLaneLatencyMs : 0;
    const local = new MemChannel(label, latency);
    const remote = new MemChannel(label, latency);
    local.partner = remote;
    remote.partner = local;
    this.channels.push(local);
    // Closing either peer must close every channel it can see, including the
    // ones the other side opened (as with a real RTCPeerConnection).
    this.partner.channels.push(remote);
    queueMicrotask(() => {
      this.partner.ondatachannel?.(remote);
      // open both ends after the partner has had a chance to attach.
      queueMicrotask(() => {
        local.open();
        remote.open();
      });
    });
    return local;
  }

  async createOffer(): Promise<SessionDescription> {
    return { type: "offer", sdp: "" };
  }
  async createAnswer(): Promise<SessionDescription> {
    return { type: "answer", sdp: "" };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  close(): void {
    for (const c of this.channels) c.close();
  }
}

export function makeInMemoryPair(opts: {
  /** Delay data-lane delivery so control messages overtake data (as on real WebRTC). */
  dataLaneLatencyMs?: number;
} = {}): {
  a: PeerConnection;
  b: PeerConnection;
} {
  const a = new MemPeerConnection(opts.dataLaneLatencyMs);
  const b = new MemPeerConnection(opts.dataLaneLatencyMs);
  a.partner = b;
  b.partner = a;
  return { a, b };
}
