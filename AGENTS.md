# DropBeam — Project Context for Codex and other agents

## What this project is

**DropBeam** is a browser-first, zero-account, peer-to-peer file transfer web app
(an open AirDrop / WeTransfer alternative).
- WebRTC DataChannels carry the files; no server ever holds them.
- A Bun WebSocket **signaling server** only pairs devices via a short code and relays SDP/ICE.
- Encrypted in transit (DTLS); optional passphrase adds AES-GCM-256 per chunk.

Scope: **the web app + signaling server only.** Native, CLI, Rust/QUIC and
desktop experiments were moved to the `archive/native` branch.

## Repo layout

```
apps/
  web/                 Vite + TS web app (the product)
    index.html         All stages' markup (idle, send-pick, send-share, recv-pick, active, done, legal, blog)
    src/main.ts        UI state machine, session orchestration, ICE handling, inbox (OPFS), history
    src/styles.css     Neobrutalist design system (cream paper, black borders, hard shadows)
    public/sw.js       Service worker (prod only): network-first HTML, cache-first /assets
  signaling/           Bun WebSocket server: rooms, codes (30 min TTL), relay, rate limits, /healthz
packages/
  protocol/            Wire types: signaling msgs, control msgs (manifest, file-end, complete, complete-ack, abort), 16-byte frame header
  transfer/            Engine
    src/sender.ts      Chunk + hash + (encrypt) + send over 4 lanes; waits for complete-ack
    src/receiver.ts    Writes chunks, finishes a file only when all bytes arrived, re-reads + verifies SHA-256, capacity check
    src/sinks/fsAccessSink.ts  Folder or OPFS writer: .dbpart partials, resume, "name (1).ext" on collision, sync-handle fallback
    src/checksum.ts    Pure-TS streaming SHA-256 (constant memory)
    src/signalingClient.ts  Multi-listener, buffers early signals, onClose, keep-alive
    src/worker/        Web Worker host: engine runs off the main thread; main thread owns RTCPeerConnection
```

## Dev

```bash
bun install
bun run dev:signaling   # terminal 1 — ws://localhost:8787/ws
bun run dev             # terminal 2 — http://localhost:5173 (proxies /ws)
bun test && bun run typecheck && bun run build
```

`.claude/launch.json` has `signaling`, `web` and `web-preview` (prod build on :4173) configs.
To test a transfer, open two tabs: sender in one, receiver joins via `/?c=CODE` in the other.
Receiving without a chosen folder uses the browser's OPFS inbox (`dropbeam-inbox`), so it works in automation.

## Deploy

Vercel builds `apps/web` from the **repo root** (root `vercel.json`). Signaling runs on a
WebSocket-capable host (Koyeb/Render/Fly; `apps/signaling/Dockerfile`, `render.yaml`).
Build-time env: `VITE_SIGNALING_URL` (required in prod), `VITE_TURN_URLS/USERNAME/CREDENTIAL` (optional).
See DEPLOY.md.

## Invariants — don't break these

- Separate DataChannels are **not ordered relative to each other**: never act on a control message
  (file-end / complete) as if all data has arrived. The receiver tracks every chunk; the sender waits for `complete-ack`.
- Frame = 16-byte header + payload (+28 B when encrypted) must fit **64 KiB** → `DEFAULT_CHUNK_SIZE = 64 KiB − 64`.
- Never buffer whole files in memory (no `arrayBuffer()` on user files, no whole-file digests).
- Never overwrite or splice user files: write `.dbpart`, verify, then rename to a free name.
- Secure-context-only APIs (`crypto.randomUUID`, `crypto.subtle`, OPFS, folder picker) are missing on
  plain `http://<lan-ip>`; degrade with a clear message instead of crashing.
- The worker's `bufferedAmount` is a cached copy; the main thread must report state when thresholds change.
- **Never trust the peer.** Everything from the network goes through `packages/protocol/src/validate.ts`
  (`parseControlMsg`, `validateManifest`, `parseClientMsg`); frames are range-, length- and duplicate-checked.
- **Receiver memory is bounded by flow control** (ADR-001): the sender may have at most the receiver's
  advertised window in flight; don't add a code path that sends frames without `waitForCredit`.
- Protocol changes bump `PROTOCOL_VERSION`; peers on different versions refuse each other with `version-mismatch`.
- Partial files are `<name>.<fingerprint>.dbpart` (ADR-002); a sender file name is always a single leaf.
- Signaling: one room per socket, rooms of 2, client IP via `TRUST_PROXY_HOPS` only (ADR-003).
- Plans and decisions: `docs/PHASES.md`, `docs/adr/`, `docs/audit/`. Update PHASES.md with the work.

## Status

Done: deploy config + config banner, reliable signaling/ICE, cancel/timeout/friendly errors, integrity
verification, resume, collision-safe saving, receive-anywhere via OPFS with Save/Share/Clear and quota
checks, big-file warnings, connection stepper, per-file progress, code expiry + renew, Try again,
recent-transfers history, mobile layout.

Ideas not built yet: folder sending (webkitdirectory), receiver-side accept/decline prompt, nearby
device discovery, server-side TURN credential minting, i18n.
