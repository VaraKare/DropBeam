/** Re-chunk a stream of arbitrary-sized buffers into fixed-size chunks. */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  let acc = new Uint8Array(0);
  for await (const buf of source) {
    if (acc.length === 0 && buf.length === chunkSize) {
      yield buf;
      continue;
    }
    const merged = new Uint8Array(acc.length + buf.length);
    merged.set(acc, 0);
    merged.set(buf, acc.length);
    acc = merged;
    while (acc.length >= chunkSize) {
      yield acc.subarray(0, chunkSize);
      acc = acc.subarray(chunkSize);
    }
  }
  if (acc.length > 0) yield acc;
}

/** Convenience: yield a Uint8Array as one chunk. */
export async function* fromBytes(b: Uint8Array): AsyncGenerator<Uint8Array> {
  yield b;
}
