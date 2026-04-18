/**
 * Node filesystem-backed FileSource and FileSinkFactory.
 * Streams from disk, writes back to disk with positional writes (so
 * out-of-order or resumed chunks land at the right offset).
 */

import {
  open as fsOpen,
  stat,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileSinkFactory, FileSink, FileSource } from "@dropbeam/transfer";

export async function fileSource(
  id: number,
  absPath: string,
  opts: { mime?: string; relativePath?: string; chunkReadSize?: number } = {},
): Promise<FileSource> {
  const st = await stat(absPath);
  const chunkRead = opts.chunkReadSize ?? 1024 * 1024; // read 1 MiB per fs read
  return {
    id,
    name: absPath.split("/").pop() ?? `file-${id}`,
    size: st.size,
    mime: opts.mime,
    relativePath: opts.relativePath,
    async *open(offset = 0) {
      const fh = await fsOpen(absPath, "r");
      try {
        const buf = Buffer.alloc(chunkRead);
        let pos = offset;
        while (pos < st.size) {
          const want = Math.min(chunkRead, st.size - pos);
          const { bytesRead } = await fh.read(buf, 0, want, pos);
          if (bytesRead <= 0) break;
          yield new Uint8Array(buf.buffer, buf.byteOffset, bytesRead).slice();
          pos += bytesRead;
        }
      } finally {
        await fh.close();
      }
    },
  };
}

interface ResumeRecord {
  size: number;
  bytesWritten: number;
  partialPath: string;
}

export class DirectorySinkFactory implements FileSinkFactory {
  constructor(private readonly outDir: string) {}

  async resumeOffsetFor(file: { id: number; name: string; size: number; relativePath?: string }): Promise<number> {
    const meta = await this.readMeta(file);
    if (!meta) return 0;
    if (meta.size !== file.size) return 0;
    return Math.min(meta.bytesWritten, file.size);
  }

  async open(file: { id: number; name: string; size: number; mime?: string; relativePath?: string }): Promise<FileSink> {
    const finalPath = join(this.outDir, file.relativePath ?? file.name);
    const partialPath = finalPath + ".dbpart";
    const metaPath = finalPath + ".dbmeta.json";
    await mkdir(dirname(finalPath), { recursive: true });

    if (!existsSync(partialPath)) {
      await writeFile(partialPath, "");
    }
    const fh = await fsOpen(partialPath, "r+");
    let bytesWritten = (await this.readMeta(file))?.bytesWritten ?? 0;

    return {
      async begin(_f, resumeOffset) {
        if (resumeOffset > bytesWritten) bytesWritten = resumeOffset;
      },
      async write(offset, bytes) {
        await fh.write(bytes, 0, bytes.byteLength, offset);
        if (offset + bytes.byteLength > bytesWritten) {
          bytesWritten = offset + bytes.byteLength;
          await writeFile(
            metaPath,
            JSON.stringify({ size: file.size, bytesWritten, partialPath } satisfies ResumeRecord),
          );
        }
      },
      async finish(_sha) {
        await fh.close();
        // rename partial → final
        const { rename, unlink } = await import("node:fs/promises");
        await rename(partialPath, finalPath);
        try {
          await unlink(metaPath);
        } catch {}
      },
      async abort(_reason) {
        await fh.close();
      },
    };
  }

  private async readMeta(file: { name: string; relativePath?: string }): Promise<ResumeRecord | null> {
    const finalPath = join(this.outDir, file.relativePath ?? file.name);
    const metaPath = finalPath + ".dbmeta.json";
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(await readFile(metaPath, "utf-8")) as ResumeRecord;
    } catch {
      return null;
    }
  }
}
