/**
 * T-529 R3 follow-up - (1) an order saved in the ~6 s before the tablet decides it is offline still prints, exactly once (`app.outagePrinted`);
 * (2) a missing till number prints `K-—`, never `K-0-…`. Plain logic: the device store, the printer and the menu are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import { fakeMeta, id, IT, MENU } from './helpers/t529-fixtures';
import { NO_TICKET_NO, printOutageForEvent } from '../src/app/pos/_kitchen/outage-print';
import { OUTAGE_PRINTED_KEY, printUnprinted, pruneOutagePrinted, pruneOutagePrintedToPending } from '../src/app/pos/_kitchen/outage-replay';

const SESSION = id(6001);
const STAND_ID = id(6002);
const AT = '2026-11-07T11:59:00.000Z';
const line = (n: number, itemId: string, qty = 1) => ({ lineId: id(6100 + n), menuItemId: itemId, qty, addedAtDevice: AT });
const standOpened = (seq: number) => ({ seq, kind: 'stand.opened', payload: { sessionId: SESSION, mode: 'dine_in', standId: STAND_ID, headsCashier: 2, openedAtDevice: AT, lines: [line(seq, IT.pork, 2)] } });
const linesAdded = (seq: number) => ({ seq, kind: 'lines.added', payload: { sessionId: SESSION, lines: [line(seq, IT.pork)] } });
const refill = (seq: number) => ({ seq, kind: 'refill.requested', payload: { sessionId: SESSION, lines: [line(seq, IT.rePork)] } });

function setup(o: { terminalNo?: number | null; meta?: ReturnType<typeof fakeMeta> } = {}) {
  const meta = o.meta ?? fakeMeta();
  const printLines = vi.fn(async (_lines: string[], _o: { copies: number }): Promise<'printed' | 'fallback' | 'failed'> => 'printed');
  const deps = (online: boolean) => ({
    online, menu: MENU, stands: [{ id: STAND_ID, number: 7 }], terminalNo: o.terminalNo === undefined ? 2 : o.terminalNo, layout: { width: 80, font: 'normal' } as const, copies: 1,
    sentAtLocal: '19:59', tableLabels: {}, printLines, getMeta: meta.getMeta, setMeta: meta.setMeta,
  });
  return { meta, printLines, deps };
}

describe('the offline switch prints what was saved before the poll said Offline', () => {
  it('an order saved while online prints nothing then; the switch to offline prints it exactly once; a second offline switch prints nothing', async () => {
    const { printLines, deps } = setup();
    const pending = [standOpened(1)];
    expect(await printUnprinted(deps(true), pending)).toEqual({ printed: 0, failed: [], message: null });
    expect(printLines).not.toHaveBeenCalled();
    expect((await printUnprinted(deps(false), pending)).printed).toBe(1);
    expect(printLines).toHaveBeenCalledTimes(1);
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('TABLE:');
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('7'); // the label comes from the pending stand.opened itself
    expect((await printUnprinted(deps(true), pending)).printed).toBe(0);
    expect((await printUnprinted(deps(false), pending)).printed).toBe(0); // the second offline switch
    expect(printLines).toHaveBeenCalledTimes(1);
  });

  it('never prints the same event twice across a reload: a new session over the same device store carries the printed-set', async () => {
    const first = setup();
    await printUnprinted(first.deps(false), [linesAdded(5)]);
    expect(first.meta.store.get(OUTAGE_PRINTED_KEY)).toEqual([5]);
    const reopened = setup({ meta: fakeMeta(Object.fromEntries(first.meta.store)) });
    expect((await printUnprinted(reopened.deps(false), [linesAdded(5)])).printed).toBe(0);
    expect(reopened.printLines).not.toHaveBeenCalled();
  });

  it('an event printed on the direct path (saved while already offline) is not printed again by the shell replay, even when both run at once', async () => {
    const { printLines, deps } = setup();
    const e = linesAdded(9);
    await Promise.all([printUnprinted(deps(false), [e]), printUnprinted(deps(false), [e])]);
    expect(printLines).toHaveBeenCalledTimes(1);
  });

  it('prints every pending order and refill that is not printed yet, oldest first, and only those kinds', async () => {
    const { printLines, deps } = setup();
    await printUnprinted(deps(false), [linesAdded(3), { seq: 2, kind: 'heads.set', payload: { sessionId: SESSION, headsCashier: 3 } }, refill(4), { seq: 1, kind: 'line.cancelled', payload: {} }]);
    expect(printLines).toHaveBeenCalledTimes(2);
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('GRILL');
    expect(printLines.mock.calls[1]![0].join('\n')).toContain('REFILL');
    // a later event prints; the earlier ones do not repeat
    await printUnprinted(deps(false), [linesAdded(3), refill(4), linesAdded(6)]);
    expect(printLines).toHaveBeenCalledTimes(3);
  });

  it('a failed print comes back for Reprint and is still marked printed (the replay never reprints it by itself)', async () => {
    const { deps, meta } = setup();
    const failing = { ...deps(false), printLines: vi.fn(async (): Promise<'failed'> => 'failed') };
    const res = await printUnprinted(failing, [linesAdded(7)]);
    expect(res.failed).toHaveLength(1);
    expect(res.message).toBe('Kitchen ticket did not print. Tap Reprint.');
    expect(meta.store.get(OUTAGE_PRINTED_KEY)).toEqual([7]);
    expect((await printUnprinted(failing, [linesAdded(7)])).failed).toEqual([]);
  });
});

describe('the printed-set is pruned when the outbox drops an event', () => {
  it('a removed seq is forgotten; the others stay', async () => {
    const m = fakeMeta({ [OUTAGE_PRINTED_KEY]: [1, 2, 3] });
    await pruneOutagePrinted(m, [2]);
    expect(m.store.get(OUTAGE_PRINTED_KEY)).toEqual([1, 3]);
    await pruneOutagePrinted(m, []);
    expect(m.store.get(OUTAGE_PRINTED_KEY)).toEqual([1, 3]);
  });
  it('after a reload only the seqs still pending are kept', async () => {
    const m = fakeMeta({ [OUTAGE_PRINTED_KEY]: [1, 2, 3, 4] });
    await pruneOutagePrintedToPending(m, [3, 4, 5]);
    expect(m.store.get(OUTAGE_PRINTED_KEY)).toEqual([3, 4]);
  });
});

describe('a missing till number', () => {
  it('prints the ticket with the label K-— and uses no counter (never K-0-…)', async () => {
    const { printLines, deps, meta } = setup({ terminalNo: null });
    await printOutageForEvent(deps(false), linesAdded(1));
    expect(NO_TICKET_NO).toBe('K-—');
    const paper = printLines.mock.calls[0]![0].join('\n');
    expect(paper).toContain('K-—');
    expect(paper).not.toMatch(/K-0/);
    expect(meta.store.size).toBe(0);
  });
  it('with a till number the ticket still counts K-<till>-<n>', async () => {
    const { printLines, deps } = setup({ terminalNo: 4 });
    await printOutageForEvent(deps(false), linesAdded(1));
    expect(printLines.mock.calls[0]![0].join('\n')).toContain('K-4-1');
  });
});

describe('a failed print keeps its Reprint job across a reload (app.outageReprint)', () => {
  it('the jobs written to the device store are read back by a new session; nothing saved reads as none', async () => {
    const { OUTAGE_REPRINT_KEY, readReprintJobs, writeReprintJobs } = await import('../src/app/pos/_kitchen/outage-replay');
    expect(OUTAGE_REPRINT_KEY).toBe('app.outageReprint');
    const m = fakeMeta();
    expect(await readReprintJobs(m)).toEqual([]);
    const jobs = [{ lines: ['GRILL', '1 x Pork belly'], copies: 1 }];
    await writeReprintJobs(m, jobs);
    expect(m.store.get('app.outageReprint')).toEqual(jobs);
    const reopened = fakeMeta(Object.fromEntries(m.store));
    expect(await readReprintJobs(reopened)).toEqual(jobs);
    await writeReprintJobs(reopened, []);
    expect(await readReprintJobs(reopened)).toEqual([]);
  });
  it('a damaged value reads as no jobs, never a crash', async () => {
    const { readReprintJobs } = await import('../src/app/pos/_kitchen/outage-replay');
    expect(await readReprintJobs(fakeMeta({ 'app.outageReprint': 'garbage' }))).toEqual([]);
    expect(await readReprintJobs(fakeMeta({ 'app.outageReprint': [{ nope: 1 }, { lines: ['A'], copies: 1 }] }))).toEqual([{ lines: ['A'], copies: 1 }]);
  });
});
