import {
  DEFAULT_BUFFER_HIGH_WATER,
  DEFAULT_BUFFER_LOW_WATER,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PARALLEL_LANES,
  MIN_FLOW_WINDOW,
  PROTOCOL_VERSION,
  encodeFrame,
  parseControlMsg,
  type ControlMsg,
  type Manifest,
  type ManifestAck,
} from "@dropbeam/protocol";
import { rechunk } from "./chunker.js";
import { makeSha256 } from "./checksum.js";
import { chunkAad, encryptChunk, randomSaltB64, deriveKey } from "./encryption.js";
import { waitForDrain, waitForOpen, type DataChannel, type PeerConnection } from "./peer.js";
import type { FileSource, ProgressEvent, TransferEvent } from "./types.js";

export interface SenderOptions {
  chunkSize?: number;
  bufferHighWater?: number;
  bufferLowWater?: number;
  lanes?: number;
  /** If set, payloads are encrypted with a key derived from this passphrase. */
  encryptionPassphrase?: string;
  /** Emitted to the host app for UI / logging. */
  onEvent?: (e: TransferEvent) => void;
  /** How often to emit progress events (ms). */
  progressIntervalMs?: number;
  /** How long to wait for the receiver to answer the manifest. */
  ackTimeoutMs?: number;
  /**
   * How long the sender may be blocked by flow control without the receiver
   * reporting any progress before the transfer fails as stalled.
   */
  stallTimeoutMs?: number;
}

/**
 * Sends files over one ordered control channel plus N data lanes.
 *
 * Lifecycle: manifest → manifest-ack (with resume offsets and the receiver's
 * flow-control window) → frames on the lanes + file-end per file → complete
 * → complete-ack. Success is reported only after complete-ack, i.e. after the
 * receiver has written and verified every file.
 *
 * Flow control (ADR-001): at most `window` encoded frame bytes may be in
 * flight (sent but not yet processed by the receiver). The receiver reports
 * cumulative processed bytes with `credit` messages.
 */
export class TransferSender {
  private readonly chunkSize: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly laneCount: number;
  private readonly emit: (e: TransferEvent) => void;
  private readonly progressMs: number;
  private readonly ackTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly encPassphrase: string | undefined;

  private control!: DataChannel;
  private lanes: DataChannel[] = [];
  private transferId?: string;

  private aborted = false;
  /** Why the transfer stopped from the far side ("control channel closed", or the receiver's reason). */
  private remoteAbort: string | null = null;

  // Control-channel state, updated by the single dispatcher.
  private ack: ManifestAck | null = null;
  private completeAcked = false;
  /** Encoded frame bytes sent / acknowledged as processed by the receiver. */
  private sentBytes = 0;
  private credited = 0;
  /** Receiver's flow-control window; 0 until the manifest-ack arrives. */
  private window = 0;

  /** Waiters re-check their condition whenever control state changes. */
  private listeners = new Set<() => void>();

  constructor(
    private readonly pc: PeerConnection,
    opts: SenderOptions = {},
  ) {
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.highWater = opts.bufferHighWater ?? DEFAULT_BUFFER_HIGH_WATER;
    this.lowWater = opts.bufferLowWater ?? DEFAULT_BUFFER_LOW_WATER;
    this.laneCount = opts.lanes ?? DEFAULT_PARALLEL_LANES;
    this.emit = opts.onEvent ?? (() => {});
    this.progressMs = opts.progressIntervalMs ?? 250;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 120_000;
    this.stallTimeoutMs = opts.stallTimeoutMs ?? 120_000;
    this.encPassphrase = opts.encryptionPassphrase;
  }

  /** Create the channels. Call BEFORE creating the SDP offer. */
  prepareChannels(): void {
    this.control = this.pc.createDataChannel("control", { ordered: true });
    this.control.binaryType = "arraybuffer";
    // Installed once, up front: a receiver that disappears before answering
    // the manifest must not leave us waiting forever.
    this.control.onmessage = (data) => this.onControlMessage(data);
    this.control.onclose = () => {
      if (!this.remoteAbort) this.remoteAbort = "control channel closed";
      this.aborted = true;
      this.poke();
    };
    for (let i = 0; i < this.laneCount; i++) {
      const ch = this.pc.createDataChannel(`data-${i}`, { ordered: true });
      ch.binaryType = "arraybuffer";
      ch.bufferedAmountLowThreshold = this.lowWater;
      this.lanes.push(ch);
    }
  }

  abort(reason: string): void {
    this.aborted = true;
    if (this.control?.readyState === "open") {
      this.sendControl({ type: "abort", transferId: this.transferId ?? "?", reason });
    }
    this.poke();
  }

  async send(transferId: string, files: FileSource[]): Promise<void> {
    try {
      await this.sendInner(transferId, files);
    } catch (e) {
      // If the receiver told us why it stopped, that's the real error — not
      // the "channel closed" fallout that follows it.
      if (this.remoteAbort) throw this.abortError();
      throw e;
    } finally {
      this.listeners.clear();
    }
  }

  private async sendInner(transferId: string, files: FileSource[]): Promise<void> {
    this.transferId = transferId;
    await waitForOpen(this.control);
    await Promise.all(this.lanes.map((l) => waitForOpen(l)));

    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    const encryption = this.encPassphrase
      ? { algo: "aes-gcm-256" as const, salt: randomSaltB64() }
      : undefined;
    const manifest: Manifest = {
      type: "manifest",
      protocol: PROTOCOL_VERSION,
      transferId,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        sha256: f.sha256,
        relativePath: f.relativePath,
        lastModified: f.lastModified,
      })),
      totalBytes,
      chunkSize: this.chunkSize,
      lanes: this.laneCount,
      encryption,
      createdAt: Date.now(),
    };

    this.emit({
      type: "manifest",
      transferId,
      files: files.map((f) => ({ id: f.id, name: f.name, size: f.size })),
      totalBytes,
    });

    this.sendControl(manifest);
    const ack = await this.waitFor(
      () => this.ack ?? undefined,
      this.ackTimeoutMs,
      () => new Error("receiver-no-response: the other device didn't answer"),
    );
    if (!ack.accept) throw new Error(`receiver rejected: ${ack.reason ?? "no reason"}`);
    if (!ack.window) {
      // A v1 receiver doesn't do flow control (or validation). Refuse rather
      // than risk exhausting its memory.
      this.sendControl({ type: "abort", transferId, reason: "version-mismatch" });
      throw new Error("version-mismatch");
    }
    if (ack.window < MIN_FLOW_WINDOW) {
      this.sendControl({ type: "abort", transferId, reason: "protocol-error: window too small" });
      throw new Error("protocol-error: receiver window too small");
    }
    this.window = ack.window;

    let cryptoKey: CryptoKey | undefined;
    if (encryption && this.encPassphrase) {
      cryptoKey = await deriveKey(this.encPassphrase, encryption.salt);
    }

    this.emit({ type: "started", transferId });

    let totalSent = 0;
    const startedAt = Date.now();
    let lastProgressAt = 0;

    for (const file of files) {
      if (this.aborted) throw this.abortError();
      const resumeOffset = Math.min(ack.resumeFrom?.[file.id] ?? 0, file.size);
      const startChunkIndex = Math.floor(resumeOffset / this.chunkSize);

      this.sendControl({ type: "file-start", transferId, fileId: file.id });

      const hasher = await makeSha256();
      let chunkIndex = startChunkIndex;
      let fileBytesSent = startChunkIndex * this.chunkSize;

      // The file-end sha256 must cover the WHOLE file so the receiver can
      // verify what's on its disk — including the prefix it already had from
      // an earlier session. Hash that prefix locally (read, not sent).
      const prefixBytes = startChunkIndex * this.chunkSize;
      if (prefixBytes > 0) {
        let hashed = 0;
        for await (const chunk of rechunk(file.open(0), this.chunkSize)) {
          if (this.aborted) throw this.abortError();
          hasher.update(chunk);
          hashed += chunk.byteLength;
          if (hashed >= prefixBytes) break;
        }
      }

      for await (const chunk of rechunk(file.open(prefixBytes), this.chunkSize)) {
        if (this.aborted) throw this.abortError();
        hasher.update(chunk);
        const isLast = chunkIndex * this.chunkSize + chunk.byteLength >= file.size;

        const payload = cryptoKey
          ? await encryptChunk(cryptoKey, chunk, chunkAad(transferId, file.id, chunkIndex))
          : chunk;
        const frame = encodeFrame(
          {
            fileId: file.id,
            chunkIndex,
            payloadLength: payload.byteLength,
            encrypted: !!cryptoKey,
            last: isLast,
          },
          payload,
        );

        await this.waitForCredit(frame.byteLength);
        const lane = this.lanes[chunkIndex % this.lanes.length]!;
        if (lane.bufferedAmount > this.highWater) await waitForDrain(lane, this.lowWater);
        if (this.aborted) throw this.abortError();
        lane.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);
        this.sentBytes += frame.byteLength;

        chunkIndex++;
        fileBytesSent += chunk.byteLength;
        totalSent += chunk.byteLength;

        const now = Date.now();
        if (now - lastProgressAt >= this.progressMs) {
          lastProgressAt = now;
          const elapsed = (now - startedAt) / 1000;
          const bps = elapsed > 0 ? totalSent / elapsed : 0;
          const remaining = totalBytes - totalSent;
          const eta = bps > 0 ? remaining / bps : NaN;
          const ev: ProgressEvent = {
            fileId: file.id,
            fileName: file.name,
            bytesTransferred: fileBytesSent,
            fileSize: file.size,
            totalBytesTransferred: totalSent,
            totalBytes,
            bytesPerSecond: bps,
            etaSeconds: eta,
          };
          this.emit({ type: "progress", transferId, ...ev });
        }
      }

      const sha = await hasher.digestHex();
      this.sendControl({ type: "file-end", transferId, fileId: file.id, sha256: sha });
      this.emit({ type: "file-done", transferId, fileId: file.id, sha256: sha });
    }

    // Wait until every lane drains before signalling complete.
    for (const l of this.lanes) {
      if (l.bufferedAmount > 0) await waitForDrain(l, 0);
    }
    if (this.aborted) throw this.abortError();
    // Don't report success until the receiver confirms every byte is written
    // and verified: `complete` can overtake in-flight data on the lanes.
    // The receiver re-reads + hashes the last file before acking, so allow
    // time proportional to the largest file (~25 MB/s worst-case disk read).
    const largest = files.reduce((m, f) => Math.max(m, f.size), 0);
    this.sendControl({ type: "complete", transferId });
    await this.waitFor(
      () => (this.completeAcked ? true : undefined),
      120_000 + Math.ceil(largest / 25_000),
      () => new Error("receiver never confirmed the transfer finished"),
    );
    this.emit({ type: "complete", transferId });
  }

  /** Block while sending `frameBytes` more would exceed the receiver's window. */
  private async waitForCredit(frameBytes: number): Promise<void> {
    const fits = () => this.sentBytes + frameBytes - this.credited <= this.window;
    if (fits()) return;
    await this.waitFor(
      () => (fits() ? true : undefined),
      this.stallTimeoutMs,
      () => new Error("receiver-stalled: the other device stopped saving data"),
    );
  }

  private onControlMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const m = parseControlMsg(data);
    if (!m || m.transferId !== this.transferId) return;
    switch (m.type) {
      case "manifest-ack":
        if (!this.ack) this.ack = m;
        break;
      case "credit":
        // Cumulative and monotonic; never trust a value beyond what we sent.
        this.credited = Math.max(this.credited, Math.min(m.consumed, this.sentBytes));
        break;
      case "complete-ack":
        this.completeAcked = true;
        break;
      case "abort":
        this.remoteAbort = m.reason;
        this.aborted = true;
        break;
      default:
        return;
    }
    this.poke();
  }

  private poke(): void {
    for (const l of [...this.listeners]) l();
  }

  /**
   * Resolve with `check()`'s value as soon as it is defined; reject on abort,
   * channel close or timeout. Re-evaluated on every control-state change.
   */
  private waitFor<T>(check: () => T | undefined, timeoutMs: number, onTimeout: () => Error): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.listeners.delete(evaluate);
      };
      const evaluate = () => {
        if (this.aborted) {
          done();
          reject(this.abortError());
          return;
        }
        const v = check();
        if (v !== undefined) {
          done();
          resolve(v);
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(onTimeout());
      }, timeoutMs);
      this.listeners.add(evaluate);
      evaluate();
    });
  }

  private abortError(): Error {
    if (this.remoteAbort === "control channel closed") return new Error("control channel closed");
    return new Error(this.remoteAbort ? `receiver aborted: ${this.remoteAbort}` : "aborted");
  }

  private sendControl(m: ControlMsg): void {
    if (this.control.readyState !== "open") return;
    this.control.send(JSON.stringify(m));
  }
}
