/**
 * `FileSource` implementation that lives inside the worker and reads from
 * a `Blob` / `File` passed in via structured clone. Uses `Blob.stream()`
 * so the file is streamed off disk on-demand — constant memory regardless
 * of file size. Phase 2 will add a FileSystemFileHandle-backed variant.
 */

import type { FileSource } from "../types.js";
import type { WorkerFileInput } from "./workerProtocol.js";

export function createWorkerFileSource(input: WorkerFileInput): FileSource {
  if (input.kind !== "blob") {
    throw new Error(`worker file source: unsupported kind ${input.kind}`);
  }
  const blob = input.blob;
  const base: FileSource = {
    id: input.id,
    name: input.name,
    size: input.size,
    open(offset = 0): AsyncIterable<Uint8Array> {
      const slice = offset > 0 ? blob.slice(offset) : blob;
      return streamToAsyncIterable(slice.stream());
    },
  };
  if (input.mime !== undefined) base.mime = input.mime;
  if (input.relativePath !== undefined) base.relativePath = input.relativePath;
  if (input.sha256 !== undefined) base.sha256 = input.sha256;
  return base;
}

async function* streamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  // Prefer the spec'd async iterator if the runtime supports it.
  const asyncIt = (
    stream as unknown as {
      [Symbol.asyncIterator]?: () => AsyncIterableIterator<Uint8Array>;
    }
  )[Symbol.asyncIterator];
  if (typeof asyncIt === "function") {
    const iter = asyncIt.call(stream);
    for await (const chunk of iter) yield chunk;
    return;
  }
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
