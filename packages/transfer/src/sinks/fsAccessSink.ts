/**
 * Direct-to-disk sink using the File System Access API.
 *
 * The receiver writes chunks straight into a `FileSystemWritableFileStream`
 * so memory usage stays O(1) regardless of file size — the 10 GB case
 * simply cannot work any other way in a browser tab.
 *
 * Safe to run inside a dedicated Web Worker: `FileSystemDirectoryHandle`
 * and `FileSystemFileHandle` are structured-cloneable and the writable
 * stream API is available in worker scope.
 *
 * Resume: if a file of the expected name already exists and is smaller
 * than the manifest size, we resume from its current byte length. The
 * writable stream is opened with `keepExistingData: true` and we `seek`
 * to the resume offset before writing.
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

export function createFileSystemAccessSinkFactory(
  opts: FileSystemAccessSinkOptions,
): FileSinkFactory {
  const createSubdirs = opts.createSubdirectories ?? true;

  async function resolveFileHandle(file: {
    name: string;
    relativePath?: string;
  }): Promise<FSFileHandleLike> {
    const path = file.relativePath ?? file.name;
    const parts = path.split("/").filter(Boolean);
    const fileName = parts.pop() ?? file.name;
    let dir = opts.root;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create: createSubdirs });
    }
    return dir.getFileHandle(fileName, { create: true });
  }

  return {
    async resumeOffsetFor(file) {
      try {
        const handle = await resolveFileHandle(file);
        const f = await handle.getFile();
        // Only treat as resume if the on-disk file is shorter than the
        // manifest's file size — a larger file almost certainly means a
        // name collision, not a partial download, so start over.
        if (f.size > 0 && f.size < file.size) return f.size;
        return 0;
      } catch {
        return 0;
      }
    },
    async open(file): Promise<FileSink> {
      const handle = await resolveFileHandle(file);
      let writable: FSWritableLike | null = null;
      let closed = false;
      return {
        async begin(meta, resumeOffset) {
          writable = await handle.createWritable({ keepExistingData: resumeOffset > 0 });
          if (resumeOffset > 0) {
            await writable.seek(resumeOffset);
          } else {
            // Fresh transfer: truncate any stale content. `createWritable`
            // without `keepExistingData` already does this, but be explicit
            // for safety on older polyfills.
            await writable.truncate(0);
          }
          void meta;
        },
        async write(offset, bytes) {
          if (!writable) throw new Error("fsAccessSink.write before begin");
          // Use the positional-write form so out-of-order chunks still land
          // at the right byte offset. This matters once parallel lanes are
          // enabled (DEFAULT_PARALLEL_LANES in @dropbeam/protocol).
          await writable.write({ type: "write", position: offset, data: bytes });
        },
        async finish(sha256) {
          if (!writable) return;
          await writable.close();
          closed = true;
          writable = null;
          void sha256;
        },
        async abort(reason) {
          if (writable && !closed) {
            try {
              await writable.abort(reason);
            } catch {
              /* ignore */
            }
          }
          writable = null;
          closed = true;
        },
      };
    },
  };
}
