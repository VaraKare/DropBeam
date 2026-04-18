# DropBeam

Universal any-device-to-any-device file sharing. AirDrop / Quick Share /
Snapdrop / WeTransfer rolled into one open protocol — browser-first,
zero-account, end-to-end encrypted in transit (DTLS) with optional
application-layer AES-GCM-256.

```
Transport ladder (fastest → most compatible):

  loopback          same host, in-memory
  lan-quic          same LAN, Rust/QUIC binary (zero-RTT, TLS 1.3)
  lan               same LAN, WebRTC DataChannels
  wifi-direct       nearby, OS-native (MultipeerConnectivity / WifiP2p)
  p2p-direct        cross-NAT, WebRTC
  p2p-relayed       cross-NAT via TURN relay
```

---

## Repo layout

```
DropBeam/
├── packages/
│   ├── protocol/          — wire types (signaling + frame codec)
│   ├── transfer/          — transfer engine (sender, receiver, QUIC transport, WASM core)
│   └── transfer-core/     — Rust crate → WASM (sha256, AES-GCM, frame codec)
├── apps/
│   ├── signaling/         — Bun WebSocket signaling server
│   ├── cli/               — Node/Bun CLI (dropbeam send / recv)
│   ├── quic-relay/        — Rust/quinn QUIC binary (dropbeam-quic)
│   ├── desktop/           — Tauri 2 desktop app (mDNS, tray, clipboard)
│   ├── ios/               — Swift app (MultipeerConnectivity + WebRTC)
│   └── android/           — Kotlin app (WifiP2p + WebRTC)
```

---

## Quick start

### Prerequisites

- **Bun** ≥ 1.0 — [bun.sh](https://bun.sh)
- **Node.js** ≥ 20 (for `ws` / `werift` native deps)
- **Rust** ≥ 1.78 + `wasm-pack` (for QUIC binary / WASM core, optional)

```bash
git clone https://github.com/you/DropBeam && cd DropBeam
bun install
```

### 1 — Start the signaling server

```bash
bun run dev:signaling
# → listening on ws://0.0.0.0:8787/ws
```

### 2 — CLI file transfer (WebRTC path)

```bash
# Terminal A — receiver creates a room and prints a code
dropbeam recv --signaling ws://localhost:8787/ws --out ./received

# Terminal B — sender joins using that code
dropbeam send --signaling ws://localhost:8787/ws --join-code "K7-9P3-MX2A" ./photo.jpg ./video.mp4

# Or let sender create the room and wait for receiver
dropbeam send --signaling ws://localhost:8787/ws ./file.zip
```

### 3 — QUIC direct LAN transfer (fastest)

Build the binary once:
```bash
cd apps/quic-relay && cargo build --release
# binary: apps/quic-relay/target/release/dropbeam-quic
```

Then transfer:
```bash
# Receiver machine
dropbeam recv --quic --port 9898 --token my-secret --out ./received

# Sender machine (same LAN)
dropbeam send --quic --host 192.168.1.42 --port 9898 --token my-secret ./bigfile.iso
```

### 4 — Encrypted transfer (AES-GCM-256)

```bash
dropbeam recv --signaling ws://... --out ./recv --passphrase "hunter2"
dropbeam send --signaling ws://... ./secret.zip --passphrase "hunter2"
```

---

## CLI reference

```
dropbeam send  --signaling <url> [OPTIONS] <file>...
dropbeam recv  --signaling <url> --out <dir> [OPTIONS]

# QUIC (skips signaling)
dropbeam send  --quic --host <ip> --port <n> --token <tok> [--lanes 4] <file>...
dropbeam recv  --quic --port <n> --token <tok> --out <dir>

OPTIONS
  --signaling <url>     Signaling server (or DROPBEAM_SIGNALING env var)
  --join-code <code>    Join existing room
  --passphrase <str>    AES-GCM-256 passphrase
  --ttl <sec>           Room TTL (default 1800)
  --adapter <name>      WebRTC adapter: auto (default) | node-dc | werift
  --wasm/--no-wasm      Force WASM or TS crypto core
  --out <dir>           Output directory (recv)
  --lanes <n>           Parallel QUIC streams (default 4)
  --transfer-id <id>    Resume ID
```

---

## Run tests

```bash
bun test                          # all unit + integration tests (26 tests)
bun run e2e                       # end-to-end: signaling + full transfer round-trip
```

Individual package tests:
```bash
bun test packages/transfer        # transfer engine (sender/receiver/router)
bun test apps/signaling           # signaling server (room codes, rate limiting, WS)
```

---

## Build native components (optional)

### WASM crypto core

```bash
cd packages/transfer-core
wasm-pack build --target bundler --out-dir pkg
```

The WASM module is imported automatically by `@dropbeam/transfer` with a
pure-TypeScript fallback if the build is absent.

### QUIC binary

```bash
cd apps/quic-relay
cargo build --release
# → target/release/dropbeam-quic
# Place on PATH or next to the dropbeam CLI binary
```

### Tauri desktop app

```bash
cd apps/desktop
npm install
npx tauri build          # production bundle
npx tauri dev            # dev mode
```

Requires Tauri 2 prerequisites: [tauri.app/v2/guides/prerequisites](https://tauri.app/v2/guides/prerequisites)

---

## iOS app

`apps/ios/DropBeam/` — Swift 5.9, iOS 15+

```bash
cd apps/ios/DropBeam
pod install              # installs GoogleWebRTC
open DropBeam.xcworkspace
```

Key classes:
- `NearbyTransfer` — MultipeerConnectivity (same-LAN, AirDrop-style)
- `WebRTCFallback` — GoogleWebRTC DataChannels (remote/cross-NAT)
- `SignalingClient` — WebSocket room/SDP relay
- `FileTransfer` — coordinator (picks transport, routes events)

---

## Android app

`apps/android/` — Kotlin, minSdk 26, Gradle 8

```bash
cd apps/android
./gradlew assembleDebug
```

Dependencies: `stream-webrtc-android`, `okhttp3`, `kotlinx-coroutines`.

Key classes:
- `NearbyTransfer` — WifiP2pManager (WiFi Direct), raw TCP socket transfer
- `WebRTCFallback` — WebRTC DataChannels via stream-webrtc-android
- `SignalingClient` — OkHttp WebSocket + Kotlin Flow events
- `FileTransfer` — coordinator

Required manifest permissions: `NEARBY_WIFI_DEVICES`, `CHANGE_WIFI_STATE`, `INTERNET`.

---

## Architecture

### Frame format (binary, 16-byte header)

```
 0        1        2        3
 magic    ver      flags    reserved
 0xDB     0x01     0bxxxxxx 0x00

 4 ─── 7  : uint32 BE  fileId
 8 ─── 11 : uint32 BE  chunkIndex
 12 ── 15 : uint32 BE  payloadLen
 16+      : payload (optionally AES-GCM encrypted)

flags:
  bit 0 = ENCRYPTED
  bit 1 = LAST (final chunk of file)
```

### Smart router

```
sameHost?     → loopback
sameLan+quic? → lan-quic   (Rust/quinn, UDP, TLS 1.3, zero-RTT)
sameLan?      → lan        (WebRTC DataChannels)
nearby?       → wifi-direct (OS-native: MPC / WifiP2p)
directReach?  → p2p-direct  (WebRTC, STUN hole-punch)
else          → p2p-relayed (WebRTC + TURN)
```

### WebRTC adapter fallback chain

```
node-datachannel (C++, libdatachannel)  ← fastest, requires native binary
   ↓ if unavailable
werift (pure TypeScript)                ← zero native deps, works everywhere
```

### Crypto core fallback chain

```
WASM (Rust: sha2 + aes-gcm crates)  ← hot path, ~10× faster
   ↓ if WASM not bundled
TypeScript (WebCrypto API)           ← universal fallback
```

---

## Fork / extend

1. **Add a new transport**: implement `PeerConnection` interface in `packages/transfer/src/peer.ts`
2. **Add a new signaling backend**: implement the wire types in `packages/protocol/src/signaling.ts`
3. **Plug in TURN**: edit `iceServers` in `weriftAdapter.ts` / `nodeDCAdapter.ts` / iOS `WebRTCFallback.swift` / Android `WebRTCFallback.kt`
4. **Custom frame format**: extend `packages/transfer-core/src/frame.rs` + `packages/protocol/src/transfer.ts`

---

## License

MIT
