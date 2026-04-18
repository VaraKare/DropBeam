/** Token-bucket rate limiter, per key (IP or peerId). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    /** Max tokens (burst capacity). */
    private readonly capacity: number,
    /** Tokens added per second. */
    private readonly refillPerSec: number,
  ) {}

  /** Returns true if allowed (and consumes 1 token), false if rate-limited. */
  consume(key: string, cost = 1): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b) {
      this.buckets.set(key, { tokens: this.capacity - cost, updatedAt: now });
      return true;
    }
    const elapsed = (now - b.updatedAt) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSec);
    b.updatedAt = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  /** Periodic GC; call on a timer to free idle keys. */
  prune(maxIdleMs: number): void {
    const cutoff = Date.now() - maxIdleMs;
    for (const [k, b] of this.buckets) {
      if (b.updatedAt < cutoff) this.buckets.delete(k);
    }
  }
}
