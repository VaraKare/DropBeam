/**
 * File-sink tests against an in-memory File System Access mock (audit #3,
 * ADR-002): fingerprinted partials, de-duplication, resume, final names.
 */

import { describe, expect, test } from "bun:test";
import { createFileSystemAccessSinkFactory } from "../src/sinks/fsAccessSink.ts";

class MockFile {
  data = new Uint8Array(0);
}

class MockFileHandle {
  readonly kind = "file" as const;
  constructor(public name: string, private dir: MockDir, public file: MockFile) {}
  async getFile(): Promise<File> {
    return new File([this.file.data.slice()], this.name);
  }
  async createWritable(opts?: { keepExistingData?: boolean }) {
    // Like browsers: writes go to a swap copy, visible only after close().
    let swap = opts?.keepExistingData ? this.file.data.slice() : new Uint8Array(0);
    const target = this.file;
    return {
      async write(arg: { type: "write"; position: number; data: Uint8Array }) {
        const end = arg.position + arg.data.byteLength;
        if (end > swap.byteLength) {
          const grown = new Uint8Array(end);
          grown.set(swap);
          swap = grown;
        }
        swap.set(arg.data, arg.position);
      },
      async seek() {},
      async truncate(size: number) {
        const t = new Uint8Array(size);
        t.set(swap.subarray(0, size));
        swap = t;
      },
      async close() {
        target.data = swap;
      },
      async abort() {},
    };
  }
  async move(newName: string) {
    if (this.dir.files.has(newName)) throw new Error("exists");
    this.dir.files.delete(this.name);
    this.dir.files.set(newName, this.file);
    this.name = newName;
  }
}

class MockDir {
  readonly kind = "directory" as const;
  files = new Map<string, MockFile>();
  constructor(public name = "inbox") {}
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new DOMException("not found", "NotFoundError");
      f = new MockFile();
      this.files.set(name, f);
    }
    return new MockFileHandle(name, this, f);
  }
  async getDirectoryHandle(): Promise<MockDir> {
    throw new Error("no subdirs in this mock");
  }
  async removeEntry(name: string) {
    this.files.delete(name);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);

async function receiveOne(
  factory: ReturnType<typeof createFileSystemAccessSinkFactory>,
  meta: { id: number; name: string; size: number; lastModified?: number },
  content: Uint8Array,
  opts: { stopAfter?: number } = {},
): Promise<{ savedAs?: string; resumedFrom: number }> {
  const resumedFrom = await factory.resumeOffsetFor(meta);
  const sink = await factory.open(meta);
  await sink.begin(meta, resumedFrom);
  const end = opts.stopAfter ?? content.byteLength;
  if (end > resumedFrom) await sink.write(resumedFrom, content.subarray(resumedFrom, end));
  if (opts.stopAfter !== undefined) {
    await sink.abort("interrupted");
    return { resumedFrom };
  }
  const r = await sink.finish("");
  return { savedAs: r ? r.savedAs : undefined, resumedFrom };
}

describe("fsAccessSink (ADR-002)", () => {
  test("two different files with the same name and size in one transfer never share a partial", async () => {
    const root = new MockDir();
    const factory = createFileSystemAccessSinkFactory({ root: root as never });
    const a = { id: 1, name: "same.txt", size: 5, lastModified: 1000 };
    const b = { id: 2, name: "same.txt", size: 5, lastModified: 1000 };
    // Both are opened before either is written — exactly what the receiver does.
    expect(await factory.resumeOffsetFor(a)).toBe(0);
    expect(await factory.resumeOffsetFor(b)).toBe(0);
    const sa = await factory.open(a);
    const sb = await factory.open(b);
    await sa.begin(a, 0);
    await sb.begin(b, 0);
    await sa.write(0, enc("AAAAA"));
    await sb.write(0, enc("BBBBB"));
    const ra = await sa.finish("");
    const rb = await sb.finish("");
    expect(ra && ra.savedAs).toBe("same.txt");
    expect(rb && rb.savedAs).toBe("same (1).txt");
    expect(new TextDecoder().decode(root.files.get("same.txt")!.data)).toBe("AAAAA");
    expect(new TextDecoder().decode(root.files.get("same (1).txt")!.data)).toBe("BBBBB");
    expect([...root.files.keys()].some((n) => n.endsWith(".dbpart"))).toBe(false);
  });

  test("the same file sent again resumes from its partial", async () => {
    const root = new MockDir();
    const meta = { id: 1, name: "movie.mp4", size: 10, lastModified: 42 };
    const content = enc("0123456789");
    await receiveOne(createFileSystemAccessSinkFactory({ root: root as never }), meta, content, { stopAfter: 6 });
    const second = await receiveOne(createFileSystemAccessSinkFactory({ root: root as never }), meta, content);
    expect(second.resumedFrom).toBe(6);
    expect(second.savedAs).toBe("movie.mp4");
    expect(new TextDecoder().decode(root.files.get("movie.mp4")!.data)).toBe("0123456789");
  });

  test("a different file with the same name and size does NOT resume someone else's partial", async () => {
    const root = new MockDir();
    await receiveOne(
      createFileSystemAccessSinkFactory({ root: root as never }),
      { id: 1, name: "report.pdf", size: 10, lastModified: 1 },
      enc("OLDOLDOLDO"),
      { stopAfter: 6 },
    );
    const r = await receiveOne(
      createFileSystemAccessSinkFactory({ root: root as never }),
      { id: 1, name: "report.pdf", size: 10, lastModified: 2 },
      enc("NEWNEWNEWN"),
    );
    expect(r.resumedFrom).toBe(0);
    expect(new TextDecoder().decode(root.files.get("report.pdf")!.data)).toBe("NEWNEWNEWN");
  });

  test("an existing file is never overwritten", async () => {
    const root = new MockDir();
    (await root.getFileHandle("photo.jpg", { create: true })).file.data = enc("ORIGINAL");
    const r = await receiveOne(createFileSystemAccessSinkFactory({ root: root as never }), { id: 1, name: "photo.jpg", size: 3 }, enc("new"));
    expect(r.savedAs).toBe("photo (1).jpg");
    expect(new TextDecoder().decode(root.files.get("photo.jpg")!.data)).toBe("ORIGINAL");
  });

  test("an empty file is created under its final name", async () => {
    const root = new MockDir();
    const r = await receiveOne(createFileSystemAccessSinkFactory({ root: root as never }), { id: 1, name: "empty.txt", size: 0 }, new Uint8Array(0));
    expect(r.savedAs).toBe("empty.txt");
    expect(root.files.get("empty.txt")!.data.byteLength).toBe(0);
  });

  test("path separators in a sender's name cannot escape the folder", async () => {
    const root = new MockDir();
    const r = await receiveOne(
      createFileSystemAccessSinkFactory({ root: root as never, flatten: true }),
      { id: 1, name: "../../etc/passwd", size: 1 },
      enc("x"),
    );
    expect(r.savedAs).toBe(".._.._etc_passwd");
    expect([...root.files.keys()]).toEqual([".._.._etc_passwd"]);
  });
});
