/**
 * Wire protocol between the main thread (UI) and the TransferWorker.
 *
 * The main thread owns the real `RTCPeerConnection`. The worker hosts
 * `TransferSender` / `TransferReceiver` against a proxied `PeerConnection`
 * that forwards everything over these messages. Binary payloads are
 * passed as Transferable `ArrayBuffer`s for zero-copy.
 *
 * Two orthogonal traffic classes ride on the same channel:
 *   1. Control-plane — lifecycle, proxied PeerConnection/DataChannel calls.
 *   2. Sink-plane    — FileSinkFactory request/response (worker calls, main answers).
 */

import type { TransferEvent } from "../types.js";

export type ChannelId = number;
export type RequestId = number;

/* ─────────────── Main ➜ Worker ─────────────── */

export interface M2W_Init {
  type: "init";
  /** Shared defaults for sender/receiver; optional. */
  progressIntervalMs?: number;
}

export interface M2W_StartSend {
  type: "send";
  transferId: string;
  /** Serializable file inputs. `File` passes via structured clone. */
  files: WorkerFileInput[];
  options: {
    chunkSize?: number;
    bufferHighWater?: number;
    bufferLowWater?: number;
    lanes?: number;
    encryptionPassphrase?: string;
    progressIntervalMs?: number;
  };
}

export interface M2W_StartReceive {
  type: "receive";
  options: {
    encryptionPassphrase?: string;
    progressIntervalMs?: number;
    autoAccept?: boolean;
  };
  /**
   * Which sink to use for writing received bytes.
   *   - "proxy":    worker forwards every sink call back to the main thread.
   *   - "fsaccess": worker writes direct to disk via a FileSystemDirectoryHandle
   *                 structured-cloned in from the main thread. O(1) memory.
   */
  sink:
    | { kind: "proxy" }
    | {
        kind: "fsaccess";
        /** `FileSystemDirectoryHandle` — structured-cloneable into the worker. */
        directory: unknown;
        createSubdirectories?: boolean;
      };
}

export interface M2W_Abort {
  type: "abort";
  reason?: string;
}

/** A data-channel created by the real PC landed — now wire it up in the worker. */
export interface M2W_ChannelOpened {
  type: "ch:opened";
  channelId: ChannelId;
  label: string;
  /** initial bufferedAmount (almost always 0). */
  bufferedAmount: number;
  /** True iff this channel was created locally (worker side initiated). */
  local: boolean;
}

export interface M2W_ChannelMessage {
  type: "ch:msg";
  channelId: ChannelId;
  /** For string messages (control JSON). */
  text?: string;
  /** For binary frames. Transferable. */
  bin?: ArrayBuffer;
}

export interface M2W_ChannelState {
  type: "ch:state";
  channelId: ChannelId;
  readyState: "connecting" | "open" | "closing" | "closed";
  bufferedAmount: number;
  /** True iff the threshold-crossing event fired on the real DC. */
  bufferedAmountLow?: boolean;
}

export interface M2W_ChannelClosed {
  type: "ch:closed";
  channelId: ChannelId;
}

export interface M2W_ChannelError {
  type: "ch:error";
  channelId: ChannelId;
  message: string;
}

/** Response to a worker-originated FileSinkFactory request. */
export interface M2W_SinkResponse {
  type: "sink:resp";
  requestId: RequestId;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export type M2WMessage =
  | M2W_Init
  | M2W_StartSend
  | M2W_StartReceive
  | M2W_Abort
  | M2W_ChannelOpened
  | M2W_ChannelMessage
  | M2W_ChannelState
  | M2W_ChannelClosed
  | M2W_ChannelError
  | M2W_SinkResponse;

/* ─────────────── Worker ➜ Main ─────────────── */

/** Worker asks the main thread to create a real RTCDataChannel. */
export interface W2M_CreateChannel {
  type: "ch:create";
  channelId: ChannelId;
  label: string;
  init?: { ordered?: boolean; maxRetransmits?: number };
  /** Low-water threshold (bytes) to apply to the real DC. */
  bufferedAmountLowThreshold?: number;
}

export interface W2M_ChannelSend {
  type: "ch:send";
  channelId: ChannelId;
  text?: string;
  bin?: ArrayBuffer; // transferable
}

export interface W2M_ChannelClose {
  type: "ch:close";
  channelId: ChannelId;
}

export interface W2M_ChannelThreshold {
  type: "ch:threshold";
  channelId: ChannelId;
  bufferedAmountLowThreshold: number;
}

/** Transfer lifecycle event from sender/receiver. `Error` is flattened. */
export interface W2M_Event {
  type: "event";
  event: SerializableTransferEvent;
}

export interface W2M_Ready {
  type: "ready";
}

export interface W2M_Done {
  type: "done";
  ok: boolean;
  error?: string;
}

/** Worker-initiated FileSinkFactory call — main thread answers with `sink:resp`. */
export interface W2M_SinkRequest {
  type: "sink:req";
  requestId: RequestId;
  call:
    | { kind: "resumeOffsetFor"; file: SinkFileMeta }
    | { kind: "open"; handle: SinkHandleId; file: SinkFileMeta }
    | { kind: "begin"; handle: SinkHandleId; file: SinkFileMeta; resumeOffset: number }
    | { kind: "write"; handle: SinkHandleId; offset: number; bytes: ArrayBuffer }
    | { kind: "finish"; handle: SinkHandleId; sha256: string }
    | { kind: "abort"; handle: SinkHandleId; reason: string };
}

export type W2MMessage =
  | W2M_Ready
  | W2M_CreateChannel
  | W2M_ChannelSend
  | W2M_ChannelClose
  | W2M_ChannelThreshold
  | W2M_Event
  | W2M_Done
  | W2M_SinkRequest;

/* ─────────────── Shared types ─────────────── */

/** Serializable shape of a FileSource passed from main → worker. */
export type WorkerFileInput =
  | {
      kind: "blob";
      id: number;
      name: string;
      size: number;
      mime?: string;
      relativePath?: string;
      sha256?: string;
      /** `File extends Blob`; structured-clones cleanly between threads. */
      blob: Blob;
    }
  | {
      kind: "stream-chunks";
      id: number;
      name: string;
      size: number;
      mime?: string;
      relativePath?: string;
      sha256?: string;
      /**
       * Reserved for Phase 2 (FileSystemFileHandle). Included here so the
       * worker's dispatch table is forward-compatible without churning this
       * file later.
       */
      reserved?: never;
    };

export type SinkHandleId = number;

export interface SinkFileMeta {
  id: number;
  name: string;
  size: number;
  mime?: string;
  relativePath?: string;
}

/** `Error` doesn't structured-clone reliably across workers — flatten it. */
export type SerializableTransferEvent =
  | Exclude<TransferEvent, { type: "error" }>
  | { type: "error"; transferId: string; error: { message: string; name?: string; stack?: string } };
