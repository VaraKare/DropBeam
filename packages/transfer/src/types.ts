/**
 * Runtime-agnostic interfaces. The transfer engine never imports `werift`
 * or browser globals directly — it only sees these abstractions.
 *
 * On the browser: thin adapter around native `RTCPeerConnection`.
 * On Node: thin adapter around `werift`'s `RTCPeerConnection`.
 */

export type IceCandidate = unknown;
export type SessionDescription = { type: "offer" | "answer" | "rollback" | "pranswer"; sdp?: string };

/** Source of bytes for a single file being sent. */
export interface FileSource {
  id: number;
  name: string;
  size: number;
  mime?: string;
  relativePath?: string;
  /** Stream returning chunks of arbitrary size; transfer engine will re-chunk as needed. */
  open(offset?: number): AsyncIterable<Uint8Array>;
  /** Optional pre-computed sha256 hex; if absent, sender will compute on the fly. */
  sha256?: string;
}

/** Sink the receiver writes file bytes into. */
export interface FileSink {
  /** Called once before any chunks. May reject (e.g. out of disk). */
  begin(file: { id: number; name: string; size: number; mime?: string; relativePath?: string }, resumeOffset: number): Promise<void>;
  write(chunkOffset: number, bytes: Uint8Array): Promise<void>;
  /** Called when sender signals end-of-file with the full sha256. */
  finish(sha256: string): Promise<void>;
  abort(reason: string): Promise<void>;
}

export interface FileSinkFactory {
  /** Returns the byte offset to resume from (0 = start). */
  resumeOffsetFor(file: { id: number; name: string; size: number; relativePath?: string }): Promise<number>;
  open(file: { id: number; name: string; size: number; mime?: string; relativePath?: string }): Promise<FileSink>;
}

export interface ProgressEvent {
  fileId: number;
  fileName: string;
  bytesTransferred: number;
  fileSize: number;
  totalBytesTransferred: number;
  totalBytes: number;
  bytesPerSecond: number;
  /** Seconds remaining (NaN if unknown). */
  etaSeconds: number;
}

export type TransferEvent =
  | { type: "manifest"; transferId: string; files: { id: number; name: string; size: number }[]; totalBytes: number }
  | { type: "started"; transferId: string }
  | { type: "progress"; transferId: string } & ProgressEvent
  | { type: "file-done"; transferId: string; fileId: number; sha256: string }
  | { type: "complete"; transferId: string }
  | { type: "error"; transferId: string; error: Error }
  | { type: "paused"; transferId: string }
  | { type: "resumed"; transferId: string };
