// @vitest-environment happy-dom
/**
 * T-620 - void an unpaid stand from the /pos till (docs/tasks/620-pos-void-unpaid-stand.md). Client side only; the server (`session.voided`) is T-524/T-525.
 *   - the event is the server's spec, field for field;
 *   - a queued void takes the table off the open list at once and frees the stand;
 *   - who may void: a person who may approve = no PIN (works offline); anyone else online = a manager PIN; anyone else offline = blocked with a sentence;
 *   - a typed PIN goes to the server at once and is never written to the outbox (IndexedDB).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindPairing, enqueue, reserveSeq } from '@/lib/pos-device';
import { OUTBOX_STORE } from '@/lib/pos-device/db';
import { VoidStandDialog } from '@/app/pos/_orders/OrderDialogs';
import { OrdersView } from '@/app/pos/_orders/OrdersView';
import { sendVoidNow, VOID_NOT_SENT, VOID_OFFLINE_NOTE, voidAccess, voidSessionEvent } from '@/app/pos/_orders/payloads';
import { projectOrders, seatStandChoices } from '@/app/pos/_orders/project';
import { createFakeIdb, type FakeIdbFactory } from './helpers/fake-idb';
import { IDS, SNAPSHOT, id, PERSON } from './helpers/t527-menu';

const NOW = new Date('2026-11-21T09:00:00.000Z');
const S = id(100);
const SERVER = { openStands: [{ sessionId: S, standId: IDS.stand5, standNumber: 5, mode: 'dine_in', headsCashier: 2, headsServer: null, openedAtDevice: '2026-11-21T08:00:00.000Z' }], sessions: {} };

describe('T-620 the event', () => {
  it('is the server spec field for field: a PIN void carries approval.pin, a manager void carries none', () => {
    expect(voidSessionEvent({ personId: PERSON, sessionId: S, reason: 'Walked out', now: NOW, offline: false, pin: '4321' })).toStrictEqual({
      kind: 'session.voided',
      personId: PERSON,
      occurredAtDevice: NOW.toISOString(),
      payload: { sessionId: S, reason: 'Walked out', voidedAtDevice: NOW.toISOString(), offline: false, approval: { pin: '4321' } },
    });
    expect(voidSessionEvent({ personId: PERSON, sessionId: S, reason: 'Walked out', now: NOW, offline: true }).payload).toStrictEqual({ sessionId: S, reason: 'Walked out', voidedAtDevice: NOW.toISOString(), offline: true });
  });
});

describe('T-620 the projection', () => {
  const queued = (kind: string) => [{ seq: 5, kind, personId: PERSON, occurredAtDevice: NOW.toISOString(), payload: { sessionId: S } }] as never;
  it('a queued void takes the table off the open list and frees its stand', () => {
    const before = projectOrders(SERVER as never, [], SNAPSHOT as never);
    expect(before.tiles.map((t) => t.sessionId)).toEqual([S]);
    expect(seatStandChoices(SNAPSHOT.stands, before.tiles).find((c) => c.id === IDS.stand5)?.inUse).toBe(true);
    const after = projectOrders(SERVER as never, queued('session.voided'), SNAPSHOT as never);
    expect(after.tiles).toEqual([]);
    expect(after.sessions[S]).toBeUndefined();
    expect(seatStandChoices(SNAPSHOT.stands, after.tiles).find((c) => c.id === IDS.stand5)?.inUse).toBe(false);
  });
  it('an unrelated queued event leaves the table where it was', () => {
    expect(projectOrders(SERVER as never, queued('heads.set'), SNAPSHOT as never).tiles.map((t) => t.sessionId)).toEqual([S]);
  });
});

describe('T-620 who may void', () => {
  it('a person who may approve needs no PIN, online or off; anyone else needs a PIN online and is blocked offline', () => {
    expect(voidAccess({ canApprove: true, online: true })).toBe('direct');
    expect(voidAccess({ canApprove: true, online: false })).toBe('direct');
    expect(voidAccess({ canApprove: false, online: true })).toBe('pin');
    expect(voidAccess({ canApprove: false, online: false })).toBe('blocked');
  });

  const dialog = (access: 'direct' | 'pin') => renderToStaticMarkup(createElement(VoidStandDialog, { label: 'Stand 5', access, onClose: () => undefined, onConfirm: async () => null }));
  it('the dialog names the table, says it cannot be undone, and has a PIN box only for a PIN void', () => {
    expect(dialog('pin')).toContain('Void Stand 5?');
    expect(dialog('pin')).toContain('This cannot be undone.');
    expect(dialog('pin')).toContain('Manager PIN');
    expect(dialog('pin')).toContain('type="password"');
    expect(dialog('direct')).not.toContain('Manager PIN');
    expect(dialog('direct')).not.toContain('type="password"');
  });

  const view = (o: { voidTable?: { onVoid: () => void; blockedNote: string | null }; paid?: boolean; readOnly?: boolean }) => {
    const p = projectOrders(SERVER as never, o.paid ? ([{ seq: 1, kind: 'sale.completed', personId: PERSON, occurredAtDevice: NOW.toISOString(), payload: { sessionId: S } }] as never) : [], SNAPSHOT as never);
    return renderToStaticMarkup(createElement(OrdersView, { readOnly: o.readOnly ?? false, tiles: p.tiles, sessions: p.sessions, selectedSessionId: S, nowMs: NOW.getTime(), onSeat: () => undefined, onTakeOut: () => undefined, onSelect: () => undefined, onHeads: () => undefined, onAddItems: () => undefined, onCancelLine: () => undefined, ...(o.voidTable ? { voidTable: o.voidTable } : {}) }));
  };
  it('the panel offers Void table on an unpaid table; blocked (cashier offline) it is disabled and says why', () => {
    const open = view({ voidTable: { onVoid: () => undefined, blockedNote: null } });
    expect(open).toContain('Void table');
    expect(open).not.toContain(VOID_OFFLINE_NOTE);
    const blocked = view({ voidTable: { onVoid: () => undefined, blockedNote: VOID_OFFLINE_NOTE } });
    expect(blocked).toContain(VOID_OFFLINE_NOTE);
    expect(/<button[^>]*disabled=""[^>]*>\s*Void table/.test(blocked)).toBe(true);
    expect(/<button[^>]*disabled=""[^>]*>\s*Void table/.test(open)).toBe(false);
  });
  it('no Void table on a paid table, on a phone (read only), or when the till gives no void', () => {
    expect(view({ voidTable: { onVoid: () => undefined, blockedNote: null }, paid: true })).not.toContain('Void table');
    expect(view({ voidTable: { onVoid: () => undefined, blockedNote: null }, readOnly: true })).not.toContain('Void table');
    expect(view({})).not.toContain('Void table');
  });
});

describe('T-620 a typed PIN is sent now and never stored', () => {
  let idb: FakeIdbFactory;
  beforeEach(async () => {
    idb = createFakeIdb({ commitDelayMs: 2 });
    vi.stubGlobal('indexedDB', idb);
    await bindPairing('pair-1');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const PIN = '987654';
  const ev = () => voidSessionEvent({ personId: PERSON, sessionId: S, reason: 'Walked out', now: NOW, offline: false, pin: PIN });
  const answer = (results: unknown, status = 200) => (async () => new Response(JSON.stringify({ ok: true, stateVersion: 3, results }), { status })) as unknown as typeof fetch;

  it('reserveSeq hands out a seq the outbox then never reuses, and stores no row', async () => {
    const a = await reserveSeq();
    const queuedEvent = await enqueue({ kind: 'heads.set', personId: PERSON, occurredAtDevice: NOW.toISOString(), payload: { sessionId: S, headsCashier: 3 } });
    expect(a.pairingId).toBe('pair-1');
    expect(queuedEvent.seq).toBeGreaterThan(a.seq);
    expect(idb.rows(OUTBOX_STORE)).toHaveLength(1);
  });
  it('posts a one-event batch under the bound pairing and answers ok when applied; the outbox stays empty [kills: queueing the PIN]', async () => {
    let body: { pairingId: string; events: { seq: number; kind: string; payload: { approval?: { pin: string } } }[] } | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true, stateVersion: 3, results: [{ seq: body!.events[0]!.seq, status: 'applied' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sendVoidNow({ reserveSeq, fetch: f }, ev());
    expect(r.ok).toBe(true);
    expect(body!.pairingId).toBe('pair-1');
    expect(body!.events).toHaveLength(1);
    expect(body!.events[0]!.kind).toBe('session.voided');
    expect(body!.events[0]!.payload.approval).toEqual({ pin: PIN });
    expect(idb.rows(OUTBOX_STORE)).toHaveLength(0);
    expect(JSON.stringify(idb.rows(OUTBOX_STORE))).not.toContain(PIN);
  });
  it('a refusal is the server sentence without its code; a lost connection or an odd answer is the one not-sent sentence', async () => {
    const seq = (await reserveSeq()).seq + 1; // the next reserve, inside sendVoidNow
    const refused = answer([{ seq, status: 'quarantined', error: 'POS_EVENT_PIN_REFUSED: That PIN cannot approve this. Ask a store manager.' }]);
    expect(await sendVoidNow({ reserveSeq, fetch: refused }, ev())).toEqual({ ok: false, message: 'That PIN cannot approve this. Ask a store manager.' });
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await sendVoidNow({ reserveSeq, fetch: offline }, ev())).toEqual({ ok: false, message: VOID_NOT_SENT });
    expect(await sendVoidNow({ reserveSeq, fetch: answer([], 409) }, ev())).toEqual({ ok: false, message: VOID_NOT_SENT });
    expect(await sendVoidNow({ reserveSeq, fetch: answer([]) }, ev())).toEqual({ ok: false, message: VOID_NOT_SENT });
  });
});
