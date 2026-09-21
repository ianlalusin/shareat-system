/**
 * T-334 slice 1 — the theme preference cookie.
 *
 * ⛔ **The default is the whole point of this task.** ADR-013: v2 follows the OS into dark mode and
 * v1 never did. A viewer with no cookie must get LIGHT regardless of their operating system, and
 * that must be true in the FIRST server-rendered paint — so the value is resolved from a cookie on
 * the server, never from `prefers-color-scheme` and never in an effect.
 *
 * ⚠️ Mirrors `shell/sidebar-state.ts`'s shape deliberately (T-234): dependency-free, importable by
 * both a server file (`layout.tsx`, via `next/headers`) and a client file (the toggle, via
 * `document.cookie`), and far away from anything that could drag `@shareat/db` into a browser
 * bundle.
 */
import { describe, expect, it } from 'vitest';

import { THEME_COOKIE_NAME, parseTheme, type Theme } from '../src/components/shell/theme-state';

describe('T-334 slice 1 — parseTheme', () => {
  it('⭐ NO COOKIE resolves to light — the ruling, and the reason this task exists', () => {
    // Asserted as a LITERAL VALUE, not as "not dark": an assertion about an absence is satisfied
    // by every cause of it, including the module failing to export a default at all.
    expect(parseTheme(undefined)).toBe('light');
    expect(parseTheme(null)).toBe('light');
  });

  it('an explicit dark cookie resolves to dark — the positive control for the case above', () => {
    // ⭐ This and the test above are each other's control. If `parseTheme` returned a constant,
    // exactly one of the two would fail.
    expect(parseTheme('dark')).toBe('dark');
  });

  it('an explicit light cookie resolves to light', () => {
    expect(parseTheme('light')).toBe('light');
  });

  it('⛔ junk degrades to LIGHT, never to dark and never by throwing', () => {
    // A hand-edited or corrupted cookie must fail toward the default, not toward the mode the
    // ruling exists to stop happening by accident.
    for (const raw of ['', 'DARK', 'Dark', 'true', '1', 'auto', 'system', 'light dark', '{}']) {
      expect(parseTheme(raw)).toBe('light');
    }
  });

  it('the cookie name is namespaced like the sidebar’s', () => {
    // ⚠️ No TTL assertion here on purpose: THEME_COOKIE_MAX_AGE ships with the toggle slice, which
    // has its only consumer. Slice 1 READS the cookie and never writes it.
    expect(THEME_COOKIE_NAME).toBe('shareat_theme');
  });

  it('Theme is exactly the two values — no auto, no system', () => {
    // ⛔ `auto` would reintroduce OS-following through the back door, which is the defect.
    const all: Theme[] = ['light', 'dark'];
    for (const t of all) expect(parseTheme(t)).toBe(t);
  });
});
