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

  constructor(label: string) {
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
  private channels: MemChannel[] = [];

  createDataChannel(label: string): DataChannel {
    const local = new MemChannel(label);
    const remote = new MemChannel(label);
    local.partner = remote;
    remote.partner = local;
    this.channels.push(local);
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

export function makeInMemoryPair(): {
  a: PeerConnection;
  b: PeerConnection;
} {
  const a = new MemPeerConnection();
  const b = new MemPeerConnection();
  a.partner = b;
  b.partner = a;
  return { a, b };
}
