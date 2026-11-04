# DropBeam

Send files of any size between any two devices, straight from the browser.
Phone → laptop, Mac → Windows, Android → iPad. No account, no app, no upload
server: files go **peer-to-peer** over WebRTC, encrypted in transit (DTLS),
with an optional passphrase for an extra AES-GCM-256 layer.

```
 Sender browser ──wss──▶ Signaling server ◀──wss── Receiver browser
        │            (only introduces the two devices)          │
        └══════════ WebRTC DataChannels: the files ═════════════┘
```

## What it does

- **Any size.** The sender streams the file from disk in 64 KB pieces and
  memory stays flat. The receiver writes straight to disk.
- **Every file is verified.** The receiver re-reads each file and checks its
  SHA-256 against the sender's before reporting success. A mismatch deletes the
  file and fails loudly.
- **Receive on anything.**
  - Chrome or Edge on a computer can save straight into a folder you pick.
  - Everywhere else (phones, Safari, Firefox), files land in the browser's
    private storage, then you tap **Save**, or **Share → Save to Files** on
    iPhone.
  - Free space is checked first, so an oversized transfer is refused up front.
- **Resumes.** If a transfer is interrupted, send it again and it continues from
  where it stopped.
- **Never overwrites.** A name clash saves as `photo (1).jpg`.
- **Pairing:** a short code, a QR code or a link, plus copy and native share
  buttons. The code expires after 30 minutes and you can get a new one.
- **Two modes:**
  - *Same Wi-Fi*: files never leave your network. The first handshake still
    reaches the signaling server, unless you self-host on the LAN (below).
  - *Anywhere*: STUN, plus TURN if you configure it.
- **Built for real use:**
  - a live connection stepper
  - per-file progress
  - size and keep-awake warnings for big transfers
  - clear error messages with Try again
  - a recent-transfers list (kept only on this device)
  - installable as an app (PWA)

## Docs

| Doc | What's in it |
|---|---|
| [docs/MAP.md](docs/MAP.md) | Project map: system diagram, transfer sequence, screens, every folder explained, where data lives |
| [docs/ROADMAP.md](docs/ROADMAP.md) | To-dos, manual + automated test plan, features to add, scaling to many users, Docker, caching, storage |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Who it's for, comparison with AirDrop / WeTransfer / Snapdrop and others, running costs, ads and other income, growth estimate |
| [SETUP.md](SETUP.md) · [DEPLOY.md](DEPLOY.md) · [FORK.md](FORK.md) · [FEATURES.md](FEATURES.md) | Run locally · go live · contribute · feature list |

## Repo layout

```
apps/
  web/          Vite + TypeScript web app (the product)
  signaling/    Bun WebSocket server: rooms, codes, SDP/ICE relay, rate limits
packages/
  protocol/     Shared wire types: signaling messages, control messages, 16-byte frame header
  transfer/     Transfer engine: sender, receiver, file sinks, Web Worker host, signaling client
```

The earlier native, CLI, Rust/QUIC and desktop experiments live on the
`archive/native` branch. They're not part of the web app.

## Run it locally

Requires [Bun](https://bun.sh) 1.1+.

```bash
bun install
bun run dev:signaling   # terminal 1: ws://localhost:8787/ws
bun run dev             # terminal 2: http://localhost:5173
```

Open the app in two tabs (or on two devices on your Wi-Fi via the network URL
Vite prints). One sends, the other receives with the code.

**Fully offline on a LAN** (one port, no internet at all):

```bash
bun run lan             # builds the web app and serves it from the signaling server
# → open http://<your-lan-ip>:8787 on both devices
```

Browsers only allow saving files (and passphrase encryption) on `https://` or
`localhost` pages. Over plain `http://<lan-ip>`, other devices can **send** but
not **receive**; the app explains this on the receive screen. To receive on
other devices too, put the server behind HTTPS on your LAN, for example Caddy
with `tls internal`, or any reverse proxy with a local certificate.

## Tests

```bash
bun test                # protocol, engine (incl. reordering, integrity, resume, aborts), signaling
bun run typecheck
bun run build           # production build of apps/web
```

## Deploy

The web app goes on Vercel. The signaling server needs a host that keeps
WebSockets open (Koyeb, Render, Fly). Step by step in **[DEPLOY.md](DEPLOY.md)**.

| Variable | Where | Required |
|---|---|---|
| `VITE_SIGNALING_URL` | Vercel (build time) | yes, e.g. `wss://your-signaling.example.com/ws` |
| `VITE_TURN_URLS`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` | Vercel (build time) | optional, for strict networks |
| `PORT`, `HOST`, `ROOM_CAPACITY`, `MAX_ROOMS`, `WEB_ROOT` | signaling host | optional |

## How a transfer works

1. The sender creates a room and gets a short code. The receiver joins with it.
2. The two browsers exchange WebRTC offers and ICE candidates through the
   signaling server. Early candidates are queued and nothing is dropped.
3. The sender opens one ordered **control** channel and four **data** lanes.
   A manifest (names, sizes, optional encryption salt) goes first. The receiver
   checks free space and asks to resume any partial files.
4. Chunks go out with a 16-byte header: magic, version, flags, file id and
   chunk index. Each lane respects backpressure.
5. Because the lanes aren't ordered relative to each other, the receiver
   finishes a file only once **every byte** has arrived. It then re-reads the
   file, verifies the SHA-256 and sends `complete-ack`. The sender reports
   success only after that ack.

All chunking, hashing and encryption run in a Web Worker, so the page stays
responsive.

## Privacy

DropBeam can't see your files. The signaling server only relays the handshake
between the two browsers, and it rate-limits by IP address. There are no
analytics and no cookies. On your own device the browser keeps a random device
id, your mode choice, and a recent-transfers list (names and sizes only, with
a Clear button). Files received into browser storage are deleted after you
clear them or after 24 hours. The full statement is on the in-app Privacy page.

## Mission

If this ever earns money (ads, a freemium API, an office tier), **30% is
donated to people in need**. Recipients are voted on quarterly and receipts are
posted publicly. **70% is reinvested** in infrastructure, development and
keeping the free tier alive. Built by Vara Prasad Karewar
([@VaraKare](https://github.com/VaraKare)).

## License

MIT. Use it, fork it, rebrand it, ship it commercially.
