// @vitest-environment happy-dom
/**
 * T-539 S3 - the Orders tile's time bar reads its warning minutes from the snapshot rule (OrdersView prop `warnMinutes`), not from a constant.
 * With the rule at 30 the line turns red (class text-danger) at 31 minutes seated and not at 29; with no rule it never turns red.
 */
import { createElement, act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDS, id } from './helpers/t527-menu';

vi.mock('next/link', () => ({ default: ({ href, children, ...r }: { href: string; children: ReactNode }) => createElement('a', { href, ...r }, children) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/pos', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

import { OrdersView } from '@/app/pos/_orders/OrdersView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const OPENED = '2026-11-07T09:00:00.000Z';
const tile = { sessionId: id(600), standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 4, headsServer: null, openedAtDevice: OPENED, packageName: null, needsHeads: false, headsMismatch: false, pending: false };

/** Renders one tile `minutes` after it was seated and returns its "Seated ..." line. */
async function seatedLine(minutes: number, warnMinutes: number | null | undefined): Promise<Element> {
  await act(async () => {
    root.render(
      createElement(OrdersView, {
        readOnly: false, tiles: [tile] as never, sessions: { [tile.sessionId]: { headsCashier: 4, headsServer: null, loaded: true, lines: [] } } as never, selectedSessionId: null,
        nowMs: Date.parse(OPENED) + minutes * 60_000, ...(warnMinutes === undefined ? {} : { warnMinutes }),
        onSeat: () => undefined, onTakeOut: () => undefined, onSelect: () => undefined, onHeads: () => undefined, onAddItems: () => undefined, onCancelLine: () => undefined,
      }),
    );
  });
  return [...host.querySelectorAll('li p')].find((p) => /^Seated/.test(p.textContent ?? ''))!;
}
const red = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).includes('text-danger');

describe('T-539 S3 - the tile turns red by the snapshot rule', () => {
  it('rule 30: 29 minutes is not red, 31 minutes is red and says "over 30m" [kills: a constant 90 minutes]', async () => {
    const at29 = await seatedLine(29, 30);
    expect(red(at29)).toBe(false);
    const at31 = await seatedLine(31, 30);
    expect(red(at31)).toBe(true);
    expect(at31.textContent).toMatch(/over 30m/);
  });

  it('rule 90: 80 minutes is not red; the same 80 minutes is red under rule 60 [kills: the rule ignored]', async () => {
    expect(red(await seatedLine(80, 90))).toBe(false);
    expect(red(await seatedLine(80, 60))).toBe(true);
  });

  it('no rule (null or absent): a table seated 10 hours is not red [kills: a hidden fallback constant]', async () => {
    expect(red(await seatedLine(600, null))).toBe(false);
    expect(red(await seatedLine(600, undefined))).toBe(false);
  });
});
