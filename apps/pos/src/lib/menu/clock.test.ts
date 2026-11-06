// @vitest-environment happy-dom
/**
 * T-510 S4b - the menu clock and the hook that uses it. Fake timers only; every instant is fixed. Manila (UTC+8), Sunday 2026-11-01.
 * The tablet sits on one cached menu: at 17:00 the package list must flip with NO new menu and NO network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { msUntilRecompute, startClock } from './clock';
import { daypartedMenu } from '@/test-helpers/menuFixture';

vi.mock('@/lib/firebase/client', () => ({ db: {}, auth: {} }));
vi.mock('@/lib/offline/browserDevice', () => ({ getBrowserDeviceId: () => 'dev' }));
vi.mock('@/hooks/useConnectivity', () => ({ getConnectivityStore: () => ({ getState: () => ({ online: false }), subscribe: () => () => {} }), useConnectivity: () => {} }));

const manila = (hhmm: string, date = '2026-11-01'): number => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, 0);
};
const menu = daypartedMenu();

describe('msUntilRecompute', () => {
  it('the next window boundary from the menu hours: 16:59:30 -> 30 s', () => {
    expect(msUntilRecompute(menu, null, manila('16:59') + 30_000)).toBe(30_000);
  });
  it('the earlier of the hours boundary and the cached nextChangeAt, whichever it is', () => {
    const at = manila('12:00');
    expect(msUntilRecompute(menu, new Date(at + 60_000).toISOString(), at)).toBe(60_000); // schedule sooner (X ends 14:00, L 17:00: next is 14:00)
    expect(msUntilRecompute(menu, new Date(at + 9 * 3_600_000).toISOString(), at)).toBe(2 * 3_600_000); // window sooner: X closes 14:00
  });
  it('only a positive delay arms: a past or equal nextChangeAt, garbage, or nothing ahead gives null', () => {
    const at = manila('12:00');
    const plain = { ...menu, hours: undefined };
    expect(msUntilRecompute(plain, new Date(at).toISOString(), at)).toBeNull();
    expect(msUntilRecompute(plain, new Date(at - 1000).toISOString(), at)).toBeNull();
    expect(msUntilRecompute(plain, 'not-a-date', at)).toBeNull();
    expect(msUntilRecompute(null, null, at)).toBeNull();
    // a past nextChangeAt does not hide the hours boundary
    expect(msUntilRecompute(menu, new Date(at - 1000).toISOString(), at)).toBe(2 * 3_600_000);
  });
  it('exactly on a boundary the NEXT one is awaited (strictly after now)', () => {
    expect(msUntilRecompute(menu, null, manila('17:00'))).toBe(15 * 3_600_000); // D ends 08:00 next day
  });
});

describe('startClock (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const only = { ...menu, hours: { ...menu.hours!, dayparts: menu.hours!.dayparts.filter((d) => d.id !== 'X') } }; // L 08-17, D 17-08

  it('ticks at the boundary, then re-arms for the next one', () => {
    vi.setSystemTime(manila('16:59'));
    const onTick = vi.fn();
    const stop = startClock({ menu: only, nextChangeAt: null, onTick, doc: null });
    vi.advanceTimersByTime(59_000);
    expect(onTick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15 * 3_600_000 - 1000); // up to 07:59:59... 08:00 is 15 h after 17:00
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onTick).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('ticks when the app returns to the front, not when it goes to the back', () => {
    const listeners = new Set<() => void>();
    const doc = { visibilityState: 'hidden' as DocumentVisibilityState, addEventListener: (_: string, l: () => void) => listeners.add(l), removeEventListener: (_: string, l: () => void) => listeners.delete(l) };
    vi.setSystemTime(manila('12:00'));
    const onTick = vi.fn();
    const stop = startClock({ menu: only, nextChangeAt: null, onTick, doc: doc as never });
    listeners.forEach((l) => l());
    expect(onTick).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    listeners.forEach((l) => l());
    expect(onTick).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners.size).toBe(0);
  });

  it('a menu with no hours and no schedule never arms a timer', () => {
    vi.setSystemTime(manila('12:00'));
    const onTick = vi.fn();
    const stop = startClock({ menu: { ...menu, hours: undefined }, nextChangeAt: null, onTick, doc: null });
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('a nextChangeAt far in the future is clamped, never fires at once', () => {
    vi.setSystemTime(manila('12:00'));
    const onTick = vi.fn();
    const stop = startClock({ menu: { ...menu, hours: undefined }, nextChangeAt: new Date(manila('12:00') + 40 * 86_400_000).toISOString(), onTick, doc: null });
    vi.advanceTimersByTime(1000);
    expect(onTick).not.toHaveBeenCalled();
    stop();
  });
});

describe('useAdaptedAt: the package list flips at 17:00 from one cached menu, no network', () => {
  let root: Root;
  let host: HTMLElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    host = document.createElement('div');
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

  it('Pork and Beef 338 at 16:59:30, 358 after 17:00; the lunch-only package moves to closedPackages', async () => {
    const { useAdaptedAt } = await import('./useErpMenu');
    vi.setSystemTime(manila('16:59') + 30_000);
    const seen: Array<{ pb: number | undefined; closed: string[] }> = [];
    const m = { ...menu, hours: { ...menu.hours!, dayparts: menu.hours!.dayparts.filter((d) => d.id !== 'X') } };
    const C = () => {
      const a = useAdaptedAt(true, m, null);
      seen.push({ pb: a?.packages.find((p) => p.packageId === 'dp-pb-v')?.pricePerHead, closed: a?.closedPackages.map((c) => c.packageId) ?? [] });
      return null;
    };
    act(() => root.render(createElement(C)));
    expect(seen.at(-1)).toEqual({ pb: 338, closed: [] });
    await act(async () => { vi.advanceTimersByTime(29_000); });
    expect(seen.at(-1)!.pb).toBe(338);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(seen.at(-1)).toEqual({ pb: 358, closed: ['dp-lo-v', 'dp-ov-v'] });
  });

  it('off (source firestore) -> null and no timer', async () => {
    const { useAdaptedAt } = await import('./useErpMenu');
    vi.setSystemTime(manila('12:00'));
    let value: unknown = 'unset';
    const C = () => { value = useAdaptedAt(false, menu, null); return null; };
    act(() => root.render(createElement(C)));
    expect(value).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
