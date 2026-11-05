# ADR-005: Scaling the signaling server

- **Status:** accepted, 2026-11-05 (trigger-based; nothing to build yet)
- **Audit:** Ops #2, #3, #4

## Context

Rooms live in one process's memory. Two instances behind a load balancer
would split a sender and receiver who share a code. Platform sticky
sessions keep one *user* on one instance, not two different users.

## Decision

- **Until measured, one instance.** Phase D load-tests it and records a
  capacity number (sockets, rooms, memory) in `docs/audit/`.
- **Trigger:** sustained use above **50%** of the measured capacity, or the
  need for a second region.
- **When triggered: route by code.** The first character of the room code
  names the shard (`ws-<shard>.<domain>`). The creator connects to a shard
  chosen at random. A joiner derives the shard from the code. No shared
  state and no Redis.
- **Fallback if routing proves awkward:** Redis pub/sub between instances
  (Upstash free tier to start).
- **Restarts:** SIGTERM stops accepting new rooms, lets existing handshakes
  finish for up to 20 s, then exits (Phase B). Peers that are already
  connected keep transferring, because file bytes don't touch signaling.
