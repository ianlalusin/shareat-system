import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LobbyLineView, LobbyResult } from '../src/app/pos/_lobby/logic';
import { addPending, clearPending, keepOnly, readPending, type PendingSeat, type PendingStorage } from '../src/app/pos/_lobby/pending';
import { mapLobbyLines, retryLobbyLink, SEAT_NEEDS_INTERNET, seatButton, seatLobbyParty, type SeatDeps } from '../src/app/pos/_lobby/seat';
import { seatEvent } from '../src/app/pos/_orders/payloads';
import { IDS, MENU, PERSON, id } from './helpers/t527-menu';

/**
 * T-644 S2 - seating a lobby party from the live POS: the pure half and its wiring. No database, no DOM.
 * MUTANT INDEX (each title ends with "[kills: ...]"): a lobby call made BEFORE the table is saved, or when saving it failed; a retry that does not persist, or keeps a note after it worked;
 * a variantId matched by item name or position; an unmatched / closed / bad-option line added to the order; a second package stacked; a Seat button that stays on offline;
 * a pending note that keeps a name or phone; a storage failure that throws; a stale note for a party that left the line.
 */
const SRC = resolve(__dirname, '..', 'src', 'app', 'pos');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

const NOW = new Date('2026-11-26T10:00:00.000Z'); // 10:00 UTC: no daypart in the fixture menu closes it
const line = (over: Partial<LobbyLineView> = {}): LobbyLineView => ({ lineKind: 'a_la_carte', qty: 1, variantId: IDS.plainV, label: 'Plain rice', posItemKey: null, ...over });

describe('the party lines become order lines through the snapshot menu (variantId -> item)', () => {
  it('a package and an a la carte line are matched by their variant id and take the item the variant belongs to, not another [kills: a variant matched by name or position]', () => {
    const lines = [
      line({ lineKind: 'package', qty: 5, variantId: IDS.unliV, label: 'Whatever the diner saw' }),
      line({ qty: 2, variantId: IDS.plainV, label: 'Pork belly' }), // the label lies on purpose: the variant id is the key
    ];
    const r = mapLobbyLines(lines, MENU, NOW);
    expect(r.byHand).toEqual([]);
    expect(r.cart).toEqual([
      { itemId: IDS.unli, variantId: IDS.unliV, qty: 1 }, // a package is billed per head: one line, the heads are the sheet's
      { itemId: IDS.plain, variantId: IDS.plainV, qty: 2 },
    ]);
  });

  it('a line whose variant is not on this menu, is sold out, or belongs to a refill item is NOT added: it is listed to tap in by hand [kills: an unmatched line silently dropped or added anyway]', () => {
    const lines = [
      line({ variantId: id(999), label: 'Gone item', qty: 3 }), // no such variant
      line({ variantId: IDS.colaV, label: 'Cola', qty: 1 }), // withdrawn
      line({ variantId: IDS.riceV, label: 'Rice refill', qty: 1 }), // a refill item is not a la carte
      line({ variantId: IDS.plainV, label: 'Plain rice', qty: 1 }), // the one that matches
    ];
    const r = mapLobbyLines(lines, MENU, NOW);
    expect(r.cart.map((c) => c.itemId)).toEqual([IDS.plain]);
    expect(r.byHand).toEqual(['3 x Gone item (tap in by hand)', '1 x Cola (tap in by hand)', '1 x Rice refill (tap in by hand)']);
  });

  it('with no menu on the tablet nothing is added and every line is listed [kills: a pre-fill that invents lines with no menu]', () => {
    const r = mapLobbyLines([line(), line({ variantId: IDS.unliV, lineKind: 'package', label: 'Unli' })], null, NOW);
    expect(r.cart).toEqual([]);
    expect(r.byHand).toHaveLength(2);
  });

  it('chosen options are kept only when this menu still offers them and the group rules hold; otherwise the line goes to hand entry [kills: an option id sent that the server would refuse]', () => {
    const sauce = (ids: string[]) => mapLobbyLines([line({ variantId: IDS.porkV, label: 'Pork belly', optionValueIds: ids })], MENU, NOW);
    expect(sauce([IDS.spicy]).cart).toEqual([{ itemId: IDS.pork, variantId: IDS.porkV, qty: 1, optionValueIds: [IDS.spicy] }]);
    expect(sauce([]).cart, 'a required Sauce choice is missing').toEqual([]);
    expect(sauce([IDS.spicy, IDS.garlic]).cart, 'a single-choice group holds two').toEqual([]);
    expect(sauce([id(777)]).cart, 'an option value this menu does not have').toEqual([]);
    expect(sauce([IDS.spicy, IDS.garlic]).byHand).toEqual(['1 x Pork belly (tap in by hand)']);
  });

  it('a second package line is not stacked on the first (the order holds one package, billed per head) [kills: two package lines on one table]', () => {
    const lines = [line({ lineKind: 'package', variantId: IDS.unliV, label: 'Unli A' }), line({ lineKind: 'package', variantId: IDS.unliV, label: 'Unli B' })];
    const r = mapLobbyLines(lines, MENU, NOW);
    expect(r.cart).toHaveLength(1);
    expect(r.byHand).toEqual(['1 x Unli B (tap in by hand)']);
  });
});

describe('the Seat button', () => {
  it('is off, with the one sentence, when the tablet is offline, whatever else is true [kills: a Seat that stays on offline and sends a table the lobby can never be told about]', () => {
    expect(seatButton({ ready: false, online: false, busy: false })).toEqual({ disabled: true, hint: SEAT_NEEDS_INTERNET });
    expect(seatButton({ ready: true, online: false, busy: false })).toEqual({ disabled: true, hint: 'Lobby needs the internet' });
  });
  it('is on when online and ready, off while that row is busy or the tablet is not ready, with no sentence', () => {
    expect(seatButton({ ready: true, online: true, busy: false })).toEqual({ disabled: false, hint: null });
    expect(seatButton({ ready: true, online: true, busy: true })).toEqual({ disabled: true, hint: null });
    expect(seatButton({ ready: false, online: true, busy: false })).toEqual({ disabled: true, hint: null });
  });
});

const ENTRY = id(500);
const stand = IDS.stand5;
const makeEvent = () => seatEvent({ personId: PERSON, menu: MENU, now: NOW, newId: (() => { let n = 100; return () => id(n++); })(), standId: stand, heads: 4, cart: [{ itemId: IDS.plain, variantId: IDS.plainV, qty: 1 }] });
const memory = (): PendingStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

function rig(over: { submit?: SeatDeps['submit']; link?: SeatDeps['link'] } = {}) {
  const calls: string[] = [];
  const store = memory();
  const deps: SeatDeps = {
    submit: async (e) => {
      calls.push(`submit:${e.kind}`);
      return over.submit ? over.submit(e) : { ok: true };
    },
    link: async (b) => {
      calls.push(`link:${b.entryId}:${b.sessionId}:${b.standLabel}`);
      return over.link ? over.link(b) : { ok: true };
    },
    remember: (p) => (calls.push('remember'), addPending('S', p, store)),
    forget: (entryId) => (calls.push('forget'), clearPending('S', entryId, store)),
  };
  return { calls, store, deps };
}

describe('two steps in one order: the table first, then the lobby', () => {
  it('saves the stand.opened, THEN tells the lobby the SAME session id and the stand number [kills: a lobby call before the table is saved, or with a different session id]', async () => {
    const r = rig();
    const event = makeEvent();
    const sessionId = (event.payload as { sessionId: string }).sessionId;
    const out = await seatLobbyParty(r.deps, { entryId: ENTRY, event, standLabel: '5' });
    expect(out).toEqual({ kind: 'seated' });
    expect(r.calls).toEqual(['submit:stand.opened', `link:${ENTRY}:${sessionId}:5`, 'forget']);
    expect(event.kind).toBe('stand.opened');
    expect(event.payload).toMatchObject({ mode: 'dine_in', standId: stand, headsCashier: 4 });
  });

  it('when the table could not be saved the lobby is NEVER called and nothing is remembered, the cashier gets the sentence [kills: a lobby call after a failed table save, which would seat a party at no table]', async () => {
    const r = rig({ submit: async () => ({ ok: false, message: 'This tablet could not save that. Nothing was sent. Try again.' }) });
    const out = await seatLobbyParty(r.deps, { entryId: ENTRY, event: makeEvent(), standLabel: '5' });
    expect(out).toEqual({ kind: 'refused', message: 'This tablet could not save that. Nothing was sent. Try again.' });
    expect(r.calls).toEqual(['submit:stand.opened']);
    expect(readPending('S', r.store)).toEqual({});
  });

  it('an event with no session id is refused before anything is sent [kills: a lobby link to an undefined session]', async () => {
    const r = rig();
    const out = await seatLobbyParty(r.deps, { entryId: ENTRY, event: { ...makeEvent(), payload: {} }, standLabel: '5' });
    expect(out.kind).toBe('refused');
    expect(r.calls).toEqual([]);
  });
});

describe('the retry path persists, retries, and clears', () => {
  const refused: LobbyResult = { ok: false, error: 'That place in line is no longer open.' };

  it('a refused or thrown lobby step leaves the table open and REMEMBERS the party (ids and stand label only) [kills: a lost party: table open, nothing to retry]', async () => {
    for (const link of [async () => refused, async (): Promise<LobbyResult> => { throw new Error('offline'); }]) {
      const r = rig({ link });
      const event = makeEvent();
      const sessionId = (event.payload as { sessionId: string }).sessionId;
      const out = await seatLobbyParty(r.deps, { entryId: ENTRY, event, standLabel: '5' });
      expect(out.kind).toBe('link-pending');
      expect(r.calls).toEqual(['submit:stand.opened', `link:${ENTRY}:${sessionId}:5`, 'remember']);
      expect(readPending('S', r.store)).toEqual({ [ENTRY]: { entryId: ENTRY, sessionId, standLabel: '5' } });
      expect([...r.store.data.values()].join(''), 'no name, phone or note is stored').not.toMatch(/Ana|phone|note|displayName/i);
    }
  });

  it('Retry sends the same ids again; success clears the note, a second failure keeps it [kills: a retry that does not persist, or a note that stays after success]', async () => {
    const p: PendingSeat = { entryId: ENTRY, sessionId: id(600), standLabel: '5' };
    const store = memory();
    addPending('S', p, store);
    let up = false;
    const sent: PendingSeat[] = [];
    const deps = {
      link: async (b: PendingSeat): Promise<LobbyResult> => (sent.push(b), up ? { ok: true } : refused),
      forget: (e: string) => clearPending('S', e, store),
    };
    expect(await retryLobbyLink(deps, p)).toEqual({ ok: false, message: 'That place in line is no longer open.' });
    expect(readPending('S', store)[ENTRY]).toEqual(p);
    up = true;
    expect(await retryLobbyLink(deps, p)).toEqual({ ok: true });
    expect(sent).toEqual([p, p]);
    expect(readPending('S', store)).toEqual({});
  });

  it('the notes survive a reload (read back from storage), are per store, and drop what is not the three known fields [kills: notes lost on reload or shared across stores]', () => {
    const store = memory();
    addPending('S', { entryId: 'e1', sessionId: 's1', standLabel: '5' }, store);
    addPending('T', { entryId: 'e2', sessionId: 's2', standLabel: '6' }, store);
    expect(Object.keys(readPending('S', store))).toEqual(['e1']);
    expect(Object.keys(readPending('T', store))).toEqual(['e2']);
    store.data.set('erp.pos.lobbyPendingSeats.S', JSON.stringify({ e1: { entryId: 'e1', sessionId: 's1', standLabel: '5', displayName: 'Ana', phone: '0917' }, junk: 5, e3: { entryId: 'e3' } }));
    expect(readPending('S', store)).toEqual({ e1: { entryId: 'e1', sessionId: 's1', standLabel: '5' } });
  });

  it('storage that is missing, full or holds garbage never throws: the note simply is not there [kills: a cashier screen that crashes when local storage is blocked]', () => {
    const broken: PendingStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
    expect(() => addPending('S', { entryId: 'e1', sessionId: 's1', standLabel: '5' }, broken)).not.toThrow();
    expect(readPending('S', broken)).toEqual({});
    expect(readPending('S', null)).toEqual({});
    expect(() => clearPending('S', 'e1', broken)).not.toThrow();
    const junk = memory();
    junk.data.set('erp.pos.lobbyPendingSeats.S', '{not json');
    expect(readPending('S', junk)).toEqual({});
    junk.data.set('erp.pos.lobbyPendingSeats.S', '[1,2]');
    expect(readPending('S', junk)).toEqual({});
  });

  it('a party that has left the line is forgotten, one still on it is kept [kills: a stale note that shows Retry for a party who is gone]', () => {
    const store = memory();
    addPending('S', { entryId: 'e1', sessionId: 's1', standLabel: '5' }, store);
    addPending('S', { entryId: 'e2', sessionId: 's2', standLabel: '6' }, store);
    keepOnly('S', ['e2', 'e9'], store);
    expect(Object.keys(readPending('S', store))).toEqual(['e2']);
    keepOnly('S', [], store);
    expect(readPending('S', store)).toEqual({});
  });
});

describe('the wiring: Seat on the row opens the Orders seat sheet; the action takes no store from the body', () => {
  it('the Lobby tab reuses OrderDialog (not a copy), builds the event with the Orders seatEvent, and saves it through submitPosEvent before the lobby action [kills: a forked seat sheet, a hand-built event, a lobby call that skips the outbox]', () => {
    const lobby = read('_lobby/Lobby.tsx');
    expect(lobby).toContain("import { OrderDialog, type OrderSend, type SeatPrefill } from '../_orders/OrderDialogs';");
    expect(lobby).toMatch(/<OrderDialog mode=\{\{ kind: 'seat' \}\}/);
    expect(lobby).toContain('seatEvent({ personId, menu');
    expect(lobby).toContain('submitPosEvent({ enqueue, requestDrain: pos.requestDrain }, event)');
    expect(lobby).toContain('seatLobbyParty(seatDeps');
    expect(lobby).toMatch(/disabled=\{seat\.disabled\}/);
    const seat = read('_lobby/seat.ts');
    expect(seat.indexOf('await d.submit(i.event)')).toBeGreaterThan(-1);
    expect(seat.indexOf('await d.submit(i.event)')).toBeLessThan(seat.indexOf('await tryLink(d, p)'));
    expect(read('_orders/OrderDialogs.tsx')).toContain('useState(prefill?.heads ?? START_HEADS)');
  });

  it('the server action sends joinUrl null, passes the pairing store as onlyStoreId, and its body names no store [kills: a store read from the body, a join link made up]', () => {
    const actions = read('lobby/actions.ts');
    expect(actions).toContain('export async function seatLobbyEntryAction(input: { entryId: string; sessionId: string; standLabel: string })');
    expect(actions).toContain('seatEntry(tx, actor, { entryId, sessionId, standLabel, joinUrl: null }, { onlyStoreId: storeId })');
    expect(actions).toMatch(/seatLobbyEntryAction[\s\S]*?\{\},\s*async \(tx, actor, storeId\)/);
  });
});
