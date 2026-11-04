/**
 * Direct-to-disk sink using the File System Access API.
 *
 * The receiver writes chunks straight into a `FileSystemWritableFileStream`
 * so memory usage stays O(1) regardless of file size.
 *
 * Safe to run inside a dedicated Web Worker: `FileSystemDirectoryHandle`
 * and `FileSystemFileHandle` are structured-cloneable and the writable
 * stream API is available in worker scope.
 *
 * Layout on disk:
 *   - Bytes are written to a partial file `<name>.<size>.dbpart` next to the
 *     destination. Only these partials are ever resumed, so an unrelated file
 *     that happens to share the name is never treated as a half-download
 *     (that used to splice two different files together).
 *   - On finish the partial is renamed to the first free name:
 *     `photo.jpg`, then `photo (1).jpg`, `photo (2).jpg`, … Existing files
 *     are never overwritten.
 *   - If the transfer is interrupted, the partial stays behind and the next
 *     transfer of the same file resumes from its length.
 *
 * Also used for the browser's Origin Private File System ("browser storage"
 * mode, for receivers without a folder picker: phones, Safari, Firefox).
 * There, `createWritable()` may be missing (older Safari), so we fall back
 * to `createSyncAccessHandle()`, which every OPFS browser offers in workers.
 */

import type { FileSink, FileSinkFactory } from "../types.js";

interface FSFileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable?(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<FSWritableLike>;
  /** OPFS-only, dedicated workers only. Methods are sync per spec (async in Safari < 16.4). */
  createSyncAccessHandle?(): Promise<FSSyncHandleLike>;
  /** Chrome 110+ (OPFS earlier). Renames in place; the handle follows the file. */
  move?(newName: string): Promise<void>;
}

interface FSDirectoryHandleLike {
  kind: "directory";
  name: string;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FSFileHandleLike>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FSDirectoryHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface FSWritableLike {
  write(data: ArrayBuffer | ArrayBufferView | Blob | { type: "write"; position?: number; data: ArrayBuffer | ArrayBufferView | Blob }): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface FSSyncHandleLike {
  write(buffer: ArrayBufferView, options?: { at?: number }): number | Promise<number>;
  truncate(size: number): void | Promise<void>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface FileSystemAccessSinkOptions {
  /** Root directory chosen by the user via `showDirectoryPicker()` (or an OPFS folder). */
  root: FSDirectoryHandleLike;
  /** If true (default), mkdir-p any `relativePath` components. */
  createSubdirectories?: boolean;
  /** Ignore `relativePath` and put every file directly in `root`. */
  flatten?: boolean;
  /**
   * Refuse transfers that won't fit in the origin's storage quota
   * (`navigator.storage.estimate()`). Only meaningful for OPFS roots.
   */
  checkQuota?: boolean;
}

/** Minimal positional writer over either a writable stream or a sync access handle. */
interface Writer {
  write(offset: number, bytes: Uint8Array): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

async function openWriter(handle: FSFileHandleLike, keepExistingData: boolean): Promise<Writer> {
  if (typeof handle.createWritable === "function") {
    const w = await handle.createWritable({ keepExistingData });
    if (!keepExistingData) await w.truncate(0);
    return {
      write: (offset, bytes) => w.write({ type: "write", position: offset, data: bytes }),
      truncate: (size) => w.truncate(size),
      close: () => w.close(),
      abort: () => w.abort(),
    };
  }
  if (typeof handle.createSyncAccessHandle === "function") {
    const h = await handle.createSyncAccessHandle();
    if (!keepExistingData) await h.truncate(0);
    return {
      async write(offset, bytes) {
        let done = 0;
        while (done < bytes.byteLength) {
          const n = await h.write(bytes.subarray(done), { at: offset + done });
          if (!n) throw new Error("sync access handle wrote 0 bytes");
          done += n;
        }
      },
      truncate: async (size) => { await h.truncate(size); },
      close: async () => { await h.flush(); await h.close(); },
      abort: async () => { await h.close(); },
    };
  }
  throw new Error("This browser can't write files to disk.");
}

function humanSize(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

type FileMeta = { name: string; size: number; relativePath?: string };

const PARTIAL_SUFFIX = ".dbpart";

/** Strip path separators / control chars a sender could use to escape the folder. */
function safeLeaf(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "file";
  return cleaned;
}

function partialName(leaf: string, size: number): string {
  return `${leaf}.${size}${PARTIAL_SUFFIX}`;
}

/** "photo.jpg" → "photo (n).jpg"; "archive.tar.gz" → "archive (n).tar.gz"; ".env" → ".env (n)". */
export function numberedName(leaf: string, n: number): string {
  if (n === 0) return leaf;
  const m = /^(.+?)((?:\.[A-Za-z0-9]{1,8}){1,2})$/.exec(leaf);
  return m && m[1] ? `${m[1]} (${n})${m[2]}` : `${leaf} (${n})`;
}

async function exists(dir: FSDirectoryHandleLike, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

async function firstFreeName(dir: FSDirectoryHandleLike, leaf: string): Promise<string> {
  for (let n = 0; n < 10_000; n++) {
    const candidate = numberedName(leaf, n);
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error(`no free file name for ${leaf}`);
}

async function* streamFile(handle: FSFileHandleLike): AsyncIterable<Uint8Array> {
  const file = await handle.getFile();
  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
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

export function createFileSystemAccessSinkFactory(
  opts: FileSystemAccessSinkOptions,
): FileSinkFactory {
  const createSubdirs = opts.createSubdirectories ?? true;

  async function resolveDir(file: FileMeta, create: boolean): Promise<{ dir: FSDirectoryHandleLike; leaf: string }> {
    const path = opts.flatten ? file.name : (file.relativePath ?? file.name);
    const parts = path.split(/[\\/]/).filter((p) => p && p !== "." && p !== "..");
    const leaf = safeLeaf(parts.pop() ?? file.name);
    let dir = opts.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(safeLeaf(part), { create: create && createSubdirs });
    }
    return { dir, leaf };
  }

  return {
    async checkCapacity(bytesNeeded) {
      if (!opts.checkQuota) return null;
      const est = await (globalThis as { navigator?: { storage?: { estimate?(): Promise<{ quota?: number; usage?: number }> } } })
        .navigator?.storage?.estimate?.().catch(() => undefined);
      if (!est?.quota) return null;
      const free = est.quota - (est.usage ?? 0);
      // Keep a little headroom: browsers evict or refuse writes near the limit.
      if (bytesNeeded > free * 0.95) {
        return `insufficient-storage: needs ${humanSize(bytesNeeded)}, this browser can store about ${humanSize(Math.max(0, free * 0.95))}`;
      }
      return null;
    },

    async resumeOffsetFor(file) {
      try {
        const { dir, leaf } = await resolveDir(file, false);
        const handle = await dir.getFileHandle(partialName(leaf, file.size), { create: false });
        const f = await handle.getFile();
        return f.size > 0 && f.size < file.size ? f.size : 0;
      } catch {
        return 0;
      }
    },

    async open(file): Promise<FileSink> {
      const { dir, leaf } = await resolveDir(file, true);
      const partName = partialName(leaf, file.size);
      let handle = await dir.getFileHandle(partName, { create: true });
      let finalName: string | null = null;
      let writable: Writer | null = null;
      let closed = false;
      // Bytes [0, contiguous) are known-written. Out-of-order writes past it
      // wait in `ahead` until the gap fills. Used to trim the partial on abort
      // so a later resume never starts after a hole.
      let contiguous = 0;
      const ahead = new Map<number, number>();

      return {
        async begin(_meta, resumeOffset) {
          contiguous = resumeOffset;
          writable = await openWriter(handle, resumeOffset > 0);
        },

        async write(offset, bytes) {
          if (!writable) throw new Error("fsAccessSink.write before begin");
          // Positional write: chunks from parallel lanes can arrive out of order.
          await writable.write(offset, bytes);
          if (offset <= contiguous) {
            contiguous = Math.max(contiguous, offset + bytes.byteLength);
            for (let next = ahead.get(contiguous); next !== undefined; next = ahead.get(contiguous)) {
              ahead.delete(contiguous);
              contiguous += next;
            }
          } else {
            ahead.set(offset, bytes.byteLength);
          }
        },

        async finish() {
          if (writable) {
            await writable.close();
            writable = null;
          }
          closed = true;

          finalName = await firstFreeName(dir, leaf);
          let moved = false;
          if (typeof handle.move === "function") {
            try {
              await handle.move(finalName);
              moved = true;
            } catch {
              /* fall back to copy below */
            }
          }
          if (!moved) {
            // No rename support: stream-copy partial → final, then delete partial.
            const target = await dir.getFileHandle(finalName, { create: true });
            const w = await openWriter(target, false);
            try {
              let pos = 0;
              for await (const chunk of streamFile(handle)) {
                await w.write(pos, chunk);
                pos += chunk.byteLength;
              }
              await w.close();
            } catch (e) {
              await w.abort().catch(() => {});
              throw e;
            }
            await dir.removeEntry(partName).catch(() => {});
            handle = target;
          }
          return { savedAs: finalName };
        },

        readBack() {
          return streamFile(handle);
        },

        async discard() {
          if (finalName) await dir.removeEntry(finalName).catch(() => {});
        },

        async abort(reason) {
          // Keep the gap-free prefix of the partial so a retry can resume from it.
          if (writable && !closed) {
            try {
              await writable.truncate(contiguous);
              await writable.close();
            } catch {
              void reason;
              try {
                await writable.abort();
              } catch {
                /* ignore */
              }
            }
          }
          writable = null;
          closed = true;
          // Nothing usable was written: don't leave an empty partial behind.
          if (contiguous === 0) await dir.removeEntry(partName).catch(() => {});
        },
      };
    },
  };
}
