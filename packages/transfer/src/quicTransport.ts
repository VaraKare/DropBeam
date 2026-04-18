/**
 * QUIC LAN transport — spawns the `dropbeam-quic` Rust binary for
 * sub-millisecond zero-RTT file transfer on the local network.
 *
 * Falls back to WebRTC automatically when:
 *   - the binary is not found in PATH / beside the CLI
 *   - the UDP port is blocked
 *   - the QUIC connect times out (2 s)
 *
 * The binary speaks the same DropBeam frame format as the WebRTC
 * datachannel transport, so SHA-256 verification and resume both work.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const QUIC_BINARY_NAME = "dropbeam-quic";
const QUIC_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_PORT = 9898;

export interface QuicSendArgs {
  host: string;
  port?: number;
  token: string;
  transferId: string;
  lanes?: number;
  chunkSize?: number;
  files: string[];
  onProgress?: (line: string) => void;
}

export interface QuicRecvArgs {
  port?: number;
  token: string;
  outDir: string;
  onProgress?: (line: string) => void;
}

/** Returns the absolute path to the dropbeam-quic binary, or null if not found. */
export function findQuicBinary(): string | null {
  // 1. Next to the CLI entrypoint (typical release packaging)
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      return process.cwd();
    }
  })();
  const candidates = [
    resolve(here, QUIC_BINARY_NAME),
    resolve(here, "..", "bin", QUIC_BINARY_NAME),
    resolve(here, "..", "..", "apps", "quic-relay", "target", "release", QUIC_BINARY_NAME),
    resolve(process.cwd(), QUIC_BINARY_NAME),
  ];
  // 2. PATH
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Check PATH via env
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    const bin = resolve(dir, QUIC_BINARY_NAME);
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** True if the QUIC binary exists and the UDP port appears accessible. */
export async function isQuicAvailable(host: string, port = DEFAULT_PORT): Promise<boolean> {
  if (!findQuicBinary()) return false;
  // Quick UDP reachability probe — we just try to open a UDP socket to the host:port.
  // A true QUIC probe would require the binary; this is a best-effort pre-check.
  try {
    const dgram = await import("node:dgram");
    return await new Promise<boolean>((res) => {
      const sock = dgram.createSocket("udp4");
      const timer = setTimeout(() => { sock.close(); res(false); }, QUIC_CONNECT_TIMEOUT_MS);
      sock.send(Buffer.alloc(1), port, host, (err) => {
        clearTimeout(timer);
        sock.close();
        res(!err);
      });
    });
  } catch {
    return false;
  }
}

export function quicSend(args: QuicSendArgs): Promise<void> {
  return runQuic([
    "send",
    "--host", args.host,
    "--port", String(args.port ?? DEFAULT_PORT),
    "--token", args.token,
    "--transfer-id", args.transferId,
    "--lanes", String(args.lanes ?? 4),
    "--chunk-size", String(args.chunkSize ?? 65536),
    ...args.files,
  ], args.onProgress);
}

export function quicRecv(args: QuicRecvArgs): Promise<void> {
  return runQuic([
    "recv",
    "--port", String(args.port ?? DEFAULT_PORT),
    "--token", args.token,
    "--out", args.outDir,
  ], args.onProgress);
}

function runQuic(argv: string[], onProgress?: (line: string) => void): Promise<void> {
  const bin = findQuicBinary();
  if (!bin) return Promise.reject(new Error("dropbeam-quic binary not found"));

  return new Promise<void>((resolve, reject) => {
    const proc: ChildProcess = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
    const onLine = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) onProgress?.(trimmed);
      }
    };
    proc.stdout?.on("data", onLine);
    proc.stderr?.on("data", onLine);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`dropbeam-quic exited ${code}`));
    });
  });
}
