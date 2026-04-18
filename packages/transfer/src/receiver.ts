import {
  decodeFrame,
  type ControlMsg,
  type Manifest,
} from "@dropbeam/protocol";
import { decryptChunk, deriveKey } from "./encryption.js";
import { type DataChannel, type PeerConnection } from "./peer.js";
import type {
  FileSink,
  FileSinkFactory,
  ProgressEvent,
  TransferEvent,
} from "./types.js";

export interface ReceiverOptions {
  sinkFactory: FileSinkFactory;
  /** Required if sender encrypted. Same passphrase, transmitted out-of-band. */
  encryptionPassphrase?: string;
  onEvent?: (e: TransferEvent) => void;
  progressIntervalMs?: number;
  /** Auto-accept manifests; if false, you must call `accept()` yourself. */
  autoAccept?: boolean;
}

interface FileState {
  manifestEntry: Manifest["files"][number];
  sink: FileSink;
  resumeOffset: number;
  /** Running count of NEW bytes written during this session (excludes prefill). */
  bytesReceived: number;
  done: boolean;
}

export class TransferReceiver {
  private control: DataChannel | null = null;
  private lanes: DataChannel[] = [];
  private files = new Map<number, FileState>();
  private currentManifest: Manifest | null = null;
  private cryptoKey: CryptoKey | undefined;
  private startedAt = 0;
  private totalBytes = 0;
  /** Sum of (resumeOffset across all files) + new bytes written. */
  private totalReceived = 0;
  private lastProgressAt = 0;
  private completeResolve: (() => void) | null = null;
  private completeReject: ((e: Error) => void) | null = null;

  /** Serialize async control-message handlers so file-end always lands before complete. */
  private controlQueue: Promise<void> = Promise.resolve();

  private readonly emit: (e: TransferEvent) => void;
  private readonly progressMs: number;
  private readonly autoAccept: boolean;

  constructor(
    private readonly pc: PeerConnection,
    private readonly opts: ReceiverOptions,
  ) {
    this.emit = opts.onEvent ?? (() => {});
    this.progressMs = opts.progressIntervalMs ?? 250;
    this.autoAccept = opts.autoAccept ?? true;
  }

  /** Wire `pc.ondatachannel`. Call BEFORE setRemoteDescription on the offer. */
  attach(): void {
    this.pc.ondatachannel = (ch) => this.adoptChannel(ch);
  }

  /** Returns when the whole transfer (all files) finishes or fails. */
  done(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.completeResolve = resolve;
      this.completeReject = reject;
    });
  }

  private adoptChannel(ch: DataChannel): void {
    ch.binaryType = "arraybuffer";
    if (ch.label === "control") {
      this.control = ch;
      ch.onmessage = (data) => {
        if (typeof data === "string") this.enqueueControl(data);
      };
      ch.onclose = () => {
        // Drain the serial queue first — the 'complete' control message may
        // already be queued but not yet processed when the channel fires onclose.
        this.controlQueue.then(() => {
          if (!this.allDone()) this.fail(new Error("control channel closed"));
        });
      };
    } else if (ch.label.startsWith("data-")) {
      this.lanes.push(ch);
      ch.onmessage = (data) => {
        if (typeof data !== "string") {
          // Datachannel can hand us either an ArrayBuffer or a Uint8Array
          // depending on the runtime; normalize.
          const ab = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
          // Important: we enqueue onto the same serial queue so writes don't race
          // with file-end / complete control messages.
          this.enqueueData(new Uint8Array(ab as ArrayBuffer));
        }
      };
    }
  }

  private enqueueControl(text: string): void {
    this.controlQueue = this.controlQueue.then(() => this.onControl(text)).catch((e) => {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    });
  }

  private enqueueData(buf: Uint8Array): void {
    this.controlQueue = this.controlQueue.then(() => this.onDataFrame(buf)).catch((e) => {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    });
  }

  private async onControl(text: string): Promise<void> {
    let msg: ControlMsg;
    try {
      msg = JSON.parse(text) as ControlMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case "manifest":
        await this.onManifest(msg);
        break;
      case "file-start":
        break;
      case "file-end":
        await this.onFileEnd(msg.fileId, msg.sha256);
        break;
      case "complete":
        await this.onComplete();
        break;
      case "abort":
        this.fail(new Error(`sender aborted: ${msg.reason}`));
        break;
      case "pause":
        this.emit({ type: "paused", transferId: msg.transferId });
        break;
      case "resume":
        this.emit({ type: "resumed", transferId: msg.transferId });
        break;
    }
  }

  private async onManifest(m: Manifest): Promise<void> {
    this.currentManifest = m;
    this.totalBytes = m.totalBytes;
    this.totalReceived = 0;
    this.startedAt = Date.now();
    this.files.clear();

    if (m.encryption) {
      if (!this.opts.encryptionPassphrase) {
        this.sendControl({
          type: "manifest-ack",
          transferId: m.transferId,
          accept: false,
          reason: "encryption-passphrase-required",
        });
        // Don't fail the done() promise — host may opt to retry with a passphrase.
        // But for the typical case we should signal completion of the negotiation
        // failure so callers don't hang. Surface as an error.
        this.fail(new Error("encryption-passphrase-required"));
        return;
      }
      this.cryptoKey = await deriveKey(this.opts.encryptionPassphrase, m.encryption.salt);
    }

    const resumeFrom: Record<number, number> = {};
    for (const f of m.files) {
      const offset = await this.opts.sinkFactory.resumeOffsetFor(f);
      const sink = await this.opts.sinkFactory.open(f);
      await sink.begin(f, offset);
      this.files.set(f.id, {
        manifestEntry: f,
        sink,
        resumeOffset: offset,
        bytesReceived: 0,
        done: offset >= f.size, // already complete from a prior session
      });
      if (offset > 0) resumeFrom[f.id] = offset;
      this.totalReceived += offset;
    }

    this.emit({
      type: "manifest",
      transferId: m.transferId,
      files: m.files.map((f) => ({ id: f.id, name: f.name, size: f.size })),
      totalBytes: m.totalBytes,
    });

    if (this.autoAccept) {
      this.sendControl({
        type: "manifest-ack",
        transferId: m.transferId,
        accept: true,
        resumeFrom: Object.keys(resumeFrom).length ? resumeFrom : undefined,
      });
      this.emit({ type: "started", transferId: m.transferId });
    }
  }

  private async onDataFrame(buf: Uint8Array): Promise<void> {
    if (!this.currentManifest) return;
    const { header, payload } = decodeFrame(buf);
    const file = this.files.get(header.fileId);
    if (!file || file.done) return;

    let plaintext: Uint8Array;
    if (header.encrypted) {
      if (!this.cryptoKey) {
        this.fail(new Error("encrypted frame without key"));
        return;
      }
      plaintext = await decryptChunk(this.cryptoKey, payload);
    } else {
      plaintext = payload;
    }

    const offset = header.chunkIndex * this.currentManifest.chunkSize;
    if (offset + plaintext.byteLength <= file.resumeOffset) {
      // Entirely covered by prefill; sender shouldn't send this but be tolerant.
      return;
    }
    await file.sink.write(offset, plaintext);
    file.bytesReceived += plaintext.byteLength;
    this.totalReceived += plaintext.byteLength;
    this.maybeEmitProgress(file);
  }

  private maybeEmitProgress(file: FileState): void {
    const now = Date.now();
    if (now - this.lastProgressAt < this.progressMs) return;
    if (!this.currentManifest) return;
    this.lastProgressAt = now;
    const elapsed = (now - this.startedAt) / 1000;
    const bps = elapsed > 0 ? (this.totalReceived - this.initialResumeTotal()) / elapsed : 0;
    const remaining = this.totalBytes - this.totalReceived;
    const eta = bps > 0 ? remaining / bps : NaN;
    const ev: ProgressEvent = {
      fileId: file.manifestEntry.id,
      fileName: file.manifestEntry.name,
      bytesTransferred: file.resumeOffset + file.bytesReceived,
      fileSize: file.manifestEntry.size,
      totalBytesTransferred: this.totalReceived,
      totalBytes: this.totalBytes,
      bytesPerSecond: bps,
      etaSeconds: eta,
    };
    this.emit({ type: "progress", transferId: this.currentManifest.transferId, ...ev });
  }

  private initialResumeTotal(): number {
    let n = 0;
    for (const f of this.files.values()) n += f.resumeOffset;
    return n;
  }

  private async onFileEnd(fileId: number, sha: string): Promise<void> {
    const file = this.files.get(fileId);
    if (!file || !this.currentManifest) return;
    // v1: trust the sender-supplied sha + DTLS integrity. Sinks may verify
    // independently (e.g. by re-reading the file from disk). We pass it
    // through to sink.finish() so the sink can record/verify if desired.
    await file.sink.finish(sha);
    file.done = true;
    this.emit({
      type: "file-done",
      transferId: this.currentManifest.transferId,
      fileId,
      sha256: sha,
    });
  }

  private allDone(): boolean {
    if (this.files.size === 0) return false;
    for (const f of this.files.values()) if (!f.done) return false;
    return true;
  }

  private async onComplete(): Promise<void> {
    if (!this.currentManifest) return;
    if (!this.allDone()) {
      this.fail(new Error("complete before all files finished"));
      return;
    }
    this.emit({ type: "complete", transferId: this.currentManifest.transferId });
    this.completeResolve?.();
    this.completeResolve = null;
    this.completeReject = null;
  }

  private fail(err: Error): void {
    if (this.currentManifest) {
      this.emit({ type: "error", transferId: this.currentManifest.transferId, error: err });
    }
    this.completeReject?.(err);
    this.completeResolve = null;
    this.completeReject = null;
  }

  private sendControl(m: ControlMsg): void {
    if (this.control?.readyState === "open") this.control.send(JSON.stringify(m));
  }
}
