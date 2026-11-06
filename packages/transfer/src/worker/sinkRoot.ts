/**
 * Where a worker-side fsaccess sink writes (see `workerProtocol.ts`, `sink`).
 * Kept apart from the worker entry so it can be unit-tested.
 */

import type { createFileSystemAccessSinkFactory } from "../sinks/fsAccessSink.js";
import type { M2WMessage } from "./workerProtocol.js";

export type SinkRoot = Parameters<typeof createFileSystemAccessSinkFactory>[0]["root"];

/** A single folder name: no separators, no dot-segments. */
export const INBOX_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,64}$/;

/**
 * Resolve where an fsaccess sink writes. An `inbox` is opened here, inside the
 * worker (`navigator.storage` is available in workers), because Safari and
 * Firefox refuse to structured-clone OPFS handles across threads.
 */
export async function openSinkRoot(
  sink: Extract<M2WMessage, { type: "receive" }>["sink"],
): Promise<SinkRoot | null> {
  if (sink.kind !== "fsaccess") return null;
  if (sink.inbox !== undefined) {
    if (typeof sink.inbox !== "string" || !INBOX_NAME.test(sink.inbox)) {
      throw new Error("invalid inbox name");
    }
    const storage = (globalThis as unknown as { navigator?: { storage?: StorageManager } }).navigator?.storage;
    if (!storage || typeof storage.getDirectory !== "function") {
      throw new Error("this browser has no private file storage in workers");
    }
    const opfs = await storage.getDirectory();
    return (await opfs.getDirectoryHandle(sink.inbox, { create: true })) as unknown as SinkRoot;
  }
  if (!sink.directory) throw new Error("no folder to save into");
  return sink.directory as SinkRoot;
}
