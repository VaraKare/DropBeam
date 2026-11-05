/**
 * Regression tests for the 2026-11-05 audit (Phase A). Each test names the
 * audit finding it pins down. See docs/audit/2026-11-05-response.md.
 */

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  FRAME_HEADER_SIZE,
  PROTOCOL_VERSION,
  encodeFrame,
  type ControlMsg,
  type Manifest,
} from "@dropbeam/protocol";
import {
  TransferReceiver,
  TransferSender,
  chunkAad,
  deriveKey,
  encryptChunk,
  makeInMemoryPair,
  waitForOpen,
  type DataChannel,
  type FileSink,
  type FileSinkFactory,
  type FileSource,
  type SinkFileMeta,
  type TransferEvent,
} from "../src/index.ts";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function memSource(id: number, name: string, bytes: Uint8Array): FileSource {
  return {
    id,
    name,
    size: bytes.byteLength,
    async *open(offset = 0) {
      // Many small reads, like a real file stream.
      for (let i = offset; i < bytes.byteLength; i += 16 * 1024) yield bytes.subarray(i, i + 16 * 1024);
    },
  };
}

/** In-memory sink that records everything, with optional write delay. */
class RecordingFactory implements FileSinkFactory {
  files = new Map<number, { buf: Buffer; finished: boolean; maxEnd: number }>();
  writeDelayMs = 0;
  /** Never resolve writes (simulates a frozen disk). */
  hangWrites = false;
  opened = 0;

  async resumeOffsetFor(): Promise<number> {
    return 0;
  }
  async open(file: SinkFileMeta): Promise<FileSink> {
    this.opened++;
    const rec = { buf: Buffer.alloc(file.size), finished: false, maxEnd: 0 };
    this.files.set(file.id, rec);
    const fac = this;
    return {
      async begin() {},
      async write(offset, bytes) {
        if (fac.hangWrites) await new Promise(() => {});
        if (fac.writeDelayMs) await new Promise((r) => setTimeout(r, fac.writeDelayMs));
        rec.maxEnd = Math.max(rec.maxEnd, offset + bytes.byteLength);
        if (offset + bytes.byteLength > rec.buf.length) throw new Error(`write past end: ${offset}+${bytes.byteLength}`);
        rec.buf.set(bytes, offset);
      },
      async finish() {
        rec.finished = true;
      },
      async *readBack() {
        yield new Uint8Array(rec.buf);
      },
      async abort() {},
    };
  }
}

/** A hand-driven "sender" so tests can send hostile messages. */
async function rawSender(factory: FileSinkFactory, opts: { passphrase?: string } = {}) {
  const { a, b } = makeInMemoryPair();
  const events: TransferEvent[] = [];
  const recv = new TransferReceiver(b, {
    sinkFactory: factory,
    encryptionPassphrase: opts.passphrase,
    onEvent: (e) => events.push(e),
  });
  recv.attach();
  const done = recv.done();
  done.catch(() => {});
  const control = a.createDataChannel("control");
  const lane = a.createDataChannel("data-0");
  const inbox: ControlMsg[] = [];
  control.onmessage = (d) => {
    if (typeof d === "string") inbox.push(JSON.parse(d));
  };
  await waitForOpen(control);
  await waitForOpen(lane);
  const tick = () => new Promise((r) => setTimeout(r, 20));
  return {
    recv,
    done,
    events,
    inbox,
    control,
    lane,
    tick,
    sendControl: (m: unknown) => control.send(JSON.stringify(m)),
    sendFrame: (fileId: number, chunkIndex: number, payload: Uint8Array, encrypted = false) => {
      const f = encodeFrame({ fileId, chunkIndex, payloadLength: payload.byteLength, encrypted }, payload);
      lane.send(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength) as ArrayBuffer);
    },
  };
}

function manifest(files: Manifest["files"], extra: Partial<Manifest> = {}): Manifest {
  return {
    type: "manifest",
    protocol: PROTOCOL_VERSION,
    transferId: "tx",
    files,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
    chunkSize: 1024,
    lanes: 1,
    createdAt: 0,
    ...extra,
  };
}

async function settled(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return String(e);
  }
}

describe("audit #1: receiver memory is bounded by the flow-control window", () => {
  test("a fast sender and a slow disk never queue more than the window", async () => {
    const factory = new RecordingFactory();
    factory.writeDelayMs = 1;
    const window = 256 * 1024;
    const { a, b } = makeInMemoryPair();
    const recv = new TransferReceiver(b, { sinkFactory: factory, flowWindow: window });
    recv.attach();
    const done = recv.done();
    const sender = new TransferSender(a, { chunkSize: 4 * 1024, lanes: 4 });
    sender.prepareChannels();
    const bytes = randomBytes(3 * 1024 * 1024);
    await Promise.all([sender.send("tx-mem", [memSource(1, "big.bin", bytes)]), done]);
    expect(sha(factory.files.get(1)!.buf)).toBe(sha(bytes));
    // Without flow control this reached ~the whole file (3 MiB+).
    expect(recv.peakQueuedBytes).toBeLessThanOrEqual(window);
  }, 30_000);

  test("a frozen receiver disk makes the sender fail as stalled instead of hanging", async () => {
    const factory = new RecordingFactory();
    factory.hangWrites = true;
    const { a, b } = makeInMemoryPair();
    const recv = new TransferReceiver(b, { sinkFactory: factory, flowWindow: 256 * 1024 });
    recv.attach();
    recv.done().catch(() => {});
    const sender = new TransferSender(a, { chunkSize: 4 * 1024, lanes: 2, stallTimeoutMs: 300 });
    sender.prepareChannels();
    const r = await settled(sender.send("tx-stall", [memSource(1, "x.bin", randomBytes(2 * 1024 * 1024))]));
    expect(r).toMatch(/receiver-stalled/);
    expect(recv.peakQueuedBytes).toBeLessThanOrEqual(256 * 1024);
  }, 10_000);
});

describe("audit #2: empty files are saved and verified like any other", () => {
  test("an empty file finishes, verifies and emits file-done", async () => {
    const factory = new RecordingFactory();
    const events: TransferEvent[] = [];
    const { a, b } = makeInMemoryPair();
    const recv = new TransferReceiver(b, { sinkFactory: factory, onEvent: (e) => events.push(e) });
    recv.attach();
    const done = recv.done();
    const sender = new TransferSender(a, { chunkSize: 4 * 1024, lanes: 2 });
    sender.prepareChannels();
    const other = randomBytes(10_000);
    await Promise.all([
      sender.send("tx-empty", [memSource(1, "empty.txt", new Uint8Array(0)), memSource(2, "data.bin", other)]),
      done,
    ]);
    expect(factory.files.get(1)!.finished).toBe(true);
    expect(factory.files.get(2)!.finished).toBe(true);
    const doneEvents = events.filter((e) => e.type === "file-done");
    expect(doneEvents.map((e) => e.type === "file-done" && e.fileId).sort()).toEqual([1, 2]);
    expect(doneEvents.every((e) => e.type === "file-done" && e.verified)).toBe(true);
  });
});

describe("audit #4: the receiver never trusts the peer", () => {
  test("a chunk index past the declared size is refused, nothing written out of range", async () => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory);
    s.sendControl(manifest([{ id: 1, name: "one.bin", size: 1 }]));
    await s.tick();
    expect(s.inbox.find((m) => m.type === "manifest-ack")).toMatchObject({ accept: true });
    s.sendFrame(1, 1000, new Uint8Array([7]));
    expect(await settled(s.done)).toMatch(/protocol-error: chunk 1000 out of range/);
    expect(factory.files.get(1)!.maxEnd).toBe(0);
    expect(s.inbox.some((m) => m.type === "abort")).toBe(true);
  });

  test("a chunk with the wrong length is refused", async () => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory);
    s.sendControl(manifest([{ id: 1, name: "f.bin", size: 1500 }]));
    await s.tick();
    s.sendFrame(1, 1, new Uint8Array(1024)); // last chunk must be 476 bytes
    expect(await settled(s.done)).toMatch(/protocol-error: chunk 1 has 1024 bytes, expected 476/);
  });

  test("a duplicated chunk is refused (it would fake completeness)", async () => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory);
    s.sendControl(manifest([{ id: 1, name: "f.bin", size: 2048 }]));
    await s.tick();
    s.sendFrame(1, 0, new Uint8Array(1024));
    s.sendFrame(1, 0, new Uint8Array(1024));
    expect(await settled(s.done)).toMatch(/protocol-error: duplicate chunk 0/);
  });

  test("frames for an unknown file are refused", async () => {
    const s = await rawSender(new RecordingFactory());
    s.sendControl(manifest([{ id: 1, name: "f.bin", size: 10 }]));
    await s.tick();
    s.sendFrame(9, 0, new Uint8Array(10));
    expect(await settled(s.done)).toMatch(/protocol-error: unknown file 9/);
  });

  test("an inconsistent manifest is rejected before any file is opened", async () => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory);
    s.sendControl(manifest([{ id: 1, name: "f.bin", size: 10 }], { totalBytes: 1 }));
    expect(await settled(s.done)).toMatch(/bad-manifest: totalBytes mismatch/);
    expect(s.inbox.find((m) => m.type === "manifest-ack")).toMatchObject({ accept: false });
    expect(factory.opened).toBe(0);
  });

  test.each([
    ["negative size", { size: -1 }],
    ["fractional size", { size: 1.5 }],
    ["empty name", { name: "" }],
    ["huge id", { id: 2 ** 33 }],
  ])("manifest with %s is rejected", async (_label, patch) => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory);
    const file = { id: 1, name: "f.bin", size: 10, ...patch };
    s.sendControl(manifest([file as Manifest["files"][number]], { totalBytes: typeof file.size === "number" ? file.size : 0 }));
    expect(await settled(s.done)).toMatch(/bad-manifest/);
    expect(factory.opened).toBe(0);
  });

  test("duplicate file ids are rejected", async () => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory);
    s.sendControl(manifest([{ id: 1, name: "a", size: 1 }, { id: 1, name: "b", size: 1 }]));
    expect(await settled(s.done)).toMatch(/duplicate file id/);
  });

  test("a second manifest is a protocol error", async () => {
    const s = await rawSender(new RecordingFactory());
    s.sendControl(manifest([{ id: 1, name: "f.bin", size: 10 }]));
    await s.tick();
    s.sendControl(manifest([{ id: 2, name: "g.bin", size: 10 }]));
    expect(await settled(s.done)).toMatch(/protocol-error: unexpected second manifest/);
  });

  test("a v1 (unversioned) manifest is refused with version-mismatch", async () => {
    const s = await rawSender(new RecordingFactory());
    const m = manifest([{ id: 1, name: "f.bin", size: 10 }]);
    delete m.protocol;
    s.sendControl(m);
    expect(await settled(s.done)).toMatch(/version-mismatch/);
    expect(s.inbox.find((x) => x.type === "manifest-ack")).toMatchObject({ accept: false, reason: "version-mismatch" });
  });
});

describe("audit #15: encrypted chunks are bound to their position", () => {
  test("a valid ciphertext replayed at another index is refused and never written", async () => {
    const factory = new RecordingFactory();
    const s = await rawSender(factory, { passphrase: "pw" });
    const salt = Buffer.from(randomBytes(16)).toString("base64");
    s.sendControl(manifest([{ id: 1, name: "f.bin", size: 2048 }], { encryption: { algo: "aes-gcm-256", salt } }));
    await s.tick();
    const key = await deriveKey("pw", salt);
    const ct = await encryptChunk(key, new Uint8Array(1024).fill(1), chunkAad("tx", 1, 0));
    s.sendFrame(1, 1, ct, true); // sealed for chunk 0, delivered as chunk 1
    expect(await settled(s.done)).toMatch(/wrong-passphrase/);
    expect(factory.files.get(1)!.maxEnd).toBe(0);
  });
});

describe("audit #8: the sender never waits forever", () => {
  test("no answer to the manifest times out", async () => {
    const { a, b } = makeInMemoryPair();
    b.ondatachannel = () => {}; // a receiver that never answers
    const sender = new TransferSender(a, { ackTimeoutMs: 200 });
    sender.prepareChannels();
    expect(await settled(sender.send("tx-silent", [memSource(1, "x", randomBytes(10))]))).toMatch(/receiver-no-response/);
  });

  test("the receiver disappearing before it answers fails promptly", async () => {
    const { a, b } = makeInMemoryPair();
    b.ondatachannel = () => {};
    const sender = new TransferSender(a, { ackTimeoutMs: 60_000 });
    sender.prepareChannels();
    const started = Date.now();
    const sent = sender.send("tx-gone", [memSource(1, "x", randomBytes(10))]);
    setTimeout(() => b.close(), 50);
    expect(await settled(sent)).toMatch(/control channel closed/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a v1 receiver (no flow-control window) is refused", async () => {
    const { a, b } = makeInMemoryPair();
    let ctrl: DataChannel | null = null;
    b.ondatachannel = (ch) => {
      if (ch.label !== "control") return;
      ctrl = ch;
      ch.onmessage = (d) => {
        const m = JSON.parse(String(d));
        if (m.type === "manifest") ctrl!.send(JSON.stringify({ type: "manifest-ack", transferId: m.transferId, accept: true }));
      };
    };
    const sender = new TransferSender(a, {});
    sender.prepareChannels();
    expect(await settled(sender.send("tx-old", [memSource(1, "x", randomBytes(10))]))).toMatch(/version-mismatch/);
  });
});

describe("frame header", () => {
  test("is 16 bytes (the flow-control accounting relies on it)", () => {
    expect(FRAME_HEADER_SIZE).toBe(16);
  });
});
