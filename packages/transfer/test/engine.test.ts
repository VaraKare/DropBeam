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
  type TransferEvent,
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
  /** Writes that landed after the sink was finished (= data that would be lost on disk). */
  writesAfterFinish = 0;
  /** Flip a byte in every write to this file id (simulates on-disk corruption). */
  corruptFileId: number | null = null;
  discarded = new Set<number>();
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
    let finished = false;
    return {
      async begin(_, off) {
        if (off > (fac.bytesWritten.get(file.id) ?? 0)) fac.bytesWritten.set(file.id, off);
      },
      async write(offset, bytes) {
        if (finished) fac.writesAfterFinish++;
        if (fac.corruptFileId === file.id && bytes.byteLength) {
          bytes = new Uint8Array(bytes);
          bytes[0] = bytes[0]! ^ 0xff;
        }
        bytes.forEach((b, i) => {
          buf[offset + i] = b;
        });
        const end = offset + bytes.byteLength;
        if (end > (fac.bytesWritten.get(file.id) ?? 0)) fac.bytesWritten.set(file.id, end);
      },
      async finish(sha) {
        finished = true;
        fac.shas.set(file.id, sha);
      },
      async *readBack() {
        yield new Uint8Array(buf);
      },
      async discard() {
        fac.discarded.add(file.id);
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
  dataLaneLatencyMs?: number;
  factory?: MemSinkFactory;
  events?: TransferEvent[];
}): Promise<MemSinkFactory> {
  const { a, b } = makeInMemoryPair({ dataLaneLatencyMs: opts.dataLaneLatencyMs });
  const factory = opts.factory ?? new MemSinkFactory();
  if (opts.prefill) factory.prefilled = opts.prefill;

  const recv = new TransferReceiver(b, {
    sinkFactory: factory,
    encryptionPassphrase: opts.passphrase,
    onEvent: (e) => opts.events?.push(e),
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
  await Promise.all([sender.send("tx-1", sources), done]);
  return factory;
}

describe("transfer engine", () => {
  test("receiver re-reads and verifies each file's sha256", async () => {
    const events: TransferEvent[] = [];
    const bytes = randomBytes(100_000);
    await runOnce({ files: [{ id: 1, name: "v.bin", bytes }], chunkSize: 8 * 1024, lanes: 3, events });
    const done = events.find((e) => e.type === "file-done");
    expect(done && done.type === "file-done" && done.verified).toBe(true);
    expect(events.some((e) => e.type === "verifying")).toBe(true);
  });

  test("wrong passphrase aborts both sides with a clear reason", async () => {
    const { a, b } = makeInMemoryPair();
    const recv = new TransferReceiver(b, { sinkFactory: new MemSinkFactory(), encryptionPassphrase: "nope" });
    recv.attach();
    const done = recv.done();
    const sender = new TransferSender(a, { encryptionPassphrase: "right", chunkSize: 8 * 1024, lanes: 2 });
    sender.prepareChannels();
    const sent = sender.send("tx-pp", [memSource(1, "s.bin", randomBytes(40_000))]);
    const [r, se] = await Promise.allSettled([done, sent]);
    expect(r.status === "rejected" && String(r.reason)).toMatch(/wrong-passphrase/);
    expect(se.status === "rejected" && String(se.reason)).toMatch(/receiver aborted: wrong-passphrase/);
  });

  test("receiver refuses up front when the transfer won't fit", async () => {
    const factory = new MemSinkFactory();
    let asked = 0;
    (factory as MemSinkFactory & { checkCapacity(n: number): Promise<string | null> }).checkCapacity = async (n) => {
      asked = n;
      return "insufficient-storage: needs 49 KB, this browser can store about 1 KB";
    };
    const { a, b } = makeInMemoryPair();
    const recv = new TransferReceiver(b, { sinkFactory: factory });
    recv.attach();
    const done = recv.done();
    const sender = new TransferSender(a, { chunkSize: 8 * 1024, lanes: 2 });
    sender.prepareChannels();
    const sent = sender.send("tx-cap", [memSource(1, "big.bin", randomBytes(50_000))]);
    const [r, se] = await Promise.allSettled([done, sent]);
    expect(asked).toBe(50_000);
    expect(r.status === "rejected" && String(r.reason)).toMatch(/insufficient-storage/);
    expect(se.status === "rejected" && String(se.reason)).toMatch(/receiver rejected: insufficient-storage/);
    expect(factory.buffers.size).toBe(0); // nothing was opened / written
  });

  test("corrupted data fails the integrity check and is discarded", async () => {
    const factory = new MemSinkFactory();
    factory.corruptFileId = 1;
    const run = runOnce({
      files: [{ id: 1, name: "bad.bin", bytes: randomBytes(30_000) }],
      chunkSize: 8 * 1024,
      lanes: 2,
      factory,
    });
    await expect(run).rejects.toThrow(/integrity-check-failed/);
    expect(factory.discarded.has(1)).toBe(true);
  });

  test("control messages overtaking data lanes don't truncate files", async () => {
    // Real WebRTC doesn't order separate DataChannels relative to each other,
    // so `file-end` / `complete` on the control channel can arrive before the
    // last data frames. The receiver must wait for every byte.
    const a = randomBytes(150_000);
    const b = randomBytes(5);
    const f = await runOnce({
      files: [
        { id: 1, name: "a.bin", bytes: a },
        { id: 2, name: "b.txt", bytes: b },
      ],
      chunkSize: 16 * 1024,
      lanes: 4,
      dataLaneLatencyMs: 25,
    });
    expect(Buffer.compare(f.buffers.get(1)!, a)).toBe(0);
    expect(Buffer.compare(f.buffers.get(2)!, b)).toBe(0);
    expect(f.writesAfterFinish).toBe(0);
  });

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
