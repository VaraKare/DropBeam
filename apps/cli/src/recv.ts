import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  SignalingClient,
  TransferReceiver,
  type DeviceInfo,
} from "@dropbeam/transfer";
import { WebSocket as NodeWS } from "ws";
import { DirectorySinkFactory } from "./fsIo.js";
import { makeWeriftPeer } from "./weriftAdapter.js";
import { answer } from "./peerHandshake.js";

export interface RecvArgs {
  signalingUrl: string;
  outDir: string;
  /** If unset, creates a new room and prints the code. */
  joinCode?: string;
  passphrase?: string;
}

export async function runRecv(args: RecvArgs): Promise<void> {
  const outDir = resolve(args.outDir);
  await mkdir(outDir, { recursive: true });

  const device: DeviceInfo = {
    deviceId: `cli-${process.pid}-${Date.now()}`,
    name: `${hostname()} (cli-recv)`,
    kind: "node",
    userAgent: `dropbeam-cli/0.1 node/${process.version}`,
  };
  const sig = new SignalingClient({
    url: args.signalingUrl,
    device,
    webSocketImpl: NodeWS as unknown as typeof WebSocket,
  });
  await sig.ready();

  let remotePeerId: string;
  if (args.joinCode) {
    const joined = await sig.joinRoom(args.joinCode);
    if (joined.peers.length === 0) throw new Error("no peer in room (sender hasn't created it?)");
    remotePeerId = joined.peers[0]!.peerId;
    console.log(`[recv] joined room ${joined.roomId}; sender: ${remotePeerId}`);
  } else {
    const room = await sig.createRoom();
    console.log(`[recv] room created.`);
    console.log(`       code: ${room.code}`);
    console.log(`[recv] tell sender to use --join-code "${room.code}"`);
    remotePeerId = await new Promise<string>((res) => {
      const off = sig.on((m) => {
        if (m.type === "peer-joined") {
          off();
          res(m.peerId);
        }
      });
    });
    console.log(`[recv] sender joined: ${remotePeerId}`);
  }

  const pc = makeWeriftPeer();
  const receiver = new TransferReceiver(pc, {
    sinkFactory: new DirectorySinkFactory(outDir),
    encryptionPassphrase: args.passphrase,
    onEvent: (e) => logEvent(e),
  });
  receiver.attach();
  await answer(pc, sig, remotePeerId);

  await receiver.done();
  console.log(`[recv] complete. files in: ${outDir}`);
  pc.close();
  sig.close();
}

function logEvent(e: { type: string; [k: string]: unknown }): void {
  if (e.type === "manifest") {
    console.log(`[recv] manifest: ${(e.files as Array<{ name: string }>).map((f) => f.name).join(", ")}`);
    console.log(`[recv] total: ${formatBytes(e.totalBytes as number)}`);
  } else if (e.type === "progress") {
    const pct = (((e.totalBytesTransferred as number) / (e.totalBytes as number)) * 100).toFixed(1);
    const mbps = (((e.bytesPerSecond as number) * 8) / 1e6).toFixed(1);
    const eta = Number.isFinite(e.etaSeconds as number) ? `${(e.etaSeconds as number).toFixed(1)}s` : "?";
    process.stdout.write(`\r[recv] ${pct}%  ${mbps} Mbps  eta ${eta}    `);
  } else if (e.type === "file-done") {
    process.stdout.write(`\n[recv] file ${e.fileId} ok (sha=${(e.sha256 as string).slice(0, 12)}…)\n`);
  } else if (e.type === "complete") {
    process.stdout.write("\n");
  } else if (e.type === "error") {
    console.error("\n[recv] error:", e.error);
  }
}

function formatBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${u[i]}`;
}
