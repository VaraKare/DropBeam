# ADR-007: Signaling on Cloudflare Workers + one Durable Object

- **Status:** accepted, 2026-11-05. Supersedes the signaling row of [ADR-006](ADR-006-hosting-and-turn.md).
- **Related:** ADR-003 (client IP), ADR-005 (scaling)

## Context

- **Northflank:** signaling ran there. Its proxy made every visitor look
  like one internal address (`10.60.149.121`), and fixing that needed a
  dashboard setting the owner could no longer sign in to change.
- **Render free:** sleeps after 15 minutes, so the first visitor waits up to
  a minute.
- **Constraints:** the product needs an always-on WebSocket server at $0
  until there is traffic, and the visitor's real address must come from a
  source clients can't fake.

## Decision

- **One Worker + one Durable Object.** A Cloudflare Worker forwards `/ws`
  and `/healthz` to **one** Durable Object (`SignalingHub`, name
  `"global"`). That object runs the same `Hub` class as the Bun server
  (`apps/signaling/src/hub.ts`), so behaviour and tests are shared.
- **Standard WebSockets, not hibernation.** A hibernated object loses its
  in-memory state, which would wipe rooms under connected users. A
  non-hibernating object stays resident while any socket is open. One
  always-on object costs ≈ 10,800 GB-s/day, inside the free plan's
  13,000 GB-s/day.
- **Client IP from `CF-Connecting-IP`.** Cloudflare's edge sets it and
  overwrites any client value. There's no proxy-hop configuration to get
  wrong.
- **Free-plan budget:** 100,000 requests/day. Incoming WebSocket messages
  bill at 20:1, so roughly 2 million signaling messages/day. One idle tab's
  20-second keep-alive costs about 216 requests/day.
- **The Bun server stays.** It is still used for Docker/self-hosting and
  LAN mode, and runs the identical hub.

## Consequences

- **One object means one region and one thread.** Signaling is light (tens
  of messages per transfer), so this is fine until ADR-005's trigger. Then
  shard by code prefix: one Durable Object per prefix, chosen by the Worker
  from the code (joiners) or at random (creators).
- **Every deploy restarts the object** and closes open signaling sockets.
  Transfers that are already connected keep going (file bytes don't touch
  signaling); only pairings in progress have to retry.
- **wrangler needs Node 22.** CI installs it. Locally, use Node 22 (or a
  private copy, see DEPLOY.md).
- **Watch:** the free-plan daily limits in the Cloudflare dashboard (Workers
  & Pages → `dropbeam-signaling` → Metrics). If they're approached, the
  Workers Paid plan ($5/mo) lifts them.

## Alternatives rejected

- **Hibernation API with state rebuilt from socket attachments:** cheaper
  when idle, but more code and more ways to lose a room. Not needed within
  the free allowance.
- **One Durable Object per room:** the client would have to know the room
  before connecting, which is a protocol change. Rate limits across objects
  would need another mechanism.
- **Render free / Koyeb / Railway / Fly.io:** sleeping, uncertain free tiers,
  or no free tier.
