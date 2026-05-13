#!/usr/bin/env bun
/**
 * dropbeam — universal file transfer CLI
 *
 *   dropbeam send  --signaling ws://host:8787/ws  ./file1 ./file2
 *   dropbeam recv  --signaling ws://host:8787/ws  --out ./received
 *
 *   # QUIC direct LAN (requires dropbeam-quic binary on PATH or next to this binary)
 *   dropbeam send  --quic --host 192.168.1.5 --port 9999 --token <tok>  ./file
 *   dropbeam recv  --quic --port 9999 --token <tok> --out ./received
 *
 *   # Adapter selection (default: auto = node-datachannel → werift)
 *   dropbeam send  --adapter werift  --signaling ...  ./file
 *   dropbeam send  --adapter node-dc --signaling ...  ./file
 *
 *   # WASM crypto core (default: auto = wasm → ts)
 *   dropbeam send  --wasm  --signaling ...  ./file
 *   dropbeam send  --no-wasm --signaling ...  ./file
 */

import { runSend } from "./send.js";
import { runRecv } from "./recv.js";
import { quicSend, quicRecv } from "@dropbeam/transfer/quic";

interface ParsedArgs {
  cmd: "send" | "recv" | "help";
  flags: Record<string, string>;
  positional: string[];
}

function parse(argv: string[]): ParsedArgs {
  const [cmd, ...rest] = argv;
  if (cmd !== "send" && cmd !== "recv") return { cmd: "help", flags: {}, positional: [] };
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

function help(): void {
  console.log(
    `dropbeam — universal file transfer CLI

USAGE
  dropbeam send  --signaling <url> [OPTIONS] <file>...
  dropbeam recv  --signaling <url> --out <dir> [OPTIONS]

  # QUIC direct LAN (skips signaling)
  dropbeam send  --quic --host <ip> --port <n> --token <tok> [--lanes 4] <file>...
  dropbeam recv  --quic --port <n> --token <tok> --out <dir>

OPTIONS
  --signaling <url>       Signaling server URL (or DROPBEAM_SIGNALING env var)
  --join-code <code>      Join an existing room instead of creating one
  --passphrase <str>      AES-GCM-256 end-to-end encryption passphrase
  --ttl <sec>             Room TTL in seconds (default: 1800)
  --adapter <name>        WebRTC adapter: auto (default), node-dc, werift
  --wasm / --no-wasm      Force WASM or TS crypto core (default: auto)
  --quic                  Use QUIC LAN transport (requires dropbeam-quic binary)
  --host <ip>             QUIC peer address (send mode)
  --port <n>              QUIC port
  --token <tok>           QUIC auth token
  --lanes <n>             Parallel QUIC streams (default: 4)
  --out <dir>             Output directory (recv mode)
  --transfer-id <id>      Transfer ID for resume (default: auto)

ENVIRONMENT
  DROPBEAM_SIGNALING      default --signaling URL

EXAMPLES
  # 1. Signaling-based (WebRTC, works across NAT)
  bun run dev:signaling                     # Terminal 1
  dropbeam recv --signaling ws://localhost:8787/ws --out ./received   # Terminal 2
  dropbeam send --signaling ws://localhost:8787/ws ./big.zip          # Terminal 3

  # 2. QUIC on LAN (fastest, zero signaling)
  dropbeam recv --quic --port 9999 --token secret --out ./received
  dropbeam send --quic --host 192.168.1.5 --port 9999 --token secret ./big.zip

  # 3. Encrypted transfer
  dropbeam recv --signaling ws://... --out ./recv --passphrase "hunter2"
  dropbeam send --signaling ws://... ./secret.zip --passphrase "hunter2"
`,
  );
}

const argv = process.argv.slice(2);
const parsed = parse(argv);
const url = parsed.flags.signaling ?? process.env.DROPBEAM_SIGNALING;
const passphrase = parsed.flags.passphrase;
const joinCode = parsed.flags["join-code"];
const useQuic = parsed.flags.quic === "true";
const adapter = parsed.flags.adapter as "auto" | "node-dc" | "werift" | undefined;
const forceWasm = parsed.flags.wasm === "true" ? true :
                  parsed.flags["no-wasm"] === "true" ? false : undefined;

if (parsed.cmd === "help" || (parsed.cmd === "send" && parsed.positional.length === 0 && !useQuic)) {
  help();
  process.exit(parsed.cmd === "help" ? 0 : 1);
}

try {
  if (useQuic) {
    // QUIC direct LAN path — no signaling needed
    if (parsed.cmd === "send") {
      const host = parsed.flags.host;
      const port = parsed.flags.port ? Number(parsed.flags.port) : 0;
      const token = parsed.flags.token;
      const lanes = parsed.flags.lanes ? Number(parsed.flags.lanes) : 4;
      const transferId = parsed.flags["transfer-id"] ?? `tx-${Date.now().toString(36)}`;
      if (!host || !port || !token) {
        console.error("error: --quic send requires --host, --port, --token");
        process.exit(2);
      }
      if (parsed.positional.length === 0) {
        console.error("error: no files specified");
        process.exit(2);
      }
      console.log(`[send] QUIC → ${host}:${port}  transferId=${transferId}`);
      await quicSend({ host, port, token, transferId, files: parsed.positional, lanes });
      console.log("[send] QUIC complete.");
    } else {
      const port = parsed.flags.port ? Number(parsed.flags.port) : 0;
      const token = parsed.flags.token;
      const out = parsed.flags.out;
      if (!port || !token || !out) {
        console.error("error: --quic recv requires --port, --token, --out");
        process.exit(2);
      }
      console.log(`[recv] QUIC listening on :${port}`);
      await quicRecv({ port, token, outDir: out });
      console.log(`[recv] QUIC complete. files in: ${out}`);
    }
  } else {
    // WebRTC signaling path
    if (!url) {
      console.error("error: --signaling <url> is required (or set DROPBEAM_SIGNALING).");
      process.exit(2);
    }
    if (parsed.cmd === "send") {
      await runSend({
        signalingUrl: url,
        files: parsed.positional,
        ttlSeconds: parsed.flags.ttl ? Number(parsed.flags.ttl) : undefined,
        passphrase,
        joinCode,
        adapter,
        forceWasm,
      });
    } else {
      const out = parsed.flags.out;
      if (!out) {
        console.error("error: --out <dir> is required for recv.");
        process.exit(2);
      }
      await runRecv({ signalingUrl: url, outDir: out, joinCode, passphrase, adapter, forceWasm });
    }
  }
} catch (e) {
  console.error("\nfatal:", (e as Error).message);
  process.exit(1);
}
