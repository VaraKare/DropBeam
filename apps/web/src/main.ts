/**
 * DropBeam web — entry point. Wires the multi-stage UI to the worker-hosted
 * transfer engine + signaling client. State machine:
 *
 *   idle ──► send-pick ──► send-share ──► active ──► done
 *        ╲                                  ▲
 *         ╲                                 │
 *          ╰────► recv-pick ────────────────╯
 */

import type { DeviceInfo } from "@dropbeam/protocol";
import {
  SignalingClient,
  WorkerTransferHost,
  type WorkerTransferEvent,
} from "@dropbeam/transfer";
import TransferWorker from "@dropbeam/transfer/worker/transferWorker?worker";

import { encodeQr, qrToSvg } from "./qr.js";

/* ─────────────── config ─────────────── */

type ConnectionMode = "lan" | "net";

interface AppEnv {
  signalingUrl: string;
  iceServers: RTCIceServer[];
  /** True when the page is being served from a same-origin signaling host (LAN-only deployment). */
  sameOrigin: boolean;
  /** Best-guess current mode. */
  mode: ConnectionMode;
}

function detectEnv(): AppEnv {
  const override = (import.meta.env.VITE_SIGNALING_URL as string | undefined) ?? null;
  const host = location.hostname;
  const isPrivateHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /\.local$/.test(host);

  const sameOrigin = !override && isPrivateHost;
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const signalingUrl = override
    ?? (sameOrigin
      ? `${wsProto}://${location.host}/ws`
      : `ws://${host || "localhost"}:8787/ws`);

  const iceServers: RTCIceServer[] = sameOrigin
    ? [] // No STUN for LAN mode — host candidates only.
    : [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

  return {
    signalingUrl,
    iceServers,
    sameOrigin,
    mode: sameOrigin ? "lan" : "net",
  };
}

let env = detectEnv();

const DEVICE: DeviceInfo = {
  deviceId: persistentDeviceId(),
  name: friendlyDeviceName(),
  kind: detectDeviceKind(),
  userAgent: navigator.userAgent,
};

function persistentDeviceId(): string {
  const k = "dropbeam.deviceId";
  let v = localStorage.getItem(k);
  if (!v) {
    v = crypto.randomUUID();
    localStorage.setItem(k, v);
  }
  return v;
}

function friendlyDeviceName(): string {
  const ua = navigator.userAgent;
  const platformish =
    /iPhone/i.test(ua) ? "iPhone" :
    /iPad/i.test(ua) ? "iPad" :
    /Android/i.test(ua) ? "Android" :
    /Macintosh/i.test(ua) ? "Mac" :
    /Windows/i.test(ua) ? "Windows" :
    /Linux/i.test(ua) ? "Linux" :
    /CrOS/i.test(ua) ? "ChromeOS" :
    "Browser";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Safari\//.test(ua) ? "Safari" :
    "Browser";
  return `${platformish} · ${browser}`;
}

function detectDeviceKind(): DeviceInfo["kind"] {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Macintosh/i.test(ua)) return "macos";
  if (/Windows/i.test(ua)) return "windows";
  if (/Linux|CrOS/i.test(ua)) return "linux";
  return "browser";
}

/* ─────────────── DOM helpers ─────────────── */

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

type Stage = "idle" | "send-pick" | "send-share" | "recv-pick" | "active" | "done" | "legal" | "blog";

const stages: Record<Stage, HTMLElement> = {
  idle:        $('[data-stage="idle"]'),
  "send-pick":  $('[data-stage="send-pick"]'),
  "send-share": $('[data-stage="send-share"]'),
  "recv-pick":  $('[data-stage="recv-pick"]'),
  active:      $('[data-stage="active"]'),
  done:        $('[data-stage="done"]'),
  legal:       $('[data-stage="legal"]'),
  blog:        $('[data-stage="blog"]'),
};

let history: Stage[] = ["idle"];

function goto(stage: Stage, push = true): void {
  for (const el of Object.values(stages)) el.classList.remove("active");
  stages[stage].classList.add("active");
  if (push) history.push(stage);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function back(): void {
  cancelActive();
  history.pop();
  const prev = history.pop() ?? "idle";
  goto(prev);
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-back]")) {
  btn.addEventListener("click", back);
}

/* ─────────────── header pill (mode indicator) ─────────────── */

const sigUrlEl = $<HTMLElement>("#sig-url");
const connPill = $<HTMLElement>("#conn-pill");
const connPillLabel = $<HTMLElement>("#conn-pill-label");

function refreshConnPill(): void {
  sigUrlEl.textContent = env.signalingUrl;
  connPill.classList.remove("pill-muted", "pill-net", "pill-lan");
  if (env.mode === "lan") {
    connPill.classList.add("pill-lan");
    connPillLabel.textContent = env.sameOrigin ? "LAN · no internet needed" : "LAN mode";
  } else {
    connPill.classList.add("pill-net");
    connPillLabel.textContent = "Internet mode";
  }
}
refreshConnPill();

/* ─────────────── mode toggle (idle stage) ─────────────── */

const modeLan = $<HTMLButtonElement>("#mode-lan");
const modeNet = $<HTMLButtonElement>("#mode-net");

function setMode(m: ConnectionMode, persist = true): void {
  env = { ...env, mode: m };
  if (m === "net") {
    // Switching to internet mode: ensure we have STUN; if the page is on a LAN
    // host, this still works — we'll just discover external reflexive candidates.
    if (env.iceServers.length === 0) {
      env.iceServers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
    }
  } else {
    env.iceServers = [];
  }
  modeLan.setAttribute("aria-selected", String(m === "lan"));
  modeNet.setAttribute("aria-selected", String(m === "net"));
  if (persist) localStorage.setItem("dropbeam.mode", m);
  refreshConnPill();
}

modeLan.addEventListener("click", () => setMode("lan"));
modeNet.addEventListener("click", () => setMode("net"));

(function initMode(): void {
  const saved = localStorage.getItem("dropbeam.mode") as ConnectionMode | null;
  setMode(saved ?? env.mode, false);
})();

/* ─────────────── role cards ─────────────── */

$<HTMLButtonElement>("#go-send").addEventListener("click", () => goto("send-pick"));
$<HTMLButtonElement>("#go-recv").addEventListener("click", () => goto("recv-pick"));

/* ─────────────── send: pick files ─────────────── */

const sendFilesInput = $<HTMLInputElement>("#send-files");
const sendFilelist = $<HTMLUListElement>("#send-filelist");
const sendTotals = $<HTMLElement>("#send-totals");
const sendCreate = $<HTMLButtonElement>("#send-create");
const dropzone = $<HTMLButtonElement>("#dropzone");
const sendPass = $<HTMLInputElement>("#send-pass");

// On iOS Safari a <label> wrapping the file input can cause page unload when
// returning from the file picker. Programmatic click from a <button> is stable
// across iOS / Android / desktop.
dropzone.addEventListener("click", (e) => {
  e.preventDefault();
  sendFilesInput.click();
});

let pickedFiles: File[] = [];

sendFilesInput.addEventListener("change", () => {
  setPickedFiles(Array.from(sendFilesInput.files ?? []));
});

function setPickedFiles(files: File[]): void {
  pickedFiles = files;
  renderFilelist(sendFilelist, files);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (files.length) {
    sendTotals.classList.remove("hidden");
    sendTotals.textContent = `${files.length} file${files.length === 1 ? "" : "s"} · ${humanBytes(total)}`;
  } else {
    sendTotals.classList.add("hidden");
  }
  sendCreate.disabled = files.length === 0;
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
// (Native <button> already handles Enter/Space activation — no extra wiring needed.)

// Paste support: Ctrl/Cmd+V on the send stage adds clipboard files.
document.addEventListener("paste", (e) => {
  if (!stages["send-pick"].classList.contains("active")) return;
  const items = e.clipboardData?.files;
  if (items && items.length) {
    setPickedFiles([...pickedFiles, ...Array.from(items)]);
  }
});

sendCreate.addEventListener("click", () => {
  void startSend(pickedFiles, sendPass.value.trim() || undefined);
});

/* ─────────────── send: share stage ─────────────── */

const shareCodeEl = $<HTMLElement>("#share-code");
const qrDisplay = $<HTMLElement>("#qr-display");
const qrUrlEl = $<HTMLElement>("#qr-url");
const waitingText = $<HTMLElement>("#waiting-text");
const copyCodeBtn = $<HTMLButtonElement>("#copy-code");
const copyLinkBtn = $<HTMLButtonElement>("#copy-link");
const shareNativeBtn = $<HTMLButtonElement>("#share-native");

if ("share" in navigator) shareNativeBtn.classList.remove("hidden");

let currentShareCode: string | null = null;
let currentShareUrl: string | null = null;

function setShareCode(code: string): void {
  currentShareCode = code;
  shareCodeEl.textContent = code;

  const url = new URL(location.href);
  url.hash = "";
  url.searchParams.set("c", code);
  currentShareUrl = url.toString();
  qrUrlEl.textContent = currentShareUrl;
  qrDisplay.innerHTML = qrToSvg(encodeQr(currentShareUrl), { fg: "#0a0b10", bg: "#ffffff", rounded: true });
}

copyCodeBtn.addEventListener("click", async () => {
  if (!currentShareCode) return;
  await navigator.clipboard.writeText(currentShareCode);
  flashCopy(copyCodeBtn);
});
copyLinkBtn.addEventListener("click", async () => {
  if (!currentShareUrl) return;
  await navigator.clipboard.writeText(currentShareUrl);
  flashCopy(copyLinkBtn);
});
shareNativeBtn.addEventListener("click", async () => {
  if (!currentShareUrl) return;
  try {
    await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
      title: "DropBeam transfer",
      text: `Join my DropBeam transfer with code ${currentShareCode}`,
      url: currentShareUrl,
    });
  } catch {
    /* user cancelled */
  }
});

function flashCopy(btn: HTMLButtonElement): void {
  const original = btn.innerHTML;
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m5 12 5 5L20 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>Copied';
  setTimeout(() => { btn.innerHTML = original; }, 1200);
}

/* ─────────────── recv: code + folder ─────────────── */

const recvCodeInput = $<HTMLInputElement>("#recv-code");
const recvPickDirBtn = $<HTMLButtonElement>("#recv-pickdir");
const recvDirName = $<HTMLElement>("#recv-dirname");
const recvGoBtn = $<HTMLButtonElement>("#recv-go");
const recvPass = $<HTMLInputElement>("#recv-pass");
const recvScanBtn = $<HTMLButtonElement>("#recv-scan");
const scannerVideo = $<HTMLVideoElement>("#scanner-video");

let saveDir: FileSystemDirectoryHandle | null = null;

const showDirectoryPicker = (window as unknown as {
  showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
}).showDirectoryPicker;

if (!showDirectoryPicker) {
  recvPickDirBtn.disabled = true;
  recvPickDirBtn.title = "Folder picker not supported in this browser; downloads will go to the default downloads folder.";
}

recvPickDirBtn.addEventListener("click", async () => {
  if (!showDirectoryPicker) return;
  try {
    saveDir = await showDirectoryPicker({ mode: "readwrite" });
    recvDirName.textContent = saveDir.name;
    recvDirName.classList.remove("muted");
    updateRecvButton();
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      console.warn(err);
    }
  }
});

recvCodeInput.addEventListener("input", () => {
  recvCodeInput.value = recvCodeInput.value.toUpperCase();
  updateRecvButton();
});

function updateRecvButton(): void {
  const len = recvCodeInput.value.replace(/[^A-Z0-9]/g, "").length;
  recvGoBtn.disabled = len < 6;
}

recvGoBtn.addEventListener("click", () => {
  void startReceive(recvCodeInput.value.trim(), saveDir, recvPass.value.trim() || undefined);
});

// QR scanner (Chrome on Android: BarcodeDetector).
const hasBarcode = "BarcodeDetector" in window;
if (hasBarcode) recvScanBtn.classList.remove("hidden");

let scanStream: MediaStream | null = null;
let scanAbort = new AbortController();

recvScanBtn.addEventListener("click", () => void toggleScan());

async function toggleScan(): Promise<void> {
  if (scanStream) {
    stopScan();
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
    scannerVideo.srcObject = scanStream;
    scannerVideo.classList.remove("hidden");
    await scannerVideo.play();

    const Detector = (window as unknown as { BarcodeDetector: new (o: { formats: string[] }) => { detect: (s: CanvasImageSource) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
    const detector = new Detector({ formats: ["qr_code"] });
    scanAbort = new AbortController();
    const tick = async (): Promise<void> => {
      if (scanAbort.signal.aborted) return;
      try {
        const results = await detector.detect(scannerVideo);
        if (results[0]) {
          const code = extractCodeFromUrl(results[0].rawValue) ?? results[0].rawValue;
          recvCodeInput.value = code;
          updateRecvButton();
          stopScan();
          return;
        }
      } catch { /* frame busy */ }
      requestAnimationFrame(() => void tick());
    };
    void tick();
  } catch (err) {
    console.warn("camera access denied", err);
  }
}

function stopScan(): void {
  scanAbort.abort();
  scanStream?.getTracks().forEach((t) => t.stop());
  scanStream = null;
  scannerVideo.srcObject = null;
  scannerVideo.classList.add("hidden");
}

function extractCodeFromUrl(text: string): string | null {
  try {
    const u = new URL(text);
    return u.searchParams.get("c");
  } catch {
    return null;
  }
}

/* ─────────────── transfer orchestration ─────────────── */

type ActiveSession = {
  signaling: SignalingClient;
  host: WorkerTransferHost;
  pc: RTCPeerConnection;
  transportPoll: number;
};

let active: ActiveSession | null = null;

function cancelActive(): void {
  if (!active) return;
  try { active.host.abort("user-cancel"); } catch { /* ignore */ }
  try { active.host.dispose(); } catch { /* ignore */ }
  try { active.signaling.close(); } catch { /* ignore */ }
  try { active.pc.close(); } catch { /* ignore */ }
  clearInterval(active.transportPoll);
  active = null;
  releaseWakeLock();
}

async function startSend(files: File[], passphrase: string | undefined): Promise<void> {
  cancelActive();
  sendCreate.disabled = true;
  goto("send-share");
  setShareCode("…");
  setActiveTitle("Creating room…");

  const signaling = new SignalingClient({ url: env.signalingUrl, device: DEVICE });
  let host: WorkerTransferHost | null = null;
  let pc: RTCPeerConnection | null = null;

  try {
    await signaling.ready();
    const room = await signaling.createRoom();
    setShareCode(room.code);
    waitingText.textContent = "Waiting for the receiver to join…";

    const remotePeerId = await waitForPeerJoined(signaling);
    goto("active");
    setActiveTitle("Negotiating…");
    setPeerName("Receiver");

    pc = new RTCPeerConnection({ iceServers: env.iceServers });
    wireTrickleIce(pc, signaling, remotePeerId);

    host = new WorkerTransferHost({
      worker: () => new TransferWorker(),
      peerConnection: pc,
    });

    const transferPromise = host.send(crypto.randomUUID(), files, {
      ...(passphrase ? { encryptionPassphrase: passphrase } : {}),
      onEvent: (e) => onTransferEvent(e, files),
    });

    await nextAnimationFrame();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signaling.signal(remotePeerId, { kind: "sdp", sdp: pc.localDescription });

    active = { signaling, host, pc, transportPoll: startTransportPoll(pc) };
    void acquireWakeLock();

    listenForPeerInfo(signaling);

    await transferPromise;
    onTransferDone("Files delivered.");
  } catch (err) {
    onTransferFailed((err as Error).message);
  } finally {
    if (host) host.dispose();
    if (pc) pc.close();
    signaling.close();
    if (active) clearInterval(active.transportPoll);
    active = null;
    releaseWakeLock();
    sendCreate.disabled = false;
  }
}

async function startReceive(
  rawCode: string,
  dir: FileSystemDirectoryHandle | null,
  passphrase: string | undefined,
): Promise<void> {
  cancelActive();
  recvGoBtn.disabled = true;
  goto("active");
  setActiveTitle("Connecting…");
  setPeerName("Sender");
  setActiveStatus("");

  const code = rawCode.toUpperCase();
  const signaling = new SignalingClient({ url: env.signalingUrl, device: DEVICE });
  let host: WorkerTransferHost | null = null;
  let pc: RTCPeerConnection | null = null;

  try {
    await signaling.ready();
    const joined = await signaling.joinRoom(code);
    const remote = joined.peers[0];
    if (!remote) throw new Error("Sender hasn't created a room yet.");
    setPeerName(remote.device.name);

    pc = new RTCPeerConnection({ iceServers: env.iceServers });
    wireTrickleIce(pc, signaling, remote.peerId);

    host = new WorkerTransferHost({
      worker: () => new TransferWorker(),
      peerConnection: pc,
    });

    const sink: Parameters<WorkerTransferHost["receive"]>[0] extends infer T ? T : never =
      dir
        ? { sink: { kind: "fsaccess" as const, directory: dir }, ...(passphrase ? { encryptionPassphrase: passphrase } : {}) }
        : { sink: { kind: "fsaccess" as const, directory: await ensureFallbackDir() }, ...(passphrase ? { encryptionPassphrase: passphrase } : {}) };

    const transferPromise = host.receive({
      ...sink,
      onEvent: (e) => onTransferEvent(e, []),
    });

    const offer = await waitForSdp(signaling, remote.peerId, "offer");
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signaling.signal(remote.peerId, { kind: "sdp", sdp: pc.localDescription });

    active = { signaling, host, pc, transportPoll: startTransportPoll(pc) };
    void acquireWakeLock();

    await transferPromise;
    onTransferDone(dir ? `Saved to ${dir.name}` : "Files saved.");
  } catch (err) {
    onTransferFailed((err as Error).message);
  } finally {
    if (host) host.dispose();
    if (pc) pc.close();
    signaling.close();
    if (active) clearInterval(active.transportPoll);
    active = null;
    releaseWakeLock();
    recvGoBtn.disabled = false;
  }
}

async function ensureFallbackDir(): Promise<FileSystemDirectoryHandle> {
  if (!showDirectoryPicker) {
    throw new Error("This browser can't write to disk. Use Chrome, Edge, or pick a folder.");
  }
  setActiveStatus("Pick a folder to save downloads to…");
  saveDir = await showDirectoryPicker({ mode: "readwrite" });
  recvDirName.textContent = saveDir.name;
  recvDirName.classList.remove("muted");
  setActiveStatus("");
  return saveDir;
}

/* ─────────────── active stage rendering ─────────────── */

const activeTitle = $<HTMLElement>("#active-title");
const activeStatus = $<HTMLElement>("#active-status");
const activeFilelist = $<HTMLUListElement>("#active-filelist");
const endSelfGlyph = $<HTMLElement>("#end-self-glyph");
const endSelfName = $<HTMLElement>("#end-self-name");
const endPeerGlyph = $<HTMLElement>("#end-peer-glyph");
const endPeerName = $<HTMLElement>("#end-peer-name");
const transportPill = $<HTMLElement>("#transport-pill");
const transportLabel = $<HTMLElement>("#transport-label");

const progressHeadline = $<HTMLElement>("#progress-headline");
const progressRate = $<HTMLElement>("#progress-rate");
const progressFill = $<HTMLElement>("#progress-fill");
const progressEta = $<HTMLElement>("#progress-eta");
const progressFiles = $<HTMLElement>("#progress-files");

endSelfGlyph.textContent = initials(DEVICE.name);
endSelfName.textContent = DEVICE.name;

let manifestFiles: { fileId: number; name: string; size: number; mime?: string }[] = [];
const fileStatusEls = new Map<number, HTMLElement>();

function onTransferEvent(e: WorkerTransferEvent, sentFiles: File[]): void {
  // For a sender we render the list of File objects up front so file names
  // show before the receiver's manifest echoes back.
  if (sentFiles.length && manifestFiles.length === 0) {
    manifestFiles = sentFiles.map((f, i) => ({
      fileId: i + 1,
      name: f.name,
      size: f.size,
      ...(f.type ? { mime: f.type } : {}),
    }));
    renderActiveFilelist(manifestFiles);
    progressFiles.textContent = `0 / ${manifestFiles.length} files`;
  }

  switch (e.type) {
    case "manifest": {
      manifestFiles = e.files.map((f) => ({
        fileId: f.id,
        name: f.name,
        size: f.size,
      }));
      fileStatusEls.clear();
      renderActiveFilelist(manifestFiles);
      setActiveTitle(`Receiving ${e.files.length} file${e.files.length === 1 ? "" : "s"}…`);
      progressFiles.textContent = `0 / ${e.files.length} files`;
      break;
    }
    case "progress": {
      const pct = e.totalBytes ? (e.totalBytesTransferred / e.totalBytes) * 100 : 0;
      progressFill.style.width = `${pct}%`;
      progressHeadline.textContent = `${humanBytes(e.totalBytesTransferred)} / ${humanBytes(e.totalBytes)}`;
      progressRate.textContent = `${humanBytes(e.bytesPerSecond)}/s`;
      progressEta.textContent = `ETA ${humanEta(e.etaSeconds)}`;
      const filesDone = manifestFiles.filter((f) => fileStatusEls.get(f.fileId)?.classList.contains("ok")).length;
      progressFiles.textContent = `${filesDone} / ${manifestFiles.length || sentFiles.length} files`;
      // Update the currently-transferring file as "sending"/"receiving".
      const inFlight = fileStatusEls.get(e.fileId);
      if (inFlight && !inFlight.classList.contains("ok")) {
        inFlight.textContent = "in flight";
      }
      break;
    }
    case "file-done": {
      const el = fileStatusEls.get(e.fileId);
      if (el) {
        el.textContent = "✓ done";
        el.classList.add("ok");
      }
      break;
    }
    case "complete":
      progressFill.style.width = "100%";
      break;
    case "error":
      setActiveStatus(e.error.message, "err");
      break;
  }
}

function renderActiveFilelist(files: { fileId: number; name: string; size: number; mime?: string }[]): void {
  activeFilelist.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = fileIconFor(f.name, f.mime);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = humanBytes(f.size);
    const status = document.createElement("span");
    status.className = "file-status";
    status.textContent = "queued";
    li.append(icon, name, size, status);
    activeFilelist.appendChild(li);
    fileStatusEls.set(f.fileId, status);
  }
}

function renderFilelist(ul: HTMLUListElement, files: File[]): void {
  ul.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = fileIconFor(f.name, f.type);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = humanBytes(f.size);
    li.append(icon, name, size);
    ul.appendChild(li);
  }
}

function fileIconFor(name: string, mime?: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime?.startsWith("image/") || /^(png|jpg|jpeg|webp|gif|heic|avif|svg)$/.test(ext)) return "🖼";
  if (mime?.startsWith("video/") || /^(mp4|mov|webm|mkv|avi)$/.test(ext)) return "🎬";
  if (mime?.startsWith("audio/") || /^(mp3|wav|flac|m4a|ogg|aac)$/.test(ext)) return "🎵";
  if (/^(pdf)$/.test(ext)) return "📄";
  if (/^(zip|rar|7z|tar|gz|bz2)$/.test(ext)) return "🗜";
  if (/^(doc|docx)$/.test(ext)) return "📝";
  if (/^(xls|xlsx|csv)$/.test(ext)) return "📊";
  if (/^(ppt|pptx|key)$/.test(ext)) return "📽";
  if (/^(json|js|ts|tsx|jsx|css|html|py|rs|go|java|c|cpp|sh)$/.test(ext)) return "⌬";
  return "📦";
}

function setActiveTitle(t: string): void { activeTitle.textContent = t; }
function setPeerName(name: string): void {
  endPeerName.textContent = name;
  endPeerName.classList.remove("muted");
  endPeerGlyph.textContent = initials(name);
}
function setActiveStatus(text: string, kind: "" | "ok" | "err" = ""): void {
  activeStatus.textContent = text;
  activeStatus.classList.remove("ok", "err");
  if (kind) activeStatus.classList.add(kind);
}

function initials(name: string): string {
  const cleaned = name.replace(/·/g, "").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

/* ─────────────── transport badge (LAN-direct / P2P-direct / Relayed) ─────────────── */

function startTransportPoll(pc: RTCPeerConnection): number {
  setTransport("handshaking");
  return window.setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let nominatedPair: { localCandidateId?: string; remoteCandidateId?: string } | null = null;
      const candidatesById = new Map<string, { type?: string; candidateType?: string; address?: string }>();
      stats.forEach((s) => {
        if (s.type === "candidate-pair" && (s.nominated || s.selected)) {
          nominatedPair = s as unknown as { localCandidateId?: string; remoteCandidateId?: string };
        }
        if (s.type === "local-candidate" || s.type === "remote-candidate") {
          candidatesById.set(s.id as string, s as unknown as { candidateType?: string; address?: string });
        }
      });
      if (nominatedPair) {
        const local = candidatesById.get((nominatedPair as { localCandidateId?: string }).localCandidateId ?? "");
        const remote = candidatesById.get((nominatedPair as { remoteCandidateId?: string }).remoteCandidateId ?? "");
        const ltype = local?.candidateType ?? "";
        const rtype = remote?.candidateType ?? "";
        if (ltype === "relay" || rtype === "relay") setTransport("relayed");
        else if (ltype === "host" && rtype === "host") setTransport("lan");
        else setTransport("p2p");
      }
    } catch { /* getStats can transiently fail */ }
  }, 1500);
}

function setTransport(kind: "handshaking" | "lan" | "p2p" | "relayed"): void {
  transportPill.classList.remove("pill-faint", "pill-lan", "pill-net", "pill-warn", "pill-ok");
  switch (kind) {
    case "handshaking":
      transportPill.classList.add("pill-faint");
      transportLabel.textContent = "Handshaking…";
      break;
    case "lan":
      transportPill.classList.add("pill-lan");
      transportLabel.textContent = "LAN-direct · no internet";
      break;
    case "p2p":
      transportPill.classList.add("pill-ok");
      transportLabel.textContent = "P2P-direct · encrypted";
      break;
    case "relayed":
      transportPill.classList.add("pill-warn");
      transportLabel.textContent = "TURN relayed · encrypted";
      break;
  }
}

/* ─────────────── done stage ─────────────── */

const doneTitle = $<HTMLElement>("#done-title");
const doneSub = $<HTMLElement>("#done-sub");
const doneAgain = $<HTMLButtonElement>("#done-again");

doneAgain.addEventListener("click", () => {
  pickedFiles = [];
  setPickedFiles([]);
  sendFilesInput.value = "";
  recvCodeInput.value = "";
  updateRecvButton();
  history = ["idle"];
  goto("idle", false);
});

function onTransferDone(subtitle: string): void {
  doneTitle.textContent = "Transfer complete";
  doneSub.textContent = subtitle;
  goto("done");
}

function onTransferFailed(message: string): void {
  doneTitle.textContent = "Transfer didn't finish";
  doneSub.textContent = message;
  goto("done");
}

/* ─────────────── signaling glue ─────────────── */

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

function listenForPeerInfo(signaling: SignalingClient): void {
  signaling.on((m) => {
    if (m.type === "peer-joined") {
      setPeerName(m.device.name);
    }
  });
}

function waitForPeerJoined(signaling: SignalingClient): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const off = signaling.on((m) => {
      if (m.type === "peer-joined") {
        setPeerName(m.device.name);
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

/* ─────────────── deep link auto-join ─────────────── */

(function autoJoinFromUrl(): void {
  const params = new URLSearchParams(location.search);
  const code = params.get("c");
  if (code && code.length >= 4) {
    recvCodeInput.value = code.toUpperCase();
    updateRecvButton();
    goto("recv-pick");
  }
})();

/* ─────────────── PWA install ─────────────── */

let deferredInstall: BeforeInstallPromptEvent | null = null;
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
const installBtn = $<HTMLButtonElement>("#install-btn");
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e as BeforeInstallPromptEvent;
  installBtn.classList.remove("hidden");
});
installBtn.addEventListener("click", async () => {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  if (outcome === "accepted") installBtn.classList.add("hidden");
  deferredInstall = null;
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* ignore */ });
  });
}

/* ─────────────── tiny helpers ─────────────── */

function humanBytes(n: number): string {
  if (!isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function humanEta(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds - m * 60);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

/* ─────────────── info popovers ─────────────── */

const popover = $<HTMLElement>("#popover");
const popoverBody = $<HTMLElement>("#popover-body");
const popoverArrow = $<HTMLElement>("#popover-arrow");

const INFO_TEXT: Record<string, string> = {
  lan: `<strong>Same Wi-Fi mode</strong> connects two devices on the same router <b>without using the internet at all</b>. WebRTC uses <code>host</code> ICE candidates (your private LAN IPs) and the data channel runs directly over your Wi-Fi. Perfect for hotel networks, planes, offline sites — anywhere internet is slow, expensive, or absent.`,
  net: `<strong>Anywhere mode</strong> works across the open internet, even when the two devices are on different networks behind NATs. STUN servers help the peers discover their public addresses and hole-punch a direct path. If that fails, a TURN relay forwards encrypted bytes — we never see them in plaintext.`,
  passphrase: `By default your transfer is encrypted in transit (<code>DTLS</code> on the WebRTC channel). A <strong>passphrase</strong> adds a second layer: every chunk is encrypted with <code>AES-GCM-256</code> using a key derived from your passphrase via <code>PBKDF2-200k</code>. Even if someone broke into our signaling server (we don't store files anyway), they couldn't read your bytes.`,
  folder: `Receivers stream bytes <b>directly to disk</b> using the File System Access API — files never get loaded into RAM, so even a 500&nbsp;GB transfer doesn't slow your browser. If you don't pick a folder, files go to your browser's default downloads folder. Chrome and Edge support this; Safari and Firefox fall back to ordinary downloads.`,
  transport: `<strong>LAN-direct</strong>: the two devices found each other on your Wi-Fi. Fastest, zero internet use.<br><br><strong>P2P-direct</strong>: STUN punched a direct hole through both NATs. Fast, peer-to-peer.<br><br><strong>TURN relayed</strong>: at least one peer is on a strict NAT and the bytes flow through a relay. Slower, but still end-to-end encrypted.`,
};

function showPopover(anchor: HTMLElement, html: string): void {
  popoverBody.innerHTML = html;
  popover.classList.remove("hidden");
  // Position after layout: prefer below, fall back above if it overflows.
  const a = anchor.getBoundingClientRect();
  const p = popover.getBoundingClientRect();
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let top = a.bottom + 10;
  let arrowTop = -6;
  let arrowRotate = "rotate(45deg)";
  if (top + p.height > vh - pad) {
    top = a.top - p.height - 10;
    arrowTop = p.height - 4;
    arrowRotate = "rotate(225deg)";
  }
  let left = a.left + a.width / 2 - p.width / 2;
  left = Math.max(pad, Math.min(left, vw - p.width - pad));

  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;
  popoverArrow.style.top = `${arrowTop}px`;
  popoverArrow.style.left = `${a.left + a.width / 2 - left - 5}px`;
  popoverArrow.style.transform = arrowRotate;
}

function hidePopover(): void {
  popover.classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement | null;
  if (!t) return;
  const info = t.closest("[data-info]") as HTMLElement | null;
  if (info) {
    e.preventDefault();
    e.stopPropagation();
    const key = info.getAttribute("data-info")!;
    showPopover(info, INFO_TEXT[key] ?? "");
    return;
  }
  if (!popover.contains(t)) hidePopover();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hidePopover();
});
window.addEventListener("resize", hidePopover);
window.addEventListener("scroll", hidePopover, { passive: true });

/* ─────────────── legal stage (privacy / terms) ─────────────── */

const legalTitle = $<HTMLElement>("#legal-title");
const legalBody = $<HTMLElement>("#legal-body");

const PRIVACY_HTML = `
<p><span class="pill-inline">TL;DR</span> <strong>We can't see your files.</strong> They never touch our servers. There's no upload bucket, no cache, no log of what you transferred.</p>

<h3>What we technically see</h3>
<p>The <strong>signaling server</strong> is the only piece of our infrastructure your devices talk to. It does exactly three things:</p>
<ul>
  <li>Mints a short share code when you click "Send", and looks it up when the other device joins.</li>
  <li>Forwards opaque WebRTC handshake blobs (<code>SDP</code> + <code>ICE</code>) between the two peers so they can find each other. We don't decrypt or inspect these — they're just relay bytes.</li>
  <li>Records the requesting IP for rate-limiting only (30 messages/sec/IP). The IP isn't stored, persisted, or tied to anything.</li>
</ul>

<h3>What we never see</h3>
<ul>
  <li><strong>File names, sizes, types, or contents.</strong> Once two peers shake hands, the data channel goes peer-to-peer; bytes flow over WebRTC's DTLS-encrypted tunnel directly between the devices.</li>
  <li><strong>Passphrases.</strong> If you set one, the key is derived in your browser via PBKDF2 and used to AES-GCM-encrypt every chunk before it leaves the device.</li>
  <li><strong>Account info.</strong> There are no accounts.</li>
</ul>

<h3>Cookies, analytics, tracking</h3>
<p><strong>None.</strong> The only thing stored in your browser is a random device id in <code>localStorage</code> (so we can show the receiver your friendly device name) and your chosen connection mode. No cookies, no third-party analytics, no fingerprinting.</p>

<h3>TURN relays</h3>
<p>If both peers are behind strict NATs, a TURN relay may be used as a last resort. Even then the bytes are still end-to-end encrypted — the relay can see <em>that</em> bytes are flowing but can't read them.</p>

<h3>Open source</h3>
<p>The code is MIT licensed and public. Anyone can audit it, run their own signaling server, or self-host the whole thing on a Raspberry Pi.</p>
`;

const TERMS_HTML = `
<p><span class="pill-inline">In short</span> DropBeam is a free, open-source tool. It comes with no warranty. Don't use it to break the law.</p>

<h3>What you can do</h3>
<ul>
  <li>Send and receive any files you have a legal right to share.</li>
  <li>Use the service for personal, educational, or commercial purposes.</li>
  <li>Self-host the signaling server and modify the client however you want — the code is MIT licensed.</li>
</ul>

<h3>What you can't do</h3>
<ul>
  <li>Use DropBeam to distribute copyrighted material you don't own.</li>
  <li>Use it to share illegal content (CSAM, malware, fraud, etc.). The service is technically incapable of detecting this — but using it for that purpose is on you.</li>
  <li>Attempt to overload, attack, or reverse-engineer the public signaling infrastructure in a way that disrupts other users.</li>
</ul>

<h3>No warranty</h3>
<p>The software is provided <strong>"as is"</strong>, without warranty of any kind, express or implied. The authors are not liable for any loss of data, damages, or other claims arising from use of DropBeam. Files in transit can be interrupted by network outages, browser crashes, OS sleep, or expired room codes — keep a copy until the receiver confirms.</p>

<h3>Changes</h3>
<p>This document may change as the project evolves. The version in the repository at the time of your transfer governs.</p>
`;

function showLegal(which: "privacy" | "terms"): void {
  legalTitle.textContent = which === "privacy" ? "Privacy Policy" : "Terms of Use";
  legalBody.innerHTML = which === "privacy" ? PRIVACY_HTML : TERMS_HTML;
  goto("legal");
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-legal]")) {
  btn.addEventListener("click", () => {
    const which = btn.getAttribute("data-legal") as "privacy" | "terms";
    showLegal(which);
  });
}

/* ─────────────── blog / about stage ─────────────── */

const blogBody = $<HTMLElement>("#blog-body");

const BLOG_HTML = `
<p><span class="pill-inline">ABOUT</span> DropBeam is a free, open-source file transfer tool that's a single page in your browser. No app to install (unless you want to). No accounts. No upload servers. The two devices talk straight to each other.</p>

<h3>What it does that others don't</h3>
<ul>
  <li><strong>Mega files, no Chrome bloat.</strong> Streams from disk straight to disk via the File System Access API. RAM stays at ~50 MB whether you're sending 5 MB or 50 GB. WeTransfer caps you at 2 GB and uploads to their servers; we don't.</li>
  <li><strong>Single share or bulk share.</strong> Drop one file or fifty in one go. Everything is queued into a single transfer session, hashed, and verified on the other side.</li>
  <li><strong>Works over the internet AND on a LAN with no internet.</strong> "Same Wi-Fi" mode uses only host candidates — two phones in a coffee shop with broken Wi-Fi can still send to each other. "Anywhere" mode punches through NATs with STUN; a TURN relay is the last-resort fallback.</li>
  <li><strong>End-to-end encrypted in transit, optionally with your own passphrase.</strong> DTLS is on by default. Tick the passphrase box and every chunk is AES-GCM-256 encrypted with a key only you and the receiver know.</li>
  <li><strong>Browser-only. Cross-platform by accident.</strong> Phone ↔ Windows. Mac ↔ Android. iPad ↔ Linux. Same code path on every device — there's no platform-specific app to maintain.</li>
</ul>

<h3>Where the money goes (when there is any)</h3>
<p>If this ever earns money — through ads, freemium tiers, or office API — the split is fixed and public:</p>

<div class="mission-split">
  <div class="mission-card donate">
    <span class="pct">30 %</span>
    <strong>Donated to people in need.</strong> Direct donations to vetted causes. The recipient is community-voted each quarter and posted publicly with receipts.
  </div>
  <div class="mission-card scale">
    <span class="pct">70 %</span>
    <strong>Reinvested in DropBeam.</strong> Infrastructure (TURN servers, signaling capacity), full-time developers, and the free tier that keeps the core promise alive.
  </div>
</div>

<h3>Coming next</h3>
<ul>
  <li><strong>DropBeam API (freemium).</strong> Office tier — drop-in WebRTC signaling for your own apps, with priority TURN, custom branding, and audit logs. Generous free tier.</li>
  <li><strong>Native mobile apps.</strong> iOS (MultipeerConnectivity) and Android (Wi-Fi Direct) for AirDrop-class same-room transfers, ~10× the throughput of the browser path.</li>
  <li><strong>Federated discovery.</strong> Optional "see other DropBeam devices on this Wi-Fi" pane, like AirDrop's nearby tray.</li>
</ul>

<h3>How to be sure we mean it</h3>
<ul>
  <li><strong>The code is open source (MIT).</strong> Audit it, fork it, self-host it. There's nothing hidden on the server side because there's no file-handling server.</li>
  <li><strong>The privacy posture is checkable.</strong> Open DevTools → Network and watch a transfer: you'll see one WebSocket to the signaling host (small text messages — SDP, ICE) and then file bytes going peer-to-peer with no upload request.</li>
  <li><strong>The donation receipts will be public.</strong> Quarterly post on the blog with proof of transfer to recipients.</li>
</ul>

<h3>Built by</h3>
<p>Vara Prasad Karewar (<a href="https://github.com/VaraKare" target="_blank" rel="noopener" style="color:inherit;font-weight:700;text-decoration:underline">@VaraKare</a>). Solo. If you want to help — code, design, money, or just feedback — get in touch via the contact links in the footer.</p>
`;

function showBlog(): void {
  blogBody.innerHTML = BLOG_HTML;
  goto("blog");
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-blog]")) {
  btn.addEventListener("click", () => showBlog());
}

/* ─────────────── safeguards: keep mobile transfers alive ─────────────── */

let wakeLock: { release(): Promise<void> } | null = null;

async function acquireWakeLock(): Promise<void> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (wl) wakeLock = await wl.request("screen");
  } catch { /* user denied or unsupported */ }
}
function releaseWakeLock(): void {
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// Re-acquire the wake lock if the page becomes visible again mid-transfer.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && active && !wakeLock) void acquireWakeLock();
});

// Warn before leaving the page during an active transfer.
window.addEventListener("beforeunload", (e) => {
  if (active) {
    e.preventDefault();
    e.returnValue = "A transfer is still in progress. Leave anyway?";
    return e.returnValue;
  }
  return undefined;
});

