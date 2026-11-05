# DropBeam: phase tracker

This is the single source of truth for what is being built, in what order,
and what "done" means. Update it in the same commit as the work.

- **Status:** ☐ not started · ◐ in progress · ☑ done
- **Inputs:**
  - [Audit 2026-11-05](audit/2026-11-05-external-audit.md) and [our response](audit/2026-11-05-response.md)
  - [ROADMAP](ROADMAP.md) (feature backlog)
  - [ADRs](adr/) (decisions)
- **Constraint:** there's no budget until there's traffic. Every phase before
  D runs on free tiers. Phase D is the first that costs money (~$7–8/mo plus
  the domain).

| Phase | Theme | Audit items | Status |
|---|---|---|---|
| A | Correctness & safety (all P1s) + tooling | 1, 2, 3, 4, 5, 6, 8 (part), 9, 10, 11, 12, 15 (part), Ops 5, X1–X5 | ☑ 2026-11-05 |
| B | Resilience | 7, 8 (rest), 14, 19 (storage/scanner/wake lock), Ops 3 | ☐ |
| C | Honest product & privacy | 15 (doc), 16, 17, 18, 20 | ☐ |
| D | Public launch infrastructure | 13, Ops 1, Ops 4, release gates | ☐ |
| E | Accessibility & maintainability | 19 (rest) | ☐ |
| F | Monetization foundation | Ops 6 | ☐ |
| G | Growth features | ROADMAP §3 | ☐ |

---

## Phase A: correctness & safety ☑

**Goal:** no known way for a peer, a client or the network to corrupt
files, lie about success, exhaust memory or leak server state.

| Item | Files | Test |
|---|---|---|
| Byte-credit flow control + stall watchdog ([ADR-001](adr/ADR-001-receiver-flow-control.md)) | `protocol/src/transfer.ts`, `transfer/src/sender.ts`, `transfer/src/receiver.ts` | `engine.test.ts`: slow sink keeps queued bytes ≤ window |
| Protocol version handshake | `protocol/src/index.ts`, `transfer.ts`, sender/receiver, `web/src/main.ts` (friendly error) | version-mismatch test |
| Empty files go through the normal finish/verify | `receiver.ts` | empty + mixed-file test |
| Manifest/frame validation, duplicate-chunk bitset, second-manifest rejection | `protocol/src/validate.ts` (new), `receiver.ts` | adversarial-peer tests |
| Partial identity + Web Locks ([ADR-002](adr/ADR-002-partial-file-identity.md)) | `sinks/fsAccessSink.ts`, `protocol` (`lastModified`), `web` file source | same-name/same-size test with a mock directory |
| Sender: single control dispatcher, ack timeout, close-before-ack | `sender.ts` | disconnect-before-ack test |
| AES-GCM AAD binds `transferId\|fileId\|chunkIndex` | `encryption.ts`, sender/receiver | moved-chunk test |
| QR: format bits, version info, 4-module quiet zone | `web/src/qr.ts` | `web/test/qr.test.ts` decodes v1–10 with jsQR |
| Route bootstrap after all constants | `web/src/main.ts` | browser smoke of every route |
| Signaling: strict schemas, TTL clamp, one membership per socket, `TRUST_PROXY_HOPS`, connection caps, capacity 2, env validation ([ADR-003](adr/ADR-003-client-ip-and-proxies.md)) | `protocol/src/signaling.ts`, `signaling/src/*`, `render.yaml` | malformed / churn / spoof tests |
| Tooling: drop WASM plugins, current Vite, pinned Docker + frozen lockfile, CI | `web/vite.config.ts`, `web/package.json`, `Dockerfile`, `.github/workflows/ci.yml` | `bun audit` has no highs; CI green |

**Exit criteria:** release gates 1–6 and 8 in the
[response](audit/2026-11-05-response.md#release-gates-adopted-from-the-audit-made-concrete).

**Result (2026-11-05):** all items done. Evidence is in
[audit/2026-11-05-phase-a-verification.md](audit/2026-11-05-phase-a-verification.md):

- 74 tests, typecheck and build pass; `bun audit` shows 0 advisories.
- Real two-tab transfers are byte-exact, including an empty file, two
  same-name files, a passphrase transfer and resume after cancel.
- Every route loads with no console errors; the QR decodes with jsQR and
  Chrome's detector.

**Done early (planned for B):** `ALLOWED_ORIGINS`, global and per-IP
connection caps, a `/whoami` deploy check for proxy trust.

**Also fixed (found during the work):**

- A `/` in a sender's file name created sub-folders in browser storage.
  Names are now always single leaves.
- The Docker runtime stage didn't copy Bun's per-workspace links, so the
  container would have failed to start.
- Vite 8 tried to bundle `<link rel="canonical" href="/">`.
- `navigator.vibrate` logged console errors without a user tap.

**Carried to the release gates:**

- Real-phone QR scan.
- Device matrix.
- `docker build` on a machine with Docker running.
- `/whoami` check after deploy.

## Phase B: resilience ☐

- Verify the partial **before** publishing the final name; check space for
  the copy fallback (#7).
- Worker `error`/`messageerror`, ready deadline, `send()` exception
  propagation, awaited worker cleanup (#8).
- Signaling: drop sockets under backpressure, `ALLOWED_ORIGINS`, per-socket
  limits, join-guess limiter, idle timeout, graceful SIGTERM drain (#14,
  Ops 3).
- Guarded `localStorage`, QR scanner stopped on every stage exit, wake-lock
  re-acquire (#19, partial).
- Playwright two-browser e2e in CI (Chromium; WebKit when stable).

## Phase C: honest product & privacy ☐

- Copy and claims follow the tested matrix (#18); "Download started"; the
  real retention behaviour plus periodic pruning (#16).
- Per-session peer id; no user agent on the wire; self-hosted font; privacy
  text covers transient IP use (#17).
- `SECURITY.md` with the threat model and a disclosure contact (#15).
- SEO/PWA: `VITE_SITE_URL`-driven absolute sitemap/canonical/OG, `og.png`,
  theme colours, build-stamped SW cache with cleanup (#20).

## Phase D: public launch ☐

**Costs:** domain ~$12/yr, Render Starter ~$7/mo.

- Domain + DNS; staging (`staging.` on free tiers) and production.
- Signaling on an always-on instance near users ([ADR-006](adr/ADR-006-hosting-and-turn.md)).
- `/turn-credentials` minting (Cloudflare TURN, short TTL, per-room cap),
  plus a spending alert (#13).
- `/metrics`: aggregate counters only (rooms, joins, setup failures, path
  type, relayed bytes).
- Load test (5k sockets) and a written capacity number.
- Rollback runbook, exercised once on staging.
- Fill the device matrix on staging, then launch.

## Phase E: accessibility & maintainability ☐

- Split `main.ts` into `routing`, `session`, `inbox`, `history`, `ui/*`,
  `capabilities`. No behaviour change, guarded by e2e.
- Focus moves to each stage heading; `role=progressbar` with values; a
  polite live region for status; valid button/tab semantics; reduced
  motion everywhere.
- Keyboard-only, VoiceOver and NVDA pass recorded in `docs/audit/`.

## Phase F: monetization foundation ☐

See [ADR-004](adr/ADR-004-ads-isolation.md).

- Content pages (guides/blog) as separate static pages, which is where ad
  inventory belongs.
- Ads only on those pages, or in a cross-origin sandboxed frame. **Never**
  as a script on the transfer page.
- Consent banner where required; privacy policy updated **before** the
  first ad loads.
- Donations link (GitHub Sponsors / UPI) from day one of this phase.

## Phase G: growth features ☐

In order: accept/decline prompt → text/link send → Android share target →
folders → pause/resume → nearby devices → multi-receiver. Each feature gets
a short design note in `docs/adr/` before code.

---

## Change log of this file

- 2026-11-05: created from the external audit; Phase A started.
- 2026-11-05: Phase A completed on branch `hardening/phase-a`.
