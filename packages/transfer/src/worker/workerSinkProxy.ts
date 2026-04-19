/**
 * `FileSinkFactory` proxy for the worker side. Every call (resumeOffsetFor,
 * open, begin, write, finish, abort) is forwarded to the main thread via a
 * request/response over `postMessage`. The main thread owns the actual
 * storage mechanism — Phase 2 swaps that out for File System Access API.
 */

import type { FileSink, FileSinkFactory } from "../types.js";
import type {
  RequestId,
  SinkFileMeta,
  SinkHandleId,
  W2M_SinkRequest,
  W2MMessage,
} from "./workerProtocol.js";

export interface SinkTransport {
  postMessage(msg: W2MMessage, transfer?: Transferable[]): void;
  /** Registers a response hook; returns a disposer. */
  onResponse(hook: (requestId: RequestId, ok: boolean, value?: unknown, error?: string) => void): () => void;
}

export function createWorkerSinkProxy(transport: SinkTransport): FileSinkFactory {
  let nextRequestId: RequestId = 1;
  let nextHandleId: SinkHandleId = 1;
  const pending = new Map<
    RequestId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  transport.onResponse((requestId, ok, value, error) => {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    if (ok) p.resolve(value);
    else p.reject(new Error(error ?? "sink call failed"));
  });

  function call<T = unknown>(
    body: W2M_SinkRequest["call"],
    transfer?: Transferable[],
  ): Promise<T> {
    const requestId = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      const msg: W2M_SinkRequest = { type: "sink:req", requestId, call: body };
      transport.postMessage(msg, transfer);
    });
  }

  function metaOf(f: {
    id: number;
    name: string;
    size: number;
    mime?: string;
    relativePath?: string;
  }): SinkFileMeta {
    const m: SinkFileMeta = { id: f.id, name: f.name, size: f.size };
    if (f.mime !== undefined) m.mime = f.mime;
    if (f.relativePath !== undefined) m.relativePath = f.relativePath;
    return m;
  }

  return {
    async resumeOffsetFor(f) {
      const v = await call<number>({ kind: "resumeOffsetFor", file: metaOf(f) });
      return typeof v === "number" ? v : 0;
    },
    async open(f): Promise<FileSink> {
      const handle: SinkHandleId = nextHandleId++;
      await call<void>({ kind: "open", handle, file: metaOf(f) });
      return {
        begin(file, resumeOffset) {
          return call<void>({
            kind: "begin",
            handle,
            file: metaOf(file),
            resumeOffset,
          });
        },
        write(offset, bytes) {
          // Copy into a fresh ArrayBuffer so we can transfer it safely — the
          // caller still holds a view on the original and will reuse it.
          const buf = new Uint8Array(bytes.byteLength);
          buf.set(bytes);
          return call<void>(
            { kind: "write", handle, offset, bytes: buf.buffer },
            [buf.buffer],
          );
        },
        finish(sha256) {
          return call<void>({ kind: "finish", handle, sha256 });
        },
        abort(reason) {
          return call<void>({ kind: "abort", handle, reason });
        },
      };
    },
  };
}
