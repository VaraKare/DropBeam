import type { DeviceInfo } from "@dropbeam/protocol";
import {
  SignalingClient,
  WorkerTransferHost,
  type WorkerTransferEvent,
} from "@dropbeam/transfer";
// Vite resolves the `?worker` query and bundles the file as a dedicated
// Web Worker. Cross-workspace path resolved through the package's exports map.
import TransferWorker from "@dropbeam/transfer/worker/transferWorker?worker";

/* ─────────────── config ─────────────── */

const SIGNALING_URL =
  (import.meta.env.VITE_SIGNALING_URL as string | undefined) ??
  `ws://${location.hostname}:8787/ws`;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const DEVICE: DeviceInfo = {
  deviceId: localDeviceId(),
  name: navigator.userAgent.includes("Mobile") ? "Phone" : "Browser",
  kind: "browser",
  userAgent: navigator.userAgent,
};

function localDeviceId(): string {
  const k = "dropbeam.deviceId";
  let v = localStorage.getItem(k);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(k, v);
  }
  return v;
}

/* ─────────────── DOM ─────────────── */

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const sigUrlEl = $("#sig-url");
sigUrlEl.textContent = SIGNALING_URL;

const viewSend = $("#view-send");
const viewRecv = $("#view-recv");
const roleSend = $<HTMLButtonElement>("#role-send");
const roleRecv = $<HTMLButtonElement>("#role-recv");

roleSend.addEventListener("click", () => setRole("send"));
roleRecv.addEventListener("click", () => setRole("recv"));

function setRole(role: "send" | "recv"): void {
  roleSend.classList.toggle("active", role === "send");
  roleRecv.classList.toggle("active", role === "recv");
  viewSend.classList.toggle("hidden", role !== "send");
  viewRecv.classList.toggle("hidden", role !== "recv");
}

/* ─────────────── send view ─────────────── */

const sendFilesInput = $<HTMLInputElement>("#send-files");
const sendFilelist = $<HTMLUListElement>("#send-filelist");
const sendStartBtn = $<HTMLButtonElement>("#send-start");
const sendCodeEl = $("#send-code");
const sendCodeValue = $("#send-code-value");
const sendStatus = $("#send-status");
const sendProgressWrap = $("#send-progress-wrap");
const sendProgress = $<HTMLProgressElement>("#send-progress");
const sendStats = $("#send-stats");
const dropzone = $<HTMLLabelElement>("#dropzone");

let pickedFiles: File[] = [];

sendFilesInput.addEventListener("change", () => {
  setPickedFiles(Array.from(sendFilesInput.files ?? []));
});

function setPickedFiles(files: File[]): void {
  pickedFiles = files;
  sendFilelist.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = humanBytes(f.size);
    li.append(name, size);
    sendFilelist.appendChild(li);
  }
  sendStartBtn.disabled = files.length === 0;
}

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  }),
);
dropzone.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) setPickedFiles(files);
});

sendStartBtn.addEventListener("click", () => {
  sendStartBtn.disabled = true;
  void runSend(pickedFiles);
});

/* ─────────────── recv view ─────────────── */

const recvCodeInput = $<HTMLInputElement>("#recv-code");
const recvPickDirBtn = $<HTMLButtonElement>("#recv-pickdir");
const recvDirName = $("#recv-dirname");
const recvStartBtn = $<HTMLButtonElement>("#recv-start");
const recvStatus = $("#recv-status");
const recvProgressWrap = $("#recv-progress-wrap");
const recvProgress = $<HTMLProgressElement>("#recv-progress");
const recvStats = $("#recv-stats");

let saveDir: FileSystemDirectoryHandle | null = null;

recvPickDirBtn.addEventListener("click", async () => {
  const picker = (window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    setStatus(recvStatus, "This browser has no File System Access API. Use Chrome/Edge.", "err");
    return;
  }
  try {
    const handle = await picker({ mode: "readwrite" });
    saveDir = handle;
    recvDirName.textContent = handle.name;
    updateRecvButton();
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      setStatus(recvStatus, `folder pick failed: ${(err as Error).message}`, "err");
    }
  }
});

recvCodeInput.addEventListener("input", updateRecvButton);

function updateRecvButton(): void {
  recvStartBtn.disabled = !saveDir || recvCodeInput.value.trim().length < 3;
}

recvStartBtn.addEventListener("click", () => {
  if (!saveDir) return;
  recvStartBtn.disabled = true;
  void runReceive(recvCodeInput.value.trim(), saveDir);
});

/* ─────────────── transfer orchestration ─────────────── */

async function runSend(files: File[]): Promise<void> {
  setStatus(sendStatus, "Connecting to signaling server…");
  const signaling = new SignalingClient({ url: SIGNALING_URL, device: DEVICE });
  let host: WorkerTransferHost | null = null;
  try {
    await signaling.ready();
    const room = await signaling.createRoom();
    sendCodeEl.textContent = room.code;
    sendCodeEl.classList.remove("hidden");
    setStatus(sendStatus, "Waiting for receiver to join with this code…");

    // Sender creates the offer AFTER the receiver joins and we know their peerId.
    const remotePeerId = await waitForPeerJoined(signaling);
    setStatus(sendStatus, "Receiver joined. Negotiating connection…");

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    wireTrickleIce(pc, signaling, remotePeerId);

    host = new WorkerTransferHost({
      worker: () => new TransferWorker(),
      peerConnection: pc,
    });

    // We must create the offer AFTER the worker creates its data channels —
    // otherwise the SDP won't advertise them. Kick off the send session first;
    // it creates `control` + `data-N` channels inside the worker, which flow
    // through to `pc.createDataChannel` on this thread.
    const transferPromise = host.send(crypto.randomUUID(), files, {
      onEvent: (e) => onEvent(e, { progress: sendProgress, stats: sendStats, status: sendStatus }),
    });

    // Wait one tick for the worker to post ch:create messages, then offer.
    // We rely on setLocalDescription flushing any pending DataChannels.
    await nextAnimationFrame();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.signal(remotePeerId, { kind: "sdp", sdp: pc.localDescription });

    await transferPromise;
    setStatus(sendStatus, "Transfer complete.", "ok");
  } catch (err) {
    setStatus(sendStatus, (err as Error).message, "err");
  } finally {
    host?.dispose();
    signaling.close();
    sendStartBtn.disabled = pickedFiles.length === 0;
  }
}

async function runReceive(code: string, dir: FileSystemDirectoryHandle): Promise<void> {
  setStatus(recvStatus, "Connecting to signaling server…");
  const signaling = new SignalingClient({ url: SIGNALING_URL, device: DEVICE });
  let host: WorkerTransferHost | null = null;
  try {
    await signaling.ready();
    const joined = await signaling.joinRoom(code);
    const remote = joined.peers[0];
    if (!remote) throw new Error("no sender in room");

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    wireTrickleIce(pc, signaling, remote.peerId);

    host = new WorkerTransferHost({
      worker: () => new TransferWorker(),
      peerConnection: pc,
    });

    // Kick off receive BEFORE we get the offer, so the worker's receiver
    // has `attach()`ed and is waiting for incoming data channels.
    const transferPromise = host.receive({
      sink: { kind: "fsaccess", directory: dir },
      onEvent: (e) => onEvent(e, { progress: recvProgress, stats: recvStats, status: recvStatus }),
    });

    setStatus(recvStatus, "Waiting for sender's offer…");
    const offer = await waitForSdp(signaling, remote.peerId, "offer");
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling.signal(remote.peerId, { kind: "sdp", sdp: pc.localDescription });

    await transferPromise;
    setStatus(recvStatus, "Transfer complete.", "ok");
  } catch (err) {
    setStatus(recvStatus, (err as Error).message, "err");
  } finally {
    host?.dispose();
    signaling.close();
    recvStartBtn.disabled = !saveDir || recvCodeInput.value.trim().length < 3;
  }
}

/* ─────────────── helpers ─────────────── */

function wireTrickleIce(
  pc: RTCPeerConnection,
  signaling: SignalingClient,
  remotePeerId: string,
): void {
  pc.addEventListener("icecandidate", (ev) => {
    if (ev.candidate) {
      signaling.signal(remotePeerId, { kind: "ice", candidate: ev.candidate.toJSON() });
    }
  });
  signaling.onSignalFrom(remotePeerId, async (data) => {
    const msg = data as
      | { kind: "sdp"; sdp: RTCSessionDescriptionInit }
      | { kind: "ice"; candidate: RTCIceCandidateInit };
    try {
      if (msg.kind === "sdp" && msg.sdp.type === "answer" && !pc.remoteDescription) {
        await pc.setRemoteDescription(msg.sdp);
      } else if (msg.kind === "ice") {
        await pc.addIceCandidate(msg.candidate);
      }
    } catch (err) {
      console.warn("signal handling failed", err);
    }
  });
}

function waitForPeerJoined(signaling: SignalingClient): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const off = signaling.on((m) => {
      if (m.type === "peer-joined") {
        off();
        resolve(m.peerId);
      } else if (m.type === "error") {
        off();
        reject(new Error(`${m.code}: ${m.message}`));
      }
    });
  });
}

function waitForSdp(
  signaling: SignalingClient,
  fromPeerId: string,
  expect: "offer" | "answer",
): Promise<RTCSessionDescriptionInit> {
  return new Promise<RTCSessionDescriptionInit>((resolve) => {
    signaling.onSignalFrom(fromPeerId, (data) => {
      const msg = data as { kind?: string; sdp?: RTCSessionDescriptionInit };
      if (msg.kind === "sdp" && msg.sdp?.type === expect) resolve(msg.sdp);
    });
  });
}

function onEvent(
  e: WorkerTransferEvent,
  ui: { progress: HTMLProgressElement; stats: HTMLElement; status: HTMLElement },
): void {
  switch (e.type) {
    case "manifest":
      ui.progress.classList.remove("hidden");
      ui.progress.max = e.totalBytes || 1;
      ui.progress.value = 0;
      setStatus(ui.status, `Manifest received: ${e.files.length} file(s), ${humanBytes(e.totalBytes)}`);
      break;
    case "progress":
      ui.progress.value = e.totalBytesTransferred;
      ui.stats.textContent =
        `${humanBytes(e.totalBytesTransferred)} / ${humanBytes(e.totalBytes)}  ` +
        `· ${humanBytes(e.bytesPerSecond)}/s  · ETA ${humanEta(e.etaSeconds)}`;
      break;
    case "file-done":
      setStatus(ui.status, `File ${e.fileId} saved (sha256 ${e.sha256.slice(0, 12)}…)`);
      break;
    case "complete":
      ui.progress.value = ui.progress.max;
      break;
    case "error":
      setStatus(ui.status, e.error.message, "err");
      break;
  }
}

function setStatus(el: HTMLElement, text: string, kind: "" | "ok" | "err" = ""): void {
  el.textContent = text;
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
}

function humanBytes(n: number): string {
  if (!isFinite(n) || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanEta(seconds: number): string {
  if (!isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}
