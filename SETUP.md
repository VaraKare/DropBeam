# Setup — fork, install, and run DropBeam in 10 minutes

Plain-English walkthrough for someone who hasn't touched the repo before.
You don't need to be a senior engineer; you just need `bun`, a terminal,
and the ability to copy-paste.

---

## What you're building

Two things run side by side:

1. **The web app** (everything the user sees — Vite + TypeScript)
2. **The signaling server** (a tiny WebSocket that introduces two devices to each other — Bun)

Once both are running, you open the web URL on two devices (or two browser
tabs), one creates a code, the other types it in, and bytes fly between
them without ever touching your machine.

---

## 1. Install the tools (one-time)

```bash
# Bun runs both the signaling server and the web app's package manager
curl -fsSL https://bun.sh/install | bash

# Node is optional (only the CLI uses it for native deps); install via nvm
# https://nodejs.org if you want the dropbeam CLI working.
```

Verify:

```bash
bun --version    # any 1.1+
```

---

## 2. Get the code

### Option A — fork it on GitHub (recommended if you'll modify)

1. Open <https://github.com/VaraKare/DropBeam>.
2. Click **Fork** in the top-right.
3. After your fork is created, clone it:
   ```bash
   git clone https://github.com/<your-username>/DropBeam
   cd DropBeam
   ```

### Option B — just clone (read-only)

```bash
git clone https://github.com/VaraKare/DropBeam
cd DropBeam
```

---

## 3. Install dependencies

```bash
bun install
```

This pulls everything and links the workspace packages
(`packages/protocol`, `packages/transfer`, `apps/web`, `apps/signaling`).
You'll see ~240 packages installed in about 3 seconds.

---

## 4. Run it locally

Open **two terminal windows**.

**Terminal 1 — signaling server:**
```bash
bun run dev:signaling
# → [dropbeam-signaling] listening on ws://0.0.0.0:8787/ws
```

**Terminal 2 — web app with hot reload:**
```bash
bun run dev:web
# → VITE v5  ready
# → Local:   http://localhost:5173/
# → Network: http://192.168.x.y:5173/
```

Open <http://localhost:5173/> in your browser. To test a real transfer,
open the **Network** URL on your phone (must be on the same Wi-Fi).

---

## 5. Try a transfer

1. On the laptop: click **Send a file** → drop any file → wait for the share code + QR.
2. On the phone: click **Receive a file** → scan the QR or type the code.
3. Watch the transport pill — it'll say `LAN-direct · no internet` if both devices are on the same Wi-Fi.

---

## 6. Single-port LAN mode (for showing friends)

When you want one URL that bundles both the signaling server and the
static web bundle:

```bash
bun run lan
# → builds the web app, serves everything on http://<your-lan-ip>:8787/
```

Everyone on the same Wi-Fi opens that URL and the app works. No public
deploy, no internet needed.

---

## 7. Where the important files live

| File / folder | What it does |
|---|---|
| `apps/web/index.html` | Page structure — change copy, add elements |
| `apps/web/src/styles.css` | Visual design — colors, borders, shadows |
| `apps/web/src/main.ts` | UI logic — state machine, send/receive flows, QR, popovers |
| `apps/web/src/qr.ts` | Pure-TS QR code generator (no external dep) |
| `apps/web/public/icon.svg` | Brand mark |
| `apps/web/public/manifest.webmanifest` | PWA manifest (app name, install icon) |
| `apps/signaling/src/server.ts` | The WebSocket signaling server |
| `packages/transfer/src/` | The transfer engine (chunking, hashing, encryption) — rarely touched |
| `FEATURES.md` | What the product does (use it for marketing copy) |
| `DEPLOY.md` | How to put it on the open internet |

---

## 8. Customize the brand

Two places to edit when you rebrand:

1. **`apps/web/index.html`** — `<title>`, `<meta name="description">`,
   the `.brand-name` span, the SVG logo inside `.brand-mark`, and the
   footer columns. Single find-and-replace handles it.
2. **`apps/web/public/manifest.webmanifest`** — `name`, `short_name`,
   `description`. Replace the icon SVGs in `apps/web/public/` if you
   want a new logo.

If you also want to rename the GitHub repo, do that on GitHub first,
then update `README.md`, `FEATURES.md`, and `FORK.md` for the new repo URL.

---

## 9. Run the tests (when you change engine code)

```bash
bun test                    # all 26 tests
bun test apps/signaling     # signaling server only
bun run typecheck           # TypeScript across the workspace
```

If a test fails after your change, that's the test telling you something
broke. Fix it before pushing.

---

## 10. Push your changes

```bash
git add .
git commit -m "describe what changed"
git push
```

If you've forked: `git push origin main`. If you're working on a feature
branch: `git push origin <branch-name>` then open a Pull Request.

---

## 11. Common gotchas

| Symptom | What's happening | Fix |
|---|---|---|
| Page loads but `localhost:8787` says "fail" in Network tab | Signaling not running | `bun run dev:signaling` |
| You stopped the server but `localhost:5173` still shows the app | Service worker is caching the shell (that's a feature) | DevTools → Application → Service Workers → Unregister; or open in Incognito |
| `port 5173 already in use` | Old Vite is still alive | `lsof -ti:5173 \| xargs kill` |
| Mobile says "no folder picker" | Safari/Firefox don't support `showDirectoryPicker` | Use Chrome/Edge, or accept that files go to the default downloads folder |
| Transfer says "TURN relayed" all the time | Your network is strict NAT | Expected on some carriers; still encrypted, just slower than direct |

---

## 12. Next: put it on the internet

See **[DEPLOY.md](./DEPLOY.md)** for the production deploy walkthrough —
web app on Vercel, signaling on Koyeb (free, no sleep) or Fly.io.

## 13. Going deeper

- **[FEATURES.md](./FEATURES.md)** — comprehensive feature catalog
- **[FORK.md](./FORK.md)** — coding conventions and where to add new
  transports / brandings / self-hosted deploys
- **[README.md](./README.md)** — project overview

Happy hacking.
