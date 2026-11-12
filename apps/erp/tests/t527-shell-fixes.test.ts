/**
 * T-527 (TESTER) - the Addendum's two fixes from the T-526 renders (round 2), docs/tasks/527-pos-orders-screen.md:
 *   1. The disabled "Sign in" in the switch-cashier dialog must LOOK disabled: a muted fill that is lower in contrast to the canvas than the enabled button,
 *      text at 4.5:1 or better on that fill, aria-disabled, and cursor not-allowed.
 *   2. The offline pill shows the elapsed time at every width: at 390 px it reads "Offline 12m", never "Offline". The pending count drops first.
 *
 * ASSUMED API: statusPillShort() in apps/erp/src/app/pos/_shell/status-pill.ts takes `offlineForMs` too (same field statusPillLabel already takes).
 * The sign-in colours are read from POS_SIGN_IN_BUTTON (`disabled:!bg-<token>` / `disabled:!text-<token>`) and resolved in apps/erp/src/app/globals.css.
 *
 * NOTE FOR THE BUILDER: t526b-shell-fixes.test.ts still pins the OLD answers (`disabled:!bg-muted` + `disabled:!text-canvas`, and `statusPillShort({.., pending: 14})` = "Offline · 14").
 * Those two cases are superseded by this file and must be updated with the change; they are not edited here.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { statusPillShort } from '@/app/pos/_shell/status-pill';
import { POS_SIGN_IN_BUTTON } from '@/app/pos/_shell/touch';

vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = readFileSync(resolve(root, 'app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const LIGHT = /:root\s*\{([\s\S]*?)\}/;
const DARK = /:root\[data-theme='dark'\]\s*\{([\s\S]*?)\}/;
const token = (block: RegExp, name: string): string => {
  const hex = css.match(block)?.[1]?.match(new RegExp(`(?<![\\w-])--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  if (!hex) throw new Error(`token --${name} is not a plain #rrggbb in that theme block`);
  return hex;
};
function luminance(hex: string): number {
  const c = (n: number) => ((n /= 255) <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  const v = (i: number) => c(Number.parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * v(1) + 0.7152 * v(3) + 0.0722 * v(5);
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);

describe('Addendum fix 1 - the disabled Sign in looks disabled', () => {
  const fill = POS_SIGN_IN_BUTTON.match(/disabled:!bg-([a-z-]+)/)?.[1];
  const text = POS_SIGN_IN_BUTTON.match(/disabled:!text-([a-z-]+)/)?.[1];

  it('names a fill and a text token, keeps the not-allowed cursor and the 3rem touch size', () => {
    expect(fill, 'a disabled:!bg-<token> class').toBeTruthy();
    expect(text, 'a disabled:!text-<token> class').toBeTruthy();
    expect(POS_SIGN_IN_BUTTON).toContain('disabled:cursor-not-allowed');
    expect(POS_SIGN_IN_BUTTON).toContain('min-h-12');
  });

  for (const [name, block] of [['light', LIGHT], ['dark', DARK]] as const) {
    it(`${name}: the text is at least 4.5:1 on the fill, and the fill sits CLOSER to the canvas than the enabled (brand) button does`, () => {
      const f = token(block, fill ?? 'missing');
      const t = token(block, text ?? 'missing');
      expect(contrast(t, f), `text --${text} on fill --${fill}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(f, token(block, 'canvas')), `fill --${fill} must be lower contrast to the canvas than --brand`).toBeLessThan(contrast(token(block, 'brand'), token(block, 'canvas')));
    });
  }

  it('the rendered Sign in carries aria-disabled="true" until the Employee ID and PIN are in', async () => {
    const { SwitchCashierDialog } = await import('@/app/pos/_shell/SwitchCashierDialog');
    const html = renderToStaticMarkup(createElement(SwitchCashierDialog, { open: false, onClose: () => undefined, onSwitched: () => undefined }));
    const button = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => (m[2] ?? '').replace(/<[^>]*>/g, '').trim() === 'Sign in');
    expect(button, 'the Sign in button').toBeTruthy();
    expect(button![1]).toContain('aria-disabled="true"');
    expect(button![1]).toContain('cursor-not-allowed');
  });
});

describe('Addendum fix 2 - the short offline pill keeps the elapsed time', () => {
  const base = { online: false, sending: false, pending: 0 };

  it('reads "Offline 12m" at 12 minutes and "Offline 1h 12m" past the hour, never bare "Offline"', () => {
    expect(statusPillShort({ ...base, offlineForMs: 12 * 60_000 })).toBe('Offline 12m');
    expect(statusPillShort({ ...base, offlineForMs: 72 * 60_000 })).toBe('Offline 1h 12m');
    expect(statusPillShort({ ...base, offlineForMs: 0 })).toBe('Offline 0m');
  });

  it('with things waiting to send, the time is still first and always there (the count is what gives way)', () => {
    expect(statusPillShort({ ...base, pending: 14, offlineForMs: 12 * 60_000 })).toMatch(/^Offline 12m/);
  });

  it('the online and signed-out words do not change', () => {
    expect(statusPillShort({ online: true, sending: false, pending: 0, offlineForMs: 0 })).toBe('Online');
    expect(statusPillShort({ online: true, sending: true, pending: 3, offlineForMs: 0 })).toBe('Sending…');
    expect(statusPillShort({ online: true, sending: false, pending: 0, offlineForMs: 0, signedOut: true })).toBe('Signed out');
  });
});
