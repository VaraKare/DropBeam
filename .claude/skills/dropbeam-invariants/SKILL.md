---
name: dropbeam-invariants
description: Check the current diff against DropBeam's hard invariants (P2P ordering, flow control, validation, no whole-file buffering, .dbpart safety, protocol versioning, signaling rules, ad isolation, privacy promise). Use before any PR or commit that touches packages/, apps/signaling or apps/web/src.
---

# dropbeam-invariants

Run `git diff main...HEAD` (or `git diff` for uncommitted changes) and check only the touched areas.
For a large protocol/transfer diff, hand this checklist to the `protocol-reviewer` agent instead.

| # | Invariant | Look for in the diff |
|---|---|---|
| 1 | DataChannels aren't ordered relative to each other | Code acting on `file-end`/`complete` as if all data arrived; receiver must count every chunk; sender waits for `complete-ack` |
| 2 | Frame ≤ 64 KiB | Changes to chunk size, header size or encryption overhead (`DEFAULT_CHUNK_SIZE = 64 KiB − 64`) |
| 3 | No whole-file memory | `arrayBuffer()`, `.text()` or whole-file digests on user files; unbounded arrays of chunks |
| 4 | Never overwrite user files | Writes not going through `.dbpart` → verify → rename-to-free-name |
| 5 | Secure-context APIs degrade | New use of `crypto.subtle`, `randomUUID`, OPFS or a folder picker without a fallback/message |
| 6 | Worker bufferedAmount is a cache | Main thread must post state when thresholds change |
| 7 | Never trust the peer | Any new network input not parsed by `packages/protocol/src/validate.ts` (`parseControlMsg`, `validateManifest`, `parseClientMsg`) |
| 8 | Flow control (ADR-001) | Any send path that skips `waitForCredit` |
| 9 | Protocol versioning | Wire format changed but `PROTOCOL_VERSION` not bumped |
| 10 | Partial names (ADR-002) | `<name>.<fingerprint>.dbpart`; sender file names are single leaves |
| 11 | Signaling shape | One room per socket, rooms of 2, logic in `hub.ts` only, adapters stay thin; IP via `TRUST_PROXY_HOPS` / `CF-Connecting-IP` |
| 12 | Ads isolation (ADR-004) | Third-party scripts on transfer stages; CSP loosened |
| 13 | Privacy promise | New storage of IPs, file names, user agents or per-user rows; cookies; analytics scripts |
| 14 | Docs | `docs/PHASES.md` updated with the work |

Output: a table of only the rows that apply, each ✔ or ✖ with `file:line`. Any ✖ blocks the PR until it's fixed
or explicitly accepted by the user.
