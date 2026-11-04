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
  /** Human-readable reason the app can't connect, or null when configured. */
  configError: string | null;
  /** ICE servers used in "Anywhere" mode (STUN + optional TURN from env). */
  netIceServers: RTCIceServer[];
  /** ICE servers for the current mode ([] in LAN mode → host candidates only). */
  iceServers: RTCIceServer[];
  /** True when a TURN relay is configured. */
  hasTurn: boolean;
  /** True when the page is being served from a same-origin signaling host (LAN-only deployment). */
  sameOrigin: boolean;
  /** Best-guess current mode. */
  mode: ConnectionMode;
}

function readIceServers(): { servers: RTCIceServer[]; hasTurn: boolean } {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  ];
  const turnUrls = (import.meta.env.VITE_TURN_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: import.meta.env.VITE_TURN_USERNAME ?? "",
      credential: import.meta.env.VITE_TURN_CREDENTIAL ?? "",
    });
  }
  return { servers, hasTurn: turnUrls.length > 0 };
}

/** Accepts ws(s):// as-is and rewrites http(s):// → ws(s)://; appends /ws if no path given. */
function normalizeSignalingUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:") u.protocol = "ws:";
  if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new Error(`unsupported protocol ${u.protocol}`);
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/ws";
  return u.toString();
}

function detectEnv(): AppEnv {
  const override = import.meta.env.VITE_SIGNALING_URL?.trim() || null;
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
  let signalingUrl = "";
  let configError: string | null = null;

  if (override) {
    try {
      signalingUrl = normalizeSignalingUrl(override);
      if (location.protocol === "https:" && signalingUrl.startsWith("ws://")) {
        configError = `VITE_SIGNALING_URL is ${signalingUrl}, but this page is served over HTTPS, so the browser will block it. Use a wss:// URL.`;
      }
    } catch {
      configError = `VITE_SIGNALING_URL ("${override}") isn't a valid ws:// or wss:// URL.`;
    }
  } else if (sameOrigin) {
    signalingUrl = `${wsProto}://${location.host}/ws`;
  } else {
    configError =
      "This deployment has no signaling server configured. Set VITE_SIGNALING_URL (e.g. wss://your-signaling.onrender.com/ws) in your hosting provider's environment variables and redeploy.";
  }

  const { servers, hasTurn } = readIceServers();
  return {
    signalingUrl,
    configError,
    netIceServers: servers,
    iceServers: servers,
    hasTurn,
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

  if (stage === "idle") {
    setPickedFiles([]);
    if (sendFilesInput) sendFilesInput.value = "";
    if (recvCodeInput) recvCodeInput.value = "";
    updateRecvButton();
    history = ["idle"]; // Reset history stack
  }
}

function back(): void {
  cancelActive();
  history.pop();
  // Never "go back" into a live-session screen — its session is gone now.
  let prev: Stage | undefined;
  do { prev = history.pop(); } while (prev === "send-share" || prev === "active" || prev === "done");
  goto(prev ?? "idle");
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-back]")) {
  btn.addEventListener("click", back);
}

/* ─────────────── header pill (mode indicator) ─────────────── */

const sigUrlEl = $<HTMLElement>("#sig-url");
const connPill = $<HTMLElement>("#conn-pill");
const connPillLabel = $<HTMLElement>("#conn-pill-label");

const configBanner = $<HTMLElement>("#config-banner");

function refreshConnPill(): void {
  sigUrlEl.textContent = env.signalingUrl || "not configured";
  if (env.configError) {
    configBanner.textContent = env.configError;
    configBanner.classList.remove("hidden");
    connPill.classList.remove("pill-muted", "pill-net", "pill-lan");
    connPill.classList.add("pill-warn");
    connPillLabel.textContent = "Not configured";
    return;
  }
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
  // LAN mode: no STUN/TURN, so only host candidates are gathered and the
  // connection never leaves the local network. Anywhere mode: STUN + TURN.
  env = { ...env, mode: m, iceServers: m === "net" ? env.netIceServers : [] };
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
$<HTMLButtonElement>("#go-recv").addEventListener("click", () => {
  goto("recv-pick");
  void refreshRecvStorageInfo();
});

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
  renderFilelist(sendFilelist, files, (idx) => {
    const next = [...pickedFiles];
    next.splice(idx, 1);
    setPickedFiles(next);
  });
  const total = files.reduce((s, f) => s + f.size, 0);
  if (files.length) {
    sendTotals.classList.remove("hidden");
    sendTotals.textContent = `${files.length} file${files.length === 1 ? "" : "s"} · ${humanBytes(total)}`;
  } else {
    sendTotals.classList.add("hidden");
  }
  sendCreate.disabled = files.length === 0;
  renderSendWarning(total);
}

const GB = 1024 ** 3;
function renderSendWarning(total: number): void {
  const warn = document.querySelector<HTMLElement>("#send-warn");
  if (!warn) return;
  if (total < 2 * GB) {
    warn.classList.add("hidden");
    return;
  }
  let text = `Big transfer (${humanBytes(total)}). Both devices need to keep this page open and stay awake until it finishes. If it gets interrupted, send again \u2014 it continues where it stopped.`;
  if (total >= 10 * GB) {
    text += " Best results: the receiver uses Chrome or Edge on a computer and chooses a folder. Phones, Safari and Firefox hold files inside the browser first, which needs about twice the free space.";
  }
  warn.textContent = text;
  warn.classList.remove("hidden");
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
  if ("vibrate" in navigator) navigator.vibrate?.(15);
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

type DirectoryPicker = (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;

const showDirectoryPicker: DirectoryPicker | undefined =
  (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker?.bind(window);

/** Browser's private file storage (OPFS): phones, Safari, Firefox, and Chrome without a chosen folder. */
const hasBrowserStorage = typeof navigator.storage?.getDirectory === "function";

const recvStorageEl = $<HTMLElement>("#recv-storage");
const recvLeftovers = $<HTMLElement>("#recv-leftovers");
const recvLeftoversText = $<HTMLElement>("#recv-leftovers-text");

if (!showDirectoryPicker) {
  recvPickDirBtn.classList.add("hidden");
  recvDirName.textContent = hasBrowserStorage
    ? "Files are held in this browser while they arrive. When it's done you tap Save (on iPhone: Share \u2192 Save to Files)."
    : "This browser can't save received files. Please use a current version of Chrome, Edge, Safari or Firefox.";
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

/** Rejection reason used when the user backs out — never shown as an error. */
class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

/** How long ICE gets to reach "connected" after the offer/answer exchange. */
const CONNECT_TIMEOUT_MS = 30_000;
/** How long the worker gets to open its first DataChannel before we give up. */
const WORKER_START_TIMEOUT_MS = 15_000;

interface Session {
  role: "send" | "receive";
  signaling: SignalingClient;
  pc: RTCPeerConnection | null;
  host: WorkerTransferHost | null;
  transportPoll: number | null;
  /** "setup" until the peer connection is up; "transfer" afterwards. */
  phase: "setup" | "transfer";
  /** Rejects as soon as anything fatal happens (cancel, peer left, ICE failed…). */
  failed: Promise<never>;
  fail(err: Error): void;
  cancelled: boolean;
  /** Set once the transfer finished successfully. */
  completed: boolean;
  tornDown: boolean;
}

let session: Session | null = null;

// Dev-only debugging handle (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __dropbeam: unknown }).__dropbeam = { get session() { return session; } };
}

function newSession(role: Session["role"]): Session {
  if (env.configError) throw new Error(env.configError);
  const signaling = new SignalingClient({ url: env.signalingUrl, device: DEVICE });
  let reject!: (e: Error) => void;
  const failed = new Promise<never>((_, rej) => { reject = rej; });
  failed.catch(() => { /* observed via race() */ });
  const s: Session = {
    role,
    signaling,
    pc: null,
    host: null,
    transportPoll: null,
    phase: "setup",
    failed,
    fail: (err) => reject(err),
    cancelled: false,
    completed: false,
    tornDown: false,
  };
  // Losing signaling only matters while we still need it for the handshake;
  // once the DataChannels are up, bytes flow peer-to-peer without it.
  signaling.onClose((err) => {
    if (s.phase === "setup") s.fail(err);
  });
  return s;
}

/** Await `p`, but bail out the moment the session fails or is cancelled. */
function race<T>(s: Session, p: Promise<T>): Promise<T> {
  return Promise.race([p, s.failed]);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: number | undefined;
  const timer = new Promise<never>((_, rej) => { t = window.setTimeout(() => rej(new Error(message)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

function teardown(s: Session, abortTransfer: boolean): void {
  if (s.tornDown) return;
  s.tornDown = true;
  if (abortTransfer) { try { s.host?.abort("user-cancel"); } catch { /* ignore */ } }
  const host = s.host;
  if (host) {
    // After a cancel/failure the worker still needs a moment to close (and
    // trim) partially-written files so they can be resumed; don't kill it mid-write.
    const dispose = (): void => { try { host.dispose(); } catch { /* ignore */ } };
    if (s.completed) dispose();
    else window.setTimeout(dispose, 2000);
  }
  try { s.signaling.close(); } catch { /* ignore */ }
  try { s.pc?.close(); } catch { /* ignore */ }
  if (s.transportPoll !== null) clearInterval(s.transportPoll);
  if (session === s) session = null;
  releaseWakeLock();
}

/** User backed out: stop everything and swallow the resulting errors. */
function cancelActive(): void {
  const s = session;
  if (!s) return;
  s.cancelled = true;
  s.fail(new Cancelled());
  teardown(s, true);
}

/**
 * Create the RTCPeerConnection for a session and wire trickle ICE.
 *
 * Remote ICE candidates that arrive before the remote description is set are
 * queued and flushed afterwards (adding them early throws InvalidStateError,
 * which used to silently drop them). All remote signals are processed one at a
 * time so an answer and its candidates can't race each other.
 *
 * Call `start()` only after the WorkerTransferHost exists, so the host is
 * already listening for DataChannels when the remote description lands.
 */
function createLink(s: Session, remotePeerId: string): { pc: RTCPeerConnection; start(): Promise<void> } {
  const pc = new RTCPeerConnection({ iceServers: env.iceServers });
  s.pc = pc;
  const pendingIce: RTCIceCandidateInit[] = [];
  let chain: Promise<void> = Promise.resolve();
  let connectTimer: number | undefined;

  // The worker creates the DataChannels asynchronously; the first one fires
  // `negotiationneeded`, which is the earliest moment an offer will actually
  // contain the data section. (A fixed delay here was racy on slow devices.)
  const negotiationNeeded = new Promise<void>((resolve) => {
    pc.addEventListener("negotiationneeded", () => resolve(), { once: true });
  });

  pc.addEventListener("icecandidate", (ev) => {
    if (!ev.candidate || s.signaling.closed) return;
    try {
      s.signaling.signal(remotePeerId, { kind: "ice", candidate: ev.candidate.toJSON() });
    } catch { /* signaling gone; onClose handles it */ }
  });

  pc.addEventListener("connectionstatechange", () => {
    const st = pc.connectionState;
    if (st === "connected") {
      s.phase = "transfer";
      clearTimeout(connectTimer);
      setActiveTitle(s.role === "send" ? "Sending…" : "Receiving…");
    } else if (st === "failed") {
      clearTimeout(connectTimer);
      s.fail(new Error(connectFailureMessage(s.phase)));
    }
  });

  s.signaling.on((m) => {
    if (m.type === "peer-left" && m.peerId === remotePeerId && s.phase === "setup") {
      s.fail(new Error("The other device left before the transfer started."));
    }
  });

  const flushIce = async (): Promise<void> => {
    while (pendingIce.length) {
      const c = pendingIce.shift()!;
      await pc.addIceCandidate(c).catch((err) => console.warn("addIceCandidate failed", err));
    }
  };

  const armConnectTimeout = (): void => {
    connectTimer = window.setTimeout(() => {
      if (pc.connectionState !== "connected") s.fail(new Error(connectFailureMessage("setup")));
    }, CONNECT_TIMEOUT_MS);
  };

  const handleSignal = async (data: unknown): Promise<void> => {
    const msg = data as
      | { kind: "sdp"; sdp: RTCSessionDescriptionInit }
      | { kind: "ice"; candidate: RTCIceCandidateInit };
    if (msg.kind === "ice") {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(msg.candidate).catch((err) => console.warn("addIceCandidate failed", err));
      } else {
        pendingIce.push(msg.candidate);
      }
      return;
    }
    if (msg.kind !== "sdp") return;
    if (msg.sdp.type === "offer" && s.role === "receive" && !pc.remoteDescription) {
      await pc.setRemoteDescription(msg.sdp);
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.signaling.signal(remotePeerId, { kind: "sdp", sdp: pc.localDescription });
      armConnectTimeout();
    } else if (msg.sdp.type === "answer" && s.role === "send" && pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(msg.sdp);
      await flushIce();
    }
  };

  return {
    pc,
    async start() {
      // Subscribing replays anything that arrived early (e.g. the offer).
      s.signaling.onSignalFrom(remotePeerId, (data) => {
        chain = chain.then(() => handleSignal(data)).catch((err) => {
          console.warn("signal handling failed", err);
          s.fail(new Error("Couldn't complete the connection handshake."));
        });
      });
      if (s.role === "send") {
        await race(s, withTimeout(negotiationNeeded, WORKER_START_TIMEOUT_MS, "The transfer engine didn't start. Reload the page and try again."));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        s.signaling.signal(remotePeerId, { kind: "sdp", sdp: pc.localDescription });
        armConnectTimeout();
      }
    },
  };
}

function connectFailureMessage(phase: Session["phase"]): string {
  if (phase === "transfer") return "The connection to the other device dropped.";
  if (env.mode === "lan") {
    return "Couldn't connect over the local network. Make sure both devices are on the same Wi-Fi, or switch to “Anywhere” mode.";
  }
  return env.hasTurn
    ? "Couldn't open a connection between the two devices, even through the relay. Check that neither network blocks WebRTC."
    : "Couldn't open a direct connection — one of the networks blocks peer-to-peer traffic, and this deployment has no TURN relay configured.";
}

/** Map engine / server error strings to something a person can act on. */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/room-not-found/.test(raw)) return "No active transfer uses that code. Check it, or ask the sender for a new one.";
  if (/room-full/.test(raw)) return "Someone else already joined that transfer.";
  {
    const m = /insufficient-storage: needs ([^,]+), this browser can store about (.+)$/.exec(raw);
    if (m) {
      return /receiver rejected/.test(raw)
        ? `The receiving device doesn't have enough free space (needs ${m[1]}, has about ${m[2]}). Ask them to free up space or use Chrome or Edge on a computer and choose a folder.`
        : `Not enough space in this browser: needs ${m[1]}, can store about ${m[2]}. Free up space on this device, or use Chrome or Edge on a computer and choose a folder.`;
    }
  }
  if (/rate-limited/.test(raw)) return "Too many attempts. Wait a few seconds and try again.";
  if (/passphrase-required/.test(raw)) return "The sender protected this transfer with a passphrase. Enter it and try again.";
  if (/receiver aborted: wrong-passphrase/.test(raw)) return "The receiver entered a different passphrase, so nothing was saved.";
  if (/wrong-passphrase|OperationError|operation-specific|decrypt/i.test(raw)) return "Wrong passphrase — the files couldn't be decrypted, so nothing was saved.";
  if (/sender aborted|user-cancel/.test(raw)) return "The sender cancelled the transfer.";
  if (/control channel closed|channel (closed|closing)|during drain/.test(raw)) {
    return "The other device cancelled or lost its connection. Send again \u2014 the transfer will pick up where it stopped.";
  }
  if (/integrity-check-failed/.test(raw)) {
    return /receiver aborted/.test(raw)
      ? "A file arrived corrupted on the other device and was deleted. Try sending again."
      : raw.replace(/^.*integrity-check-failed: /, "Integrity check failed: ") + ". Try again.";
  }
  if (/receiver aborted|receiver-cancel/.test(raw)) return "The receiver cancelled the transfer.";
  return raw || "Something went wrong. Please try again.";
}

function resetActiveUI(peerLabel: string): void {
  manifestFiles = [];
  receivedFiles = [];
  longTransferHintShown = false;
  fileStatusEls.clear();
  activeFilelist.innerHTML = "";
  progressFill.style.width = "0%";
  progressHeadline.textContent = "0 B / 0 B";
  progressRate.textContent = "—";
  progressEta.textContent = "—";
  progressFiles.textContent = "—";
  endPeerName.textContent = peerLabel;
  endPeerName.classList.add("muted");
  endPeerGlyph.textContent = "";
  setTransport("handshaking");
  setActiveStatus("");
}

async function startSend(files: File[], passphrase: string | undefined): Promise<void> {
  cancelActive();
  if (!files.length) return;
  sendCreate.disabled = true;
  let s: Session;
  try {
    s = newSession("send");
  } catch (err) {
    sendCreate.disabled = false;
    onTransferFailed(friendlyError(err));
    return;
  }
  session = s;
  goto("send-share");
  setShareCode("…");
  waitingText.textContent = "Connecting to the signaling server…";

  try {
    await race(s, s.signaling.ready());
    const room = await race(s, s.signaling.createRoom());
    setShareCode(room.code);
    waitingText.textContent = "Waiting for the receiver to join…";

    const peer = await race(s, waitForPeerJoined(s.signaling));
    resetActiveUI("Receiver");
    setPeerName(peer.name);
    goto("active");
    setActiveTitle("Connecting…");

    const link = createLink(s, peer.peerId);
    s.transportPoll = startTransportPoll(link.pc);
    s.host = new WorkerTransferHost({ worker: () => new TransferWorker(), peerConnection: link.pc });
    const transfer = s.host.send(crypto.randomUUID(), files, {
      ...(passphrase ? { encryptionPassphrase: passphrase } : {}),
      onEvent: (e) => onTransferEvent(e, files),
    });
    transfer.catch(() => { /* observed via race() */ });
    void acquireWakeLock();

    await race(s, link.start());
    await race(s, transfer);
    s.completed = true;
    onTransferDone("Files delivered.");
  } catch (err) {
    if (!s.cancelled) onTransferFailed(friendlyError(err));
  } finally {
    teardown(s, false);
    sendCreate.disabled = pickedFiles.length === 0;
  }
}

async function startReceive(
  rawCode: string,
  dir: FileSystemDirectoryHandle | null,
  passphrase: string | undefined,
): Promise<void> {
  cancelActive();
  recvGoBtn.disabled = true;

  // Destination: the folder the user chose, otherwise the browser's private
  // storage (files are saved out with a tap once the transfer finishes).
  const browserMode = !dir;
  try {
    if (!dir) dir = await inboxDir();
  } catch (err) {
    recvGoBtn.disabled = false;
    onTransferFailed(friendlyError(err));
    return;
  }

  let s: Session;
  try {
    s = newSession("receive");
  } catch (err) {
    recvGoBtn.disabled = false;
    onTransferFailed(friendlyError(err));
    return;
  }
  session = s;
  resetActiveUI("Sender");
  goto("active");
  setActiveTitle("Connecting…");

  const code = rawCode.trim(); // the server normalizes case / dashes / spaces

  try {
    await race(s, s.signaling.ready());
    const joined = await race(s, s.signaling.joinRoom(code));
    const remote = joined.peers[0];
    if (!remote) throw new Error("The sender isn't connected any more. Ask them for a new code.");
    setPeerName(remote.device.name);

    const link = createLink(s, remote.peerId);
    s.transportPoll = startTransportPoll(link.pc);
    s.host = new WorkerTransferHost({ worker: () => new TransferWorker(), peerConnection: link.pc });
    const transfer = s.host.receive({
      sink: { kind: "fsaccess", directory: dir, ...(browserMode ? { browserStorage: true } : {}) },
      ...(passphrase ? { encryptionPassphrase: passphrase } : {}),
      onEvent: (e) => onTransferEvent(e, []),
    });
    transfer.catch(() => { /* observed via race() */ });
    void acquireWakeLock();

    await race(s, link.start());
    await race(s, transfer);
    s.completed = true;
    if (browserMode) {
      onTransferDone("Now save them to this device.");
      await renderSaves(receivedFiles.map((f) => ({ name: f.savedAs, size: f.size })), "fresh");
    } else {
      onTransferDone(`Saved to \u201c${dir.name}\u201d.`);
    }
  } catch (err) {
    if (!s.cancelled) onTransferFailed(friendlyError(err));
  } finally {
    teardown(s, false);
    updateRecvButton();
  }
}

/* ─────────────── browser-storage inbox (OPFS) ─────────────── */

const INBOX = "dropbeam-inbox";
/** Received files left in browser storage are removed after this long. */
const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function inboxDir(): Promise<FileSystemDirectoryHandle> {
  if (!hasBrowserStorage) {
    throw new Error("This browser can't save received files. Please use a current version of Chrome, Edge, Safari or Firefox.");
  }
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(INBOX, { create: true });
}

type InboxEntry = { name: string; size: number; lastModified: number; partial: boolean };

async function listInbox(): Promise<InboxEntry[]> {
  if (!hasBrowserStorage) return [];
  const out: InboxEntry[] = [];
  try {
    const dir = await inboxDir();
    const it = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
    for await (const [name, h] of it) {
      if (h.kind !== "file") continue;
      try {
        const f = await (h as FileSystemFileHandle).getFile();
        out.push({ name, size: f.size, lastModified: f.lastModified, partial: name.endsWith(".dbpart") });
      } catch { /* locked by an in-flight write */ }
    }
  } catch { /* storage unavailable (private mode, etc.) */ }
  return out;
}

async function removeFromInbox(names: string[]): Promise<void> {
  try {
    const dir = await inboxDir();
    await Promise.all(names.map((n) => dir.removeEntry(n).catch(() => {})));
  } catch { /* ignore */ }
}

/** Drop anything older than a day so forgotten transfers don't eat disk space. */
async function pruneInbox(): Promise<void> {
  const cutoff = Date.now() - INBOX_MAX_AGE_MS;
  const old = (await listInbox()).filter((e) => e.lastModified < cutoff).map((e) => e.name);
  if (old.length) await removeFromInbox(old);
}

/** Recv screen: how much this browser can hold, and any files left from earlier. */
async function refreshRecvStorageInfo(): Promise<void> {
  if (!hasBrowserStorage) return;
  try {
    const est = await navigator.storage.estimate();
    if (est.quota) {
      const free = Math.max(0, est.quota - (est.usage ?? 0)) * 0.95;
      recvStorageEl.textContent = showDirectoryPicker
        ? `Without a folder, this browser can hold about ${humanBytes(free)} of incoming files.`
        : `This browser can hold about ${humanBytes(free)} of incoming files.`;
      recvStorageEl.classList.remove("hidden");
    }
  } catch { /* estimate unsupported */ }
  const done = (await listInbox()).filter((e) => !e.partial);
  if (done.length) {
    const bytes = done.reduce((n, e) => n + e.size, 0);
    recvLeftoversText.textContent = `${done.length} received file${done.length === 1 ? " is" : "s are"} still stored in this browser (${humanBytes(bytes)}).`;
    recvLeftovers.classList.remove("hidden");
  } else {
    recvLeftovers.classList.add("hidden");
  }
}

$<HTMLButtonElement>("#recv-leftovers-show").addEventListener("click", async () => {
  const done = (await listInbox()).filter((e) => !e.partial);
  setDoneState("ok", "Files waiting in this browser", "Save them to this device, then clear them.");
  goto("done");
  await renderSaves(done.map((e) => ({ name: e.name, size: e.size })), "leftover");
});
$<HTMLButtonElement>("#recv-leftovers-clear").addEventListener("click", async () => {
  const all = await listInbox();
  await removeFromInbox(all.map((e) => e.name));
  await refreshRecvStorageInfo();
});

void pruneInbox().then(() => refreshRecvStorageInfo());

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
/** Files this receive session finished, with the name they ended up under. */
let receivedFiles: { name: string; savedAs: string; size: number }[] = [];
let longTransferHintShown = false;
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
      const verb = session?.role === "send" ? "Sending" : "Receiving";
      setActiveTitle(`${verb} ${e.files.length} file${e.files.length === 1 ? "" : "s"}…`);
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
      // Long transfers die if the device sleeps or the tab closes: say so once.
      if (!longTransferHintShown && isFinite(e.etaSeconds) && e.etaSeconds > 10 * 60) {
        longTransferHintShown = true;
        setActiveStatus(
          `Long transfer (about ${Math.round(e.etaSeconds / 60)} min). Keep this page open and the device awake \u2014 plugged in if you can. If it gets interrupted, send again and it continues where it stopped.`,
        );
      }
      break;
    }
    case "verifying": {
      const el = fileStatusEls.get(e.fileId);
      if (el) {
        el.textContent = e.fileSize > 0 && e.bytesDone > 0
          ? `verifying ${Math.floor((e.bytesDone / e.fileSize) * 100)}%`
          : "verifying\u2026";
      }
      break;
    }
    case "file-done": {
      const entry = manifestFiles.find((f) => f.fileId === e.fileId);
      if (entry && session?.role === "receive") {
        receivedFiles.push({ name: entry.name, savedAs: e.savedAs ?? entry.name, size: entry.size });
      }
      const el = fileStatusEls.get(e.fileId);
      if (el) {
        el.textContent = e.verified ? "✓ verified" : "✓ sent";
        el.title = `SHA-256 ${e.sha256}`;
        el.classList.add("ok");
      }
      if (e.savedAs) {
        const nameEl = el?.parentElement?.querySelector(".file-name");
        if (nameEl) nameEl.textContent = `${nameEl.textContent} → ${e.savedAs}`;
      }
      break;
    }
    case "complete":
      progressFill.style.width = "100%";
      progressHeadline.textContent = `${humanBytes(manifestFiles.reduce((n, f) => n + f.size, 0))} done`;
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

function renderFilelist(ul: HTMLUListElement, files: File[], onRemove?: (idx: number) => void): void {
  ul.innerHTML = "";
  files.forEach((f, idx) => {
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
    
    if (onRemove) {
      const rm = document.createElement("button");
      rm.className = "remove-btn";
      rm.innerHTML = "&times;";
      rm.onclick = (e) => {
        e.preventDefault();
        onRemove(idx);
      };
      li.appendChild(rm);
    }
    
    ul.appendChild(li);
  });
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
  goto("idle");
});

const doneCard = $<HTMLElement>(".done-card");
const doneIconPath = $<SVGPathElement>("#done-icon-path");
const doneSaves = $<HTMLElement>("#done-saves");
const doneSavesNote = $<HTMLElement>("#done-saves-note");
const doneFiles = $<HTMLUListElement>("#done-files");
const doneShareAll = $<HTMLButtonElement>("#done-share-all");
const doneClear = $<HTMLButtonElement>("#done-clear");

function setDoneState(kind: "ok" | "failed", title: string, subtitle: string): void {
  doneCard.classList.toggle("failed", kind === "failed");
  doneIconPath.setAttribute("d", kind === "ok" ? "m8 12 3 3 5-6" : "m9 9 6 6m0-6-6 6");
  doneTitle.textContent = title;
  doneSub.textContent = subtitle;
  doneSaves.classList.add("hidden");
  doneFiles.innerHTML = "";
}

function onTransferDone(subtitle: string): void {
  setDoneState("ok", "Transfer complete", subtitle);
  goto("done");
  burstConfetti();
  if ("vibrate" in navigator) navigator.vibrate?.([30, 80, 30]);
}

function onTransferFailed(message: string): void {
  setDoneState("failed", "Transfer didn't finish", message);
  goto("done");
}

/** Names currently listed in the done screen's save list (for Clear / Share all). */
let savesShown: string[] = [];

async function getInboxFile(name: string): Promise<File> {
  const dir = await inboxDir();
  return (await dir.getFileHandle(name)).getFile();
}

function canShareFiles(files: File[]): boolean {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    return !!nav.canShare && nav.canShare({ files });
  } catch {
    return false;
  }
}

/**
 * Received files held in browser storage: one Save (download) button each,
 * plus Share on devices that support sharing files (iPhone → Save to Files).
 * The File objects are disk-backed, so even huge files aren't loaded into RAM.
 */
async function renderSaves(files: { name: string; size: number }[], kind: "fresh" | "leftover"): Promise<void> {
  savesShown = files.map((f) => f.name);
  doneFiles.innerHTML = "";
  if (!files.length) return;
  doneSavesNote.textContent =
    (kind === "fresh"
      ? "Your files are in this browser's temporary storage. "
      : "")
    + "Tap Save to put each one in your Downloads (on iPhone: Share \u2192 Save to Files). They're deleted automatically after 24 hours, or tap Clear when you're done.";

  let anyShare = false;
  for (const f of files) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = fileIconFor(f.name);
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = humanBytes(f.size);
    const save = document.createElement("button");
    save.type = "button";
    save.className = "save-btn";
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      try {
        const file = await getInboxFile(f.name);
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        save.textContent = "Saved \u2713";
        save.classList.add("saved");
      } catch {
        save.textContent = "Missing";
        save.disabled = true;
      }
    });
    li.append(icon, name, size, save);

    try {
      const file = await getInboxFile(f.name);
      if (canShareFiles([file])) {
        anyShare = true;
        const share = document.createElement("button");
        share.type = "button";
        share.className = "save-btn";
        share.textContent = "Share\u2026";
        share.addEventListener("click", async () => {
          try {
            await navigator.share({ files: [await getInboxFile(f.name)] });
          } catch { /* cancelled */ }
        });
        li.append(share);
      }
    } catch { /* file vanished */ }
    doneFiles.appendChild(li);
  }
  doneShareAll.classList.toggle("hidden", !(anyShare && files.length > 1));
  doneClear.classList.remove("hidden");
  doneSaves.classList.remove("hidden");
}

doneShareAll.addEventListener("click", async () => {
  try {
    const files = await Promise.all(savesShown.map((n) => getInboxFile(n)));
    await navigator.share({ files });
  } catch { /* cancelled or too many files for the share sheet */ }
});

doneClear.addEventListener("click", async () => {
  await removeFromInbox(savesShown);
  savesShown = [];
  doneFiles.innerHTML = "";
  doneShareAll.classList.add("hidden");
  doneClear.classList.add("hidden");
  doneSavesNote.textContent = "Cleared from this browser.";
});

/* ─────────────── signaling glue ─────────────── */

function waitForPeerJoined(signaling: SignalingClient): Promise<{ peerId: string; name: string }> {
  return new Promise((resolve, reject) => {
    const off = signaling.on((m) => {
      if (m.type === "peer-joined") {
        off();
        resolve({ peerId: m.peerId, name: m.device.name });
      } else if (m.type === "error") {
        off();
        reject(new Error(`${m.code}: ${m.message}`));
      }
    });
  });
}

/* ─────────────── deep link auto-join + SEO route handling ─────────────── */

interface RouteMeta {
  title: string;
  description: string;
  stage?: Stage;
  legal?: "privacy" | "terms";
}

const ROUTES: Record<string, RouteMeta> = {
  "/": {
    title: "DropBeam · big file transfer, any device, no cloud · free peer-to-peer",
    description: "DropBeam — any size, any device, no cloud. Free peer-to-peer file transfer for big files (50 GB+), large videos, photos, folders. End-to-end encrypted, no upload server, no account.",
  },
  "/about": {
    title: "About DropBeam · how peer-to-peer file transfer actually works",
    description: "DropBeam is open-source P2P file transfer in your browser. No upload bucket, no size cap. Learn what it does, where the money goes (30 % donated), and what's coming.",
    stage: "blog",
  },
  "/blog": {
    title: "DropBeam Blog · peer-to-peer file transfer, mega files, no cloud",
    description: "Articles on big file transfer, P2P file sharing, WeTransfer alternatives, AirDrop for any device.",
    stage: "blog",
  },
  "/features": {
    title: "DropBeam features · 50 GB+ files, LAN mode, QR pairing, bulk share",
    description: "Every DropBeam capability: mega-file streaming, LAN mode that works without internet, QR pairing, encrypted bulk transfers, browser-only cross-platform.",
    stage: "blog",
  },
  "/privacy": {
    title: "DropBeam Privacy · we never see your files",
    description: "DropBeam is peer-to-peer. The signaling server only introduces two devices. No upload bucket, no analytics, no cookies, no accounts.",
    stage: "legal",
    legal: "privacy",
  },
  "/terms": {
    title: "DropBeam Terms of Use · open-source, no warranty, MIT-licensed",
    description: "Terms for using DropBeam: free, open-source under MIT, no warranty, no liability for in-transit failures. Don't use it for illegal sharing.",
    stage: "legal",
    legal: "terms",
  },
};

function applyRouteMeta(path: string): void {
  const meta = ROUTES[path] ?? ROUTES["/"]!;
  document.title = meta.title;
  let desc = document.querySelector('meta[name="description"]');
  if (!desc) {
    desc = document.createElement("meta");
    desc.setAttribute("name", "description");
    document.head.appendChild(desc);
  }
  desc.setAttribute("content", meta.description);
  let canon = document.querySelector('link[rel="canonical"]');
  if (canon) canon.setAttribute("href", path);
}

(function routeOnLoad(): void {
  const path = location.pathname;
  const meta = ROUTES[path];
  applyRouteMeta(path);

  // ?c=CODE deep-link auto-join (anywhere on the site).
  const params = new URLSearchParams(location.search);
  const code = params.get("c");
  if (code && code.length >= 4) {
    recvCodeInput.value = code.toUpperCase();
    updateRecvButton();
    goto("recv-pick");
    return;
  }

  // Otherwise route to the right in-app stage based on pathname.
  if (meta?.stage === "blog") showBlog();
  else if (meta?.stage === "legal" && meta.legal) showLegal(meta.legal);
})();


/* ─────────────── memorable moments ─────────────── */

// Rotating hero word — the first <em> in the title cycles through
// synonyms so the page has a tiny bit of liveness when someone lands.
(function rotateHeroWord(): void {
  const words = ["anything", "any file", "any folder", "any size", "any movie", "any photo", "any ZIP", "5 GB", "50 GB"];
  const ems = document.querySelectorAll<HTMLElement>(".title em");
  const first = ems[0];
  if (!first) return;
  let i = 0;
  setInterval(() => {
    if (!document.querySelector('[data-stage="idle"].active')) return; // pause off-idle
    i = (i + 1) % words.length;
    first.style.transition = "opacity 0.18s ease-out, transform 0.18s ease-out";
    first.style.opacity = "0";
    first.style.transform = "rotate(-1.2deg) translateY(-4px)";
    setTimeout(() => {
      first.textContent = words[i]!;
      first.style.opacity = "1";
      first.style.transform = "rotate(-1.2deg) translateY(0)";
    }, 200);
  }, 2400);
})();

// Confetti — tiny canvas burst on transfer-done. ~50 lines, zero deps.
function burstConfetti(): void {
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:fixed;inset:0;z-index:9998;pointer-events:none;width:100%;height:100%";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) { canvas.remove(); return; }

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width = window.innerWidth * dpr;
  const h = canvas.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);

  const colors = ["#FCE43B", "#7BE0B5", "#FF8FB0", "#C9B6FF", "#9ED8FF", "#0A0A0A"];
  type P = { x: number; y: number; vx: number; vy: number; w: number; h: number; rot: number; vrot: number; color: string };
  const pieces: P[] = [];
  const N = 140;
  const cx = (w / dpr) / 2;
  const cy = (h / dpr) / 2;
  for (let i = 0; i < N; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 6 + Math.random() * 12;
    pieces.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vrot: (Math.random() - 0.5) * 0.3,
      color: colors[Math.floor(Math.random() * colors.length)]!,
    });
  }

  let frame = 0;
  const maxFrames = 110;
  const tick = (): void => {
    ctx.clearRect(0, 0, w / dpr, h / dpr);
    let stillAlive = false;
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35;            // gravity
      p.vx *= 0.99;            // drag
      p.rot += p.vrot;
      if (p.y < h / dpr + 30) stillAlive = true;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frame++;
    if (stillAlive && frame < maxFrames) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}

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
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => { /* ignore */ });
    });
  } else {
    // In dev the SW would cache Vite's source modules and serve stale code
    // after edits. Remove any registration left over from a previous build.
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const r of regs) void r.unregister();
    });
    void caches?.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
  }
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
  folder: `Receivers stream bytes <b>directly to disk</b> using the File System Access API — files never get loaded into RAM, so even a 500&nbsp;GB transfer doesn't slow your browser. Choosing a folder works in Chrome and Edge on computers. Without a folder (and always on phones, Safari and Firefox) files are held in the browser's private storage while they arrive \u2014 still streamed to disk, not RAM \u2014 and you save each one with a tap at the end. That needs about twice the free space while you save, and leftovers are deleted after 24 hours.`,
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
  // Info buttons are <span role="button"> (because they're nested inside other
  // buttons, where button-in-button is invalid HTML). Wire Enter/Space to fire
  // the same click handler.
  if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement)?.classList.contains("info-btn")) {
    e.preventDefault();
    (e.target as HTMLElement).click();
  }
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
  if (document.visibilityState === "visible" && session && !wakeLock) void acquireWakeLock();
});

// Warn before leaving the page during an active transfer.
window.addEventListener("beforeunload", (e) => {
  if (session?.phase === "transfer") {
    e.preventDefault();
    e.returnValue = "A transfer is still in progress. Leave anyway?";
    return e.returnValue;
  }
  return undefined;
});

