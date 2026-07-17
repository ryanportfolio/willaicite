export interface RateLimiter {
  /** Records a hit for key; returns whether it is under the limit. */
  hit(key: string): { allowed: boolean; retryAfterMs: number };
}

/**
 * Fixed-window per-key limiter. In-memory; a key's window is reset lazily on
 * its next access so an idle server does not accumulate keys unbounded. `now`
 * is injectable for deterministic tests.
 */
export function createRateLimiter(opts: { windowMs: number; max: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { windowStart: number; count: number }>();

  return {
    hit(key: string) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.windowStart >= opts.windowMs) {
        windows.set(key, { windowStart: t, count: 1 });
        return { allowed: true, retryAfterMs: 0 };
      }
      w.count++;
      if (w.count <= opts.max) return { allowed: true, retryAfterMs: 0 };
      return { allowed: false, retryAfterMs: w.windowStart + opts.windowMs - t };
    },
  };
}
