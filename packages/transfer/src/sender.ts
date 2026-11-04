import {
  DEFAULT_BUFFER_HIGH_WATER,
  DEFAULT_BUFFER_LOW_WATER,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_PARALLEL_LANES,
  encodeFrame,
  type ControlMsg,
  type Manifest,
  type ManifestAck,
} from "@dropbeam/protocol";
import { rechunk } from "./chunker.js";
import { makeSha256 } from "./checksum.js";
import { encryptChunk, randomSaltB64, deriveKey } from "./encryption.js";
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
}

export class TransferSender {
  private readonly chunkSize: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly laneCount: number;
  private readonly emit: (e: TransferEvent) => void;
  private readonly progressMs: number;

  private control!: DataChannel;
  private lanes: DataChannel[] = [];
  private aborted = false;
  /** Reason the receiver gave if it aborted (e.g. "integrity-check-failed"). */
  private remoteAbort: string | null = null;
  /** Wakes a pending awaitCompleteAck() when the control channel closes. */
  private onControlClosed: (() => void) | null = null;

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
    this.encPassphrase = opts.encryptionPassphrase;
  }

  private encPassphrase: string | undefined;

  /** Create the channels. Call BEFORE creating the SDP offer. */
  prepareChannels(): void {
    this.control = this.pc.createDataChannel("control", { ordered: true });
    this.control.binaryType = "arraybuffer";
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
  }

  private transferId?: string;

  async send(transferId: string, files: FileSource[]): Promise<void> {
    try {
      await this.sendInner(transferId, files);
    } catch (e) {
      // If the receiver told us why it stopped, that's the real error — not
      // the "channel closed" fallout that follows it.
      if (this.remoteAbort) throw this.abortError();
      throw e;
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
      transferId,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        sha256: f.sha256,
        relativePath: f.relativePath,
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

    const ackPromise = this.awaitAck(transferId);
    this.sendControl(manifest);
    const ack = await ackPromise;
    if (!ack.accept) throw new Error(`receiver rejected: ${ack.reason ?? "no reason"}`);

    // If the control channel closes, the receiver is gone (tab closed, user
    // cancelled, network dropped). Stop instead of waiting on acks forever.
    this.control.onclose = () => {
      if (!this.remoteAbort) this.remoteAbort = "control channel closed";
      this.aborted = true;
      this.onControlClosed?.();
    };

    // Listen for a receiver-side abort for the rest of the transfer (e.g. a
    // failed integrity check or the user cancelling on the other device).
    this.control.onmessage = (data: string | ArrayBuffer) => {
      if (typeof data !== "string") return;
      try {
        const m = JSON.parse(data) as ControlMsg;
        if (m.type === "abort" && m.transferId === transferId) {
          this.remoteAbort = m.reason;
          this.aborted = true;
        }
      } catch {
        /* ignore */
      }
    };

    let cryptoKey: CryptoKey | undefined;
    if (encryption && this.encPassphrase) {
      cryptoKey = await deriveKey(this.encPassphrase, encryption.salt);
    }

    this.emit({ type: "started", transferId });

    let totalSent = 0;
    const startedAt = Date.now();
    let lastProgressAt = 0;
    const fileById = new Map(files.map((f) => [f.id, f]));

    for (const file of files) {
      if (this.aborted) throw this.abortError();
      const resumeOffset = ack.resumeFrom?.[file.id] ?? 0;
      const startChunkIndex = Math.floor(resumeOffset / this.chunkSize);

      this.sendControl({ type: "file-start", transferId, fileId: file.id });

      const hasher = await makeSha256();
      let chunkIndex = 0;
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

      const stream = file.open(startChunkIndex * this.chunkSize);
      for await (const chunk of rechunk(stream, this.chunkSize)) {
        if (this.aborted) throw this.abortError();
        // hash plaintext
        hasher.update(chunk);
        const isLast =
          startChunkIndex * this.chunkSize +
            chunkIndex * this.chunkSize +
            chunk.byteLength >=
          file.size;

        const payload = cryptoKey ? await encryptChunk(cryptoKey, chunk) : chunk;
        const frame = encodeFrame(
          {
            fileId: file.id,
            chunkIndex: startChunkIndex + chunkIndex,
            payloadLength: payload.byteLength,
            encrypted: !!cryptoKey,
            last: isLast,
          },
          payload,
        );

        const lane = this.lanes[
          (startChunkIndex + chunkIndex) % this.lanes.length
        ]!;

        if (lane.bufferedAmount > this.highWater) {
          await waitForDrain(lane, this.lowWater);
        }
        lane.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer);

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
      void fileById;
    }

    // wait until every lane drains before signalling complete
    for (const l of this.lanes) {
      if (l.bufferedAmount > 0) await waitForDrain(l, 0);
    }
    // Don't report success until the receiver confirms every byte is on disk:
    // `complete` can overtake in-flight data on the lanes, and tearing the
    // connection down early would silently truncate the last file(s).
    if (this.aborted) throw this.abortError();
    // The receiver re-reads + hashes the last file before acking, so allow
    // time proportional to the largest file (~25 MB/s worst-case disk read).
    const largest = files.reduce((m, f) => Math.max(m, f.size), 0);
    const confirmed = this.awaitCompleteAck(transferId, 120_000 + Math.ceil(largest / 25_000));
    this.sendControl({ type: "complete", transferId });
    await confirmed;
    this.emit({ type: "complete", transferId });
  }

  private awaitCompleteAck(transferId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.aborted) {
        reject(this.abortError());
        return;
      }
      const timer = setTimeout(() => {
        this.control.onmessage = null;
        reject(new Error("receiver never confirmed the transfer finished"));
      }, timeoutMs);
      this.onControlClosed = () => {
        clearTimeout(timer);
        reject(this.abortError());
      };
      this.control.onmessage = (data: string | ArrayBuffer) => {
        if (typeof data !== "string") return;
        try {
          const m = JSON.parse(data) as ControlMsg;
          if (m.transferId !== transferId) return;
          if (m.type === "complete-ack") {
            clearTimeout(timer);
            this.control.onmessage = null;
            resolve();
          } else if (m.type === "abort") {
            clearTimeout(timer);
            this.control.onmessage = null;
            reject(new Error(`receiver aborted: ${m.reason}`));
          }
        } catch {
          /* ignore non-json control noise */
        }
      };
    });
  }

  private abortError(): Error {
    if (this.remoteAbort === "control channel closed") return new Error("control channel closed");
    return new Error(this.remoteAbort ? `receiver aborted: ${this.remoteAbort}` : "aborted");
  }

  private sendControl(m: ControlMsg): void {
    this.control.send(JSON.stringify(m));
  }

  private awaitAck(transferId: string): Promise<ManifestAck> {
    return new Promise<ManifestAck>((resolve, reject) => {
      const onMsg = (data: string | ArrayBuffer) => {
        if (typeof data !== "string") return;
        try {
          const m = JSON.parse(data) as ControlMsg;
          if (m.type === "manifest-ack" && m.transferId === transferId) {
            this.control.onmessage = null;
            resolve(m);
          } else if (m.type === "abort" && m.transferId === transferId) {
            this.control.onmessage = null;
            reject(new Error(`receiver aborted: ${m.reason}`));
          }
        } catch {
          // ignore non-json control noise
        }
      };
      this.control.onmessage = onMsg;
    });
  }
}
