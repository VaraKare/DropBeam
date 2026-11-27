/**
 * Public, aggregate-only usage counters (no IPs, codes, names or per-user
 * rows; one row per UTC day). Adapter-neutral: the hub bumps counters in
 * memory; the Cloudflare adapter persists dirty days to SQLite about once a
 * minute and loads them on start, the Bun adapter keeps them in memory.
 */

import type { StatsPath } from "@dropbeam/protocol";

export interface DayCounters {
  /** UTC day, "YYYY-MM-DD". */
  date: string;
  roomsCreated: number;
  roomsPaired: number;
  transfers: number;
  bytes: number;
  files: number;
  direct: number;
  lan: number;
  relay: number;
}

type Totals = Omit<DayCounters, "date">;

export interface StatsSnapshot {
  today: DayCounters;
  last30Days: Array<{ date: string; transfers: number; bytes: number }>;
  allTime: Totals & { since: string | null };
}

const DAY_MS = 86_400_000;
const NUMERIC_KEYS = ["roomsCreated", "roomsPaired", "transfers", "bytes", "files", "direct", "lan", "relay"] as const;

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const MAX = Number.MAX_SAFE_INTEGER;
/** Counters saturate instead of losing precision (or being zeroed on reload). */
const add = (a: number, b: number): number => Math.min(MAX, a + b);

const emptyTotals = (): Totals => ({
  roomsCreated: 0, roomsPaired: 0, transfers: 0, bytes: 0, files: 0, direct: 0, lan: 0, relay: 0,
});

export class Stats {
  private readonly days = new Map<string, DayCounters>();
  private readonly dirty = new Set<string>();
  private readonly totals = emptyTotals();

  /** `onChange` fires after every bump (the Cloudflare adapter schedules a flush). */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly onChange?: () => void,
  ) {}

  roomCreated(): void {
    this.bump({ roomsCreated: 1 });
  }

  roomPaired(): void {
    this.bump({ roomsPaired: 1 });
  }

  /** Caller has already validated bytes/files/path (validate.ts + hub). */
  transfer(bytes: number, files: number, path: StatsPath): void {
    this.bump({ transfers: 1, bytes, files, [path]: 1 });
  }

  /** Merge persisted rows (on start). Values are absolute per-day counts. */
  load(rows: DayCounters[]): void {
    for (const r of rows) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
      const prev = this.days.get(r.date);
      const row: DayCounters = { date: r.date, ...emptyTotals() };
      for (const k of NUMERIC_KEYS) {
        const v = Number(r[k]);
        const loaded = Number.isFinite(v) && v >= 0 ? Math.min(MAX, Math.floor(v)) : 0;
        row[k] = add(loaded, prev?.[k] ?? 0);
        this.totals[k] = add(this.totals[k], loaded);
      }
      this.days.set(r.date, row);
    }
  }

  /** Days changed since the last call, for the adapter to persist. */
  takeDirty(): DayCounters[] {
    const out: DayCounters[] = [];
    for (const d of this.dirty) {
      const row = this.days.get(d);
      if (row) out.push({ ...row });
    }
    this.dirty.clear();
    return out;
  }

  /** Put rows back if persisting them failed, so the next flush retries. */
  markDirty(dates: string[]): void {
    for (const d of dates) this.dirty.add(d);
  }

  get hasDirty(): boolean {
    return this.dirty.size > 0;
  }

  snapshot(): StatsSnapshot {
    const now = this.now();
    const todayKey = utcDay(now);
    const last30Days: StatsSnapshot["last30Days"] = [];
    for (let i = 29; i >= 0; i--) {
      const date = utcDay(now - i * DAY_MS);
      const d = this.days.get(date);
      last30Days.push({ date, transfers: d?.transfers ?? 0, bytes: d?.bytes ?? 0 });
    }
    let since: string | null = null;
    for (const d of this.days.keys()) if (since === null || d < since) since = d;
    return {
      today: { ...(this.days.get(todayKey) ?? { date: todayKey, ...emptyTotals() }) },
      last30Days,
      allTime: { ...this.totals, since },
    };
  }

  private bump(delta: Partial<Totals>): void {
    const date = utcDay(this.now());
    let row = this.days.get(date);
    if (!row) {
      row = { date, ...emptyTotals() };
      this.days.set(date, row);
    }
    for (const k of NUMERIC_KEYS) {
      const v = delta[k];
      if (!v) continue;
      row[k] = add(row[k], v);
      this.totals[k] = add(this.totals[k], v);
    }
    this.dirty.add(date);
    this.onChange?.();
  }
}

/**
 * Headers for `GET /stats`: cacheable for a minute, readable cross-origin by
 * the site. With no ALLOWED_ORIGINS the data is public anyway, so `*`.
 */
export function statsHeaders(allowedOrigins: string[], origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "public, max-age=60",
    // Same-origin self-hosts serve the /stats *page* at this URL too; never
    // let a cached JSON answer stand in for a page navigation.
    vary: "accept",
  };
  if (allowedOrigins.length === 0) h["access-control-allow-origin"] = "*";
  else {
    h.vary = "accept, origin";
    if (origin && allowedOrigins.includes(origin)) h["access-control-allow-origin"] = origin;
  }
  return h;
}
