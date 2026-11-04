# Fork & contribute to DropBeam

1. Fork on GitHub, clone your fork, `bun install`. See [SETUP.md](SETUP.md).
2. Create a branch, make your change, run `bun test && bun run typecheck && bun run build`.
3. Open a pull request describing what changed and how you tested it.

## Where to make common changes

| I want to… | Edit |
|---|---|
| Change the UI copy or layout | `apps/web/index.html`, `apps/web/src/styles.css` |
| Change UI behavior (stages, buttons, warnings) | `apps/web/src/main.ts` |
| Change how files are saved (names, resume, browser storage) | `packages/transfer/src/sinks/fsAccessSink.ts` |
| Change the transfer protocol | `packages/protocol/src/transfer.ts` + `packages/transfer/src/sender.ts` / `receiver.ts` |
| Change rooms, codes, TTLs, rate limits | `apps/signaling/src/` |
| Add STUN/TURN servers | Env vars `VITE_TURN_*`, read in `readIceServers()` in `apps/web/src/main.ts` |
| Rebrand | `apps/web/index.html` (title, meta, header), `public/icon*.svg`, `public/manifest.webmanifest` |

## Rules of the road

- **Never load a whole file into memory.** Stream it in chunks; hash with `makeSha256()` incrementally.
- **Data lanes aren't ordered relative to the control channel.** Don't treat
  `file-end` or `complete` as "all bytes arrived".
- **Keep messages ≤ 64 KiB** (frame header and encryption overhead included).
- Add an engine test in `packages/transfer/test/` for protocol changes. The
  in-memory pair can simulate lane latency (`dataLaneLatencyMs`).
- TypeScript strict mode. No new runtime dependencies without a good reason.

## Self-hosting

- **Internet:** deploy signaling anywhere that keeps WebSockets open, and the
  web app on any static host (see [DEPLOY.md](DEPLOY.md)).
- **One machine on a LAN:** run `bun run lan`, which serves app and signaling
  on `:8787`. Put HTTPS in front of it (e.g. Caddy `tls internal`) if other
  devices need to receive.

## Archived code

The iOS/Android stubs, CLI, Rust QUIC relay, WASM core and Tauri desktop app
are preserved on the `archive/native` branch.
