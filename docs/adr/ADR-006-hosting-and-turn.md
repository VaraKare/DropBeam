# ADR-006: Hosting and TURN on a zero budget

- **Status:** accepted, 2026-11-05
- **Audit:** #13, Ops #1

## Decision

| Piece | Now (no traffic, no money) | At public launch (Phase D) | Why |
|---|---|---|---|
| Static app | Vercel Hobby (no ads yet, so non-commercial use is fine) | **Cloudflare Pages** (free, commercial use allowed), or Vercel Pro if its features are needed | Ads make the site commercial; Vercel Hobby forbids that |
| Signaling | ~~Render~~ → **Cloudflare Workers + Durable Object, free** ([ADR-007](ADR-007-signaling-on-cloudflare.md)) | Same; Workers Paid ($5/mo) only if free daily limits are approached | Always on, no cold start, unspoofable client IP |
| TURN | **None.** Direct P2P only; the UI already explains strict networks | Cloudflare TURN via short-lived credentials minted by signaling, with per-room byte caps and a billing alert | Static credentials in public JS invite relay abuse |
| Domain | – | One `.com` (~$12/yr). Apex = app, `ws.` = signaling, `staging.` = staging | |

**Rule:** no paid service is added without (a) a metric showing the need
and (b) a spending cap or alert.
