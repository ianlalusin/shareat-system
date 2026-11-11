/**
 * T-527 audit fix 4 - no blink. A dropped event stays on screen until the /state poll AND that table's body have both landed after the drop
 * (settle.ts), and the reducer keeps applying it meanwhile, so a sent change never vanishes and reappears. docs/tasks/527-pos-orders-screen.md.
 */
import { describe, expect, it } from 'vitest';
import type { PosEvent } from '@/lib/pos-device';
import { projectOrders } from '@/app/pos/_orders/project';
import { droppedEvents, SETTLE_MAX_MS, stillSettling, type Settling } from '@/app/pos/_orders/settle';
import { IDS, PERSON, SNAPSHOT, id } from './helpers/t527-menu';

const A = id(500);
const T = '2026-11-07T09:00:00.000Z';
const NEW = id(501);
const ev = (seq: number, kind: PosEvent['kind'], payload: Record<string, unknown>): PosEvent => ({ seq, kind, personId: PERSON, occurredAtDevice: T, payload });
const added = ev(7, 'lines.added', { sessionId: A, lines: [{ lineId: NEW, menuItemId: IDS.pork, variantId: IDS.porkV, qty: 1, addedAtDevice: T }] });
const settlingOf = (o: Partial<Settling> = {}): Settling => ({ event: added, sessionId: A, versionAtDrop: 4, droppedAtMs: 1_000, ...o });

describe('droppedEvents', () => {
  it('lists the events that were in the outbox and are not now, by seq', () => {
    const a = ev(1, 'heads.set', { sessionId: A, headsCashier: 3 });
    const b = ev(2, 'heads.set', { sessionId: A, headsCashier: 4 });
    expect(droppedEvents([a, b], [b])).toEqual([a]);
    expect(droppedEvents([a, b], [a, b])).toEqual([]);
    expect(droppedEvents([], [a])).toEqual([]);
  });
});

describe('stillSettling - when a dropped event lets go', () => {
  const now = 2_000;
  it('keeps it until the poll has a newer version AND the table body was read for that version', () => {
    const s = settlingOf();
    expect(stillSettling([s], { version: 4, landed: { [A]: 4 }, nowMs: now })).toHaveLength(1); // nothing newer yet
    expect(stillSettling([s], { version: 5, landed: { [A]: 4 }, nowMs: now })).toHaveLength(1); // poll landed, the body has not
    expect(stillSettling([s], { version: 5, landed: {}, nowMs: now })).toHaveLength(1);
    expect(stillSettling([s], { version: 5, landed: { [A]: 5 }, nowMs: now })).toHaveLength(0); // both landed
  });

  it('a body read for the OLD version (before the poll moved) does not release it', () => {
    expect(stillSettling([settlingOf({ versionAtDrop: 4 })], { version: 4, landed: { [A]: 4 }, nowMs: now })).toHaveLength(1);
  });

  it('lets go after the time limit when nothing on the server moved (a duplicate or a refusal); a table it cannot name only lets go by time', () => {
    const quiet = settlingOf();
    expect(stillSettling([quiet], { version: 4, landed: { [A]: 4 }, nowMs: quiet.droppedAtMs + SETTLE_MAX_MS - 1 })).toHaveLength(1);
    expect(stillSettling([quiet], { version: 4, landed: { [A]: 4 }, nowMs: quiet.droppedAtMs + SETTLE_MAX_MS })).toHaveLength(0);
    const unnamed = settlingOf({ sessionId: null });
    expect(stillSettling([unnamed], { version: 9, landed: { [A]: 9 }, nowMs: now })).toHaveLength(1);
  });
});

describe('the view while an event is settling', () => {
  const server = (lines: { id: string; name: string }[]) => ({
    openStands: [{ sessionId: A, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 2, headsServer: null, openedAtDevice: T }],
    sessions: {
      [A]: {
        session: { id: A, mode: 'dine_in', standId: IDS.stand5, status: 'open', headsCashier: 2, headsServer: null },
        lines: lines.map((l) => ({ id: l.id, kind: 'item', name: l.name, qty: 1, unitPrice: '250.00', kitchenStatus: 'queued', bundleHeads: null })),
      },
    },
  });

  it('the line stays visible, still marked sending, from the moment the outbox drops it until the body has it', () => {
    const settling = [settlingOf()];
    const before = projectOrders(server([]), settling.map((s) => s.event), SNAPSHOT);
    expect(before.sessions[A]!.lines.map((l) => [l.id, l.pending])).toEqual([[NEW, true]]);
    const after = projectOrders(server([{ id: NEW, name: 'Pork belly' }]), [], SNAPSHOT); // released: the server body holds it
    expect(after.sessions[A]!.lines.map((l) => [l.id, l.pending])).toEqual([[NEW, false]]);
  });

  it('while the body already holds it and the event is still settling, it is shown ONCE and not as sending', () => {
    const view = projectOrders(server([{ id: NEW, name: 'Pork belly' }]), [added], SNAPSHOT);
    expect(view.sessions[A]!.lines.map((l) => [l.id, l.pending])).toEqual([[NEW, false]]);
  });
});
