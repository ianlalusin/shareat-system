// @vitest-environment happy-dom
/**
 * T-529 follow-up - the Kitchen and Refills tab CONTAINERS rendered for real in happy-dom, with the Server Actions replaced by fakes:
 *   Kitchen: a served line leaves at once and comes back with the domain's sentence on a refusal; an alreadyServed line stays gone with no error; a failed
 *     line of All out comes back; a double tap sends ONE request; the Served button names its table; two take-out cards are labelled apart.
 *   Refills: a send that fails on the network and is sent again carries the SAME line ids both times (so the server writes one refill); a cart change or a
 *     success starts new ids; a table holding two packages offers the meats of both.
 */
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { id, MENU, minutesAgo, STORE, ticket, VAR } from './helpers/t529-fixtures';

const ACT = vi.hoisted(() => ({
  serveLine: vi.fn(),
  serveAll: vi.fn(),
  requestRefill: vi.fn(),
  confirmHeads: vi.fn(),
}));
vi.mock('../src/app/pos/kitchen/actions', () => ({ serveLineAction: (...a: unknown[]) => ACT.serveLine(...a), serveAllAction: (...a: unknown[]) => ACT.serveAll(...a) }));
vi.mock('../src/app/pos/refills/actions', () => ({ requestRefillAction: (...a: unknown[]) => ACT.requestRefill(...a), confirmHeadsAction: (...a: unknown[]) => ACT.confirmHeads(...a) }));

import { Kitchen } from '../src/app/pos/_kitchen/Kitchen';
import { Refills } from '../src/app/pos/_refills/Refills';
import { PosContext, type PosContextValue } from '../src/app/pos/_shell/pos-context';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  for (const f of Object.values(ACT)) f.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const ctx = (o: Partial<PosContextValue>): PosContextValue => ({
  storeId: STORE, paired: false, personId: id(1), offlineActorPersonId: null, online: true, openStands: null, kitchenQueue: [], refillQueue: [], refillTables: [],
  held: new Set<string>(), stateVersion: 1, pendingEvents: [], ordersSnapshot: { stands: [], menu: MENU }, bodiesRef: { current: {} }, requestDrain: () => undefined, setResultsHandler: () => undefined, ...o,
});
const show = (value: PosContextValue, el: unknown) => act(async () => root.render(createElement(PosContext.Provider, { value }, el as never)));
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const li = (lineId: string) => host.querySelector(`[data-line="${lineId}"]`);
const served = (lineId: string) => li(lineId)?.querySelector('button') as HTMLButtonElement;
const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? '';
const defer = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const A = id(7001), B = id(7002), C = id(7003);
const T1 = ticket({ sessionId: A, standNumber: 7, name: 'Pork belly', qty: 2, addedAtDevice: minutesAgo(9) });
const T2 = ticket({ sessionId: A, standNumber: 7, name: 'Beef brisket', qty: 1, addedAtDevice: minutesAgo(8) });
const kitchen = (tickets = [T1, T2]) => ctx({ kitchenQueue: tickets, held: new Set(['serve_pos_ticket']) });

describe('Kitchen', () => {
  it('a served line leaves its card AT ONCE; a refusal brings it back with the domain\'s sentence', async () => {
    const d = defer<{ ok: false; error: string }>();
    ACT.serveLine.mockReturnValue(d.promise);
    await show(kitchen(), createElement(Kitchen));
    await click(served(T1.lineId));
    expect(li(T1.lineId)).toBeNull(); // optimistic: gone before the server answered
    expect(li(T2.lineId)).not.toBeNull();
    expect(ACT.serveLine).toHaveBeenCalledWith({ storeId: STORE, lineId: T1.lineId });
    await act(async () => d.resolve({ ok: false, error: 'That line was cancelled.' }));
    await flush();
    expect(li(T1.lineId)).not.toBeNull(); // the refusal put it back
    expect(alertText()).toContain('Pork belly');
    expect(alertText()).toContain('That line was cancelled.');
  });

  it('a network failure brings the line back and says so', async () => {
    ACT.serveLine.mockRejectedValue(new Error('Failed to fetch'));
    await show(kitchen(), createElement(Kitchen));
    await click(served(T1.lineId));
    await flush();
    expect(li(T1.lineId)).not.toBeNull();
    expect(alertText()).toContain('Check the internet');
  });

  it('a served line stays gone when the server says ok, and a line served elsewhere (alreadyServed) stays gone with NO error', async () => {
    ACT.serveAll.mockResolvedValue({ ok: true, saved: [T1.lineId], alreadyServed: [T2.lineId], failed: [] });
    await show(kitchen(), createElement(Kitchen));
    const allOut = [...host.querySelectorAll('button')].find((b) => /All out/.test(b.textContent ?? ''))!;
    await click(allOut);
    await flush();
    expect(li(T1.lineId)).toBeNull();
    expect(li(T2.lineId)).toBeNull();
    expect(alertText()).toBe('');
    expect(ACT.serveAll).toHaveBeenCalledWith({ storeId: STORE, lineIds: [T1.lineId, T2.lineId] });
  });

  it('All out with one refused line brings back only that line and names it', async () => {
    ACT.serveAll.mockResolvedValue({ ok: false, saved: [T1.lineId], alreadyServed: [], failed: [{ lineId: T2.lineId, error: 'That line was cancelled.' }] });
    await show(kitchen(), createElement(Kitchen));
    await click([...host.querySelectorAll('button')].find((b) => /All out/.test(b.textContent ?? ''))!);
    await flush();
    expect(li(T1.lineId)).toBeNull();
    expect(li(T2.lineId)).not.toBeNull();
    expect(alertText()).toContain('Beef brisket');
    expect(alertText()).toContain('That line was cancelled.');
  });

  it('a double tap sends ONE request (Served twice, All out twice, Served then All out over the same line)', async () => {
    const d = defer<{ ok: true; wrote: true }>();
    ACT.serveLine.mockReturnValue(d.promise);
    ACT.serveAll.mockReturnValue(new Promise(() => undefined));
    await show(kitchen(), createElement(Kitchen));
    const btn = served(T1.lineId);
    await act(async () => {
      btn.click();
      btn.click();
    });
    expect(ACT.serveLine).toHaveBeenCalledTimes(1);
    const allOut = [...host.querySelectorAll('button')].find((b) => /All out/.test(b.textContent ?? ''))!;
    await act(async () => {
      allOut.click(); // T1 is still in flight: only T2 goes
    });
    expect(ACT.serveAll).toHaveBeenCalledTimes(1);
    expect(ACT.serveAll).toHaveBeenCalledWith({ storeId: STORE, lineIds: [T2.lineId] });
    await act(async () => {
      allOut.click();
      allOut.click();
    });
    expect(ACT.serveAll).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ ok: true, wrote: true }));
  });

  it('read-only without serve_pos_ticket: no button at all', async () => {
    await show(ctx({ kitchenQueue: [T1], held: new Set() }), createElement(Kitchen));
    expect(host.querySelectorAll('button:not([aria-pressed])')).toHaveLength(0);
  });

  it('the Served button names its table, and two take-out cards carry different labels', async () => {
    const o1 = ticket({ sessionId: id(7101), standNumber: null, sessionMode: 'take_out', name: 'Kimchi', addedAtDevice: minutesAgo(3) });
    const o2 = ticket({ sessionId: id(7102), standNumber: null, sessionMode: 'take_out', name: 'Cheese corn', addedAtDevice: minutesAgo(2) });
    await show(kitchen([T1, o1, o2]), createElement(Kitchen));
    expect(served(T1.lineId).getAttribute('aria-label')).toBe('Served: 2 × Pork belly, stand 7');
    expect(served(o1.lineId).getAttribute('aria-label')).toMatch(/^Served: 1 × Kimchi, take-out [0-9A-F]{4}$/);
    const labels = [...host.querySelectorAll('section[data-session]')].map((s) => s.getAttribute('aria-label'));
    expect(labels[0]).toBe('Stand 7');
    expect(labels[1]).toMatch(/^Take-out, ticket [0-9A-F]{4}$/);
    expect(labels[2]).toMatch(/^Take-out, ticket [0-9A-F]{4}$/);
    expect(labels[1]).not.toBe(labels[2]);
  });
});

describe('Refills', () => {
  const TABLE = { sessionId: id(7201), standNumber: 7, mode: 'dine_in', packageVariantId: VAR.unli, headsCashier: 2, headsServer: null };
  const phone = (tables: unknown[] = [TABLE]) => ctx({ refillTables: tables, held: new Set(['request_pos_refill']) });
  const byLabel = (label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
  const send = () => [...host.querySelectorAll('button')].find((b) => /^Send refill/.test(b.textContent ?? ''))!;
  const ids = (call: number) => (ACT.requestRefill.mock.calls[call]![0] as { lines: { lineId: string }[] }).lines.map((l) => l.lineId);

  it('a send that fails on the network and is sent again carries the SAME line ids; after a success a new request gets new ids', async () => {
    ACT.requestRefill.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue({ ok: true, wrote: true });
    await show(phone(), createElement(Refills));
    await click(byLabel('Stand 7'));
    await click(byLabel('More Pork belly'));
    await click(byLabel('More Pork belly'));
    await click(byLabel('More Chicken bulgogi'));
    await click(send());
    await flush();
    expect(alertText()).toContain('Check the internet');
    await click(send());
    await flush();
    expect(ACT.requestRefill).toHaveBeenCalledTimes(2);
    expect(ids(0)).toHaveLength(2);
    expect(ids(1)).toEqual(ids(0)); // one set of lines on the server
    // a lost answer that did arrive at the server and then the person asks for the same meats again: a NEW request, new ids
    await click(byLabel('More Pork belly'));
    await click(send());
    await flush();
    expect(ACT.requestRefill).toHaveBeenCalledTimes(3);
    expect(ids(2).some((x) => ids(0).includes(x))).toBe(false);
  });

  it('changing the cart between the failure and the resend starts new ids (the resend is a different request)', async () => {
    ACT.requestRefill.mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue({ ok: true, wrote: true });
    await show(phone(), createElement(Refills));
    await click(byLabel('Stand 7'));
    await click(byLabel('More Pork belly'));
    await click(send());
    await flush();
    await click(byLabel('More Pork belly'));
    await click(send());
    await flush();
    expect(ids(1).some((x) => ids(0).includes(x))).toBe(false);
  });

  it('a refusal from the server is shown as its sentence', async () => {
    ACT.requestRefill.mockResolvedValue({ ok: false, error: "Pork belly is not a refill of this table's package." });
    await show(phone(), createElement(Refills));
    await click(byLabel('Stand 7'));
    await click(byLabel('More Pork belly'));
    await click(send());
    await flush();
    expect(alertText()).toContain("not a refill of this table's package");
  });

  it('a table holding two packages offers the meats of BOTH, a shared meat once', async () => {
    await show(phone([{ ...TABLE, packageVariantIds: [VAR.unli, VAR.premium] }]), createElement(Refills));
    await click(byLabel('Stand 7'));
    const names = [...host.querySelectorAll('ul[aria-label^="Meats for"] li > span:first-child')].map((s) => s.textContent).sort();
    expect(names).toEqual(['Beef brisket', 'Chicken bulgogi', 'Lettuce', 'Pork belly']);
  });

  it('with one package only that package\'s meats show', async () => {
    await show(phone(), createElement(Refills));
    await click(byLabel('Stand 7'));
    const names = [...host.querySelectorAll('ul[aria-label^="Meats for"] li > span:first-child')].map((s) => s.textContent).sort();
    expect(names).toEqual(['Beef brisket', 'Chicken bulgogi', 'Pork belly']);
  });
});
