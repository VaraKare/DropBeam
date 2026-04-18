#!/usr/bin/env bash
# End-to-end smoke test: spin signaling, recv (creates room), send (joins), verify checksum.
#
# This uses the real WebRTC stack via werift, so it validates the full pipeline.
# Requires: bun, and that `bun install` has been run at the repo root.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-18787}"
TMP="$ROOT/tmp/e2e"
SENT="$TMP/sent.bin"
RECVDIR="$TMP/received"

rm -rf "$TMP"
mkdir -p "$TMP" "$RECVDIR"

# generate a 5 MiB random file
echo "[e2e] generating test file ($SENT)"
dd if=/dev/urandom of="$SENT" bs=1m count=5 2>/dev/null

cleanup() {
  [[ -n "${SIG_PID:-}" ]] && kill "$SIG_PID" 2>/dev/null || true
  [[ -n "${RECV_PID:-}" ]] && kill "$RECV_PID" 2>/dev/null || true
  [[ -n "${SEND_PID:-}" ]] && kill "$SEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[e2e] starting signaling server on :$PORT"
PORT="$PORT" bun apps/signaling/src/server.ts > "$TMP/signaling.log" 2>&1 &
SIG_PID=$!
sleep 1

URL="ws://localhost:$PORT/ws"

echo "[e2e] starting receiver"
bun apps/cli/src/index.ts recv --signaling "$URL" --out "$RECVDIR" > "$TMP/recv.log" 2>&1 &
RECV_PID=$!

# wait for the receiver to print the join code
CODE=""
for i in $(seq 1 40); do
  if grep -qE "code: " "$TMP/recv.log"; then
    CODE="$(grep -E '^\s*code: ' "$TMP/recv.log" | head -n1 | sed 's/.*code: //')"
    break
  fi
  sleep 0.25
done
if [[ -z "$CODE" ]]; then
  echo "[e2e] FAIL: receiver did not produce a code in time"
  cat "$TMP/recv.log"
  exit 1
fi
echo "[e2e] receiver code: $CODE"

echo "[e2e] starting sender"
bun apps/cli/src/index.ts send --signaling "$URL" --join-code "$CODE" "$SENT" > "$TMP/send.log" 2>&1 &
SEND_PID=$!

# wait up to 60s for sender + receiver to both finish
for i in $(seq 1 240); do
  if grep -q "complete." "$TMP/send.log" && grep -q "complete." "$TMP/recv.log"; then
    break
  fi
  sleep 0.25
done

if ! grep -q "complete." "$TMP/recv.log"; then
  echo "[e2e] FAIL: receiver never reported complete"
  echo "----- recv.log -----"; cat "$TMP/recv.log"
  echo "----- send.log -----"; cat "$TMP/send.log"
  exit 1
fi

RECV_FILE="$RECVDIR/$(basename "$SENT")"
if [[ ! -f "$RECV_FILE" ]]; then
  echo "[e2e] FAIL: $RECV_FILE missing"
  ls -la "$RECVDIR"
  exit 1
fi

EXPECTED="$(shasum -a 256 "$SENT" | cut -d' ' -f1)"
ACTUAL="$(shasum -a 256 "$RECV_FILE" | cut -d' ' -f1)"
echo "[e2e] expected sha: $EXPECTED"
echo "[e2e] actual   sha: $ACTUAL"
if [[ "$EXPECTED" != "$ACTUAL" ]]; then
  echo "[e2e] FAIL: sha mismatch"
  exit 1
fi

echo "[e2e] PASS — round-trip ok"
