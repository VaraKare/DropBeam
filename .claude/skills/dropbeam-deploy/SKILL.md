---
name: dropbeam-deploy
description: Deploy DropBeam's signaling Worker to Cloudflare and/or the web app, then smoke-test production and know how to roll back. Use when asked to deploy, go live, push to production, or after a release that changes apps/signaling or apps/web.
---

# dropbeam-deploy

Deploying is outward-facing: confirm with the user before each deploy command.

## Signaling (Cloudflare Worker + Durable Object, ADR-007)

1. Needs Node 22 for wrangler (`node --version`). Logged in: `cd apps/signaling && bunx wrangler whoami`.
2. Note the current version for rollback: `bunx wrangler deployments list` (keep the top id).
3. Deploy: `cd apps/signaling && bun run deploy:cloudflare`.
4. Smoke: `bun apps/signaling/scripts/smoke.ts https://dropbeam-signaling.dropbeam-signaling.workers.dev`
   (must print 12/12 or the current total). Also `curl …/whoami` (shows `cf-connecting-ip`) and `curl …/healthz`.
5. Rollback if smoke fails: `bunx wrangler rollback <previous-id>`, then smoke again.
   Durable Object migrations (`migrations` in `wrangler.jsonc`) can't be rolled back; review them twice.

## Web app

- Today: Vercel builds `apps/web` from the repo root on push to `main` (`vercel.json`).
  `VITE_SIGNALING_URL` must be `wss://…/ws`; otherwise the red config banner shows.
- Before any ad or donation button: move to Cloudflare Pages (Vercel Hobby forbids commercial use, ADR-006).
- Check after deploy: open the live site in the built-in browser, confirm no config banner and no console
  errors, then do one real transfer (as in `dropbeam-verify` step 2, but against prod).
- Rollback: promote the previous deployment in the Vercel dashboard (user action), or `git revert` + push.

## After

Add a line to docs/PHASES.md change log: what was deployed, smoke result, date.
