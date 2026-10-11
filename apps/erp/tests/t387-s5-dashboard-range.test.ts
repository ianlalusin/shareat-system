import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dayCount, eachDay, presetRange, resolveRange } from '../src/app/dashboard/lib';

/** T-387 S5 audit: range resolution, the cap, presets, eachDay and dayCount. Pure date arithmetic. */
const TODAY = '2026-10-11';
const MTD = { from: '2026-10-01', to: TODAY, preset: null };

describe('presetRange', () => {
  it('each preset against a mid-month today', () => {
    expect(presetRange('today', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(presetRange('7d', TODAY)).toEqual({ from: '2026-10-05', to: TODAY });
    expect(presetRange('30d', TODAY)).toEqual({ from: '2026-09-12', to: TODAY });
    expect(presetRange('mtd', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
  });
  it('month and year boundaries (today is the business date, already Asia/Manila)', () => {
    expect(presetRange('7d', '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(presetRange('mtd', '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-01' });
    expect(presetRange('30d', '2024-03-10')).toEqual({ from: '2024-02-10', to: '2024-03-10' });
  });
  it('unknown or missing key is null', () => {
    expect(presetRange('90d', TODAY)).toBeNull();
    expect(presetRange(undefined, TODAY)).toBeNull();
  });
});

describe('eachDay and dayCount', () => {
  it('inclusive, across a month end and a leap day', () => {
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(eachDay('2024-02-28', '2024-03-01')).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
    expect(eachDay(TODAY, TODAY)).toEqual([TODAY]);
  });
  it('dayCount agrees with eachDay', () => {
    expect(dayCount('2026-10-05', TODAY)).toBe(7);
    expect(dayCount(TODAY, TODAY)).toBe(1);
    expect(dayCount('2024-02-28', '2024-03-01')).toBe(3);
  });
  it('reversed or malformed throws', () => {
    expect(() => eachDay(TODAY, '2026-10-10')).toThrow();
    expect(() => eachDay('nope', TODAY)).toThrow();
  });
});

describe('resolveRange', () => {
  it('a preset wins over from/to', () => {
    expect(resolveRange({ range: '7d', from: '2020-01-01', to: '2020-01-02' }, TODAY)).toEqual({
      from: '2026-10-05',
      to: TODAY,
      preset: '7d',
    });
  });
  it('a valid custom range is kept', () => {
    expect(resolveRange({ from: '2026-09-01', to: '2026-09-30' }, TODAY)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      preset: null,
    });
  });
  it('no params is month to date', () => {
    expect(resolveRange({}, TODAY)).toEqual(MTD);
  });
  it('reversed, malformed and impossible ranges fall back to month to date', () => {
    expect(resolveRange({ from: '2026-10-11', to: '2026-10-01' }, TODAY)).toEqual(MTD);
    expect(resolveRange({ from: 'yesterday', to: TODAY }, TODAY)).toEqual(MTD);
    expect(resolveRange({ from: '2026-02-30', to: TODAY }, TODAY)).toEqual(MTD);
  });
  it('cap: 366 days is allowed, 367 falls back', () => {
    expect(resolveRange({ from: '2025-10-11', to: TODAY }, TODAY)).toMatchObject({ from: '2025-10-11', to: TODAY });
    expect(resolveRange({ from: '2025-10-10', to: TODAY }, TODAY)).toEqual(MTD);
  });
  it('cap: a start before 2000-01-01 falls back, including year 0001', () => {
    expect(resolveRange({ from: '0001-01-01', to: TODAY }, TODAY)).toEqual(MTD);
    expect(resolveRange({ from: '1999-12-31', to: '2000-01-02' }, TODAY)).toEqual(MTD);
  });
  it('a range whose PREVIOUS range would start before 2000 also falls back', () => {
    expect(resolveRange({ from: '2000-01-01', to: '2000-01-10' }, TODAY)).toEqual(MTD);
    expect(resolveRange({ from: '2000-01-11', to: '2000-01-20' }, TODAY)).toMatchObject({ from: '2000-01-11' });
  });
});

describe('globals.css', () => {
  it('the outline-count transition sits inside the prefers-reduced-motion: no-preference block', () => {
    const css = readFileSync(path.join(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8');
    const start = css.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{/);
    expect(start).toBeGreaterThan(-1);
    let i = css.indexOf('{', start) + 1;
    for (let depth = 1; depth > 0 && i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    const outside = css.slice(0, start) + css.slice(i);
    expect(outside).not.toMatch(/outline-count[^{]*\{[^}]*transition/);
    expect(css.slice(start, i)).toMatch(/outline-count-num\s*\{[^}]*transition/);
  });
});
