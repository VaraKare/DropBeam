# ADR-004: Ads never run on the transfer page

- **Status:** accepted, 2026-11-05 (implementation in Phase F)
- **Audit:** Ops #6

## Context

The plan is to fund DropBeam with ads. An ad script on the same page as the
transfer UI runs with full access to that page: chosen files and their
names, the passphrase field, the share code. Hiding ads during a transfer
does nothing, because the script has already run. Ad networks also bring
cookies, which contradicts the current "no cookies" promise.

## Decision

1. **The transfer app stays script-clean.** It has a strict
   Content-Security-Policy with no third-party script sources.
2. **Ad inventory lives on content pages:** guides, comparisons and the
   blog, built as separate static HTML pages that don't load the transfer
   app. For a utility site this is where search traffic, and therefore ad
   revenue, actually comes from.
3. **An optional single slot on the "done" screen** is allowed **only** as
   a cross-origin `<iframe sandbox>` served from a separate origin (e.g.
   `ads.<domain>`). It is checked against the ad network's policy before
   use.
4. **Before the first ad:** privacy policy updated, consent banner for
   EU/UK/EEA visitors, and the "no cookies" claim removed from pages that
   carry ads.
5. **Also from day one:** donations (GitHub Sponsors / UPI / Buy Me a
   Coffee), and later an ad-free Pro tier (see `docs/PRODUCT.md`).

## Alternatives rejected

- **AdSense script on the main page, hidden during transfers:** unsafe
  (see Context).
- **No ads at all:** contradicts the funding plan. Revisit if donations
  cover costs.
