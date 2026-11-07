/**
 * T-526b - the fixes found by rendering the POS shell: touch size and contrast, the offline band, the "needs the internet once" rule, the phone layout,
 * and staff wording on the placeholder cards. Source-level promises are read from the files (the shell is a client component with no DOM here), the
 * pure parts are called. The landing (P0) is in t526-landing.test.ts and integration/t526b-tablet-landing.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialPosState, pollPosState, reducePosState } from '@/app/pos/_shell/pos-state';
import { localHHMM, posOfflineBandText, showNeedsInternetOnce } from '@/app/pos/_shell/offline-band';
import { statusPillShort } from '@/app/pos/_shell/status-pill';
import { POS_SIGN_IN_BUTTON, POS_TOUCH } from '@/app/pos/_shell/touch';
import { SlicePlaceholder } from '@/app/pos/_shell/SlicePlaceholder';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const src = (p: string) => readFileSync(resolve(root, p), 'utf8');
const css = src('app/globals.css').replace(/\/\*[\s\S]*?\*\//g, '');

function luminance(hex: string): number {
  const c = (n: number) => ((n /= 255) <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
  const v = (i: number) => c(Number.parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * v(1) + 0.7152 * v(3) + 0.0722 * v(5);
}
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const token = (block: RegExp, name: string) => css.match(block)?.[1]?.match(new RegExp(`(?<![\\w-])${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1] as string;
const LIGHT = /:root\s*\{([\s\S]*?)\}/;
const DARK = /:root\[data-theme='dark'\]\s*\{([\s\S]*?)\}/;

describe('T-526b item 2 - touch size and contrast', () => {
  it('every keypad key is 3rem tall and wide (min-h-12 min-w-12) and opts out of the dialog compact-control rule', () => {
    const keypad = src('app/pos/_shell/Keypad.tsx');
    expect(POS_TOUCH).toBe('min-h-12 min-w-12');
    expect(keypad).toMatch(/const KEY = '[^']*\bmin-h-12\b[^']*\bmin-w-12\b/);
    const buttons = keypad.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons.length).toBe(4); // 9 digits via map + Clear + 0 + Del
    for (const b of buttons) expect(b, b).toContain('data-erp-size="free"');
  });

  it('the global compact rule (32 px) no longer reaches a control that says data-erp-size="free", whether it is a kit Button or a plain button', () => {
    expect(css).toContain('[data-erp-control="single"]:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([data-erp-size="free"])');
    expect(css).toContain('button:not(.erp-help-tip):not(.erp-icon-btn):not([data-erp-size="free"])');
  });

  it('the switch dialog Sign in uses the POS button classes and the free-size opt-out', () => {
    const dialog = src('app/pos/_shell/SwitchCashierDialog.tsx');
    expect(dialog).toMatch(/<Button[^>]*className=\{POS_SIGN_IN_BUTTON\}[^>]*data-erp-size="free"/);
    expect(POS_SIGN_IN_BUTTON).toContain('min-h-12');
    expect(dialog).toContain('Enter your Employee ID and PIN first.');
  });

  it('disabled Sign in is a flat surface-border fill with muted text, both tokens: at least 4.5:1 in light AND dark (it was white on 50% red, about 2:1), and the fill sits closer to the canvas than the brand fill (T-527 Addendum fix 1)', () => {
    expect(POS_SIGN_IN_BUTTON).toContain('disabled:!opacity-100');
    expect(POS_SIGN_IN_BUTTON).toContain('disabled:!bg-surface-border');
    expect(POS_SIGN_IN_BUTTON).toContain('disabled:!text-muted');
    for (const [name, block] of [['light', LIGHT], ['dark', DARK]] as const) {
      expect(contrast(token(block, '--muted'), token(block, '--surface-border')), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(block, '--surface-border'), token(block, '--canvas')), name).toBeLessThan(contrast(token(block, '--brand'), token(block, '--canvas')));
    }
    // control: the kit's own disabled style (opacity-50 on the brand fill) is the one that fails, which is why it is scoped here and not changed in the kit.
    const kit = src('components/ui/Button.tsx');
    expect(kit).toContain('disabled:opacity-50');
  });
});

describe('T-526b item 3 - the offline band', () => {
  it('says what still works and when the internet went (local HH:MM of the first failed poll)', () => {
    const at = new Date(2026, 10, 7, 15, 51).getTime();
    expect(localHHMM(at)).toBe('15:51');
    expect(localHHMM(new Date(2026, 10, 7, 9, 5).getTime())).toBe('09:05');
    expect(posOfflineBandText(at)).toBe(
      'No internet since 15:51. Keep selling: cash, and GCash/Maya with the reference (marked to check). Card, refunds and day close wait for the internet.',
    );
  });

  it('the time is the FIRST failure of the streak, not the one that flipped the pill, and an answer clears it', async () => {
    const fail = (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch;
    const deps = (t: number) => ({ fetch: fail, storeId: 'S', visibilityState: () => 'visible' as const, nowMs: () => t });
    const one = await pollPosState(deps(1000), initialPosState);
    expect(one.online).toBe(true);
    expect(one.failingSinceMs).toBe(1000);
    const two = await pollPosState(deps(4000), one);
    expect(two.online).toBe(false);
    expect(two.failingSinceMs).toBe(1000);
    const back = reducePosState(two, { type: 'not_modified' });
    expect(back.online).toBe(true);
    expect(back.failingSinceMs).toBeUndefined();
    expect(reducePosState(back, { type: 'failure', atMs: 9000 }).failingSinceMs).toBe(9000);
  });

  it('the shell draws the band full width under the top bar, only while offline, from that time', () => {
    const shell = src('app/pos/_shell/PosShell.tsx');
    const header = shell.indexOf('</header>');
    const band = shell.indexOf('posOfflineBandText(');
    const nav = shell.indexOf('<nav aria-label="POS sections"');
    expect(header).toBeGreaterThan(0);
    expect(band).toBeGreaterThan(header);
    expect(nav).toBeGreaterThan(band);
    expect(shell).toMatch(/\{offline \? \(\s*<div role="status" className="w-full bg-warning-soft[^"]*text-warning-ink"/);
    expect(shell).toContain('state.failingSinceMs');
  });

  it('the "needs the internet once" banner shows ONLY with no usable snapshot: never beside a good one, online or offline', () => {
    const paired = { paired: true, unpaired: false };
    expect(showNeedsInternetOnce({ ...paired, snapshotUsable: false })).toBe(true); // no usable snapshot: the one case
    expect(showNeedsInternetOnce({ ...paired, snapshotUsable: true })).toBe(false); // a good snapshot, whether the tablet is online or offline
    expect(showNeedsInternetOnce({ ...paired, snapshotUsable: null })).toBe(false); // first refresh not finished yet
    expect(showNeedsInternetOnce({ paired: false, unpaired: false, snapshotUsable: false })).toBe(false); // phone or kitchen browser
    expect(showNeedsInternetOnce({ paired: true, unpaired: true, snapshotUsable: false })).toBe(false); // un-paired has its own message
  });

  it('the hook and the shell use that one rule (no second condition)', () => {
    expect(src('app/pos/_shell/use-device-sync.ts')).toContain('needsInternet: showNeedsInternetOnce({ paired, snapshotUsable: usable, unpaired })');
    expect(src('app/pos/_shell/PosShell.tsx')).toContain('{sync.needsInternet ? <Banner tone="warning">{POS_NEEDS_INTERNET_ONCE}</Banner> : null}');
  });
});

describe('T-526b item 4 - phone width (below sm)', () => {
  const shell = src('app/pos/_shell/PosShell.tsx');
  const nav = shell.match(/const NAV = '([^']*)'/)?.[1] ?? '';
  const tab = shell.match(/const TAB = '([^']*)'/)?.[1] ?? '';

  it('the tab strip is a fixed bottom bar below sm, and today\'s strip from sm up', () => {
    for (const c of ['fixed', 'inset-x-0', 'bottom-0', 'sm:static', 'sm:overflow-x-auto', 'sm:border-b', 'pb-[env(safe-area-inset-bottom)]']) expect(nav, c).toContain(c);
  });
  it('every tab has the same width on the phone, a visible label, and is at least 3rem tall', () => {
    for (const c of ['min-h-12', 'flex-1', 'min-w-0', 'sm:flex-none']) expect(tab, c).toContain(c);
    expect(tab).not.toMatch(/\bhidden\b/);
  });
  it('the page leaves room for the bar on the phone only', () => {
    expect(shell).toContain('pb-24 sm:pb-4');
  });
  it('the top bar is one row: no wrapping, a short pill on the phone, the long one from sm', () => {
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    expect(header).not.toContain('flex-wrap');
    expect(header).toContain('label={pillShort} className="sm:hidden"');
    expect(header).toContain('label={pill} className="hidden sm:inline-flex"');
    expect(statusPillShort({ online: false, sending: false, pending: 14, offlineForMs: 12 * 60_000 })).toBe('Offline 12m');
    expect(statusPillShort({ online: true, sending: false, pending: 0, offlineForMs: 0 })).toBe('Online');
  });
  it('the avatar is a button below sm, and its menu holds Switch cashier and the ERP button', () => {
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    const phone = header.slice(header.indexOf('relative sm:hidden'));
    expect(phone).toContain('aria-controls={menuId}');
    expect(phone).not.toMatch(/role="menu(item)?"|aria-haspopup/); // a plain disclosure, not an ARIA menu
    expect(phone).toContain('aria-expanded={menuOpen}');
    expect(phone).toContain('Switch cashier');
    expect(phone).toMatch(/\{showErp \?[\s\S]*ERP/);
    // the tablet block keeps Switch cashier and ERP in the bar from sm up
    const tablet = header.slice(header.indexOf('hidden items-center gap-3 sm:flex'), header.indexOf('relative sm:hidden'));
    expect(tablet).toContain('Switch cashier');
    expect(tablet).toContain('ERP');
  });
});

describe('T-526b item 5 - placeholder cards speak staff words', () => {
  it.each([
    ['Orders', 'Orders are coming in the next update.'],
    ['Kitchen', 'Kitchen is coming in the next update.'],
    ['Refills', 'Refills are coming in the next update.'],
    ['Receipts', 'Receipts are coming in the next update.'],
    ['Till', 'Till is coming in the next update.'],
  ])('%s', (title, message) => {
    const html = renderToStaticMarkup(createElement(SlicePlaceholder, { title, message }));
    expect(html).toContain(message);
    expect(html).not.toMatch(/T-\d{3}|slice|frame|built in/i);
  });

  it('each page passes its own sentence and no page names a task number', () => {
    // T-527: the Orders page is the real screen now (no placeholder sentence); it must still name no task number.
    expect(src('app/pos/page.tsx').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/slice=|T-5\d\d/);
    for (const [file, msg] of [['kitchen/page', 'Kitchen is'], ['refills/page', 'Refills are'], ['receipts/page', 'Receipts are'], ['till/page', 'Till is']] as const) {
      const page = src(`app/pos/${file}.tsx`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(page, file).toContain(`message="${msg} coming in the next update."`);
      expect(page, file).not.toMatch(/slice=|T-5\d\d/);
    }
  });
});
