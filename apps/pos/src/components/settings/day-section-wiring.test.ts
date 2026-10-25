/**
 * T-471 slice T - the Settings "Day" section is wired (Ruling 8): Settings page renders it; it has the two buttons; Z goes through the POS v2 server with the
 * tablet's unsent count and a fresh request id; X is a read (GET) with no PIN; the slips print through the same path as the X-slip; no new route.
 *
 * CONTRACT: `@/components/settings/DaySection` exports `DaySection`; `@/lib/pos2/zReadingClient` exports `closeDay` and `readX` (it owns the fetches).
 * RED FOR THE RIGHT REASON: the component and the client do not exist yet - each case fails on the missing file.
 * MUTANTS: M1 section not rendered; M2 Z called without unsentCount; M3 X asks for a PIN or posts; M4 Z called through GET; M5 a new route page added.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('Settings -> Day section', () => {
  it('the Settings page imports and renders DaySection', () => {
    const page = read('../../app/settings/page.tsx');
    expect(page).toMatch(/import \{ DaySection \} from ["']@\/components\/settings\/DaySection["']/);
    expect(page).toMatch(/<DaySection\s*\/>/);
  });
  it('has the two buttons, a PIN pad for Z only, the last Z number, and prints through the same path as the X-slip', () => {
    const src = read('./DaySection.tsx');
    expect(src).toContain('Print X-reading');
    expect(src).toContain('Close the day (Z)');
    expect(src).toMatch(/PinPad/);
    expect(src).toMatch(/Last Z/);
    expect(src).toMatch(/formatZSlip/);
    expect(src).toMatch(/printXSlipText/);
    expect(src).toMatch(/paperWidthFor/);
    expect(src).toMatch(/unsentCount/);
  });
  it('the client: Z is a POST to z-readings carrying unsentCount and a request id; X is a GET to x-reading with no PIN', () => {
    const src = read('../../lib/pos2/zReadingClient.ts');
    expect(src).toMatch(/postPos2[^\n]*["']z-readings["']/);
    expect(src).toMatch(/unsentCount/);
    expect(src).toMatch(/requestId/);
    expect(src).toMatch(/x-reading\?storeId=/);
    expect(src).toMatch(/method:\s*["']GET["']/);
    const xPart = src.slice(src.indexOf('readX'));
    expect(xPart).not.toMatch(/\bpin\b/i);
  });
  it('adds no new page route (Ruling 8)', () => {
    for (const p of ['day', 'z-reading', 'z-readings', 'x-reading', 'close-day']) expect(existsSync(new URL(`../../app/${p}/page.tsx`, import.meta.url)), p).toBe(false);
  });
});
