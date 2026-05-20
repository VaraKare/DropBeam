# DropBeam — Project Context for Codex

## What this project is

**DropBeam** is a universal file-sharing web app — an open-source AirDrop/WeTransfer alternative.
- Browser-first, zero-account, end-to-end encrypted (AES-GCM-256)
- WebRTC DataChannels for peer-to-peer transfer (no server holds files)
- A signaling server (Bun/WebSocket) is only used for SDP/ICE handshake

**We are building the web UI.** Everything else (iOS, Android, CLI, desktop, QUIC relay) is out of scope for now.

## Repo layout — what matters for web UI

```
apps/
  web/              ← THE web app we are working on
    index.html      ← HTML shell (already exists, needs UI work)
    src/
      main.ts       ← all transfer logic, DOM wiring
      styles.css    ← dark theme, Inter font
  signaling/        ← Bun WebSocket server (run this first: bun run dev:signaling)

packages/
  transfer/         ← core transfer engine (sender, receiver, router, worker)
  protocol/         ← shared wire types (signaling + frame codec)
  transfer-core/    ← Rust/WASM crypto (sha256, AES-GCM) — don't edit directly
```

## What iOS/Android folders are (ignore for web UI)

The project is designed to be a *universal platform* — same protocol, every device.
iOS uses MultipeerConnectivity + WebRTC. Android uses WifiP2p + WebRTC.
Both speak the same 16-byte binary frame format defined in `packages/protocol/`.
We are NOT building those. They're placeholders for future mobile apps.

## How to start dev

```bash
bun run dev:signaling   # terminal 1 — ws://localhost:8787/ws
bun run dev             # terminal 2 — Vite dev server for apps/web
```

## graphify — knowledge graph (auto-updated)

The graph lives in `graphify-out/`. Run `/graphify .` to rebuild it after major code changes.
- `graphify-out/graph.html` — default interactive graph (open in browser)
- `graphify-out/dropbeam-graph.html` — polished dashboard UI
- `graphify-out/GRAPH_REPORT.md` — god nodes, surprising connections

**Key god nodes** (most connected = most important):
1. `TransferSender` / `TransferReceiver` — core file transfer engine
2. `SignalingClient` — WebSocket signaling (pairs sender ↔ receiver via code)
3. `WorkerTransferHost` — offloads transfer to a Web Worker (keeps UI smooth)
4. `decideRoute` — smart transport ladder (loopback → LAN-QUIC → WebRTC → relay)

**Surprising connections found by graphify:**
- QUIC Relay (`protocol.rs`) and TS Transfer Protocol (`transfer.ts`) evolved in parallel — they implement the same frame format independently
- `Web App main.ts` reaches directly into worker protocol types (`WorkerFileInput`) — tight coupling worth refactoring

## Architecture (for context when building UI)

```
User picks file → main.ts → SignalingClient.createRoom() → server gives code
                                                     ↓ share code with peer
Receiver enters code → SignalingClient.joinRoom(code) → server relays SDP/ICE
                                                     ↓
WebRTC DataChannel established peer-to-peer (no server sees file data)
                                                     ↓
WorkerTransferHost → Web Worker → TransferSender → chunked, encrypted frames → DataChannel
                                               → TransferReceiver → FileSystemAccessAPI → saved to disk
```

## Current web UI state

The web app has a working but minimal UI:
- Dark theme, Inter font, gradient accent
- Send tab: drag-drop zone + file list + "Create share code" button
- Receive tab: code input + folder picker + "Join and receive" button
- Progress bar + speed/ETA stats + status messages
- No peer discovery, no transfer history, no QR code share, no mobile-friendly layout improvements

## What to build next (web UI)

- [ ] QR code display alongside the share code (mobile-to-desktop handoff)
- [ ] Copy-to-clipboard button for the share code
- [ ] Transfer history / recent files panel
- [ ] Connection status indicator (connecting → connected → transferring → done)
- [ ] Drag-to-reorder or remove individual files from queue
- [ ] Multi-file progress breakdown (per-file progress bars)
- [ ] Mobile responsive polish (the current UI works but can be improved)
- [ ] Passphrase / encryption toggle UI
- [ ] Room TTL countdown timer
- [ ] Error recovery UX (retry button on failure)
