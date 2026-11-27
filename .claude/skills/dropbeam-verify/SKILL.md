---
name: dropbeam-verify
description: Prove DropBeam still works after a change. Runs unit tests, typecheck and build, then a real two-tab transfer in the built-in browser and checks the received file is byte-exact. Use before every PR, after any change to apps/ or packages/, or when asked "is it still working?".
---

# dropbeam-verify

Run the cheap checks first and stop at the first failure.

## 1. Static checks (delegate to the `test-runner` agent to save tokens)

```bash
bun test && bun run typecheck && bun run build
```

Report only failures (test name + first error lines). Don't paste passing output.

## 2. Live two-tab transfer (only if the change touches apps/web, packages/transfer, packages/protocol or apps/signaling)

1. `preview_start {name: "signaling"}`, then `preview_start {name: "web-preview"}` (prod build on :4173; the build from step 1 is in `apps/web/dist`).
   Use `web` (:5173, dev, proxies /ws) instead if you need HMR.
2. Tab A (sender): open the home page → Send → pick a file. Automation can't use the OS file picker, so
   inject a generated file with `javascript_tool` (a `File` of ~5 MB random bytes set on the file input via
   `DataTransfer`, then dispatch `change`). Record its SHA-256 via `crypto.subtle.digest` (fine for test data only).
3. Create the share code; read it from the page.
4. Tab B (receiver): open `/?c=CODE` → Join. Without a folder, the file lands in the OPFS inbox `dropbeam-inbox`.
5. Wait for "Verified" on both tabs. In tab B, read the file back from OPFS
   (`navigator.storage.getDirectory()` → `dropbeam-inbox`) and compare its SHA-256 with step 2.
6. `read_console_messages {onlyErrors: true}` on both tabs, and `preview_logs` for signaling errors.

Also cover (when relevant to the change): passphrase transfer, cancel + resend resumes, empty file, two same-name files.

## 3. Report

One short block: static ✔/✖, transfer ✔/✖ (size, hash match), console errors, and anything you could NOT
check (e.g. real phones, which go to `dropbeam-device-test`). Never claim a check you didn't run.
