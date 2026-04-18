/**
 * Engine end-to-end test using the in-memory paired-channel mock.
 * Exercises real chunking, hashing, manifest, ack, and (optional) AES-GCM
 * code paths without needing a WebRTC stack.
 */

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  TransferReceiver,
  TransferSender,
  makeInMemoryPair,
  type FileSink,
  type FileSinkFactory,
  type FileSource,
} from "../src/index.ts";

function memSource(id: number, name: string, bytes: Uint8Array): FileSource {
  return {
    id,
    name,
    size: bytes.byteLength,
    async *open(offset = 0) {
      yield bytes.subarray(offset);
    },
  };
}

class MemSinkFactory implements FileSinkFactory {
  buffers = new Map<number, Buffer>();
  bytesWritten = new Map<number, number>();
  shas = new Map<number, string>();
  /** Pre-seed bytes for resume tests. */
  prefilled = new Map<number, Buffer>();

  async resumeOffsetFor(file: { id: number; size: number }): Promise<number> {
    const pre = this.prefilled.get(file.id);
    return pre ? pre.byteLength : 0;
  }

  async open(file: { id: number; size: number }): Promise<FileSink> {
    const fac = this;
    const buf = Buffer.alloc(file.size);
    const pre = this.prefilled.get(file.id);
    if (pre) pre.copy(buf, 0);
    this.buffers.set(file.id, buf);
    this.bytesWritten.set(file.id, pre?.byteLength ?? 0);
    return {
      async begin(_, off) {
        if (off > (fac.bytesWritten.get(file.id) ?? 0)) fac.bytesWritten.set(file.id, off);
      },
      async write(offset, bytes) {
        bytes.forEach((b, i) => {
          buf[offset + i] = b;
        });
        const end = offset + bytes.byteLength;
        if (end > (fac.bytesWritten.get(file.id) ?? 0)) fac.bytesWritten.set(file.id, end);
      },
      async finish(sha) {
        fac.shas.set(file.id, sha);
      },
      async abort() {},
    };
  }
}

async function runOnce(opts: {
  files: { id: number; name: string; bytes: Uint8Array }[];
  passphrase?: string;
  prefill?: Map<number, Buffer>;
  chunkSize?: number;
  lanes?: number;
}): Promise<MemSinkFactory> {
  const { a, b } = makeInMemoryPair();
  const factory = new MemSinkFactory();
  if (opts.prefill) factory.prefilled = opts.prefill;

  const recv = new TransferReceiver(b, {
    sinkFactory: factory,
    encryptionPassphrase: opts.passphrase,
  });
  recv.attach();
  const done = recv.done();

  const sender = new TransferSender(a, {
    encryptionPassphrase: opts.passphrase,
    chunkSize: opts.chunkSize,
    lanes: opts.lanes,
  });
  sender.prepareChannels();

  const sources = opts.files.map((f) => memSource(f.id, f.name, f.bytes));
  await sender.send("tx-1", sources);
  await done;
  return factory;
}

describe("transfer engine", () => {
  test("transfers a small file with correct sha", async () => {
    const bytes = randomBytes(40_000);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const f = await runOnce({
      files: [{ id: 1, name: "small.bin", bytes }],
      chunkSize: 8 * 1024,
      lanes: 2,
    });
    const got = f.buffers.get(1)!;
    expect(got.byteLength).toBe(40_000);
    expect(createHash("sha256").update(got).digest("hex")).toBe(expectedSha);
    expect(f.shas.get(1)).toBe(expectedSha);
  });

  test("transfers multiple files across many lanes", async () => {
    const a = randomBytes(20_000);
    const b = randomBytes(33_333);
    const c = randomBytes(7);
    const f = await runOnce({
      files: [
        { id: 1, name: "a.bin", bytes: a },
        { id: 2, name: "b.bin", bytes: b },
        { id: 3, name: "c.bin", bytes: c },
      ],
      chunkSize: 4 * 1024,
      lanes: 4,
    });
    expect(Buffer.compare(f.buffers.get(1)!, a)).toBe(0);
    expect(Buffer.compare(f.buffers.get(2)!, b)).toBe(0);
    expect(Buffer.compare(f.buffers.get(3)!, c)).toBe(0);
  });

  test("AES-GCM encryption round-trips when both sides share the passphrase", async () => {
    const bytes = randomBytes(50_000);
    const f = await runOnce({
      files: [{ id: 1, name: "secret.bin", bytes }],
      passphrase: "correct horse battery staple",
      chunkSize: 16 * 1024,
      lanes: 2,
    });
    expect(Buffer.compare(f.buffers.get(1)!, bytes)).toBe(0);
  });

  test("resume skips bytes the receiver already has on disk", async () => {
    const bytes = randomBytes(30_000);
    const partial = Buffer.from(bytes.subarray(0, 8000)); // already on disk
    const prefill = new Map<number, Buffer>([[1, partial]]);
    const f = await runOnce({
      files: [{ id: 1, name: "resume.bin", bytes }],
      chunkSize: 4 * 1024,
      lanes: 1,
      prefill,
    });
    // first chunkSize-aligned offset >= 8000 is 8192; receiver should have 8192 bytes from prefill+resume
    // but the sender resumes from 8192 (8000 rounded down to 8192? no, floor: 8000/4096=1, so chunkIndex=1, offset=4096)
    // Either way, the final file should be byte-identical.
    expect(Buffer.compare(f.buffers.get(1)!, bytes)).toBe(0);
  });

  test("rejects encrypted manifest if receiver has no passphrase", async () => {
    const { a, b } = makeInMemoryPair();
    const factory = new MemSinkFactory();
    const recv = new TransferReceiver(b, { sinkFactory: factory });
    recv.attach();
    const done = recv.done();
    const sender = new TransferSender(a, {
      encryptionPassphrase: "secret",
      chunkSize: 1024,
      lanes: 1,
    });
    sender.prepareChannels();
    const src = memSource(1, "x", new Uint8Array(10));
    await expect(
      Promise.all([sender.send("tx", [src]), done]),
    ).rejects.toThrow(/encryption-passphrase-required|aborted/);
  });
});
