import { describe, expect, it } from 'vitest';
import { easeOutCubic, countUpValue } from '../src/components/feedback/count-up';

/**
 * T-387 S5 - the pure easing module behind `CountUp.tsx` (L6: no jsdom, so the maths is tested directly).
 * PINNED, in `apps/erp/src/components/feedback/count-up.ts`:
 *   easeOutCubic(t: number): number
 *     0 at t<=0, 1 at t>=1, monotonic non-decreasing between
 *   countUpValue(o: { start: number; end: number; t: number; reducedMotion?: boolean }): number
 *     t is progress in [0,1], clamped. start at t=0, end at t=1. reducedMotion true -> `end` at any t.
 */
describe('count-up easing', () => {
  it('easeOutCubic hits the endpoints and clamps outside [0,1]', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-0.5)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
  it('easeOutCubic is monotonic non-decreasing', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = easeOutCubic(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('countUpValue is start at t=0 and end at t=1', () => {
    expect(countUpValue({ start: 0, end: 1234.5, t: 0 })).toBe(0);
    expect(countUpValue({ start: 0, end: 1234.5, t: 1 })).toBe(1234.5);
    expect(countUpValue({ start: 100, end: 400, t: 0 })).toBe(100);
    expect(countUpValue({ start: 100, end: 400, t: 1 })).toBe(400);
  });
  it('countUpValue is monotonic between start and end, rising and falling', () => {
    let prev = 0;
    for (let i = 0; i <= 50; i++) {
      const v = countUpValue({ start: 0, end: 500, t: i / 50 });
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(500);
      prev = v;
    }
    let prevDown = 500;
    for (let i = 0; i <= 50; i++) {
      const v = countUpValue({ start: 500, end: 0, t: i / 50 });
      expect(v).toBeLessThanOrEqual(prevDown);
      expect(v).toBeGreaterThanOrEqual(0);
      prevDown = v;
    }
  });
  it('reduced motion shows the final value immediately, at any t', () => {
    expect(countUpValue({ start: 0, end: 987, t: 0, reducedMotion: true })).toBe(987);
    expect(countUpValue({ start: 0, end: 987, t: 0.3, reducedMotion: true })).toBe(987);
  });
  it('t outside [0,1] is clamped', () => {
    expect(countUpValue({ start: 10, end: 20, t: -1 })).toBe(10);
    expect(countUpValue({ start: 10, end: 20, t: 5 })).toBe(20);
  });
});

import { initialDisplay } from '../src/components/feedback/count-up';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('initialDisplay (the start-value decision, pure)', () => {
  it('reduced motion shows the final value; otherwise the animation starts at 0', () => {
    expect(initialDisplay({ end: 987, reducedMotion: true })).toBe(987);
    expect(initialDisplay({ end: 987, reducedMotion: false })).toBe(0);
  });
  it('CountUp.tsx calls it, so the decision cannot drift back into the component', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'feedback', 'CountUp.tsx'), 'utf8');
    expect(src).toMatch(/initialDisplay\(/);
  });
});
