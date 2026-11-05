# DropBeam engineering and product audit — 5 November 2026

Review baseline: commit `0140584`, working tree initially clean. Repository: `/Users/karevaraprasad/Desktop/Projects/DropBeam`. The workspace path supplied to the chat was stale. Three specialist agents reviewed signaling/security, transfer/storage, and frontend/product alongside the coordinating reviewer. This report is the only intentional tracked-file change; application code was not fixed or deployed.

**Assessment:** The small browser-first architecture suits the product, and the existing integrity, ordering, cancellation, and streaming work is valuable. Treat the current version as a development/beta build. Fix the delivery, pairing, and abuse issues below before a broad public launch. Passing unit tests currently overstates confidence in the real browser product.

## Evidence and limits

- `bun test`: **29 passed, 0 failed**, across six test files.
- `bun run typecheck`: all four workspaces passed.
- `bun run build`: passed; Vite 5.4.21. Main JavaScript 74.87 kB / 24.11 kB gzip; CSS 32.15 kB / 6.36 kB gzip; HTML 29.27 kB / 7.01 kB gzip; worker JavaScript 28.15 kB uncompressed. These are local build sizes, not measured page speed.
- Additional local probes reproduced malformed signaling requests, leaked memberships, forwarding-header rate-limit bypass, empty-file completion, receive-queue growth, out-of-range writes, and temporary-file collisions.
- Installed headless Chrome, controlled through CDP against the production build, reproduced route initialization failures. `/` and `/?c=TEST1234` initialized normally; `/about`, `/features`, and `/privacy` threw ReferenceErrors. `/blog` and `/terms` follow the same faulty source paths.
- Native macOS Vision could not decode generated QR samples, but decoded a native CoreImage reference. A temporary correction to format-bit coordinates made short-code and ordinary join-link samples decode; long version-7+ samples still failed.
- Queried npm's bulk advisory endpoint with **82 public package names and locked versions**. Six packages matched advisories: Vite, esbuild, nanoid, postcss, source-map-js, uuid. These matches need reachability analysis; they do not establish exploitation of the deployed static app. Bun's configured scan command could not run because no scanner is configured.
- Docker could not be built because the local Docker daemon is unavailable. No deployed URL, production logs, real mobile-device transfer matrix, WAN throughput benchmark, or load test was available. No claim of complete penetration testing or production performance measurement is made.

Priority: **P1** = fix before broad launch; **P2** = next hardening cycle, or before enabling the affected feature; **P3** = later improvement. Runtime reproductions, static findings, and conditional risks are identified separately.

## Delivery, storage, and pairing findings

### 1. P1 — Receiver memory is not bounded by disk speed (runtime reproduced)

`packages/transfer/src/receiver.ts:131` captures every incoming frame in a serial Promise chain. Sender `bufferedAmount` limits network enqueueing, not outstanding receiver disk writes. Verification also occupies that queue at `receiver.ts:331` while more data can arrive.

A 2 MiB transfer with 4 KiB chunks and a 2 ms simulated write delay queued approximately the entire payload (2,105,344 bytes including framing). A sufficiently fast network and slow disk/phone can grow memory with transfer size and crash the tab. This contradicts the flat-memory promise.

**Fix:** Receiver-driven byte credits/window acknowledgments, a measured maximum queued-byte budget across worker and disk queues, and explicit protocol failure on overrun. Replenish credits after successful writes. Verify bounded memory with slow-storage, encryption, and multi-file tests.

### 2. P1 — Empty files can report success without being saved (runtime reproduced)

`packages/transfer/src/receiver.ts:216` marks a zero-byte file done immediately because `offset >= size`. Its file-end is ignored at line 309. The sink never finishes, verifies, or emits file-done, yet the transfer acknowledges completion.

Probe result: transfer completed with `finished=0`, `writes=0`, events `manifest, started, complete`.

**Fix:** Separate byte-completeness from finalized/verified state. Empty files must close, receive a final name, verify the empty SHA-256, and emit file-done through the normal path.

### 3. P1 — Temporary filenames collide for distinct files (runtime reproduced with sink mock)

`packages/transfer/src/sinks/fsAccessSink.ts:144` keys partials solely by sanitized name and size. `receiver.ts:205` opens all manifest files before transfer begins. Two distinct files named `same.txt` with the same size therefore target the same partial; sanitized-name collisions and concurrent receive tabs introduce similar risks. The mock requested `same.txt.1.dbpart` twice and the second exclusive handle failed.

**Fix:** Give partials durable content/transfer identity, persist resume metadata, and lock ownership. Preserve intentional cross-session resume without letting unrelated files share a writer. Reserve final filenames safely under concurrency. Test duplicate names, sanitized collisions, multiple tabs, and interrupted retries.

### 4. P1 — Receiver accepts writes outside the declared file (runtime reproduced)

`packages/transfer/src/receiver.ts:140` casts unvalidated JSON to protocol types. Lines 263–268 compute write offsets without enforcing declared size, valid chunk range, or exact final-chunk length. A peer declared a one-byte file, passed a one-byte capacity check, then caused `sink.write(65472000, oneByte)` by sending chunk index 1000.

**Fix:** Validate manifest limits, finite safe integers, unique file IDs, total size consistency, chunk lengths and bounds, encryption policy, transfer identity, and protocol state before opening or writing. Track unique received ranges/chunks rather than counting duplicate bytes. Reject second manifests and unexpected messages. Add fuzz and adversarial-peer tests.

### 5. P1 — QR generation is broken (independent decoder reproduction)

`apps/web/src/qr.ts:345–352` writes format information with transposed coordinates. A temporary format-bit correction made the short-code and normal URL samples readable. Version 7+ additionally lacks required version-information handling. The default SVG margin at line 431 is two modules; use the standard four-module quiet zone.

**Fix:** Use a vetted standards-complete encoder or correct the implementation against reference vectors. Verify generated output with an independent decoder, short/long URLs, Unicode, screen scaling, and actual phone cameras. A visual snapshot alone is insufficient. [Nayuki's reference implementation](https://www.nayuki.io/page/qr-code-generator-library) is a relevant primary reference and is already credited by this source.

### 6. P1 — Direct information/legal URLs fail initialization (production-browser reproduced)

`apps/web/src/main.ts:1745` invokes route handling before `legalTitle`, legal content, and `BLOG_HTML` initialize at lines 1984 onwards. `/about` and `/features` threw `Cannot access 'cr' before initialization` in the production bundle; `/privacy` threw the equivalent error for `sr`. They stayed on the idle screen. Later module setup is also skipped.

**Fix:** Run one explicit bootstrap after all constants initialize, preferably with routing and content in separate modules. Smoke-test every direct URL and refresh, alongside code deep links.

### 7. P2 — Save fallback adds substantial I/O and temporary space

`packages/transfer/src/sinks/fsAccessSink.ts:279` copies a complete partial into a final file when rename is unsupported, then `receiver.ts:331` rereads the final file to hash it. Relative to initial receiving, a file of size S adds about S bytes written and 2S read. The copy temporarily needs both files, while the capacity check only uses remaining transfer bytes. Writable-stream implementations may add further temporary storage. User export from OPFS may need another device-side copy.

**Fix:** Detect storage capabilities and budget for finalization, resume, and export; retain valid partials on failure. Verify the partial before publishing a final filename. Prefer an atomic move where supported; measure actual fallback behavior. [Chrome documents move limitations](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access#renaming-and-moving-files-and-folders). [MDN documents quota estimation, errors, and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

### 8. P2 — Several failures can leave sessions waiting

`packages/transfer/src/sender.ts:316` waits for manifest acknowledgment without timeout or close handling; the close listener is installed only after acknowledgment. A pre-ack disconnect remained pending in the probe. `worker/workerClient.ts:354` does not catch real DataChannel send exceptions and return them to the worker. The host also lacks worker error/messageerror handling and a ready deadline. On the receive path, connected transport does not ensure the engine is healthy.

**Fix:** Bounded readiness/ack waits, worker error propagation, channel-send failure propagation, cancellation-aware cleanup, and a progress watchdog suitable for slow disks. Await cleanup acknowledgment instead of assuming a fixed two-second worker grace period always suffices.

## Signaling and security findings

### 9. P1 — Malformed requests create rooms that never expire (runtime reproduced)

`packages/protocol/src/signaling.ts:140` validates only the message type. A create-room request missing device metadata and using `ttlSeconds: "not-a-number"` succeeded. `apps/signaling/src/room.ts:59` produces NaN expiry; the wire returns null and pruning never expires the room.

**Fix:** Strict discriminated runtime schemas, bounded device fields, positive finite TTL validation, maximum payload complexity, and environment validation before startup. Test malformed objects as well as invalid JSON.

### 10. P1 — Repeated membership operations leak rooms (runtime reproduced)

`apps/signaling/src/server.ts:211` and line 244 overwrite socket membership without leaving the previous room. Close only cleans the newest membership. Three creates on one socket left two rooms after disconnect. Combined with invalid expiry this can exhaust capacity until restart.

**Fix:** Enforce one membership per socket; reject duplicate create/join or explicitly detach first. Test disconnect, switching rooms, repeated joins, expiry, and cleanup invariants.

### 11. P1 — Spoofed forwarded IP bypasses rate limits (runtime reproduced)

`apps/signaling/src/server.ts:115` trusts the first X-Forwarded-For entry from every connection. A sixth room creation was limited, but changing this header from the same machine immediately allowed another create. Production exposure depends on the actual proxy configuration.

**Fix:** Socket IP by default; accept forwarded identity only from configured trusted proxies, with a correctly processed chain and protected backend ingress. Add global/per-connection connection and room caps. Avoid merely switching to the last header value without defining the proxy trust boundary. [OWASP recommends validation, connection limits, bounded resources, and backpressure](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

### 12. P2 — Eight-peer rooms do not match the one-receiver product

`apps/signaling/src/server.ts:82` and `render.yaml` default to eight peers. The sender handles the first receiver and the receiving UI selects the first peer. Later joiners can be admitted without a supported transfer path.

**Fix:** Capacity two and explicit sender/receiver roles for now. Confirm the intended receiver before sending sensitive files; present a receiver accept/decline gate before file creation. Multicast needs its own session design and bandwidth budget.

### 13. P2 — Public static TURN credentials invite relay abuse (conditional on configuration)

`apps/web/src/main.ts:45–53` embeds credentials into public JavaScript. Long-lived shared credentials can be reused outside this app and consume relay bandwidth.

**Fix:** Mint short-lived credentials server-side with allocation/usage caps and cost alerts. Keep the provider's long-term secret on the backend. Choose expiry and renewal for long transfers. [Cloudflare's official credential guidance](https://developers.cloudflare.com/realtime/turn/generate-credentials/) describes this pattern. Without TURN, strict-network reliability remains limited.

### 14. P2 — Further signaling hardening

`server.ts:96` ignores WebSocket send backpressure/drop results; define bounded delivery or explicit failure for slow clients. Add configurable Origin validation as abuse reduction; this is not a demonstrated cookie-session hijack because the app has no authenticated cookie session. Separate per-socket relay limits from coarse IP abuse limits so shared school/office/carrier IPs are not unfairly throttled. Rate-limit credential issuance and join guesses separately. Close dead/idle sockets and observe rejected requests without logging codes, SDP, or file metadata.

### 15. P2 — Passphrase threat model needs a dedicated review (not an exploited vulnerability)

AES-GCM encrypts chunks without binding transfer/file/chunk position as authenticated associated data. Manifest and completion hashes are not authenticated by the passphrase layer. DTLS protects against ordinary network alteration; a compromised signaling service that substitutes peer fingerprints is a different threat. No full exploit was reproduced.

**Fix:** Document the trust model, then bind chunk metadata and authenticate manifest/completion if the passphrase promises protection from an active signaling compromise. Obtain a focused cryptographic review before making stronger claims. Do not invent new cryptography casually.

## Privacy, product, accessibility, and maintenance

### 16. P2 — Retention and Save labels promise more than the app guarantees

`apps/web/src/main.ts:1069` prunes old inbox files only at startup. Closed apps cannot run deletion, and open tabs do not periodically prune. `main.ts:2010` and line 1595 promise deletion after 24 hours; saving a download does not clear OPFS. Line 1624 says Saved immediately after clicking an anchor, without confirmation of successful download.

**Fix:** Describe cleanup as occurring on a later visit after expiry, add safe active-page cleanup, retain explicit Clear, and say Download started. Preserve the browser copy until users choose to clear it. Distinguish verified receipt in browser storage from durable export to Downloads/Files.

### 17. P2 — Disclose and minimize transient metadata

`main.ts:116–119` sends persistent device ID and full user agent; `server.ts:249–265` forwards the device object to peers. IP-keyed buckets exist in server memory even though the policy says IP is not stored or tied to anything. Remote font requests at `apps/web/index.html:90–91` also contact a third party.

**Fix:** Prefer per-session identity and omit full user agent; explain transient routing/rate-limit data accurately. Self-host the font for fewer external requests, simpler privacy wording, and better offline consistency. Verify actual hosting logs separately. This is an engineering accuracy finding, not a legal-compliance conclusion.

### 18. P2 — Product claims exceed demonstrated browser support

Marketing advertises any size/device, folders, and 50 GB+, while folder selection is not implemented, OPFS has quotas/eviction, and mobile background execution is constrained. Host-only ICE also does not prove physical proximity or guarantee a private subnet route in every network topology.

**Fix:** Publish tested browser/device/size limits and precise mode semantics. Explain that both devices must stay available, browser receipt may require export, TURN may relay encrypted bytes, and HTTPS is required for receive/storage APIs. Prefer evidence from the deployed device matrix over absolute claims.

### 19. P2 — Accessibility and module boundaries need deliberate work

The main module has 2,143 lines. Screen changes do not move focus to the new screen heading; transfer progress lacks semantic progress values; nested role-button info controls and tab semantics need keyboard/screen-reader testing. Reduced-motion CSS covers only a small part of JS-driven movement. A wake-lock reference is retained after browser release, so the visible-again check may not reacquire it. Unguarded localStorage access at `main.ts:136` and mode initialization can stop startup when storage access is denied. The QR scanner's `stopScan()` at line 548 is not called on navigation or receive start, allowing camera tracks and detection to continue after leaving the screen.

**Fix:** Split session orchestration, routing, inbox, history, rendering, and capability detection. Keep behavior stable during extraction. Add focus management, semantic progress/status updates, valid interactive structure, reduced-motion support, best-effort localStorage with ephemeral identity fallback, wake-lock release handling, and scanner cleanup on every stage exit/error. Test with keyboard, VoiceOver, NVDA, zoom, and real phones. [WCAG 2.2](https://www.w3.org/TR/WCAG22/) supplies the relevant accessibility criteria; this review is not a conformance certification.

### 20. P2/P3 — PWA, SEO, and visual polish

`apps/web/public/sw.js:13` has a fixed cache version, cache-first hashed assets, and no size/age budget; repeated deployments can accumulate obsolete assets. Caching the shell does not make public signaling available offline. Dark manifest/theme metadata does not match the light design. The social preview references `/og.png`, which does not exist. Sitemap entries are relative and a source comment wrongly says Google accepts them.

**Fix:** Version and bound app-owned caches, preserve assets required by active transfers, handle deployment changes explicitly, and test offline/update flows. Align theme/install metadata and provide appropriate icons. Add the PNG preview, absolute sitemap URLs, canonical/OG URLs, and meaningful direct-route content. [Google explicitly requires fully qualified sitemap URLs](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).

## Operations and growth risks

1. **Free-host cold starts:** `render.yaml` uses Free in Oregon. Render documents roughly one-minute spin-up, restarts, and shared monthly hours. Monitoring pings are not an availability guarantee. Select an always-on service and region based on users when launch reliability matters. This improves pairing latency, not established direct-transfer bandwidth. [Render free-service limits](https://render.com/docs/free).
2. **Horizontal scaling breaks room lookup:** room state is process-local. Sender and receiver may land on different instances. Keep one measured instance initially; later use room-aware routing or shared discovery and cross-instance signaling. Per-user sticky sessions alone do not colocate two different users. [Render documents random WebSocket instance assignment](https://render.com/docs/websocket).
3. **Restart/reconnect semantics:** tokens are issued but the current protocol has no reconnect/rejoin implementation. Restart loses rooms. Add graceful draining, bounded reconnect/backoff, and explicitly designed recovery/ICE restart. Established peer traffic should remain independent of signaling availability where possible.
4. **Unmeasured capacity and cost:** MAX_ROOMS=10000 is a configuration value, not a load-test result. The documentation's concurrency, TURN-share, revenue, and growth estimates are hypotheses. Measure sockets, memory, setup failures, and relayed bytes before scaling or forecasting.
5. **Build/dependency hygiene:** no CI workflow is present. Docker deletes the lockfile and uses floating Bun image tags. Pin a tested runtime and use deterministic production dependency resolution. Add CI for tests, typecheck, build, browser smoke tests, dependency updates, and applicable advisory review. Vite 5 is outside current support; upgrade to a supported release. [Vite support policy](https://vite.dev/releases), [Vite maintainer advisory](https://github.com/vitejs/vite/security/advisories/GHSA-4w7w-66w2-5vf9). esbuild's advisory concerns its serve feature; a dependency match alone does not show DropBeam runs that vulnerable server path. [esbuild maintainer advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99).
6. **Third-party scripts:** the same page has access to chosen files and passphrases. If ads are added later, merely hiding them during transfer stages in this SPA does not remove already executed scripts. Use a separate origin/sandbox boundary and revisit privacy/security claims before integrating monetization scripts.

## Performance plan

The current bundle is already small. Measure the transfer path before a framework rewrite or additional channels.

| Area | Action | Measurement |
|---|---|---|
| Pairing latency | Always-on regional signaling, bounded readiness waits, efficient trickle ICE | Click-to-code and join-to-first-byte p50/p95 by region/network |
| Memory stability | Receiver credits, bounded queues, bounded reorder metadata | Peak queued bytes and heap under slow disk/fast sender |
| Transfer throughput | Compare 1/2/4 lanes, 16/32/~64 KiB chunks and watermarks on real browsers | Delivered-and-verified MiB/s, cancellation delay, retransmission/RTT |
| Main-thread responsiveness | Profile and reduce redundant frame copies and worker messages | Long tasks and interaction delay during transfer |
| Finalization | Capability-aware move/copy, verify before publishing final name | Wire time vs write/copy/hash/export time; peak disk usage |
| CPU/battery | Profile pure-TS hashing and per-chunk encryption on low-end phones before considering vetted WASM hashing | Hash MiB/s, worker CPU, thermal/battery impact |
| Page load | Self-host font; maintain small asset budget | Measured LCP/INP and repeat-load bytes, not bundle size alone |

Multiple DataChannels share the underlying transport; more lanes do not guarantee more bandwidth. Respect negotiated message limits and retain the existing frame-size safety margin. [MDN's DataChannel guidance](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels) covers buffering, size limits, and head-of-line effects.

## Recommended sequence and release evidence

**First hardening cycle:** fix receiver bounds/memory/finalization and empty files; isolate partial files; fix QR and routing; enforce signaling schemas, membership invariants, trusted proxy handling, and two-peer rooms. Add a regression for each demonstrated defect. Upgrade supported tooling and establish CI.

**Second hardening cycle:** real two-browser transfer tests through the worker and filesystem paths; then real iPhone/Android/desktop matrix. Exercise wrong passphrase, cancellation, disconnect before ack, screen lock/return, duplicate names, empty files, large files, quota/finalization errors, browser restart/retry, and deployment updates. Verify the actual final exported bytes, not just the success message.

**Launch preparation:** configure and test TURN on restrictive networks; add expiry-aware credential minting and spending limits; choose an availability-appropriate signaling host; align privacy/product wording; finish accessibility and direct-route/SEO checks. Add aggregate operational measurements without file names, contents, codes, passphrases, SDP, or stable device identifiers.

**Later product work:** receiver consent and sender confirmation first, then reliable folders and text/link transfer, Android share target, intentional pause/resume, and self-host HTTPS packaging. Nearby discovery and multi-recipient transfers need explicit privacy and bandwidth designs. Store-and-forward and native apps materially expand product scope and should follow demonstrated demand.

Suggested release gates are project targets, not industry promises: all P1 regressions fixed; tested transfer/export matrix documented; receiver memory stays within a declared budget independent of file size; success only after verified finalization; no browser-console errors on supported routes; no leaked memberships under connection churn; observable setup failure rates and TURN cost; a rollback procedure exercised against staging. Set numerical latency and reliability targets after collecting a representative baseline.
