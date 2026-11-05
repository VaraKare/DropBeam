# Phase A verification, 5 November 2026

What was run, and what it showed, for the Phase A fixes from
[the audit response](2026-11-05-response.md). Anyone can re-run every
command here.

- **Branch:** `hardening/phase-a`
- **Machine:** macOS, Bun 1.3.12, Chromium (Claude desktop browser pane)

## Automated

| Check | Command | Result |
|---|---|---|
| Unit + integration tests | `bun test` | **74 pass, 0 fail** (was 29) across 10 files |
| Types | `bun run typecheck` | clean, all 4 workspaces |
| Production build | `bun run build` | OK, Vite 8.3.4. JS 62.4 kB (23.2 kB gzip), worker 34.1 kB, CSS 32.1 kB |
| Dependency advisories | `bun audit --audit-level=high` | **No vulnerabilities found** (was 15: 5 high, 9 moderate, 1 low) |
| Lockfile determinism | `bun install --frozen-lockfile` | no changes |

## Each finding: the test that pins it

| Audit # | Test (file › name) | Proof that it can fail |
|---|---|---|
| 1 Memory | `hardening.test.ts` › "a fast sender and a slow disk never queue more than the window" | With a 64 MiB window (effectively unbounded), a probe queued **3,158,016 B for a 3 MiB file**, the audit's reproduction. With the 256 KiB window the peak stays ≤ 256 KiB. |
| 1/8 Stall | › "a frozen receiver disk makes the sender fail as stalled" | Before: the sender hung forever |
| 2 Empty files | › "an empty file finishes, verifies and emits file-done"; `fsAccessSink.test.ts` › "an empty file is created under its final name" | Before: `finished=0`, no file-done |
| 3 Partials | `fsAccessSink.test.ts` › "two different files with the same name and size…", "the same file sent again resumes…", "a different file … does NOT resume…" | Before: both files targeted `same.txt.5.dbpart` |
| 4 Validation | `hardening.test.ts` › out-of-range chunk, wrong length, duplicate chunk, unknown file, inconsistent/invalid manifests (4 variants), duplicate ids, second manifest, v1 manifest | Before: `sink.write(65472000, …)` for a 1-byte file |
| 5 QR | `apps/web/test/qr.test.ts` (decoded by jsQR, versions 1–10, Unicode, quiet zone) | Same tests against the old encoder: **4 of 5 fail** |
| 6 Routes | Browser smoke (below) | Before: ReferenceError on 5 routes |
| 8 Waits | › "no answer to the manifest times out", "the receiver disappearing before it answers fails promptly", "a v1 receiver … is refused" | Before: pending forever |
| 9 Malformed | `server.test.ts` › "#9 malformed create-room requests…", "#9 an absurd TTL is clamped"; `validation.test.ts` › parseClientMsg | Before: an immortal room with NaN expiry |
| 10 Leaks | › "#10 one membership per socket…", "#10 churn: 300 create/join/leave/disconnect cycles leave zero rooms" | Before: two rooms leaked per three creates |
| 11 Spoofing | `validation.test.ts` › clientIp (4 cases); `server.test.ts` › "#11 /whoami…" | Before: the first XFF entry was trusted |
| 12 Capacity | › "#12 rooms hold exactly two peers" | Before: 8 |
| 15 AAD | › "a valid ciphertext replayed at another index is refused and never written" | Before: no binding |

## Real browser (production build, two tabs, real WebRTC)

Started with `signaling` + `web-preview` from `.claude/launch.json`.

| Scenario | Result |
|---|---|
| `/about`, `/features`, `/blog`, `/privacy`, `/terms` loaded directly | Each shows its stage (blog/legal) and title. **No console errors.** |
| `/?c=TEST1234` | Receive screen with the code pre-filled |
| On-screen QR decoded by Chrome's native `BarcodeDetector` | `http://localhost:4173/?c=CN-106-PGDP`, exact |
| Transfer to browser storage: `big.bin` 6 MiB random + two **different** `same.txt` (same size and mtime) + **empty** `empty.txt` | "Transfer complete" on both sides. SHA-256 of every received file equals the sender's. Saved as `same.txt` (AAAAA), `same (1).txt` (BBBBB), `empty.txt` (0 B). No `.dbpart` left. |
| Passphrase transfer, 1,048,699 B | Byte-exact (`34f3be82…`) |
| Cancel at 31% of 40 MiB, then **Try again** | Partial kept as `movie.mp4.7249a0b1d581.dbpart` (12.9 MB). The second attempt's progress starts at **30.9%**. Final file matches (`26d493de…`); partial removed. |

After testing, browser storage, the service worker, caches and
localStorage were cleared, the servers stopped, and `apps/web/dist`
deleted.

## Not verified here (needs the deployed site or real devices)

- Real iPhone/Android camera scan of the QR (release gate 6, second half)
- The device matrix (`docs/ROADMAP.md` §2a)
- `docker build`: the Docker daemon was not running. The install step and
  workspace links were reproduced in a scratch copy, and the server started
  from it and answered `/healthz`. That run caught a real bug in the old
  runtime stage, fixed in this phase.
- `TRUST_PROXY_HOPS=1` on Render: check with `/whoami` after deploy (see
  DEPLOY.md).
