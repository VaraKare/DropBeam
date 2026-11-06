# Changelog

All notable changes. Dates are UTC. The wire protocol version is in
`packages/protocol/src/index.ts`; peers on different versions refuse each
other with a clear "reload both pages" message.

## Fix: receiving in Safari and Firefox (2026-11-06)

- Receiving without a chosen folder failed in Safari and Firefox with
  "…FileSystemDirectoryHandle object could not be cloned". Those browsers
  can't pass a private-storage (OPFS) folder from the page to a Web Worker.
  The worker now opens the inbox itself from its name
  (`packages/transfer/src/worker/sinkRoot.ts`); channel traffic that arrives
  while it opens is held and replayed in order, and a cancel during setup is
  honoured.
- If the browser still refuses to hand something to the worker, the session
  fails with `worker-handoff-failed` and a plain-language message instead of
  raw browser text. Storage that can't be opened gives
  `browser-storage-unavailable`.
- Worker-internal only: the peer wire protocol is unchanged (still v2).

## Signaling on Cloudflare (2026-11-05)

- The signaling server runs on Cloudflare Workers with one Durable Object
  (ADR-007): always on, free plan, client IP from `CF-Connecting-IP`.
  Deploy with `bun run deploy:cloudflare` in `apps/signaling`.
- Room logic moved into a shared `Hub` (`apps/signaling/src/hub.ts`), used
  by both the Bun server and the Worker.
- `apps/signaling/scripts/smoke.ts`: a 12-check smoke test for any
  deployed signaling server.
- Room codes and ids use Web Crypto (no Node APIs).
- CI bundles the Worker (`wrangler deploy --dry-run`) on Node 22.
- `undici` pinned to 7.30.1 via `overrides` (wrangler's 7.29.1 had
  advisories).

## Phase A hardening (2026-11-05)

From the [external audit](docs/audit/2026-11-05-external-audit.md). See the
[response](docs/audit/2026-11-05-response.md) and
[verification](docs/audit/2026-11-05-phase-a-verification.md).

### Protocol v2 (breaking: v1 and v2 tabs refuse each other cleanly)

- Receiver-driven flow control: `credit` messages and a 16 MiB window. A
  slow disk can't exhaust memory (ADR-001).
- The manifest carries `protocol` and per-file `lastModified`;
  `manifest-ack` carries `window`.
- AES-GCM additional data binds each encrypted chunk to its transfer, file
  and index.

### Fixed

- Empty files reported success without being saved.
- Partial files of two different same-name, same-size files collided. They
  are now fingerprinted, de-duplicated and locked across tabs (ADR-002).
- A peer could make the receiver write outside a file. Manifests, control
  messages and frames are now strictly validated; duplicates and bad
  lengths are rejected.
- The QR code didn't scan: format bits were transposed, version info was
  missing for v7+, and the quiet zone was too small. It is now verified by
  an independent decoder in tests.
- `/about`, `/features`, `/blog`, `/privacy` and `/terms` crashed when
  opened directly.
- The sender could wait forever if the receiver vanished before answering.
  There is now an ack timeout, close handling from the start, and a stall
  watchdog.
- Signaling:
  - Malformed requests created rooms that never expired.
  - A socket could hold several rooms (leak).
  - A spoofed `X-Forwarded-For` bypassed rate limits (`TRUST_PROXY_HOPS`,
    ADR-003).
  - Rooms admitted 8 peers; now 2.
- A `/` in a file name created folders in browser storage.
- The Docker image would not have found its workspace dependency. The
  install is now deterministic (`--frozen-lockfile`) on a pinned Bun image.

### Added

- Signaling: global and per-IP connection caps, optional `ALLOWED_ORIGINS`,
  env validation at startup, and a `/whoami` deploy check.
- CI: tests, typecheck, build and `bun audit` on every PR.
- Docs: `docs/PHASES.md`, `docs/audit/`, `docs/adr/`.

### Changed

- Vite 5 → 8.3.4. Removed the unused WASM build plugins. `bun audit` went
  from 15 advisories to 0.
