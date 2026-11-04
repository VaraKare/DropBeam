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
 */

import type { FileSink, FileSinkFactory } from "../types.js";

interface FSFileHandleLike {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
  createWritable(options?: {
    keepExistingData?: boolean;
    mode?: "exclusive" | "siloed";
  }): Promise<FSWritableLike>;
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

export interface FileSystemAccessSinkOptions {
  /** Root directory chosen by the user via `showDirectoryPicker()`. */
  root: FSDirectoryHandleLike;
  /** If true (default), mkdir-p any `relativePath` components. */
  createSubdirectories?: boolean;
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
    const path = file.relativePath ?? file.name;
    const parts = path.split(/[\\/]/).filter((p) => p && p !== "." && p !== "..");
    const leaf = safeLeaf(parts.pop() ?? file.name);
    let dir = opts.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(safeLeaf(part), { create: create && createSubdirs });
    }
    return { dir, leaf };
  }

  return {
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
      let writable: FSWritableLike | null = null;
      let closed = false;
      // Bytes [0, contiguous) are known-written. Out-of-order writes past it
      // wait in `ahead` until the gap fills. Used to trim the partial on abort
      // so a later resume never starts after a hole.
      let contiguous = 0;
      const ahead = new Map<number, number>();

      return {
        async begin(_meta, resumeOffset) {
          contiguous = resumeOffset;
          writable = await handle.createWritable({ keepExistingData: resumeOffset > 0 });
          if (resumeOffset > 0) {
            await writable.seek(resumeOffset);
          } else {
            await writable.truncate(0);
          }
        },

        async write(offset, bytes) {
          if (!writable) throw new Error("fsAccessSink.write before begin");
          // Positional write: chunks from parallel lanes can arrive out of order.
          await writable.write({ type: "write", position: offset, data: bytes });
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
            const w = await target.createWritable({ keepExistingData: false });
            try {
              for await (const chunk of streamFile(handle)) await w.write(chunk);
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
              try {
                await writable.abort(reason);
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
