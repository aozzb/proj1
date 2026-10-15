import { describe, it, expect } from 'vitest';
import { backoffDelay } from '../../src/worker/backoff';

// Test env sets BACKOFF_BASE_MS=50, BACKOFF_CAP_MS=400.
const BASE = 50;
const CAP = 400;

describe('backoffDelay (full jitter)', () => {
  it('stays within [0, min(cap, base*2^(n-1))) across many samples', () => {
    for (let n = 1; n <= 8; n++) {
      const exp = Math.min(CAP, BASE * 2 ** (n - 1));
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(n);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(exp || 1); // exp>=50 here, so strictly less
      }
    }
  });

  it('never exceeds the cap even for large attempt numbers', () => {
    for (let i = 0; i < 500; i++) {
      expect(backoffDelay(20)).toBeLessThan(CAP);
    }
  });

  it('grows exponentially before the cap (mean of n=3 > mean of n=1)', () => {
    const mean = (n: number) => {
      let s = 0;
      for (let i = 0; i < 2000; i++) s += backoffDelay(n);
      return s / 2000;
    };
    expect(mean(3)).toBeGreaterThan(mean(1));
  });
});
