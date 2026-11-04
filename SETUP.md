# Setup: run DropBeam locally in 5 minutes

## 1. Install Bun (one time)

```bash
curl -fsSL https://bun.sh/install | bash
```

That's the only tool you need. No Node, Rust or native build steps.

## 2. Get the code and install

```bash
git clone https://github.com/<you>/DropBeam.git
cd DropBeam
bun install
```

## 3. Run it

```bash
bun run dev:signaling   # terminal 1 → ws://localhost:8787/ws
bun run dev             # terminal 2 → http://localhost:5173
```

The Vite dev server forwards `/ws` to the signaling server, so no
configuration is needed locally.

## 4. Try a transfer

1. Open http://localhost:5173 in two tabs (or a second device on your Wi-Fi,
   using the "Network" URL Vite prints).
2. Tab 1: **Send a file**, pick files, then **Create share code**.
3. Tab 2: **Receive a file**, type the code (or open the link), then **Join and receive**.
4. Without a chosen folder, files land in browser storage. Tap **Save** for
   each one.

> A second *device* opening `http://192.168.x.x:5173` can send but not
> receive. Browsers only allow saving files on `https://` or `localhost`.
> Test receiving in a second tab on the same machine, or use the deployed
> https:// site.

## 5. Tests

```bash
bun test            # engine, protocol, signaling
bun run typecheck
bun run build       # production build → apps/web/dist
```

## 6. Common gotchas

| Symptom | Cause | Fix |
|---|---|---|
| Red banner "no signaling server configured" on a deployed site | `VITE_SIGNALING_URL` not set at build time | Set it in Vercel and redeploy (see DEPLOY.md) |
| "Couldn't open a direct connection…" | Strict NAT/firewall, no TURN configured | Add `VITE_TURN_*` env vars, or try on the same Wi-Fi |
| Receive screen says the page is on plain http:// | Opened via a LAN IP without HTTPS | Use https:// or localhost |
| "Not enough space in this browser" | Browser storage quota too small for the transfer | Free up space, or receive in Chrome/Edge on a computer and choose a folder |

## 7. Next

- Put it online: [DEPLOY.md](DEPLOY.md)
- Make changes: [FORK.md](FORK.md)
