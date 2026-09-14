/**
 * How much one token may spend in a minute.
 *
 * Keyed on the access-token row id, never on the token value: the value is a
 * bearer credential and this map would otherwise be somewhere it is held in
 * memory in the clear.
 *
 * Not the public rate-limit guard, which is inert without its decorator and
 * keys on the client address. A hosted connected app's calls all arrive from
 * one egress range, so an address key throttles either the whole cooperative
 * or nobody.
 *
 * A fixed window, and in memory. That means it is per process and resets when
 * the process does - installing a plugin replaces the process - so it bounds
 * what one connection can do to an instance rather than being a quota anybody
 * is accounted against. A shared counter is the next change if that becomes
 * the wrong answer, and ADR 0009 says so.
 */

export const DEFAULT_TOKEN_CALLS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

interface Window {
  /** When the current window began. */
  startedAt: number;
  count: number;
}

export interface TokenRateLimitVerdict {
  allowed: boolean;
  /** Seconds until the window resets. Always at least one. */
  retryAfter: number;
}

export class TokenRateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly max: number = DEFAULT_TOKEN_CALLS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  take(tokenRowId: string): TokenRateLimitVerdict {
    const at = this.now();
    const window = this.windows.get(tokenRowId);

    if (window === undefined || at - window.startedAt >= WINDOW_MS) {
      this.windows.set(tokenRowId, { startedAt: at, count: 1 });
      this.sweep(at);
      return { allowed: true, retryAfter: 0 };
    }

    window.count += 1;
    if (window.count <= this.max) {
      return { allowed: true, retryAfter: 0 };
    }

    const remaining = WINDOW_MS - (at - window.startedAt);
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil(remaining / 1000)),
    };
  }

  /**
   * Drops windows that have expired.
   *
   * Without this the map grows by one entry per token ever seen and is never
   * emptied, which on a long-running process is a leak rather than a cache.
   * Done on the cheap path - the call that opens a window - so there is no
   * timer to own and nothing to shut down.
   */
  private sweep(at: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, window] of this.windows) {
      if (at - window.startedAt >= WINDOW_MS) {
        this.windows.delete(key);
      }
    }
  }
}
