// ASSUMED API (T-530a): none.
// ASSUMED API: apps/erp/src/app/pos/_shell/theme.ts exports posThemeFor(pathname: string, rawCookie: string | undefined | null): 'light' | 'dark'
//   /pos/kitchen (and anything under it): 'dark' unless the cookie is EXACTLY 'light'. Every other route: parseTheme (anything not exactly 'dark' is light).
// ASSUMED API: the kitchen page or a nested layout under apps/erp/src/app/pos/kitchen/ sets `data-theme` from that function (server-side, first paint).
/**
 * T-526 R1 (bible row 433) - the Kitchen screen is dark unless the viewer chose light; every other route keeps the existing light-by-default rule,
 * and theme-state.ts is not changed. Written BEFORE the code (tester lane).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_COOKIE_NAME, parseTheme } from '@/components/shell/theme-state';
import { posThemeFor } from '@/app/pos/_shell/theme';

const here = dirname(fileURLToPath(import.meta.url));
const kitchenDir = resolve(here, '..', 'src', 'app', 'pos', 'kitchen');

describe('T-526 R1 - the Kitchen theme (row 433)', () => {
  it('the cookie is still named shareat_theme', () => {
    expect(THEME_COOKIE_NAME).toBe('shareat_theme');
  });

  it('/pos/kitchen: no cookie -> dark', () => {
    expect(posThemeFor('/pos/kitchen', undefined)).toBe('dark');
    expect(posThemeFor('/pos/kitchen', null)).toBe('dark');
  });
  it("/pos/kitchen: cookie exactly 'light' -> light (the one way out)", () => {
    expect(posThemeFor('/pos/kitchen', 'light')).toBe('light');
  });
  it("/pos/kitchen: cookie 'dark' -> dark", () => {
    expect(posThemeFor('/pos/kitchen', 'dark')).toBe('dark');
  });
  it("/pos/kitchen: anything that is not exactly 'light' stays dark (empty, wrong case, stale, hand-edited)", () => {
    for (const odd of ['', 'LIGHT', 'Light', ' light', 'light ', 'auto', 'system', 'blue']) {
      expect(posThemeFor('/pos/kitchen', odd), JSON.stringify(odd)).toBe('dark');
    }
  });

  it('the Orders route with no cookie -> light (the control: only the kitchen flips the default)', () => {
    expect(posThemeFor('/pos', undefined)).toBe('light');
  });
  it("other POS routes keep the existing rule: no cookie light, 'dark' dark, 'light' light", () => {
    for (const route of ['/pos', '/pos/refills', '/pos/receipts', '/pos/till']) {
      expect(posThemeFor(route, undefined), route).toBe('light');
      expect(posThemeFor(route, 'dark'), route).toBe('dark');
      expect(posThemeFor(route, 'light'), route).toBe('light');
      expect(posThemeFor(route, 'LIGHT'), route).toBe('light');
    }
  });
  it('an ERP route outside /pos keeps the existing rule too (a path that merely starts with /pos/kitchen-like text is not the kitchen)', () => {
    expect(posThemeFor('/settings', undefined)).toBe('light');
    expect(posThemeFor('/pos/kitchenette', undefined)).toBe('light');
  });

  it('theme-state.ts is unchanged for everyone else: parseTheme(undefined) is light, only exactly "dark" is dark', () => {
    expect(parseTheme(undefined)).toBe('light');
    expect(parseTheme(null)).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('DARK')).toBe('light');
  });

  it('the decision is made on the server for the first paint: the kitchen folder reads the cookie, calls posThemeFor and writes data-theme', () => {
    expect(existsSync(kitchenDir), 'apps/erp/src/app/pos/kitchen/ does not exist').toBe(true);
    const files = ['layout.tsx', 'page.tsx'].map((f) => resolve(kitchenDir, f)).filter(existsSync);
    expect(files.length).toBeGreaterThan(0);
    const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(all).toContain('posThemeFor');
    expect(all).toContain('data-theme');
    expect(all).toMatch(/cookies\(\)/);
    expect(all, 'a client component cannot decide the first paint').not.toMatch(/useEffect[\s\S]{0,200}data-theme|document\.documentElement/);
  });
});
