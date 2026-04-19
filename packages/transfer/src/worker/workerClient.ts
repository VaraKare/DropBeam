/**
 * Main-thread client for the DropBeam transfer worker.
 *
 * Responsibilities on the UI side:
 *   1. Own the real `RTCPeerConnection` (SDP/ICE lives here; Safari/Firefox
 *      still don't expose RTCPC inside workers reliably in 2026).
 *   2. Host the real `FileSinkFactory` (Phase 2 will plug in FS Access API).
 *   3. Bridge every worker-originated DataChannel call to a real
 *      `RTCDataChannel` on the PC, and forward every DC event back.
 *
 * The worker does everything else — chunking, hashing, encryption, framing,
 * backpressure pacing — off the main thread so the UI never freezes.
 */

import type { FileSinkFactory } from "../types.js";
import type {
  ChannelId,
  M2WMessage,
  RequestId,
  SerializableTransferEvent,
  W2MMessage,
  W2M_SinkRequest,
  WorkerFileInput,
} from "./workerProtocol.js";

export type WorkerTransferEvent =
  | Exclude<SerializableTransferEvent, { type: "error" }>
  | { type: "error"; transferId: string; error: Error };

export interface WorkerTransferHostOptions {
  /** Either a pre-constructed Worker or a URL to spawn one from. */
  worker: Worker | WorkerFactory;
  /** Real RTCPeerConnection (created + negotiated by host code). */
  peerConnection: RTCPeerConnection;
  /** Bound FileSinkFactory used when running a receive session. */
  sinkFactory?: FileSinkFactory;
  /** Forwarded to the worker on startup (e.g. default progress interval). */
  init?: Extract<M2WMessage, { type: "init" }>;
}

export interface WorkerFactory {
  (): Worker;
}

export interface SendOptions {
  chunkSize?: number;
  bufferHighWater?: number;
  bufferLowWater?: number;
  lanes?: number;
  encryptionPassphrase?: string;
  progressIntervalMs?: number;
  onEvent?: (e: WorkerTransferEvent) => void;
}

export interface ReceiveOptions {
  encryptionPassphrase?: string;
  progressIntervalMs?: number;
  autoAccept?: boolean;
  onEvent?: (e: WorkerTransferEvent) => void;
  /**
   * How received bytes reach disk.
   *   - { kind: "fsaccess", directory }: worker streams directly into a
   *     FileSystemDirectoryHandle (O(1) memory, Chrome/Edge).
   *   - { kind: "proxy" }: worker round-trips each write to the main thread,
   *     which must have a `sinkFactory` installed. Default.
   */
  sink?:
    | { kind: "proxy" }
    | {
        kind: "fsaccess";
        directory: FileSystemDirectoryHandle;
        createSubdirectories?: boolean;
      };
}

interface BridgedChannel {
  id: ChannelId;
  label: string;
  dc: RTCDataChannel;
  /** True if the worker created this channel (via ch:create). */
  localOriginated: boolean;
  /** Cached low-water threshold so we can re-apply it on restart. */
  lowWater: number;
}

export class WorkerTransferHost {
  private readonly worker: Worker;
  private readonly pc: RTCPeerConnection;
  private readonly channels = new Map<ChannelId, BridgedChannel>();
  private sinkFactory: FileSinkFactory | null;
  /** Sinks keyed by the handle id the worker assigned. */
  private sinks = new Map<number, ReturnType<FileSinkFactory["open"]> extends Promise<infer S> ? S : never>();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private activeSession: {
    role: "send" | "receive";
    resolve: () => void;
    reject: (e: Error) => void;
    onEvent?: (e: WorkerTransferEvent) => void;
  } | null = null;

  constructor(opts: WorkerTransferHostOptions) {
    this.worker = typeof opts.worker === "function" ? opts.worker() : opts.worker;
    this.pc = opts.peerConnection;
    this.sinkFactory = opts.sinkFactory ?? null;
    this.ready = new Promise<void>((r) => {
      this.readyResolve = r;
    });
    this.worker.addEventListener("message", this.onWorkerMessage);
    this.pc.addEventListener("datachannel", this.onRemoteDataChannel);
    if (opts.init) this.worker.postMessage(opts.init);
  }

  setSinkFactory(f: FileSinkFactory): void {
    this.sinkFactory = f;
  }

  /** Run a send session; resolves on `complete`, rejects on error/abort. */
  async send(
    transferId: string,
    files: File[] | WorkerFileInput[],
    options: SendOptions = {},
  ): Promise<void> {
    await this.ready;
    if (this.activeSession) throw new Error("worker host already running a session");
    const inputs: WorkerFileInput[] = files.map((f, i) => {
      if (isWorkerFileInput(f)) return f;
      const file = f;
      const entry: WorkerFileInput = {
        kind: "blob",
        id: i + 1,
        name: file.name,
        size: file.size,
        blob: file,
      };
      if (file.type) entry.mime = file.type;
      const rel = (file as { webkitRelativePath?: string }).webkitRelativePath;
      if (rel) entry.relativePath = rel;
      return entry;
    });
    const { onEvent, ...transport } = options;
    return new Promise<void>((resolve, reject) => {
      this.activeSession = { role: "send", resolve, reject, ...(onEvent ? { onEvent } : {}) };
      this.worker.postMessage({
        type: "send",
        transferId,
        files: inputs,
        options: transport,
      } satisfies M2WMessage);
    });
  }

  /** Run a receive session; resolves on `complete`, rejects on error/abort. */
  async receive(options: ReceiveOptions = {}): Promise<void> {
    await this.ready;
    if (this.activeSession) throw new Error("worker host already running a session");
    const { onEvent, sink, ...transport } = options;
    const sinkConfig: Extract<M2WMessage, { type: "receive" }>["sink"] = sink ?? { kind: "proxy" };
    if (sinkConfig.kind === "proxy" && !this.sinkFactory) {
      throw new Error("receive({sink:'proxy'}) requires a host-side sinkFactory");
    }
    return new Promise<void>((resolve, reject) => {
      this.activeSession = { role: "receive", resolve, reject, ...(onEvent ? { onEvent } : {}) };
      const msg: Extract<M2WMessage, { type: "receive" }> = {
        type: "receive",
        options: transport,
        sink:
          sinkConfig.kind === "fsaccess"
            ? {
                kind: "fsaccess",
                directory: sinkConfig.directory,
                ...(sinkConfig.createSubdirectories !== undefined
                  ? { createSubdirectories: sinkConfig.createSubdirectories }
                  : {}),
              }
            : { kind: "proxy" },
      };
      this.worker.postMessage(msg);
    });
  }

  abort(reason = "abort"): void {
    this.worker.postMessage({ type: "abort", reason } satisfies M2WMessage);
  }

  dispose(): void {
    this.worker.removeEventListener("message", this.onWorkerMessage);
    this.pc.removeEventListener("datachannel", this.onRemoteDataChannel);
    for (const c of this.channels.values()) {
      try {
        c.dc.close();
      } catch {
        /* ignore */
      }
    }
    this.channels.clear();
    this.sinks.clear();
    this.worker.terminate();
  }

  /* ─────────────── Worker → Main ─────────────── */

  private onWorkerMessage = (ev: MessageEvent<W2MMessage>): void => {
    const msg = ev.data;
    switch (msg.type) {
      case "ready":
        this.readyResolve();
        break;
      case "ch:create":
        this.hostCreateChannel(msg);
        break;
      case "ch:send":
        this.hostSendChannel(msg);
        break;
      case "ch:close":
        this.hostCloseChannel(msg.channelId);
        break;
      case "ch:threshold": {
        const b = this.channels.get(msg.channelId);
        if (b) {
          b.lowWater = msg.bufferedAmountLowThreshold;
          b.dc.bufferedAmountLowThreshold = msg.bufferedAmountLowThreshold;
        }
        break;
      }
      case "event":
        this.dispatchEvent(msg.event);
        break;
      case "done":
        this.completeSession(msg.ok, msg.error);
        break;
      case "sink:req":
        void this.handleSinkRequest(msg);
        break;
    }
  };

  private hostCreateChannel(
    msg: Extract<W2MMessage, { type: "ch:create" }>,
  ): void {
    const dc = this.pc.createDataChannel(msg.label, {
      ordered: msg.init?.ordered ?? true,
      ...(msg.init?.maxRetransmits !== undefined
        ? { maxRetransmits: msg.init.maxRetransmits }
        : {}),
    });
    dc.binaryType = "arraybuffer";
    this.wireRealChannel(msg.channelId, dc, /* local */ true);
  }

  private onRemoteDataChannel = (ev: RTCDataChannelEvent): void => {
    // Assign an id that won't clash with worker-originated ids (worker counts
    // up from 1; we count down from 2^31-1 for remotes).
    const id = this.nextRemoteId();
    const dc = ev.channel;
    dc.binaryType = "arraybuffer";
    this.wireRealChannel(id, dc, /* local */ false);
  };

  private remoteIdCounter = 0x7fffffff;
  private nextRemoteId(): ChannelId {
    return this.remoteIdCounter--;
  }

  private wireRealChannel(id: ChannelId, dc: RTCDataChannel, local: boolean): void {
    const bridged: BridgedChannel = { id, label: dc.label, dc, localOriginated: local, lowWater: 0 };
    this.channels.set(id, bridged);

    const announceOpen = (): void => {
      this.worker.postMessage({
        type: "ch:opened",
        channelId: id,
        label: dc.label,
        bufferedAmount: dc.bufferedAmount,
        local,
      } satisfies M2WMessage);
    };

    if (dc.readyState === "open") {
      announceOpen();
    } else {
      dc.addEventListener("open", announceOpen, { once: true });
    }

    dc.addEventListener("message", (ev) => {
      const data = ev.data;
      if (typeof data === "string") {
        this.worker.postMessage({
          type: "ch:msg",
          channelId: id,
          text: data,
        } satisfies M2WMessage);
      } else if (data instanceof ArrayBuffer) {
        // Copy — we can't transfer `data` because the browser still owns it.
        const buf = data.slice(0);
        this.worker.postMessage(
          { type: "ch:msg", channelId: id, bin: buf } satisfies M2WMessage,
          [buf],
        );
      } else if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        const buf = new Uint8Array(view.byteLength);
        buf.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        this.worker.postMessage(
          { type: "ch:msg", channelId: id, bin: buf.buffer } satisfies M2WMessage,
          [buf.buffer],
        );
      }
    });

    dc.addEventListener("bufferedamountlow", () => {
      this.worker.postMessage({
        type: "ch:state",
        channelId: id,
        readyState: dc.readyState,
        bufferedAmount: dc.bufferedAmount,
        bufferedAmountLow: true,
      } satisfies M2WMessage);
    });

    dc.addEventListener("close", () => {
      this.worker.postMessage({
        type: "ch:closed",
        channelId: id,
      } satisfies M2WMessage);
      this.channels.delete(id);
    });

    dc.addEventListener("error", (ev) => {
      const anyEv = ev as Event & { error?: { message?: string } };
      this.worker.postMessage({
        type: "ch:error",
        channelId: id,
        message: anyEv.error?.message ?? "datachannel error",
      } satisfies M2WMessage);
    });
  }

  private hostSendChannel(msg: Extract<W2MMessage, { type: "ch:send" }>): void {
    const b = this.channels.get(msg.channelId);
    if (!b) return;
    if (typeof msg.text === "string") {
      b.dc.send(msg.text);
    } else if (msg.bin) {
      b.dc.send(msg.bin);
    }
    // Feed the post-send bufferedAmount back into the worker so its local
    // watermark tracking converges with reality.
    this.worker.postMessage({
      type: "ch:state",
      channelId: msg.channelId,
      readyState: b.dc.readyState,
      bufferedAmount: b.dc.bufferedAmount,
    } satisfies M2WMessage);
  }

  private hostCloseChannel(id: ChannelId): void {
    const b = this.channels.get(id);
    if (!b) return;
    try {
      b.dc.close();
    } catch {
      /* ignore */
    }
  }

  private dispatchEvent(event: SerializableTransferEvent): void {
    const evt: WorkerTransferEvent =
      event.type === "error"
        ? {
            type: "error",
            transferId: event.transferId,
            error: Object.assign(new Error(event.error.message), {
              name: event.error.name ?? "Error",
              stack: event.error.stack,
            }),
          }
        : event;
    this.activeSession?.onEvent?.(evt);
  }

  private completeSession(ok: boolean, error?: string): void {
    const s = this.activeSession;
    if (!s) return;
    this.activeSession = null;
    if (ok) s.resolve();
    else s.reject(new Error(error ?? "worker session failed"));
  }

  /* ─────────────── Sink proxy responder ─────────────── */

  private async handleSinkRequest(msg: W2M_SinkRequest): Promise<void> {
    const respond = (ok: boolean, value?: unknown, error?: string): void => {
      const payload: M2WMessage = { type: "sink:resp", requestId: msg.requestId, ok };
      if (value !== undefined) payload.value = value;
      if (error !== undefined) payload.error = error;
      this.worker.postMessage(payload);
    };
    try {
      const factory = this.sinkFactory;
      if (!factory) throw new Error("no sinkFactory on host");
      const c = msg.call;
      switch (c.kind) {
        case "resumeOffsetFor": {
          const v = await factory.resumeOffsetFor(c.file);
          respond(true, v);
          return;
        }
        case "open": {
          const sink = await factory.open(c.file);
          this.sinks.set(c.handle, sink);
          respond(true);
          return;
        }
        case "begin": {
          const sink = this.sinks.get(c.handle);
          if (!sink) throw new Error(`no sink for handle ${c.handle}`);
          await sink.begin(c.file, c.resumeOffset);
          respond(true);
          return;
        }
        case "write": {
          const sink = this.sinks.get(c.handle);
          if (!sink) throw new Error(`no sink for handle ${c.handle}`);
          await sink.write(c.offset, new Uint8Array(c.bytes));
          respond(true);
          return;
        }
        case "finish": {
          const sink = this.sinks.get(c.handle);
          if (!sink) throw new Error(`no sink for handle ${c.handle}`);
          await sink.finish(c.sha256);
          this.sinks.delete(c.handle);
          respond(true);
          return;
        }
        case "abort": {
          const sink = this.sinks.get(c.handle);
          if (sink) await sink.abort(c.reason);
          this.sinks.delete(c.handle);
          respond(true);
          return;
        }
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      respond(false, undefined, e.message);
    }
  }
}

function isWorkerFileInput(v: unknown): v is WorkerFileInput {
  return !!v && typeof v === "object" && "kind" in v && "id" in v;
}
