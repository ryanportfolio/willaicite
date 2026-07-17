import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/rateLimiter.js';

describe('createRateLimiter', () => {
  it('allows up to max within a window, then blocks with retryAfter', () => {
    let t = 1000;
    const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
    expect(rl.hit('ip1').allowed).toBe(true);
    expect(rl.hit('ip1').allowed).toBe(true);
    const third = rl.hit('ip1');
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);
    expect(third.retryAfterMs).toBeLessThanOrEqual(1000);
    void t;
  });
  it('resets after the window elapses', () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('ip1').allowed).toBe(true);
    expect(rl.hit('ip1').allowed).toBe(false);
    t = 1001;
    expect(rl.hit('ip1').allowed).toBe(true);
  });
  it('isolates keys', () => {
    const t = 0;
    const rl = createRateLimiter({ windowMs: 1000, max: 1, now: () => t });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('b').allowed).toBe(true);
  });
});
