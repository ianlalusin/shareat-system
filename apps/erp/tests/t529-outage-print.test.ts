/**
 * T-529 (TESTER) - R3 / R4 unit: the outage print (the paper backstop when the store tablet is offline). docs/tasks/529-pos-kitchen-refills.md R3.
 * No database, no DOM, no clock: the device store, the printer and the menu are injected.
 *
 * ASSUMED API (apps/erp/src/app/pos/_kitchen/outage-print.ts):
 *   nextKitchenTicketNo({ terminalNo: number; getMeta; setMeta }): Promise<string>
 *     reads meta `app.kitchenTicketSeq` (absent = 0), writes the next number back BEFORE returning, and returns `K-<terminalNo>-<seq>`: the first is 'K-2-1'.
 *     Calls that overlap each get their own number. A print reference only, never stored on the server.
 *   KITCHEN_TICKET_SEQ_KEY = 'app.kitchenTicketSeq'
 *   PRINT_FAILED_NOTE = 'Kitchen ticket did not print. Tap Reprint.'
 *   printOutageForEvent(deps: OutageDeps, event: { kind: string; payload: Record<string, unknown> }): Promise<OutageResult>
 *     OutageDeps = {
 *       online: boolean; menu: StoreMenuV2; stands: { id: string; number: number }[]; terminalNo: number;
 *       layout: PrintLayout (T-528a); copies: number; sentAtLocal: string (already formatted by the caller);
 *       tableLabels: Record<string, string | null>   the label of a table ALREADY open, by sessionId (a `lines.added` payload only carries the sessionId);
 *       printLines(lines: string[], o: { copies: number }): Promise<'printed' | 'fallback' | 'failed'>   (T-528 adapter);
 *       getMeta; setMeta }
 *     OutageResult = { printed: number; failed: PrintJob[]; message: string | null }       PrintJob = { lines: string[]; copies: number }
 *     - online -> prints NOTHING, touches no counter, { printed: 0, failed: [], message: null } (the kitchen screen is the source of truth).
 *     - offline AND kind 'stand.opened' | 'lines.added': groups the lines by the item's `stationId`, one KitchenTicketView per station whose `printOnOutage` is true
 *       (a line with no station, or a station with printOnOutage false, prints nothing), stations in menu order, each with its own ticket number from the counter.
 *       View = { stationName, tableLabel, ticketNo, sentAtLocal, items: { name, qty, note }[], offline: true }; the paper is formatKitchenTicket(view, layout); `copies` is passed on.
 *       tableLabel: stand.opened -> String(stand number from payload.standId) or null for take-out; lines.added -> deps.tableLabels[sessionId] ?? null.
 *     - offline AND kind 'refill.requested': ONE formatRefillSlip view { tableLabel, sentAtLocal, items: { name, qty }[], offline: true } (no counter use).
 *     - any other kind prints nothing.
 *     - a printer that returns 'failed' or THROWS never throws out of here: the job comes back in `failed` with message PRINT_FAILED_NOTE. 'fallback' counts as printed.
 *   reprintOutage(deps: Pick<OutageDeps, 'printLines'>, jobs: PrintJob[]): Promise<OutageResult>   prints the same lines again, consumes no ticket number.
 *
 * RED NOW FOR THE RIGHT REASON: the module does not exist (lazy import: "MISSING MODULE ... not built").
 */
import { describe, expect, it, vi } from 'vitest';
import { formatKitchenTicket, formatRefillSlip } from '@/lib/pos-print';
import { fakeMeta, id, IT, MENU, menuWithPrint, ST, VAR } from './helpers/t529-fixtures';

async function load(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any -- the module under test does not exist yet
  try {
    return await import(/* @vite-ignore */ `../src/app/pos/_kitchen/${'outage-print'}`);
  } catch (e) {
    throw new Error(`MISSING MODULE: apps/erp/src/app/pos/_kitchen/outage-print.ts cannot be loaded (T-529 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}

const LAYOUT = { width: 80, font: 'normal' } as const;
const SESSION = id(4001);
const STAND_ID = id(4002);
const AT = '2026-11-07T11:59:00.000Z';
let lineSeq = 4100;
const line = (menuItemId: string, qty: number, note?: string) => ({ lineId: id(++lineSeq), menuItemId, qty, addedAtDevice: AT, ...(note ? { note } : {}) });

function deps(o: { online?: boolean; menu?: typeof MENU; meta?: ReturnType<typeof fakeMeta>; print?: (lines: string[], o: { copies: number }) => Promise<string>; copies?: number } = {}) {
  const meta = o.meta ?? fakeMeta();
  const printLines = vi.fn(o.print ?? (async () => 'printed'));
  return {
    printLines, meta,
    d: {
      online: o.online ?? false, menu: o.menu ?? MENU, stands: [{ id: STAND_ID, number: 7 }], terminalNo: 2, layout: LAYOUT, copies: o.copies ?? 1,
      sentAtLocal: '19:59', tableLabels: { [SESSION]: '7' }, printLines, getMeta: meta.getMeta, setMeta: meta.setMeta,
    },
  };
}
const standOpened = (lines: ReturnType<typeof line>[], mode: 'dine_in' | 'take_out' = 'dine_in') => ({
  kind: 'stand.opened',
  payload: { sessionId: SESSION, mode, ...(mode === 'dine_in' ? { standId: STAND_ID } : {}), headsCashier: 2, openedAtDevice: AT, lines },
});
const linesAdded = (lines: ReturnType<typeof line>[]) => ({ kind: 'lines.added', payload: { sessionId: SESSION, lines } });

describe('the device ticket counter (app.kitchenTicketSeq)', () => {
  it('starts at 1 and counts up: K-<terminal>-<seq>', async () => {
    const { nextKitchenTicketNo } = await load();
    const m = fakeMeta();
    expect(await nextKitchenTicketNo({ terminalNo: 2, ...m })).toBe('K-2-1');
    expect(await nextKitchenTicketNo({ terminalNo: 2, ...m })).toBe('K-2-2');
    expect(await nextKitchenTicketNo({ terminalNo: 2, ...m })).toBe('K-2-3');
  });
  it('is written to the device store under the documented key', async () => {
    const { nextKitchenTicketNo, KITCHEN_TICKET_SEQ_KEY } = await load();
    const m = fakeMeta();
    await nextKitchenTicketNo({ terminalNo: 1, ...m });
    expect(KITCHEN_TICKET_SEQ_KEY).toBe('app.kitchenTicketSeq');
    expect(m.store.get('app.kitchenTicketSeq')).toBe(1);
  });
  it('never repeats across a reopen: a new session over the same store carries on, it does not restart', async () => {
    const m = fakeMeta();
    const first = await load();
    expect(await first.nextKitchenTicketNo({ terminalNo: 3, ...m })).toBe('K-3-1');
    expect(await first.nextKitchenTicketNo({ terminalNo: 3, ...m })).toBe('K-3-2');
    // the tablet is closed and reopened: only the persisted store is left
    const reopened = fakeMeta(Object.fromEntries(m.store));
    const second = await load();
    expect(await second.nextKitchenTicketNo({ terminalNo: 3, ...reopened })).toBe('K-3-3');
  });
  it('overlapping calls each get a different number', async () => {
    const { nextKitchenTicketNo } = await load();
    const m = fakeMeta();
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => nextKitchenTicketNo({ terminalNo: 2, ...m })));
    expect(new Set(all).size).toBe(5);
    expect([...all].sort()).toEqual(['K-2-1', 'K-2-2', 'K-2-3', 'K-2-4', 'K-2-5']);
  });
});

describe('while ONLINE nothing prints (the kitchen screen is the source of truth)', () => {
  it('stand.opened, lines.added and refill.requested online print nothing and use no ticket number', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines, meta } = deps({ online: true });
    for (const e of [standOpened([line(IT.pork, 2)]), linesAdded([line(IT.pork, 1)]), { kind: 'refill.requested', payload: { sessionId: SESSION, lines: [line(IT.rePork, 1)] } }]) {
      expect(await printOutageForEvent(d, e)).toEqual({ printed: 0, failed: [], message: null });
    }
    expect(printLines).not.toHaveBeenCalled();
    expect(meta.store.size).toBe(0);
  });
});

describe('OFFLINE: one kitchen ticket per station', () => {
  it('one station: the exact ticket view, formatted with the T-528a formatter, copies passed on', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps({ copies: 2 });
    const res = await printOutageForEvent(d, standOpened([line(IT.pork, 2, 'well done'), line(IT.brisket, 1)]));
    const expected = formatKitchenTicket(
      { stationName: 'Grill', tableLabel: '7', ticketNo: 'K-2-1', sentAtLocal: '19:59', items: [{ name: 'Pork belly', qty: 2, note: 'well done' }, { name: 'Beef brisket', qty: 1, note: null }], offline: true },
      LAYOUT,
    );
    expect(printLines).toHaveBeenCalledTimes(1);
    expect(printLines).toHaveBeenCalledWith(expected, { copies: 2 });
    expect(res).toEqual({ printed: 1, failed: [], message: null });
    expect(expected.join('\n')).toContain('OFFLINE');
  });
  it('two stations in one send: two tickets, each with only its own lines and its own number, in menu order', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    const res = await printOutageForEvent(d, linesAdded([line(IT.rice, 1), line(IT.pork, 3)]));
    // the menu lists Hot kitchen before Grill
    const hot = formatKitchenTicket({ stationName: 'Hot kitchen', tableLabel: '7', ticketNo: 'K-2-1', sentAtLocal: '19:59', items: [{ name: 'Kimchi fried rice', qty: 1, note: null }], offline: true }, LAYOUT);
    const grill = formatKitchenTicket({ stationName: 'Grill', tableLabel: '7', ticketNo: 'K-2-2', sentAtLocal: '19:59', items: [{ name: 'Pork belly', qty: 3, note: null }], offline: true }, LAYOUT);
    expect(printLines.mock.calls.map((c) => c[0])).toEqual([hot, grill]);
    expect(res.printed).toBe(2);
  });
  it('a station whose printOnOutage is false is skipped (Drinks), the others still print', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    await printOutageForEvent(d, linesAdded([line(IT.tea, 2), line(IT.pork, 1)]));
    expect(printLines).toHaveBeenCalledTimes(1);
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('GRILL');
    expect(printLines.mock.calls[0]![0].join('\n')).not.toContain('Iced tea');
  });
  it('turning printOnOutage on for Drinks and off for Grill swaps which one prints (the flag comes from the snapshot, not the code)', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps({ menu: menuWithPrint({ [ST.drinks]: true, [ST.grill]: false }) });
    await printOutageForEvent(d, linesAdded([line(IT.tea, 2), line(IT.pork, 1)]));
    expect(printLines).toHaveBeenCalledTimes(1);
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('DRINKS');
  });
  it('every station off: nothing prints and no number is used', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines, meta } = deps({ menu: menuWithPrint({ [ST.grill]: false, [ST.hot]: false, [ST.drinks]: false }) });
    expect(await printOutageForEvent(d, linesAdded([line(IT.pork, 1)]))).toEqual({ printed: 0, failed: [], message: null });
    expect(printLines).not.toHaveBeenCalled();
    expect(meta.store.size).toBe(0);
  });
  it('a dish with no kitchen station is NOT dropped: it prints on the catch-all ticket headed Kitchen (no station means no rule to skip it)', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    await printOutageForEvent(d, linesAdded([line(IT.starter, 1)]));
    expect(printLines).toHaveBeenCalledTimes(1);
    const expected = formatKitchenTicket({ stationName: 'Kitchen', tableLabel: '7', ticketNo: 'K-2-1', sentAtLocal: '19:59', items: [{ name: 'Starter set', qty: 1, note: null }], offline: true }, LAYOUT);
    expect(printLines).toHaveBeenCalledWith(expected, { copies: 1 });
    expect(expected.join('\n')).toContain('KITCHEN');
  });
  it('the catch-all prints even when every station has printOnOutage off, and goes after the station tickets', async () => {
    const { printOutageForEvent } = await load();
    const off = deps({ menu: menuWithPrint({ [ST.grill]: false, [ST.hot]: false, [ST.drinks]: false }) });
    await printOutageForEvent(off.d, linesAdded([line(IT.starter, 1), line(IT.pork, 1)]));
    expect(off.printLines).toHaveBeenCalledTimes(1);
    expect(off.printLines.mock.calls[0]![0].join('\n')).toContain('KITCHEN');
    expect(off.printLines.mock.calls[0]![0].join('\n')).not.toContain('Pork belly');
    const on = deps();
    await printOutageForEvent(on.d, linesAdded([line(IT.starter, 1), line(IT.pork, 1)]));
    expect(on.printLines.mock.calls.map((c) => (c[0].join('\n').match(/GRILL|KITCHEN/) ?? [])[0])).toEqual(['GRILL', 'KITCHEN']);
  });
  it('a station this tablet does not know, and an item its menu does not hold, both land on the catch-all (nothing is lost)', async () => {
    const { printOutageForEvent } = await load();
    const unknownStation = { ...MENU, items: MENU.items.map((i) => (i.id === IT.pork ? { ...i, stationId: id(9999) } : i)) };
    const a = deps({ menu: unknownStation });
    await printOutageForEvent(a.d, linesAdded([line(IT.pork, 2)]));
    expect(a.printLines.mock.calls[0]![0].join('\n')).toContain('KITCHEN');
    expect(a.printLines.mock.calls[0]![0].join('\n')).toContain('2 x Pork belly');
    const b = deps();
    await printOutageForEvent(b.d, linesAdded([{ ...line(IT.pork, 3), menuItemId: id(888888) }]));
    expect(b.printLines.mock.calls[0]![0].join('\n')).toContain('3 x Unknown item');
  });
  it('take-out: the ticket has no table label (the formatter prints TAKE-OUT)', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    await printOutageForEvent(d, standOpened([line(IT.pork, 1)], 'take_out'));
    const expected = formatKitchenTicket({ stationName: 'Grill', tableLabel: null, ticketNo: 'K-2-1', sentAtLocal: '19:59', items: [{ name: 'Pork belly', qty: 1, note: null }], offline: true }, LAYOUT);
    expect(printLines).toHaveBeenCalledWith(expected, { copies: 1 });
    expect(expected.join('\n')).toContain('TAKE-OUT');
  });
  it('lines.added to an open table uses that table\'s label', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    d.tableLabels = { [SESSION]: '12' };
    await printOutageForEvent(d, linesAdded([line(IT.pork, 1)]));
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('12');
    const expected = formatKitchenTicket({ stationName: 'Grill', tableLabel: '12', ticketNo: 'K-2-1', sentAtLocal: '19:59', items: [{ name: 'Pork belly', qty: 1, note: null }], offline: true }, LAYOUT);
    expect(printLines).toHaveBeenCalledWith(expected, { copies: 1 });
  });
  it('the ticket numbers carry on across sends', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    await printOutageForEvent(d, linesAdded([line(IT.pork, 1)]));
    await printOutageForEvent(d, linesAdded([line(IT.pork, 2)]));
    expect(printLines.mock.calls.map((c) => c[0].join('\n').match(/K-2-\d+/)?.[0])).toEqual(['K-2-1', 'K-2-2']);
  });
  it('another kind of event (heads.set, line.cancelled, sale.completed) prints nothing even offline', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    for (const kind of ['heads.set', 'line.cancelled', 'sale.completed', 'discount.added', 'session.voided']) {
      expect(await printOutageForEvent(d, { kind, payload: {} })).toEqual({ printed: 0, failed: [], message: null });
    }
    expect(printLines).not.toHaveBeenCalled();
  });
});

describe('OFFLINE: a refill prints one refill slip', () => {
  it('one slip with the table and the meats, formatted with formatRefillSlip', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps({ copies: 1 });
    const res = await printOutageForEvent(d, { kind: 'refill.requested', payload: { sessionId: SESSION, lines: [line(IT.rePork, 2), line(IT.reBulgogi, 1)] } });
    const expected = formatRefillSlip({ tableLabel: '7', sentAtLocal: '19:59', items: [{ name: 'Pork belly', qty: 2 }, { name: 'Chicken bulgogi', qty: 1 }], offline: true }, LAYOUT);
    expect(printLines).toHaveBeenCalledTimes(1);
    expect(printLines).toHaveBeenCalledWith(expected, { copies: 1 });
    expect(res).toEqual({ printed: 1, failed: [], message: null });
    expect(expected.join('\n')).toContain('REFILL');
  });
  it('a refill of an item this tablet does not know still prints (as Unknown item)', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps();
    await printOutageForEvent(d, { kind: 'refill.requested', payload: { sessionId: SESSION, lines: [{ ...line(IT.rePork, 2), menuItemId: id(777777) }] } });
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('2 x Unknown item');
  });
  it('is ONE slip even when the meats belong to different stations, and even when every station has printOnOutage off', async () => {
    const { printOutageForEvent } = await load();
    const { d, printLines } = deps({ menu: menuWithPrint({ [ST.grill]: false, [ST.hot]: false, [ST.drinks]: false }) });
    await printOutageForEvent(d, { kind: 'refill.requested', payload: { sessionId: SESSION, lines: [line(IT.rePork, 1), line(IT.reLettuce, 1)] } });
    expect(printLines).toHaveBeenCalledTimes(1);
  });
});

describe('a print failure never loses the order (R3)', () => {
  it('a printer that says "failed": the job comes back with the one sentence, nothing throws', async () => {
    const { printOutageForEvent, PRINT_FAILED_NOTE } = await load();
    const { d } = deps({ print: async () => 'failed' });
    const res = await printOutageForEvent(d, linesAdded([line(IT.pork, 1)]));
    expect(PRINT_FAILED_NOTE).toBe('Kitchen ticket did not print. Tap Reprint.');
    expect(res.printed).toBe(0);
    expect(res.message).toBe('Kitchen ticket did not print. Tap Reprint.');
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].copies).toBe(1);
    expect(res.failed[0].lines.join('\n')).toContain('Pork belly');
  });
  it('a printer that THROWS is the same as failed', async () => {
    const { printOutageForEvent } = await load();
    const { d } = deps({
      print: async () => {
        throw new Error('USB unplugged');
      },
    });
    const res = await printOutageForEvent(d, linesAdded([line(IT.pork, 1)]));
    expect(res.failed).toHaveLength(1);
    expect(res.message).toBe('Kitchen ticket did not print. Tap Reprint.');
  });
  it('the browser print fallback counts as printed', async () => {
    const { printOutageForEvent } = await load();
    const { d } = deps({ print: async () => 'fallback' });
    expect(await printOutageForEvent(d, linesAdded([line(IT.pork, 1)]))).toEqual({ printed: 1, failed: [], message: null });
  });
  it('one station prints and the other fails: printed 1, only the failed ticket is waiting for Reprint', async () => {
    const { printOutageForEvent } = await load();
    let n = 0;
    const { d } = deps({ print: async () => (++n === 1 ? 'printed' : 'failed') });
    const res = await printOutageForEvent(d, linesAdded([line(IT.rice, 1), line(IT.pork, 1)]));
    expect(res.printed).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].lines.join('\n')).toContain('GRILL'); // the second ticket (Grill sorts after Hot kitchen)
  });
  it('Reprint prints the very same paper again and uses no new ticket number', async () => {
    const { printOutageForEvent, reprintOutage } = await load();
    const first = deps({ print: async () => 'failed' });
    const res = await printOutageForEvent(first.d, linesAdded([line(IT.pork, 1)]));
    const seqBefore = first.meta.store.get('app.kitchenTicketSeq');
    const again = vi.fn(async () => 'printed');
    const out = await reprintOutage({ printLines: again }, res.failed);
    expect(again).toHaveBeenCalledTimes(1);
    expect(again).toHaveBeenCalledWith(res.failed[0].lines, { copies: 1 });
    expect(out).toEqual({ printed: 1, failed: [], message: null });
    expect(first.meta.store.get('app.kitchenTicketSeq')).toBe(seqBefore);
  });
  it('Reprint that fails again keeps the job and says the sentence again', async () => {
    const { reprintOutage } = await load();
    const jobs = [{ lines: ['GRILL', 'OFFLINE'], copies: 1 }];
    const out = await reprintOutage({ printLines: async () => 'failed' }, jobs);
    expect(out.failed).toEqual(jobs);
    expect(out.message).toBe('Kitchen ticket did not print. Tap Reprint.');
  });
});

describe('fixtures this file leans on', () => {
  it('Drinks is the only station with printOnOutage false, and the unli variant id exists', () => {
    expect(MENU.stations.filter((s) => !s.printOnOutage).map((s) => s.name)).toEqual(['Drinks']);
    expect(VAR.unli).toBeTruthy();
  });
});
