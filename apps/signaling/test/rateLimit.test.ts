import { describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/rateLimit.ts";

describe("RateLimiter", () => {
  test("allows up to capacity then denies", () => {
    const rl = new RateLimiter(3, 0);
    expect(rl.consume("k")).toBe(true);
    expect(rl.consume("k")).toBe(true);
    expect(rl.consume("k")).toBe(true);
    expect(rl.consume("k")).toBe(false);
  });

  test("refill restores tokens", async () => {
    const rl = new RateLimiter(1, 100); // refills 100/s
    expect(rl.consume("k")).toBe(true);
    expect(rl.consume("k")).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(rl.consume("k")).toBe(true);
  });

  test("keys isolated", () => {
    const rl = new RateLimiter(1, 0);
    expect(rl.consume("a")).toBe(true);
    expect(rl.consume("b")).toBe(true);
    expect(rl.consume("a")).toBe(false);
    expect(rl.consume("b")).toBe(false);
  });
});
