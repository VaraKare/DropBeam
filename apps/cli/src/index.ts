#!/usr/bin/env bun
/**
 * dropbeam — minimal CLI for the DropBeam transfer engine.
 *
 *   dropbeam send  --signaling ws://host:8787/ws  ./file1 ./file2
 *   dropbeam recv  --signaling ws://host:8787/ws  --out ./received
 *   dropbeam send  --signaling ws://host:8787/ws  --join-code "K7-9P3-MX2"  ./file
 */

import { runSend } from "./send.js";
import { runRecv } from "./recv.js";

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
  dropbeam send  --signaling <url> [--ttl <sec>] [--passphrase <s>] [--join-code <code>]  <file>...
  dropbeam recv  --signaling <url> --out <dir> [--passphrase <s>] [--join-code <code>]

ENVIRONMENT
  DROPBEAM_SIGNALING   default --signaling URL (e.g. ws://localhost:8787/ws)

EXAMPLES
  # Terminal 1: start signaling server
  bun run dev:signaling

  # Terminal 2: receiver creates room
  dropbeam recv --signaling ws://localhost:8787/ws --out ./received

  # Terminal 3: sender joins via code printed by receiver
  dropbeam send --signaling ws://localhost:8787/ws --join-code "K7-9P3-MX2" ./big.zip

  # Or, sender creates room and waits:
  dropbeam send --signaling ws://localhost:8787/ws ./big.zip
`,
  );
}

const argv = process.argv.slice(2);
const parsed = parse(argv);
const url = parsed.flags.signaling ?? process.env.DROPBEAM_SIGNALING;
const passphrase = parsed.flags.passphrase;
const joinCode = parsed.flags["join-code"];

if (parsed.cmd === "help" || (parsed.cmd === "send" && parsed.positional.length === 0)) {
  help();
  process.exit(parsed.cmd === "help" ? 0 : 1);
}
if (!url) {
  console.error("error: --signaling <url> is required (or set DROPBEAM_SIGNALING).");
  process.exit(2);
}

try {
  if (parsed.cmd === "send") {
    await runSend({
      signalingUrl: url,
      files: parsed.positional,
      ttlSeconds: parsed.flags.ttl ? Number(parsed.flags.ttl) : undefined,
      passphrase,
      joinCode,
    });
  } else if (parsed.cmd === "recv") {
    const out = parsed.flags.out;
    if (!out) {
      console.error("error: --out <dir> is required for recv.");
      process.exit(2);
    }
    await runRecv({ signalingUrl: url, outDir: out, joinCode, passphrase });
  }
} catch (e) {
  console.error("\nfatal:", (e as Error).message);
  process.exit(1);
}
