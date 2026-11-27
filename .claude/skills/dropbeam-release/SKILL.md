---
name: dropbeam-release
description: Cut a DropBeam version after a good piece of work. Bumps semver, updates CHANGELOG and PHASES, opens a PR, tags after merge, then proposes a fresh Claude session for the next phase. Use when a phase or feature is done and verified, or when asked to "release", "version", "tag" or "ship a version".
---

# dropbeam-release

Every good version gets a tag and the next piece of work starts in a fresh, cheap session.

## Preconditions (stop if any fails)

- `dropbeam-verify` passed in this session (or run it now).
- `dropbeam-invariants` passed on the diff; the `security-auditor` agent reviewed it if it touches
  `packages/`, `apps/signaling/` or anything network-facing.
- Working tree contains only this release's changes.

## Steps

1. **Pick the version** from the last tag (`git describe --tags --abbrev=0`, else `package.json` `version`):
   - patch `x.y.Z`: fixes only
   - minor `x.Y.0`: a new feature or phase (pre-1.0 this is the normal bump)
   - major: reserved for 1.0 public launch
   A change to `PROTOCOL_VERSION` (packages/protocol/src/index.ts) is always at least minor; say so in the changelog.
2. **Bump** `version` in `package.json` and `apps/web/package.json` (keep them equal).
3. **CHANGELOG.md:** add `## vX.Y.Z: <title> (YYYY-MM-DD)` at the top with plain-language bullets
   (what users notice first, then internals). Match the existing tone.
4. **docs/PHASES.md:** tick finished items and add a change-log line.
5. **Branch + commit + PR.** If on `main`, create `release/vX.Y.Z` first. Commit, push, then
   `gh pr create` with the changelog section as the body. Commit or push only with the user's go-ahead.
6. **After the user merges:** `git tag vX.Y.Z <merge-commit> && git push origin vX.Y.Z` (ask first).
   Deploy with `dropbeam-deploy` if the release changes signaling or the web app.
7. **Fresh session for the next step:** propose (start_session, own_initiative, context "fresh") the next
   open item from docs/PHASES.md with a short brief. Then tell the user this session can be archived.

## Token note

Release work is mechanical: do it on Sonnet/Haiku if the user agrees, and don't re-read big files.
Read only the top of CHANGELOG.md and the relevant phase in PHASES.md.
