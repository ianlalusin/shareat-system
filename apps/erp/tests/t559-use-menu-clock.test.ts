// @vitest-environment happy-dom
/**
 * T-559 audit F2 (t559-initial-menu-clock-stale) - the hook, rendered. The hours arrive AFTER the shell mounted: `startClock` only arms a future
 * timer, so the hook must catch `at` up to now itself, or the picker keeps showing the lunch price after 17:00 until the next boundary.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMenuClock } from '@/app/pos/_shell/use-menu-clock';
import type { DaypartHours } from '@/lib/pos-device/daypart-client';
import { DAYPARTED_MENU, manila } from './helpers/t559-menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let seen = 0;
function Probe({ hours }: { hours: DaypartHours | undefined }) {
  seen = useMenuClock(hours, null);
  return null;
}
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('useMenuClock', () => {
  it('mounted at 16:59:59 with no hours; hours arrive at 17:00:01: the hook returns the new time, not the mount time', async () => {
    const mount = manila('16:59').getTime() + 59_000;
    vi.setSystemTime(mount);
    await act(async () => root.render(createElement(Probe, { hours: undefined })));
    expect(seen).toBe(mount);
    const later = manila('17:00').getTime() + 1_000;
    vi.setSystemTime(later);
    await act(async () => root.render(createElement(Probe, { hours: DAYPARTED_MENU.hours })));
    expect(seen).toBeGreaterThanOrEqual(later);
  });
});
