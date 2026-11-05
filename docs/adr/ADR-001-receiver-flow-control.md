# ADR-001: Receiver-driven flow control (byte credits)

- **Status:** accepted, 2026-11-05
- **Audit:** #1, #8

## Context

The sender limits only each DataChannel's `bufferedAmount`, which measures
what is waiting to go **onto the network**. On the receiver, every
arriving frame is queued in memory until the disk write before it
finishes. With a fast link and a slow disk (a phone writing to OPFS), that
queue grows with file size and can crash the tab. WebRTC DataChannels have
no receive-side pause.

## Decision

The receiver grants the sender a **sliding window of bytes**:

- **Counting:** each side counts consumed bytes as the **encoded frame
  length** (header + payload, encrypted or not). It's the same number on
  both sides, and needs no decryption to compute.
- **Credits:** after it finishes processing a frame (write done, or frame
  deliberately skipped), the receiver adds its length to `consumed`. When
  `consumed − lastCredited ≥ creditStep`, it sends
  `{type:"credit", transferId, consumed}` on the ordered control channel.
  `consumed` is cumulative, so a lost or merged message can't desync it.
- **Credit step:** `creditStep = min(1 MiB, window / 4)`.
- **Window:** the sender keeps `sentBytes − credited ≤ window`. The
  receiver advertises the window in `manifest-ack.window`: 16 MiB by
  default, and never below 256 KiB (`MIN_FLOW_WINDOW`). The sender refuses
  a smaller one.
- **Liveness:** the sender blocks only when `inflight > window − maxFrame`.
  At that point the receiver has more than `window − maxFrame` uncredited
  bytes coming. With `window ≥ 256 KiB` and `maxFrame ≤ 64 KiB`, that is
  ≥ `window / 4 ≥ creditStep`, so a credit is guaranteed once they are
  processed. No deadlock.
- **Watchdog:** if the sender is blocked with no credit progress for
  **120 s**, it fails with `receiver-stalled`. That is long enough for a
  slow phone disk or a long verification read.
- **Version handshake:** the manifest carries `protocol: 2`. A receiver
  that doesn't match answers `accept:false, reason:"version-mismatch"`. The
  UI then says to reload both pages.

**Memory bound:** receiver queued bytes ≤ window (16 MiB) + one frame per
lane. Throughput is roughly window ÷ RTT: 16 MiB at 100 ms RTT ≈ 160 MiB/s,
above real-world WebRTC rates.

## Alternatives rejected

- **Ack per chunk:** ~16 messages per MiB, and no better bound.
- **Stop-and-wait per file:** destroys throughput on high-RTT links.
- **Smaller lane high-water mark:** bounds the network queue, not the disk
  queue, so it doesn't fix the bug.

## Consequences

- Wire protocol bumps to **v2**. v1 and v2 tabs refuse each other cleanly.
- Engine tests cover a slow sink (queued bytes ≤ window) and a stalled
  receiver (watchdog fires).
