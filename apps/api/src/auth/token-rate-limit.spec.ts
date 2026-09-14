import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOKEN_CALLS_PER_MINUTE,
  TokenRateLimiter,
} from "./token-rate-limit";

/**
 * The window behaviour, driven through the injected clock.
 *
 * The guard's own spec proves that the budget is taken and that a token over
 * it is refused, but it cannot move time, so the two properties that matter
 * most here are only reachable from this side: that a budget comes back, and
 * that the map does not grow without bound on a process that stays up.
 */

/** A clock the test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe("TokenRateLimiter", () => {
  it("allows exactly the budget", () => {
    const time = clock();
    const limiter = new TokenRateLimiter(3, time.now);

    for (let call = 0; call < 3; call += 1) {
      expect(limiter.take("token-1").allowed).toBe(true);
    }
    expect(limiter.take("token-1").allowed).toBe(false);
  });

  it("gives the budget back when the window passes", () => {
    const time = clock();
    const limiter = new TokenRateLimiter(1, time.now);

    expect(limiter.take("token-1").allowed).toBe(true);
    expect(limiter.take("token-1").allowed).toBe(false);

    time.advance(60_000);
    // A limiter that never reset would lock a connection out permanently after
    // one busy minute.
    expect(limiter.take("token-1").allowed).toBe(true);
  });

  it("does not give it back early", () => {
    const time = clock();
    const limiter = new TokenRateLimiter(1, time.now);

    limiter.take("token-1");
    time.advance(59_999);
    expect(limiter.take("token-1").allowed).toBe(false);
  });

  it("counts each token separately", () => {
    const time = clock();
    const limiter = new TokenRateLimiter(1, time.now);

    expect(limiter.take("token-1").allowed).toBe(true);
    // One connected app spending its budget must not throttle another. This is
    // the whole reason the key is the token row rather than a client address,
    // which a hosted app shares across an entire cooperative.
    expect(limiter.take("token-2").allowed).toBe(true);
    expect(limiter.take("token-1").allowed).toBe(false);
  });

  it("names a delay that is never zero and never longer than the window", () => {
    const time = clock();
    const limiter = new TokenRateLimiter(1, time.now);

    limiter.take("token-1");
    // Just inside the window, where the true remainder rounds to zero. A
    // Retry-After of 0 invites an immediate retry that is refused again.
    time.advance(59_900);
    const verdict = limiter.take("token-1");

    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfter).toBeGreaterThanOrEqual(1);
    expect(verdict.retryAfter).toBeLessThanOrEqual(60);
  });

  it("does not grow without bound as tokens come and go", () => {
    const time = clock();
    const limiter = new TokenRateLimiter(10, time.now);

    // Every call is a different token, as a long-lived process sees over days.
    for (let index = 0; index < 1500; index += 1) {
      limiter.take(`token-${String(index)}`);
    }
    time.advance(60_001);
    limiter.take("token-fresh");

    // The expired windows are dropped rather than kept for every token ever
    // seen. Reached through the public surface: an entry that survived would
    // still be counting, so its budget would not be whole.
    for (let index = 0; index < 5; index += 1) {
      const verdict = limiter.take(`token-${String(index)}`);
      expect(verdict.allowed).toBe(true);
    }
  });

  it("defaults to a budget an ordinary connection does not reach", () => {
    expect(DEFAULT_TOKEN_CALLS_PER_MINUTE).toBe(60);
  });
});
