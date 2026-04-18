import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  SignalingClient,
  TransferSender,
  type DeviceInfo,
  type FileSource,
} from "@dropbeam/transfer";
import { WebSocket as NodeWS } from "ws";
import { fileSource } from "./fsIo.js";
import { makeWeriftPeer } from "./weriftAdapter.js";
import { offer } from "./peerHandshake.js";

export interface SendArgs {
  signalingUrl: string;
  files: string[];
  ttlSeconds?: number;
  passphrase?: string;
  /** When set, joins an existing room instead of creating one. */
  joinCode?: string;
}

export async function runSend(args: SendArgs): Promise<void> {
  const device: DeviceInfo = {
    deviceId: `cli-${process.pid}-${Date.now()}`,
    name: `${hostname()} (cli)`,
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
    if (joined.peers.length === 0) throw new Error("no peer in room to send to");
    remotePeerId = joined.peers[0]!.peerId;
    console.log(`[send] joined room ${joined.roomId}; peer: ${remotePeerId}`);
  } else {
    const room = await sig.createRoom(args.ttlSeconds);
    console.log(`[send] room created.`);
    console.log(`       roomId : ${room.roomId}`);
    console.log(`       code   : ${room.code}`);
    console.log(`       expires: ${new Date(room.expiresAt).toISOString()}`);
    console.log(`[send] waiting for receiver to join...`);
    remotePeerId = await new Promise<string>((res) => {
      const off = sig.on((m) => {
        if (m.type === "peer-joined") {
          off();
          res(m.peerId);
        }
      });
    });
    console.log(`[send] receiver joined: ${remotePeerId}`);
  }

  const sources: FileSource[] = [];
  for (let i = 0; i < args.files.length; i++) {
    const abs = resolve(args.files[i]!);
    const st = await stat(abs);
    if (!st.isFile()) throw new Error(`not a file: ${abs}`);
    sources.push(await fileSource(i + 1, abs));
  }

  const pc = makeWeriftPeer();
  const sender = new TransferSender(pc, {
    encryptionPassphrase: args.passphrase,
    onEvent: (e) => logEvent(e),
  });
  sender.prepareChannels();
  await offer(pc, sig, remotePeerId);

  const transferId = `tx-${Date.now().toString(36)}`;
  await sender.send(transferId, sources);
  console.log(`[send] complete.`);
  pc.close();
  sig.close();
}

function logEvent(e: { type: string; [k: string]: unknown }): void {
  if (e.type === "progress") {
    const pct = (((e.totalBytesTransferred as number) / (e.totalBytes as number)) * 100).toFixed(1);
    const mbps = (((e.bytesPerSecond as number) * 8) / 1e6).toFixed(1);
    const eta = Number.isFinite(e.etaSeconds as number) ? `${(e.etaSeconds as number).toFixed(1)}s` : "?";
    process.stdout.write(`\r[send] ${pct}%  ${mbps} Mbps  eta ${eta}    `);
  } else if (e.type === "file-done") {
    process.stdout.write(`\n[send] file ${e.fileId} ok (sha=${(e.sha256 as string).slice(0, 12)}…)\n`);
  } else if (e.type === "complete") {
    process.stdout.write("\n");
  } else if (e.type === "error") {
    console.error("\n[send] error:", e.error);
  }
}
