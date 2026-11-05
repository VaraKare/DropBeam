# ADR-003: Client IP, trusted proxies and signaling limits

- **Status:** accepted, 2026-11-05
- **Audit:** #9, #10, #11, #12, #14

## Context

The server took the **first** `X-Forwarded-For` entry from any connection.
A client can set that header, so it could dodge every per-IP limit.
Separately, malformed messages created rooms that never expired, and a
socket could hold several rooms.

## Decision

- **`TRUST_PROXY_HOPS`** (default `0`):
  - `0`: use the TCP peer address and ignore forwarding headers.
  - `N > 0`: take the **N-th entry from the right** of `X-Forwarded-For`.
    That is the address our own outermost trusted proxy saw. Fewer entries
    than N means a misconfigured proxy, so fall back to the socket address.
  - Render sets `1`.
- **Strict message validation** per type, in `packages/protocol`:
  - bounded device fields (name ≤ 64, kind enum)
  - `ttlSeconds` an integer clamped to [60, 14 400]
  - code ≤ 32 characters
  - peer ids ≤ 64 characters
  - signal payloads ≤ the message cap
- **One membership per socket:** a create/join while already in a room gets
  `already-in-room`.
- **Room capacity 2** (one sender, one receiver) until multi-receiver is
  designed.
- **Connection caps:**
  - `MAX_CONNECTIONS` (default 20 000) globally
  - `MAX_CONNECTIONS_PER_IP` (default 64), generous enough for a school or
    office behind one NAT
- **Env validation:** the server refuses to start on a non-numeric or
  out-of-range setting, instead of running with `NaN`.

## Alternatives rejected

- **Right-most entry, always:** wrong with zero proxies, where the client
  controls it, and wrong with chained proxies.
- **CIDR allow-list of proxies:** more precise, but platform egress ranges
  change without notice. Revisit if we self-host behind a fixed load
  balancer.
