import {
  CREDIT_STEP,
  DEFAULT_FLOW_WINDOW,
  MIN_FLOW_WINDOW,
  PROTOCOL_VERSION,
  decodeFrame,
  parseControlMsg,
  validateManifest,
  type ControlMsg,
  type Manifest,
} from "@dropbeam/protocol";
import { sha256OfStream } from "./checksum.js";
import { chunkAad, decryptChunk, deriveKey } from "./encryption.js";
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
  /**
   * Flow-control window advertised to the sender (ADR-001): the most encoded
   * frame bytes that may be queued here, unwritten, at any moment.
   */
  flowWindow?: number;
}

interface FileState {
  manifestEntry: Manifest["files"][number];
  sink: FileSink;
  /** Leading bytes already on disk from an earlier session. */
  resumeOffset: number;
  /** First chunk the sender will send (the one containing `resumeOffset`). */
  startChunk: number;
  /** Total chunks in the file (0 for an empty file). */
  totalChunks: number;
  /** One bit per chunk index ≥ startChunk; catches duplicates and gaps exactly. */
  seen: Uint8Array;
  chunksGot: number;
  /** NEW bytes written during this session (excludes the resume prefix). */
  bytesReceived: number;
  /**
   * sha256 from the sender's `file-end`, once it has arrived. `file-end` comes
   * over the control channel and can overtake this file's last data frames
   * (which ride separate, independently-ordered lanes), so we only finish the
   * file once *both* the end marker and every chunk are in.
   */
  pendingSha: string | null;
  /** Finalized: renamed to its final name and verified. */
  finished: boolean;
}

/** A peer broke the protocol; the transfer stops with this reason. */
class ProtocolError extends Error {
  constructor(detail: string) {
    super(`protocol-error: ${detail}`);
  }
}

export class TransferReceiver {
  private control: DataChannel | null = null;
  private lanes: DataChannel[] = [];
  private files = new Map<number, FileState>();
  private currentManifest: Manifest | null = null;
  /** A manifest has been received (even one we rejected); a second one is a protocol error. */
  private sawManifest = false;
  private cryptoKey: CryptoKey | undefined;
  private startedAt = 0;
  private totalBytes = 0;
  /** Sum of (resumeOffset across all files) + new bytes written. */
  private totalReceived = 0;
  private lastProgressAt = 0;
  /** Set once the transfer has failed; later frames are ignored. */
  private failed = false;
  /** Sender sent `complete`; finalize as soon as the last file is fully written. */
  private completeRequested = false;
  private completeResolve: (() => void) | null = null;
  private completeReject: ((e: Error) => void) | null = null;

  // Flow control (ADR-001).
  private readonly window: number;
  /** Credit at least every window/4 bytes (≤ CREDIT_STEP) so the sender can never deadlock. */
  private readonly creditStep: number;
  /** Encoded frame bytes fully processed (written or skipped). */
  private consumed = 0;
  private lastCredited = 0;
  /** Encoded frame bytes received but not yet processed (held in memory). */
  private queued = 0;
  private peakQueued = 0;

  /** Serialize async handlers so writes, file-end and complete never race. */
  private queue: Promise<void> = Promise.resolve();

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
    this.window = Math.max(MIN_FLOW_WINDOW, opts.flowWindow ?? DEFAULT_FLOW_WINDOW);
    this.creditStep = Math.min(CREDIT_STEP, Math.floor(this.window / 4));
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

  /** Largest number of unprocessed frame bytes held in memory so far (diagnostics/tests). */
  get peakQueuedBytes(): number {
    return this.peakQueued;
  }

  private adoptChannel(ch: DataChannel): void {
    ch.binaryType = "arraybuffer";
    if (ch.label === "control") {
      this.control = ch;
      ch.onmessage = (data) => {
        if (typeof data === "string") this.enqueue(() => this.onControl(data));
      };
      ch.onclose = () => {
        // Drain the queue first — 'complete' may already be queued but not
        // yet processed when the channel fires onclose.
        void this.queue.then(() => {
          if (!this.allDone()) this.fail(new Error("control channel closed"));
        });
      };
    } else if (ch.label.startsWith("data-")) {
      this.lanes.push(ch);
      ch.onmessage = (data) => {
        if (typeof data === "string") return;
        // Datachannels hand us an ArrayBuffer or a view depending on the runtime.
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(
                (data as ArrayBufferView).buffer,
                (data as ArrayBufferView).byteOffset,
                (data as ArrayBufferView).byteLength,
              );
        this.queued += bytes.byteLength;
        if (this.queued > this.peakQueued) this.peakQueued = this.queued;
        this.enqueue(async () => {
          try {
            await this.onDataFrame(bytes);
          } finally {
            this.queued -= bytes.byteLength;
            this.consumed += bytes.byteLength;
            this.maybeCredit();
          }
        });
      };
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((e) => {
      const err = e instanceof Error ? e : new Error(String(e));
      if (e instanceof ProtocolError) this.abort(err.message);
      else this.fail(err);
    });
  }

  private maybeCredit(): void {
    if (this.failed || !this.currentManifest) return;
    if (this.consumed - this.lastCredited < this.creditStep) return;
    this.lastCredited = this.consumed;
    this.sendControl({ type: "credit", transferId: this.currentManifest.transferId, consumed: this.consumed });
  }

  private async onControl(text: string): Promise<void> {
    if (this.failed) return;
    const msg = parseControlMsg(text);
    if (!msg) return; // malformed or unknown: ignore
    if (msg.type !== "manifest" && msg.transferId !== this.currentManifest?.transferId) return;
    switch (msg.type) {
      case "manifest":
        await this.onManifest(msg);
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
      default:
        break;
    }
  }

  /** Refuse the manifest with a reason the sender will show, and fail locally. */
  private reject(transferId: string, reason: string): void {
    this.sendControl({ type: "manifest-ack", transferId, accept: false, reason });
    this.fail(new Error(reason));
  }

  private async onManifest(m: Manifest): Promise<void> {
    if (this.sawManifest) throw new ProtocolError("unexpected second manifest");
    this.sawManifest = true;
    // Set before any rejection so errors carry the transferId; no file is
    // opened until validation has passed.
    this.currentManifest = m;

    if (m.protocol !== PROTOCOL_VERSION) return this.reject(m.transferId, "version-mismatch");
    const invalid = validateManifest(m);
    if (invalid) return this.reject(m.transferId, invalid);

    if (m.encryption) {
      if (!this.opts.encryptionPassphrase) return this.reject(m.transferId, "encryption-passphrase-required");
      this.cryptoKey = await deriveKey(this.opts.encryptionPassphrase, m.encryption.salt);
    }

    // Resume offsets: trust the sink only for values strictly inside the file.
    const offsets = new Map<number, number>();
    for (const f of m.files) {
      const off = await this.opts.sinkFactory.resumeOffsetFor(f);
      offsets.set(f.id, Number.isSafeInteger(off) && off > 0 && off < f.size ? off : 0);
    }

    // Fail up front (before any bytes move) if the destination can't hold it.
    if (this.opts.sinkFactory.checkCapacity) {
      let alreadyHave = 0;
      for (const off of offsets.values()) alreadyHave += off;
      const problem = await this.opts.sinkFactory.checkCapacity(m.totalBytes - alreadyHave);
      if (problem) return this.reject(m.transferId, problem);
    }

    this.totalBytes = m.totalBytes;
    this.totalReceived = 0;
    this.startedAt = Date.now();

    const resumeFrom: Record<number, number> = {};
    for (const f of m.files) {
      const offset = offsets.get(f.id) ?? 0;
      const sink = await this.opts.sinkFactory.open(f);
      await sink.begin(f, offset);
      const totalChunks = Math.ceil(f.size / m.chunkSize);
      const startChunk = Math.floor(offset / m.chunkSize);
      this.files.set(f.id, {
        manifestEntry: f,
        sink,
        resumeOffset: offset,
        startChunk,
        totalChunks,
        seen: new Uint8Array(Math.ceil((totalChunks - startChunk) / 8)),
        chunksGot: 0,
        bytesReceived: 0,
        pendingSha: null,
        finished: false,
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
        window: this.window,
        resumeFrom: Object.keys(resumeFrom).length ? resumeFrom : undefined,
      });
      this.emit({ type: "started", transferId: m.transferId });
    }
  }

  private async onDataFrame(buf: Uint8Array): Promise<void> {
    if (this.failed) return;
    const m = this.currentManifest;
    if (!m) throw new ProtocolError("data before manifest");

    let decoded: ReturnType<typeof decodeFrame>;
    try {
      decoded = decodeFrame(buf);
    } catch (e) {
      throw new ProtocolError((e as Error).message);
    }
    const { header, payload } = decoded;
    if (header.payloadLength !== buf.byteLength - 16) throw new ProtocolError("trailing bytes after frame");
    const file = this.files.get(header.fileId);
    if (!file) throw new ProtocolError(`unknown file ${header.fileId}`);
    if (header.encrypted !== !!m.encryption) throw new ProtocolError("encryption flag mismatch");
    const idx = header.chunkIndex;
    if (idx < file.startChunk || idx >= file.totalChunks) throw new ProtocolError(`chunk ${idx} out of range`);
    const rel = idx - file.startChunk;
    const bit = 1 << (rel & 7);
    if (file.seen[rel >>> 3]! & bit) throw new ProtocolError(`duplicate chunk ${idx}`);

    let plaintext: Uint8Array;
    if (header.encrypted) {
      try {
        plaintext = await decryptChunk(this.cryptoKey!, payload, chunkAad(m.transferId, header.fileId, idx));
      } catch {
        // AES-GCM auth failure: almost always a passphrase mismatch.
        this.abort("wrong-passphrase");
        return;
      }
    } else {
      plaintext = payload;
    }

    const offset = idx * m.chunkSize;
    const expected = Math.min(m.chunkSize, file.manifestEntry.size - offset);
    if (plaintext.byteLength !== expected) {
      throw new ProtocolError(`chunk ${idx} has ${plaintext.byteLength} bytes, expected ${expected}`);
    }

    await file.sink.write(offset, plaintext);
    file.seen[rel >>> 3]! |= bit;
    file.chunksGot++;
    // Only count bytes beyond the resume prefix, for honest progress/speed.
    const overlap = Math.max(0, Math.min(plaintext.byteLength, file.resumeOffset - offset));
    const fresh = plaintext.byteLength - overlap;
    file.bytesReceived += fresh;
    this.totalReceived += fresh;
    this.maybeEmitProgress(file);
    if (file.pendingSha !== null) await this.maybeFinishFile(header.fileId, file);
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
    if (!file) throw new ProtocolError(`file-end for unknown file ${fileId}`);
    if (file.finished || file.pendingSha !== null) return;
    file.pendingSha = sha;
    await this.maybeFinishFile(fileId, file);
  }

  /**
   * Finalize a file once its end marker *and* every chunk have arrived.
   * Empty files and fully-resumed files have zero chunks to wait for, so they
   * finalize as soon as `file-end` arrives — through the same verify path.
   */
  private async maybeFinishFile(fileId: number, file: FileState): Promise<void> {
    if (file.finished || file.pendingSha === null || !this.currentManifest) return;
    if (file.chunksGot < file.totalChunks - file.startChunk) return;
    file.finished = true;
    const sha = file.pendingSha;
    const transferId = this.currentManifest.transferId;
    const result = await file.sink.finish(sha);
    const savedAs = result && result.savedAs !== file.manifestEntry.name ? result.savedAs : undefined;

    // Integrity: re-read what actually landed on disk and compare with the
    // sender's sha256 (computed over the whole source file). Constant memory.
    let verified = false;
    if (file.sink.readBack) {
      const fileSize = file.manifestEntry.size;
      this.emit({ type: "verifying", transferId, fileId, bytesDone: 0, fileSize });
      let lastEmit = Date.now();
      const actual = await sha256OfStream(file.sink.readBack(), (bytesDone) => {
        const now = Date.now();
        if (now - lastEmit < this.progressMs) return;
        lastEmit = now;
        this.emit({ type: "verifying", transferId, fileId, bytesDone, fileSize });
      });
      if (actual !== sha) {
        await file.sink.discard?.().catch(() => {});
        const err = new Error(
          `integrity-check-failed: "${file.manifestEntry.name}" didn't match the sender's copy and was deleted`,
        );
        this.sendControl({ type: "abort", transferId, reason: "integrity-check-failed" });
        throw err;
      }
      verified = true;
    }
    this.emit({
      type: "file-done",
      transferId,
      fileId,
      sha256: sha,
      verified,
      ...(savedAs ? { savedAs } : {}),
    });
    if (this.completeRequested && this.allDone()) this.finalizeComplete();
  }

  private allDone(): boolean {
    if (this.files.size === 0) return !!this.currentManifest; // an empty transfer is done once accepted
    for (const f of this.files.values()) if (!f.finished) return false;
    return true;
  }

  private async onComplete(): Promise<void> {
    if (!this.currentManifest) return;
    this.completeRequested = true;
    // Data lanes may still be delivering the tail of the last file(s);
    // maybeFinishFile() calls finalizeComplete() when they land.
    if (this.allDone()) this.finalizeComplete();
  }

  private finalizeComplete(): void {
    if (!this.currentManifest || !this.completeResolve) return;
    const transferId = this.currentManifest.transferId;
    this.sendControl({ type: "complete-ack", transferId });
    this.emit({ type: "complete", transferId });
    this.completeResolve();
    this.completeResolve = null;
    this.completeReject = null;
  }

  /** Cancel from the receiving side: tell the sender, close files, reject done(). */
  abort(reason = "receiver-cancel"): void {
    if (this.currentManifest) {
      this.sendControl({ type: "abort", transferId: this.currentManifest.transferId, reason });
    }
    this.fail(new Error(reason));
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    // Close unfinished files (after any write already in flight) so partials
    // are trimmed to their gap-free prefix and can be resumed later.
    const pending = [...this.files.values()].filter((f) => !f.finished);
    this.queue = this.queue
      .catch(() => {})
      .then(() => Promise.all(pending.map((f) => f.sink.abort(err.message).catch(() => {}))))
      .then(() => {});
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
