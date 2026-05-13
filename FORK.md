# Fork & contribute to DropBeam

This is a short, practical guide to getting your own copy running, making
changes, and (optionally) merging them back. The codebase is intentionally
small, typed, and well-commented — you can land your first useful PR in
an afternoon.

---

## 1. Fork the repo

Click the **Fork** button at the top of the GitHub page, or via the CLI:

```bash
gh repo fork <upstream-org>/DropBeam --clone
cd DropBeam
```

If you'd rather start fresh, just clone:

```bash
git clone https://github.com/<upstream-org>/DropBeam
cd DropBeam
```

---

## 2. Install prerequisites

| Tool          | Why                                | Min version | Install                          |
|---------------|-------------------------------------|-------------|----------------------------------|
| **Bun**       | Runtime + workspace package manager | 1.1         | `curl -fsSL https://bun.sh/install \| bash` |
| **Node.js**   | Some native deps (`werift`, `ws`)   | 20          | [nodejs.org](https://nodejs.org) |
| **Rust**      | *Optional* — QUIC binary + WASM     | 1.78        | `curl https://sh.rustup.rs -sSf \| sh` |
| **wasm-pack** | *Optional* — build the WASM core   | latest      | `cargo install wasm-pack`       |

You can ship the whole app **without** Rust — there are pure-TS fallbacks
for the WASM crypto core and the QUIC binary is only used by the CLI.

---

## 3. Install dependencies

From the repo root:

```bash
bun install
```

This populates `node_modules/` and links the workspace packages
(`packages/protocol`, `packages/transfer`, `apps/web`, etc.).

---

## 4. Run it locally

The web app + signaling server are the primary surface. Open two terminals:

```bash
# terminal 1 — signaling server (ws://localhost:8787/ws)
bun run dev:signaling

# terminal 2 — Vite dev server with HMR (http://localhost:5173)
bun run dev:web
```

Open `http://localhost:5173/` in two browser tabs (or two devices on
the same Wi-Fi) and you've got a working sender/receiver pair.

### One-port LAN mode

For testing the no-internet flow, build and serve everything from
one process:

```bash
bun run lan
# → http://<your-lan-ip>:8787/
```

This builds `apps/web/dist/` and tells the signaling server to serve it
statically. Phones on the same Wi-Fi connect to the LAN IP and it Just
Works™.

---

## 5. Run the tests

```bash
bun test                  # all 26 unit + integration tests
bun test apps/signaling   # signaling server only
bun test packages/transfer
bun run typecheck         # TS type check across the workspace
bun run e2e               # end-to-end signaling + transfer round-trip
```

---

## 6. Repo layout

```
DropBeam/
├── packages/
│   ├── protocol/          wire types (signaling + frame codec). TS, no deps.
│   ├── transfer/          transfer engine: sender, receiver, router, worker.
│   └── transfer-core/     Rust → WASM (sha256, AES-GCM, frame codec). Optional.
├── apps/
│   ├── web/               Vite/TS PWA — the universal frontend you're editing 99% of the time.
│   ├── signaling/         Bun WebSocket server. Also serves the web bundle when WEB_ROOT is set.
│   ├── cli/               Node/Bun CLI (`dropbeam send` / `recv`). Imports QUIC from `@dropbeam/transfer/quic`.
│   ├── quic-relay/        Rust/quinn QUIC binary (`dropbeam-quic`). Optional.
│   ├── desktop/           Tauri 2 app (mDNS, tray, clipboard).
│   ├── ios/               Swift stub (MultipeerConnectivity + WebRTC). Future native app.
│   └── android/           Kotlin stub (WifiP2p + WebRTC). Future native app.
├── scripts/
│   └── e2e.sh             End-to-end test harness.
├── FEATURES.md            Full feature catalog.
├── FORK.md                This file.
└── README.md              Project overview + quick start.
```

---

## 7. Where to make common changes

| You want to…                              | Edit…                                         |
|--------------------------------------------|-----------------------------------------------|
| Tweak the homepage / drop UX               | `apps/web/index.html`, `apps/web/src/main.ts` |
| Change colors / typography / animations    | `apps/web/src/styles.css`                     |
| Add a new transport (e.g. bluetooth)       | `packages/transfer/src/peer.ts` + new adapter |
| Change the wire frame format               | `packages/transfer-core/src/frame.rs` + `packages/protocol/src/transfer.ts` |
| Add a signaling message type               | `packages/protocol/src/signaling.ts` + handlers in `apps/signaling/src/server.ts` |
| Wire in a TURN server                      | `apps/web/src/main.ts` → `ICE_SERVERS`, `apps/cli/src/weriftAdapter.ts` |
| Brand for your org                          | `apps/web/public/icon*.svg`, `manifest.webmanifest`, `index.html` title/meta |
| Adjust rate limits / room TTL              | `apps/signaling/src/server.ts` (env vars: `PORT`, `ROOM_CAPACITY`, `MAX_ROOMS`) |

---

## 8. Coding conventions

- **TypeScript everywhere on the JS side.** Strict mode. No `any` unless
  the cost of typing it is genuinely prohibitive.
- **No new runtime dependencies without a good reason.** The web bundle
  is < 30 KB gzipped; keep it that way.
- **No comments on what code does** — only on *why* it does it that way
  (subtle invariants, workarounds, performance choices).
- **Tests before refactors.** If you're touching `transfer/`, add or run
  the integration tests in `packages/transfer/test/`.

---

## 9. Submitting a PR

1. Create a branch: `git checkout -b feat/your-thing`.
2. Make the change. Run `bun test` and `bun run typecheck`.
3. Commit with a clear message — the **why** matters more than the what.
4. Push to your fork: `git push origin feat/your-thing`.
5. Open a PR against `main`. Describe what changed, why, and how you tested.

---

## 10. Self-hosting your own DropBeam

You don't have to send PRs upstream. The MIT license means you can:

- Rebrand it (logo, colors, name) and ship it as your own.
- Run a private instance for your company on a single VPS or Pi.
- Bake it into a desktop app, browser extension, or kiosk.
- Use the protocol and write a totally different UI on top of it.

A minimal production deploy:

```bash
# On any Linux box with Bun installed
git clone https://github.com/<you>/DropBeam && cd DropBeam
bun install
bun run lan                       # binds to 0.0.0.0:8787 by default
# put it behind nginx / caddy with TLS for the wider-internet case
```

For HTTPS (required by browsers for the Wake Lock and Clipboard APIs),
front it with Caddy:

```caddy
dropbeam.example.com {
  reverse_proxy localhost:8787
}
```

---

## 11. Help wanted

Areas where outside contributions are particularly welcome:

- **Native iOS / Android apps.** The Swift/Kotlin stubs are wired up but
  not shipping.
- **More transports.** WebTransport, Bluetooth, USB.
- **Localization.** Strings live in `apps/web/index.html` and
  `apps/web/src/main.ts` — straightforward to extract.
- **TURN bundling.** A drop-in `coturn` config + setup script so
  self-hosters get reliable cross-NAT delivery out of the box.

Have fun. The protocol is small, the code is honest, the dogfooding is
plentiful.
