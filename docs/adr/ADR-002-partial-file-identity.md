# ADR-002: Identity and locking of partial files

- **Status:** accepted, 2026-11-05
- **Audit:** #3

## Context

Partials were named `<name>.<size>.dbpart`. Two different files with the
same name and size, in one transfer or in two tabs, wrote into the same
partial. We still want **resume**: if the same file is sent again after an
interruption, continue where it stopped.

## Decision

1. **Fingerprint:** the sender adds `lastModified` (ms) to each manifest
   entry. The partial is named `<leaf>.<fp>.dbpart`, where `fp` is 12 hex
   characters of SHA-256 over `relativePath|name`, `size` and
   `lastModified`. The same file sent again has the same fingerprint, so it
   resumes. A different file has a different fingerprint, so there's no
   sharing.
2. **De-duplication inside one transfer:** if two entries still map to the
   same partial (identical name, size and mtime), the later one gets
   `.<fileId>` appended. It won't resume, but it can't collide.
3. **Cross-tab lock:** before opening a partial, the sink takes the Web
   Lock `dropbeam:part:<dir>/<partial>` with `ifAvailable`. If another tab
   holds it, this transfer uses a fresh random partial name (no resume, no
   collision). Browsers without `navigator.locks` keep the old behaviour.
4. **Final-name reservation:** finding a free name and moving the partial
   to it happen under the Web Lock `dropbeam:finalize`, so two tabs can't
   both pick `photo (1).jpg`.

## Alternatives rejected

- **Random names everywhere:** loses resume.
- **Content hash as the identity:** the sender would have to read the whole
  file before sending.
- **IndexedDB resume metadata:** more moving parts for the same result.
  Revisit if fingerprints prove insufficient.

## Consequences

- Partials from v1 (`name.size.dbpart`) are no longer resumed. They are
  cleaned up with the inbox, or left in a user folder, where they are
  harmless.
