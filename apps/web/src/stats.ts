/**
 * Live public stats: the `/stats` page, the footer "N files beamed today"
 * ticker, and the one fire-and-forget `stats` report a sender makes after a
 * verified transfer. Aggregate counts only (see apps/signaling/src/stats.ts).
 */

import type { ClientToServerMsg, StatsPath } from "@dropbeam/protocol";

interface DayRow { date: string; transfers: number; bytes: number }
interface StatsData {
  today: { date: string; transfers: number; bytes: number; files: number };
  last30Days: DayRow[];
  allTime: { transfers: number; bytes: number; files: number; direct: number; lan: number; relay: number; since: string | null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** `wss://host/ws` → `https://host/stats`. Null if the URL can't be parsed. */
export function statsEndpoint(signalingUrl: string): string | null {
  try {
    const u = new URL(signalingUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
    u.pathname = "/stats";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** Fetch and defensively parse `/stats` (an old server answers with plain text → null). */
async function fetchStats(url: string): Promise<StatsData | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, credentials: "omit" });
    if (!res.ok) return null;
    const v: unknown = await res.json();
    if (!isObj(v) || !isObj(v.today) || !isObj(v.allTime) || !Array.isArray(v.last30Days)) return null;
    const t = v.today;
    const a = v.allTime;
    return {
      today: { date: String(t.date ?? ""), transfers: n(t.transfers), bytes: n(t.bytes), files: n(t.files) },
      last30Days: v.last30Days
        .filter((d): d is Record<string, unknown> => isObj(d) && typeof d.date === "string" && DATE_RE.test(d.date))
        .slice(-30)
        .map((d) => ({ date: d.date as string, transfers: n(d.transfers), bytes: n(d.bytes) })),
      allTime: {
        transfers: n(a.transfers), bytes: n(a.bytes), files: n(a.files),
        direct: n(a.direct), lan: n(a.lan), relay: n(a.relay),
        since: typeof a.since === "string" && DATE_RE.test(a.since) ? a.since : null,
      },
    };
  } catch {
    return null;
  }
}

/* ─── formatting ─── */

function bytes(b: number): string {
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
}
const count = (x: number): string => Math.round(x).toLocaleString("en-US");
const shortDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (x: number, one: string, many: string): string => `${count(x)} ${x === 1 ? one : many}`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ─── page ─── */

function bigNumber(label: string, value: string, tone: string): HTMLElement {
  const card = el("div", `stat-card ${tone}`);
  card.append(el("span", "stat-value", value), el("span", "stat-label", label));
  return card;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/**
 * 30 bars, transfers per day; built with DOM APIs (no innerHTML, no library).
 * The viewBox matches the box's real pixel width, so labels stay 12 px on
 * phones and the chart doesn't balloon on wide screens.
 */
function barChart(days: DayRow[], width: number): SVGSVGElement {
  const W = Math.round(Math.min(1000, Math.max(280, width || 600))), H = 200, PAD_B = 26, PAD_T = 18;
  const max = Math.max(1, ...days.map((d) => d.transfers));
  const slot = W / Math.max(1, days.length);
  const bw = Math.max(4, slot * 0.68);
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "stats-chart", role: "img" });
  const total = days.reduce((s, d) => s + d.transfers, 0);
  root.setAttribute("aria-label", `Transfers per day over the last ${days.length} days: ${count(total)} in total, at most ${count(max)} in one day.`);
  root.append(svg("line", { x1: 0, x2: W, y1: H - PAD_B, y2: H - PAD_B, class: "axis" }));
  days.forEach((d, i) => {
    const h = d.transfers ? Math.max(3, ((H - PAD_B - PAD_T) * d.transfers) / max) : 0;
    const x = i * slot + (slot - bw) / 2;
    const isToday = i === days.length - 1;
    const g = svg("g", {});
    const title = svg("title", {});
    title.textContent = `${shortDate(d.date)}: ${plural(d.transfers, "transfer", "transfers")} · ${bytes(d.bytes)}`;
    g.append(title);
    // Invisible full-height hit area so tiny bars still show their tooltip.
    g.append(svg("rect", { x: i * slot, y: 0, width: slot, height: H - PAD_B, class: "hit" }));
    if (h) g.append(svg("rect", { x, y: H - PAD_B - h, width: bw, height: h, rx: 2, class: isToday ? "bar today" : "bar" }));
    root.append(g);
  });
  const label = (i: number, anchor: string): void => {
    const d = days[i];
    if (!d) return;
    const t = svg("text", { x: Math.min(W - 2, Math.max(2, i * slot + slot / 2)), y: H - 6, "text-anchor": anchor, class: "tick" });
    t.textContent = i === days.length - 1 ? "Today" : shortDate(d.date);
    root.append(t);
  };
  label(0, "start");
  label(Math.floor(days.length / 2), "middle");
  label(days.length - 1, "end");
  const peak = svg("text", { x: 2, y: 12, class: "tick" });
  peak.textContent = `max ${count(max)}/day`;
  root.append(peak);
  return root;
}

function pathSplit(a: StatsData["allTime"]): HTMLElement {
  const wrap = el("div", "stats-split");
  const total = a.direct + a.lan + a.relay;
  const parts: Array<[string, number, string]> = [
    ["Same Wi-Fi", a.lan, "lan"],
    ["Direct over the internet", a.direct, "direct"],
    ["Relayed (TURN)", a.relay, "relay"],
  ];
  const pct = (x: number): number => (total ? Math.round((x / total) * 100) : 0);
  const directPct = total ? Math.round(((a.direct + a.lan) / total) * 100) : 0;
  wrap.append(el("h3", "", total ? `${directPct}% went device to device` : "Direct vs relayed"));
  const bar = el("div", "split-bar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", parts.map(([l, v]) => `${l} ${pct(v)}%`).join(", "));
  for (const [, v, cls] of parts) {
    if (!v) continue;
    const seg = el("span", `seg ${cls}`);
    seg.style.width = `${(v / total) * 100}%`;
    bar.append(seg);
  }
  if (!total) bar.append(el("span", "seg empty"));
  const legend = el("ul", "split-legend");
  for (const [l, v, cls] of parts) {
    const li = el("li", "");
    li.append(el("span", `dot ${cls}`), el("span", "", `${l} · ${pct(v)}%`));
    legend.append(li);
  }
  wrap.append(bar, legend);
  return wrap;
}

function renderPage(root: HTMLElement, s: StatsData): void {
  root.replaceChildren();
  const today = el("div", "stats-grid");
  today.append(
    bigNumber("transfers today", count(s.today.transfers), "yellow"),
    bigNumber("files beamed today", count(s.today.files), "mint"),
    bigNumber("moved today", bytes(s.today.bytes), "sky"),
  );
  const all = el("div", "stats-grid");
  all.append(
    bigNumber("transfers, all time", count(s.allTime.transfers), "paper"),
    bigNumber("files, all time", count(s.allTime.files), "paper"),
    bigNumber("data moved, all time", bytes(s.allTime.bytes), "coral"),
  );
  const chartBox = el("div", "stats-chart-box");
  chartBox.append(el("h3", "", "Transfers, last 30 days"));
  const since = s.allTime.since ? ` since ${shortDate(s.allTime.since)}` : "";
  root.append(
    el("h3", "stats-h", "Today (UTC)"),
    today,
    el("h3", "stats-h", `All time${since}`),
    all,
    chartBox,
    pathSplit(s.allTime),
  );
  chartBox.append(barChart(s.last30Days, chartBox.clientWidth - 32));
}

/** Render the stats stage into `root`. */
export async function renderStats(root: HTMLElement, url: string | null): Promise<void> {
  root.replaceChildren(el("p", "muted", "Loading…"));
  const data = url ? await fetchStats(url) : null;
  if (!data) {
    root.replaceChildren(el("p", "muted", "Stats aren't available right now. Transfers still work. Try again in a minute."));
    return;
  }
  renderPage(root, data);
}

/** Footer: "N files beamed today". Stays hidden if the server has no stats. */
export async function initStatsTicker(link: HTMLElement, url: string | null): Promise<void> {
  const data = url ? await fetchStats(url) : null;
  if (!data) return;
  const f = data.today.files;
  link.textContent = f ? `${plural(f, "file", "files")} beamed today →` : "Live stats: be the first to beam a file today →";
  link.classList.remove("hidden");
}

/* ─── reporting ─── */

/** Which way the bytes went, from the selected ICE candidate pair. */
export async function selectedPath(pc: RTCPeerConnection): Promise<StatsPath | null> {
  const report = await pc.getStats();
  let pair: { localCandidateId?: string; remoteCandidateId?: string } | null = null;
  const cands = new Map<string, { candidateType?: string }>();
  report.forEach((s: { type?: string; id?: string; nominated?: boolean; selected?: boolean }) => {
    if (s.type === "candidate-pair" && (s.nominated || s.selected)) pair = s as typeof pair;
    if (s.type === "local-candidate" || s.type === "remote-candidate") cands.set(s.id ?? "", s as { candidateType?: string });
  });
  if (!pair) return null;
  const p = pair as { localCandidateId?: string; remoteCandidateId?: string };
  const l = cands.get(p.localCandidateId ?? "")?.candidateType ?? "";
  const r = cands.get(p.remoteCandidateId ?? "")?.candidateType ?? "";
  if (l === "relay" || r === "relay") return "relay";
  if (l === "host" && r === "host") return "lan";
  return "direct";
}

/**
 * One fire-and-forget report after `complete-ack`. Never throws and never
 * waits for a reply: servers that predate `stats` answer invalid-message,
 * which nobody is listening for by then.
 */
export async function reportTransfer(
  send: (msg: ClientToServerMsg) => void,
  pc: RTCPeerConnection | null,
  files: readonly File[],
): Promise<void> {
  try {
    const path = (pc && (await selectedPath(pc).catch(() => null))) ?? "direct";
    const total = files.reduce((s, f) => s + f.size, 0);
    send({ type: "stats", bytes: Math.min(total, 2 ** 40), files: Math.min(files.length, 10_000), path });
  } catch { /* signaling already closed; stats are best-effort */ }
}
