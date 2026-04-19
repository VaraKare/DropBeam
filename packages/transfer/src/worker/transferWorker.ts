/**
 * Dedicated Web Worker entry point for the DropBeam transfer engine.
 *
 * Host usage (main thread, bundler-aware):
 *   new Worker(new URL("@dropbeam/transfer/worker/transferWorker", import.meta.url),
 *              { type: "module" })
 *
 * The worker sits behind a message protocol (see `workerProtocol.ts`) and
 * drives either `TransferSender` or `TransferReceiver` against a proxied
 * `PeerConnection` whose data channels are bridged to real
 * `RTCDataChannel`s on the main thread.
 */

/// <reference lib="webworker" />

import { TransferReceiver } from "../receiver.js";
import { TransferSender } from "../sender.js";
import { createFileSystemAccessSinkFactory } from "../sinks/fsAccessSink.js";
import type { FileSinkFactory, TransferEvent } from "../types.js";
import { ProxiedPeerConnection } from "./proxiedPeer.js";
import { createWorkerFileSource } from "./workerFileSource.js";
import { createWorkerSinkProxy, type SinkTransport } from "./workerSinkProxy.js";
import type {
  ChannelId,
  M2WMessage,
  RequestId,
  SerializableTransferEvent,
  W2MMessage,
} from "./workerProtocol.js";

type Scope = DedicatedWorkerGlobalScope;
const scope = self as unknown as Scope;

function post(msg: W2MMessage, transfer?: Transferable[]): void {
  if (transfer && transfer.length) scope.postMessage(msg, transfer);
  else scope.postMessage(msg);
}

// The main thread can send us a lot of incoming-channel events before our
// receiver has attached its `ondatachannel` callback. Buffer them.
interface PendingIncoming {
  channelId: ChannelId;
  label: string;
  bufferedAmount: number;
}

class WorkerSession {
  private pc: ProxiedPeerConnection | null = null;
  private pendingIncoming: PendingIncoming[] = [];
  private activeRole: "sender" | "receiver" | null = null;
  private sender: TransferSender | null = null;
  private receiver: TransferReceiver | null = null;
  private sinkResponseHook:
    | ((requestId: RequestId, ok: boolean, value?: unknown, error?: string) => void)
    | null = null;

  handle(msg: M2WMessage): void {
    switch (msg.type) {
      case "init":
        // Reserved for future config. No-op for now.
        break;
      case "send":
        void this.startSend(msg);
        break;
      case "receive":
        this.startReceive(msg);
        break;
      case "abort":
        this.sender?.abort(msg.reason ?? "abort");
        break;
      case "ch:opened": {
        const ch = this.pc?._channel(msg.channelId);
        if (ch) {
          ch._onOpen(msg.bufferedAmount);
        } else if (!msg.local) {
          // Remote-initiated channel (receiver path).
          if (this.pc) {
            this.pc._adoptRemoteChannel(msg.channelId, msg.label, msg.bufferedAmount);
          } else {
            this.pendingIncoming.push({
              channelId: msg.channelId,
              label: msg.label,
              bufferedAmount: msg.bufferedAmount,
            });
          }
        }
        break;
      }
      case "ch:msg":
        this.pc?._channel(msg.channelId)?._onMessage(msg);
        break;
      case "ch:state":
        this.pc?._channel(msg.channelId)?._onState(msg);
        break;
      case "ch:closed": {
        const ch = this.pc?._channel(msg.channelId);
        ch?._onClose();
        this.pc?._forgetChannel(msg.channelId);
        break;
      }
      case "ch:error":
        this.pc?._channel(msg.channelId)?._onError(new Error(msg.message));
        break;
      case "sink:resp":
        this.sinkResponseHook?.(msg.requestId, msg.ok, msg.value, msg.error);
        break;
    }
  }

  private ensurePC(): ProxiedPeerConnection {
    if (!this.pc) this.pc = new ProxiedPeerConnection({ postMessage: post });
    return this.pc;
  }

  private drainPendingIncoming(): void {
    if (!this.pc || this.pendingIncoming.length === 0) return;
    const pending = this.pendingIncoming;
    this.pendingIncoming = [];
    for (const p of pending) {
      this.pc._adoptRemoteChannel(p.channelId, p.label, p.bufferedAmount);
    }
  }

  private emitEvent(e: TransferEvent): void {
    const serial: SerializableTransferEvent =
      e.type === "error"
        ? {
            type: "error",
            transferId: e.transferId,
            error: {
              message: e.error.message,
              ...(e.error.name !== undefined ? { name: e.error.name } : {}),
              ...(e.error.stack !== undefined ? { stack: e.error.stack } : {}),
            },
          }
        : e;
    post({ type: "event", event: serial });
  }

  private async startSend(msg: Extract<M2WMessage, { type: "send" }>): Promise<void> {
    if (this.activeRole) {
      this.finishWithError("worker already busy");
      return;
    }
    this.activeRole = "sender";
    const pc = this.ensurePC();
    const sources = msg.files.map(createWorkerFileSource);
    const sender = new TransferSender(pc, {
      ...msg.options,
      onEvent: (e) => this.emitEvent(e),
    });
    this.sender = sender;
    sender.prepareChannels();
    try {
      await sender.send(msg.transferId, sources);
      post({ type: "done", ok: true });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      post({ type: "done", ok: false, error: e.message });
    } finally {
      this.activeRole = null;
      this.sender = null;
    }
  }

  private startReceive(msg: Extract<M2WMessage, { type: "receive" }>): void {
    if (this.activeRole) {
      this.finishWithError("worker already busy");
      return;
    }
    this.activeRole = "receiver";
    const pc = this.ensurePC();
    const sinkFactory = this.buildSinkFactory(msg.sink);
    const options = {
      ...msg.options,
      sinkFactory,
      onEvent: (e: TransferEvent) => this.emitEvent(e),
    };
    const receiver = new TransferReceiver(pc, options);
    this.receiver = receiver;
    receiver.attach();
    // Any incoming channels that landed before `attach()` ran are now ready
    // to be adopted. `attach()` wired `ondatachannel`, so this is safe.
    this.drainPendingIncoming();
    receiver
      .done()
      .then(() => post({ type: "done", ok: true }))
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        post({ type: "done", ok: false, error: e.message });
      })
      .finally(() => {
        this.activeRole = null;
        this.receiver = null;
      });
  }

  private buildSinkFactory(
    sink: Extract<M2WMessage, { type: "receive" }>["sink"],
  ): FileSinkFactory {
    if (sink.kind === "fsaccess") {
      const dir = sink.directory as Parameters<
        typeof createFileSystemAccessSinkFactory
      >[0]["root"];
      return createFileSystemAccessSinkFactory({
        root: dir,
        ...(sink.createSubdirectories !== undefined
          ? { createSubdirectories: sink.createSubdirectories }
          : {}),
      });
    }
    const sinkTransport: SinkTransport = {
      postMessage: post,
      onResponse: (hook) => {
        this.sinkResponseHook = hook;
        return () => {
          if (this.sinkResponseHook === hook) this.sinkResponseHook = null;
        };
      },
    };
    return createWorkerSinkProxy(sinkTransport);
  }

  private finishWithError(message: string): void {
    post({ type: "done", ok: false, error: message });
  }
}

const session = new WorkerSession();

scope.addEventListener("message", (ev: MessageEvent<M2WMessage>) => {
  session.handle(ev.data);
});

post({ type: "ready" });
