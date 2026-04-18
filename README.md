# DropBeam

Universal any-device-to-any-device file sharing. AirDrop / Quick Share /
Snapdrop / WeTransfer rolled into one open protocol — browser-first,
zero-account, end-to-end encrypted in transit (DTLS) with optional
application-layer AES-GCM.

> **Status — phase 1 (backend complete).** This repo ships the protocol,
> signaling server, transfer engine, and a Node CLI that do real WebRTC
> file transfer end-to-end. UI/native apps are deliberately out of scope
> — see _Roadmap_.

```
       ┌────────────┐    JSON / WebSocket    ┌────────────┐
       │ Sender     │◄──────────────────────►│ Signaling  │
       │ (browser   │     (room + ICE relay) │ (Bun/WS)   │
       │  or CLI)   │                        └────────────┘
       └─────┬──────┘                              ▲
             │                                     │
             │           WebRTC DataChannels       │
             │ ◄──────────────────────────────────►│
             ▼          (DTLS, P2P or TURN)        ▼
       ┌────────────┐                        ┌────────────┐
       │ Receiver   │                        │ Receiver   │
       └────────────┘                        └────────────┘
```

---

## Repo layout

```
DropBeam/
├── apps/
│   ├── signaling/        Bun + WebSocket signaling server
│   └── cli/              Node CLI (send/recv via werift WebRTC)
├── packages/
│   ├── protocol/         Wire types: signaling msgs + binary frame format
│   └── transfer/         Runtime-agnostic engine: sender, receiver,
│                         chunker, AES-GCM, smart router, in-memory pair
├── scripts/
│   └── e2e.sh            End-to-end smoke test (real WebRTC)
└── package.json          Bun workspace root
```

| Package              | Responsibility                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `@dropbeam/protocol` | Signaling JSON messages, control messages, binary frame codec.                              |
| `@dropbeam/transfer` | `TransferSender`, `TransferReceiver`, `decideRoute`, `SignalingClient`. Browser+Node safe.  |
| `@dropbeam/signaling`| Stateless WS server. Rooms, codes, rate limiting, signal relay.                             |
| `@dropbeam/cli`      | Headless sender/receiver, used for tests and real transfers between machines.               |

---

## What works today

- ✅ Room creation with human-friendly codes (`K7-9P3-MX2A`)
- ✅ Long room IDs for QR pairing
- ✅ WebSocket signal relay with per-IP rate limiting
- ✅ WebRTC offer/answer + ICE handshake (with STUN; TURN config-ready)
- ✅ Multiple parallel datachannel "lanes" for throughput
- ✅ Chunked transfer with positional writes (out-of-order safe)
- ✅ Backpressure via `bufferedAmount` watermarks (memory-safe for huge files)
- ✅ Resume from on-disk partial via per-file `.dbmeta.json` markers
- ✅ Optional AES-GCM-256 application-layer encryption (PBKDF2 from passphrase)
- ✅ SHA-256 file hash sent with each `file-end` (verify-on-finish hook)
- ✅ Smart routing decision engine (`loopback`/`lan`/`wifi-direct`/`p2p-direct`/`p2p-relayed`)
- ✅ 26 unit tests + real WebRTC e2e script (5 MiB random file, hash-checked)

---

## Prerequisites

- **[Bun](https://bun.sh) ≥ 1.1** (`curl -fsSL https://bun.sh/install | bash`)
- macOS / Linux / WSL — werift requires a working `dgram` for ICE.

```bash
git clone <your-fork-url> DropBeam
cd DropBeam
bun install
```

---

## Run it

### 1. Start the signaling server

```bash
bun run dev:signaling
# → [dropbeam-signaling] listening on ws://0.0.0.0:8787/ws
```

Env vars:

| Var            | Default | Meaning                                  |
| -------------- | ------- | ---------------------------------------- |
| `PORT`         | 8787    | TCP port for HTTP + WS upgrades          |
| `HOST`         | 0.0.0.0 | bind address                             |
| `MAX_ROOMS`    | 10000   | hard cap on concurrent rooms             |
| `ROOM_CAPACITY`| 8       | peers per room                           |
| `MAX_MSG_BYTES`| 65536   | max WS payload                           |

Health: `curl http://localhost:8787/healthz` → `{"ok":true,"rooms":0,"uptimeMs":...}`.

### 2. Send & receive between two terminals

```bash
# Terminal A — receiver creates a room and prints a join code
bun run cli recv \
  --signaling ws://localhost:8787/ws \
  --out ./received

# →  code: TW-TFZ-HKDR
# →  tell sender to use --join-code "TW-TFZ-HKDR"

# Terminal B — sender joins that room
bun run cli send \
  --signaling ws://localhost:8787/ws \
  --join-code "TW-TFZ-HKDR" \
  ./big.zip ./photo.jpg
```

Or invert the roles (sender creates room, receiver joins):

```bash
# Terminal A — sender creates and waits
bun run cli send --signaling ws://localhost:8787/ws ./big.zip
# →  code: 8B-RFM-XQ2P

# Terminal B
bun run cli recv --signaling ws://localhost:8787/ws --out ./received --join-code "8B-RFM-XQ2P"
```

### 3. With application-layer encryption

```bash
bun run cli send --signaling ... --passphrase "correct horse battery staple" ./secret.pdf
bun run cli recv --signaling ... --passphrase "correct horse battery staple" --out ./received
```

The same passphrase must be shared out-of-band — the signaling server
never sees it.

### 4. Across the internet

Replace `ws://localhost:8787/ws` with your deployed signaling URL
(`wss://...`). For NAT traversal in restrictive networks you'll need a
TURN server — wire its credentials into `makeWeriftPeer({ iceServers })`
in `apps/cli/src/weriftAdapter.ts`, or pass through your browser app.

---

## Test

```bash
bun test                      # all 26 unit tests
bun run test:protocol         # frame codec
bun run test:transfer         # engine via in-memory paired channels
bun run test:signaling        # full WS integration test

bun run e2e                   # real WebRTC round-trip with werift
                              # generates 5 MiB random, verifies SHA-256
```

---

## Embedding the engine in your own app

The engine is runtime-agnostic. For a browser app:

```ts
import {
  SignalingClient,
  TransferSender,
  TransferReceiver,
} from "@dropbeam/transfer";

// 1. connect signaling
const sig = new SignalingClient({
  url: "wss://signaling.example.com/ws",
  device: { deviceId: crypto.randomUUID(), name: "My Mac", kind: "browser" },
});
const room = await sig.createRoom();
console.log("share this code:", room.code);

// 2. wait for peer
const peerId = await new Promise<string>((res) => {
  sig.on((m) => m.type === "peer-joined" && res(m.peerId));
});

// 3. set up native browser RTCPeerConnection (use the included
//    runtime-agnostic peer interface; see apps/cli/src/weriftAdapter.ts
//    for the Node analogue — a browser adapter is ~30 lines).
const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
const adapter: import("@dropbeam/transfer").PeerConnection = wrapBrowserPC(pc);

// 4. send files
const sender = new TransferSender(adapter, {
  onEvent: (e) => console.log(e),
});
sender.prepareChannels();
await offer(adapter, sig, peerId);              // see apps/cli/src/peerHandshake.ts
await sender.send("tx-1", [browserFileSource(file)]);
```

`browserFileSource` is a 10-line wrapper around `File.stream()`. The CLI
has `apps/cli/src/fsIo.ts` for an analogous Node implementation.

### Hooks the host app provides

| Interface         | What you implement                                                  |
| ----------------- | ------------------------------------------------------------------- |
| `PeerConnection`  | Adapter over your platform's WebRTC stack (browser / Node / native).|
| `FileSource`      | Stream of `Uint8Array` chunks for one file you're sending.          |
| `FileSinkFactory` | How to open per-file sinks; resume offset lookup.                   |

---

## Architecture notes

### Wire format

**Control channel** (datachannel labelled `"control"`, ordered, JSON
strings):

```
manifest → manifest-ack → [file-start, file-end]* → complete
                           ↘ chunk-ack (optional)
                           ↘ pause / resume / abort / chat
```

**Data channels** (`"data-0"` … `"data-N"`, ordered, binary).
Each frame is:

```
[ magic=0xDB | ver=1 | flags | reserved | u32 fileId | u32 chunkIndex | u32 length ] payload
   1B          1B      1B       1B          4B           4B               4B          length B
```

`flags` bit0 = encrypted (payload prefixed with 12-byte IV), bit1 = last
chunk of file. See `packages/protocol/src/transfer.ts`.

### Routing

`decideRoute(networkProbe, modeHint)` returns a `RouteDecision` —
transport, lane count, chunk size, whether to apply application-layer
encryption. The probe is platform-supplied (browser fingerprint, ICE
gathering result, mDNS sweep on native). See
`packages/transfer/src/router.ts`.

### Resume

The receiver's `FileSink.begin(file, resumeOffset)` is called with the
on-disk byte count. It echoes that offset back in `manifest-ack.resumeFrom`.
The sender skips already-confirmed bytes and resumes from the chunk
boundary at-or-before that offset. Each datachannel is ordered, so within
a lane chunks always arrive in order; across lanes they may interleave,
which is fine because writes are positional (`pwrite(2)` semantics).

### Backpressure

Each lane sets `bufferedAmountLowThreshold = 1 MiB`. When `bufferedAmount`
exceeds 4 MiB, the sender awaits `onbufferedamountlow`. This caps memory
regardless of file size — 100 GB transfers run in O(few MB) of RAM.

### Security

- **In transit**: WebRTC DTLS by default. Signaling server never sees file
  bytes; ICE candidates and SDP only.
- **Optional app-layer**: AES-GCM-256, key derived via PBKDF2-SHA256
  (200k iterations) from passphrase + 16-byte salt. Salt travels in the
  manifest; passphrase never does. Use this for transfers via untrusted TURN.
- **Anti-spam**: per-IP token-bucket on messages (30 burst / 15/s refill)
  and on room creates (5 burst / 1 per 10s).
- **No persistence**: rooms live in memory; default TTL 30 min, max 4 h.

---

## Roadmap

| Phase   | Scope                                                          | Status |
| ------- | -------------------------------------------------------------- | ------ |
| **1**   | Protocol + signaling + engine + CLI + tests                    | ✅ done |
| **2**   | Web UI (Next.js), tab-based modes, drag-drop, QR pair, history | 🔜 user-owned |
| **3**   | Native apps (iOS/Android/macOS/Windows), nearby (mDNS, BT, WiFi Direct), TURN cluster | 🚧 |
| **3.5** | Chat during transfer, multicast LAN, multi-receiver fan-out, transfer scheduler | 💡 |

The transfer engine already supports pause/resume/chat in the protocol —
those messages are defined and the receiver dispatches paused/resumed
events; the UI just needs to call them.

---

## Contributing & forking

```bash
gh repo fork <upstream>     # or your VCS equivalent
cd DropBeam
bun install
bun test                    # green = good baseline
bun run e2e                 # real WebRTC round-trip
```

**Conventions**

- TypeScript strict; no `any` outside the platform-adapter boundary.
- The transfer engine never imports `werift`, browser globals, or
  `node:*` modules directly — only via the abstractions in
  `packages/transfer/src/types.ts` and `peer.ts`. New platforms = new
  adapter, no engine changes.
- Tests live next to the code they exercise (`*/test/*.test.ts`).
- Wire-protocol changes bump `PROTOCOL_VERSION` in
  `packages/protocol/src/index.ts`.

---

## License

MIT (or your choice).
