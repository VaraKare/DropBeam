/**
 * In-worker proxies for `PeerConnection` + `DataChannel`. They satisfy the
 * same interfaces as the real thing (see `../peer.ts`) but forward every
 * interaction to the main thread over `postMessage`.
 *
 * The proxied `PeerConnection` deliberately implements ONLY the surface
 * that `TransferSender` / `TransferReceiver` actually touch — namely
 * `createDataChannel` + `ondatachannel`. SDP / ICE are driven on the
 * main thread by the host code; they never reach the worker.
 */

import type { DataChannel, PeerConnection } from "../peer.js";
import type { IceCandidate, SessionDescription } from "../types.js";
import type {
  ChannelId,
  M2W_ChannelMessage,
  M2W_ChannelState,
  W2MMessage,
} from "./workerProtocol.js";

/** Minimal surface of `postMessage` we need — keeps tests easy to stub. */
export interface WorkerPost {
  postMessage(msg: W2MMessage, transfer?: Transferable[]): void;
}

export class ProxiedDataChannel implements DataChannel {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  bufferedAmount = 0;
  private _low = 0;
  binaryType: "arraybuffer" | "blob" = "arraybuffer";

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: Error) => void) | null = null;
  onmessage: ((data: string | ArrayBuffer) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  constructor(
    readonly channelId: ChannelId,
    readonly label: string,
    private readonly post: WorkerPost,
  ) {}

  get bufferedAmountLowThreshold(): number {
    return this._low;
  }

  set bufferedAmountLowThreshold(v: number) {
    this._low = v;
    this.post.postMessage({
      type: "ch:threshold",
      channelId: this.channelId,
      bufferedAmountLowThreshold: v,
    });
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== "open") {
      throw new Error(`send on ${this.readyState}`);
    }
    if (typeof data === "string") {
      this.post.postMessage({ type: "ch:send", channelId: this.channelId, text: data });
      // `bufferedAmount` updates arrive from main via ch:state.
      return;
    }
    let buf: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
      buf = data;
    } else {
      // ArrayBufferView → slice out its backing window into an owned buffer.
      const view = data;
      const copy = new Uint8Array(view.byteLength);
      copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      buf = copy.buffer;
    }
    // Optimistically reflect the outbound bytes in local bufferedAmount so
    // the sender's watermark logic stays accurate between ch:state updates.
    this.bufferedAmount += buf.byteLength;
    this.post.postMessage(
      { type: "ch:send", channelId: this.channelId, bin: buf },
      [buf],
    );
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closing";
    this.post.postMessage({ type: "ch:close", channelId: this.channelId });
  }

  /* ───── helpers invoked by the dispatcher in transferWorker.ts ───── */

  _onState(msg: M2W_ChannelState): void {
    this.readyState = msg.readyState;
    this.bufferedAmount = msg.bufferedAmount;
    if (msg.bufferedAmountLow) this.onbufferedamountlow?.();
  }

  _onMessage(msg: M2W_ChannelMessage): void {
    if (!this.onmessage) return;
    if (typeof msg.text === "string") this.onmessage(msg.text);
    else if (msg.bin) this.onmessage(msg.bin);
  }

  _onOpen(bufferedAmount: number): void {
    this.readyState = "open";
    this.bufferedAmount = bufferedAmount;
    this.onopen?.();
  }

  _onClose(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }

  _onError(err: Error): void {
    this.onerror?.(err);
  }
}

export class ProxiedPeerConnection implements PeerConnection {
  onicecandidate: ((c: IceCandidate | null) => void) | null = null;
  ondatachannel: ((ch: DataChannel) => void) | null = null;
  oniceconnectionstatechange: ((state: string) => void) | null = null;
  onconnectionstatechange: ((state: string) => void) | null = null;

  private readonly channels = new Map<ChannelId, ProxiedDataChannel>();
  private nextChannelId = 1;

  constructor(private readonly post: WorkerPost) {}

  createDataChannel(
    label: string,
    init?: { ordered?: boolean; maxRetransmits?: number },
  ): DataChannel {
    const channelId = this.nextChannelId++;
    const ch = new ProxiedDataChannel(channelId, label, this.post);
    this.channels.set(channelId, ch);
    this.post.postMessage({
      type: "ch:create",
      channelId,
      label,
      ...(init !== undefined ? { init } : {}),
    });
    return ch;
  }

  /** Called by the worker dispatcher when the main thread hands us an
   *  incoming (remote-initiated) data channel. */
  _adoptRemoteChannel(channelId: ChannelId, label: string, bufferedAmount: number): void {
    const ch = new ProxiedDataChannel(channelId, label, this.post);
    this.channels.set(channelId, ch);
    // The receiver wires `ondatachannel` before the remote side opens it;
    // we first deliver the channel, then flip it to open in the next tick
    // so listeners attached in the callback (onmessage, onopen) don't miss events.
    this.ondatachannel?.(ch);
    queueMicrotask(() => ch._onOpen(bufferedAmount));
  }

  _channel(channelId: ChannelId): ProxiedDataChannel | undefined {
    return this.channels.get(channelId);
  }

  _forgetChannel(channelId: ChannelId): void {
    this.channels.delete(channelId);
  }

  /* SDP / ICE are driven on the main thread; these should never be called
   * from inside the worker. Keep them safe but inert. */
  async createOffer(): Promise<SessionDescription> {
    throw new Error("ProxiedPeerConnection: SDP/ICE is driven on the main thread");
  }
  async createAnswer(): Promise<SessionDescription> {
    throw new Error("ProxiedPeerConnection: SDP/ICE is driven on the main thread");
  }
  async setLocalDescription(): Promise<void> {
    /* no-op — main thread owns this */
  }
  async setRemoteDescription(): Promise<void> {
    /* no-op — main thread owns this */
  }
  async addIceCandidate(): Promise<void> {
    /* no-op — main thread owns this */
  }
  close(): void {
    for (const c of this.channels.values()) c.close();
  }
}
