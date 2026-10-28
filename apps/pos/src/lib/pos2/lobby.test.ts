/**
 * T-455 S5 (TESTER) - the lobby card's pure rules. docs/tasks/455-customer-lobby.md "S5 rulings" 4, 6, 7 and the S5 row of section 5.
 * (The POS test setup is node-only, `.test.ts`, no DOM: the screens' decisions live in this pure module and the screens are checked by
 * the wiring test beside LobbyCard.)
 *
 * RED FOR THE RIGHT REASON: `@/lib/pos2/lobby` does not exist, so every case fails on "Failed to resolve import".
 *
 * CONTRACT THE BUILDER MATCHES (src/lib/pos2/lobby.ts, no React, no Firebase, no fetch):
 *   LOBBY_UNAVAILABLE = 'The waiting list needs the POS server. Seat walk-ins as usual.'
 *   LOBBY_RETRY_LABEL = 'Retry link'
 *   lobbyFailure(err: { status?: unknown; message?: unknown } | null | undefined)
 *       -> { kind: 'unavailable', message: LOBBY_UNAVAILABLE }  for status 503 and status 0 (offline / no answer)
 *       -> { kind: 'refused', message: err.message }             for status 409 (a LobbyRefusal's one sentence)
 *       -> { kind: 'error', message: <non-empty string> }        for anything else (a 403 keeps its own message)
 *   keypadPress(digits: string, key: string): string   '0'-'9' appends (max 4 digits, then ignored); 'back' drops the last; 'clear' empties; any other key ignored
 *   filterByCode<T extends { code: string }>(entries: T[], digits: string): T[]   '' -> all, in order; a full 4-digit code -> that entry only; no match -> []
 *   lobbyRowSummary(e: { code, displayName, partySize, createdAt: string | number | Date, lines: { lineKind, label }[] }, nowMs: number): string
 *       "4821 (middle dot) Ana (middle dot) 5 pax (middle dot) Pork+Chicken (middle dot) 12 min"   (package line labels joined with "+"; the part is left out when there is none)
 *   prefillForSeat(e: ListEntry): { partySize: number; notes: string; items: { posItemKey: string; qty: number }[]; textLines: { label: string; qty: number }[] }
 *       notes contains the diner's name and the entry's note; a line with a posItemKey goes to `items`, a line with null goes to `textLines`
 *       (shown to the cashier as plain text to tap in by hand): items.length + textLines.length === lines.length, nothing dropped.
 *   linkSeatedSession(i: { entryId, sessionId, standLabel, fetchJoinUrl: () => Promise<string>, seat: (b: { entryId, sessionId, standLabel, joinUrl: string }) => Promise<unknown> })
 *       : Promise<{ linked: true } | { linked: false; retryLabel: 'Retry link' }>      NEVER throws; the session is not its business and is never undone.
 *       If fetchJoinUrl fails, `seat` is NOT called (the entry stays on the list so a retry can still hand the phone over).
 * MUTANTS: M1 a 503 shown as a generic error; M2 a refusal's text hidden; M3 keypad accepts a 5th digit / letters; M4 search by name; M5 an unmapped line dropped;
 *   M6 a failed seat call throws / hides the retry; M7 seat called after a failed join-url fetch; M8 the diner's name missing from the notes.
 */
import { describe, expect, it, vi } from 'vitest';
import { LOBBY_RETRY_LABEL, LOBBY_UNAVAILABLE, filterByCode, keypadPress, linkSeatedSession, lobbyFailure, lobbyRowSummary, prefillForSeat } from '@/lib/pos2/lobby';

const DOT = '·';
const entry = (code: string, extra: Record<string, unknown> = {}) => ({
  code, entryId: `id-${code}`, displayName: 'Ana', partySize: 5, status: 'waiting', source: 'lobby', note: 'near the door', phone: null,
  createdAt: new Date(Date.UTC(2026, 9, 29, 3, 0, 0)).toISOString(), calledAt: null, lines: [] as any[], ...extra,
});

describe('failure wording', () => {
  it('503 and "no answer" (status 0) read the one waiting-list sentence; the exact sentence is fixed [kills: M1]', () => {
    expect(LOBBY_UNAVAILABLE).toBe('The waiting list needs the POS server. Seat walk-ins as usual.');
    expect(lobbyFailure({ status: 503, message: 'POS server is not configured' })).toEqual({ kind: 'unavailable', message: LOBBY_UNAVAILABLE });
    expect(lobbyFailure({ status: 0, message: "Cannot confirm the POS server's response." })).toEqual({ kind: 'unavailable', message: LOBBY_UNAVAILABLE });
  });
  it("409 keeps the server's sentence; anything else is a generic error with some text [kills: M2]", () => {
    expect(lobbyFailure({ status: 409, message: 'That place in line is already closed.' })).toEqual({ kind: 'refused', message: 'That place in line is already closed.' });
    for (const e of [{ status: 500, message: 'x' }, { status: 403, message: 'This tablet is not registered for the lobby.' }, null, undefined, {}]) {
      const r = lobbyFailure(e as any);
      expect(r.kind).toBe('error');
      expect(r.message.length).toBeGreaterThan(0);
    }
    expect(lobbyFailure({ status: 403, message: 'This tablet is not registered for the lobby.' }).message).toBe('This tablet is not registered for the lobby.');
  });
});

describe('keypad search finds by code (no free typing)', () => {
  it('digits append up to four, back and clear work, everything else is ignored [kills: M3]', () => {
    let d = '';
    for (const k of ['4', '8', '2', '1', '9']) d = keypadPress(d, k);
    expect(d).toBe('4821');
    expect(keypadPress('4821', 'back')).toBe('482');
    expect(keypadPress('', 'back')).toBe('');
    expect(keypadPress('4821', 'clear')).toBe('');
    for (const k of ['a', '-', ' ', '12', '', 'Enter']) expect(keypadPress('48', k), k).toBe('48');
  });
  it('typing 4-8-2-1 on the pad finds entry 4821 and only it; the empty pad shows the whole line; a code nobody holds shows nothing [kills: M4]', () => {
    const list = [entry('1234'), entry('4821', { displayName: 'Ben 7777' }), entry('7048')];
    let d = '';
    for (const k of ['4', '8', '2', '1']) d = keypadPress(d, k);
    expect(filterByCode(list, d).map((e) => e.code)).toEqual(['4821']);
    expect(filterByCode(list, '').map((e) => e.code)).toEqual(['1234', '4821', '7048']);
    expect(filterByCode(list, '9999')).toEqual([]);
    expect(filterByCode(list, '48').map((e) => e.code)).toContain('4821');
    // the search is by CODE, not by anything else on the row
    expect(filterByCode(list, '7777')).toEqual([]);
  });
});

describe('the row reads "4821 (dot) Ana (dot) 5 pax (dot) Pork+Chicken (dot) 12 min"', () => {
  const now = Date.UTC(2026, 9, 29, 3, 12, 30);
  it('with a package line', () => {
    const e = entry('4821', { lines: [{ lineKind: 'package', label: 'Pork+Chicken' }, { lineKind: 'a_la_carte', label: 'Beef' }] });
    expect(lobbyRowSummary(e as any, now)).toBe(`4821 ${DOT} Ana ${DOT} 5 pax ${DOT} Pork+Chicken ${DOT} 12 min`);
  });
  it('without any line the package part is simply left out', () => {
    expect(lobbyRowSummary(entry('4821') as any, now)).toBe(`4821 ${DOT} Ana ${DOT} 5 pax ${DOT} 12 min`);
  });
});

describe('seat pre-fill: pax, name in notes, mapped lines, unmapped shown as text', () => {
  it('maps what has a POS key, keeps the rest as text, drops nothing [kills: M5, M8]', () => {
    const e = entry('4821', {
      note: 'window seat',
      lines: [
        { lineKind: 'package', qty: 5, variantId: 'v1', optionValueIds: [], label: 'Pork+Chicken', posItemKey: 'PKG-1' },
        { lineKind: 'a_la_carte', qty: 2, variantId: 'v2', optionValueIds: [], label: 'Cheese Dip', posItemKey: null },
        { lineKind: 'a_la_carte', qty: 1, variantId: 'v3', optionValueIds: [], label: 'Beef Add-on', posItemKey: 'BEEF-9' },
      ],
    });
    const p = prefillForSeat(e as any);
    expect(p.partySize).toBe(5);
    expect(p.notes).toContain('Ana');
    expect(p.notes).toContain('window seat');
    expect(p.items).toEqual([{ posItemKey: 'PKG-1', qty: 5 }, { posItemKey: 'BEEF-9', qty: 1 }]);
    expect(p.textLines).toEqual([{ label: 'Cheese Dip', qty: 2 }]);
    expect(p.items.length + p.textLines.length).toBe(e.lines.length);
  });
  it('an entry with no lines and no note still carries pax and the name', () => {
    const p = prefillForSeat(entry('4821', { note: null }) as any);
    expect(p).toMatchObject({ partySize: 5, items: [], textLines: [] });
    expect(p.notes).toContain('Ana');
  });
});

describe('after the session starts: link it to the waiting entry; if that fails the session stands and the row offers "Retry link"', () => {
  const base = { entryId: 'E1', sessionId: 'S1', standLabel: '7' };
  it('join URL fetched, then seat called with it: linked', async () => {
    const seat = vi.fn(async (_b: unknown) => ({ ok: true }));
    const r = await linkSeatedSession({ ...base, fetchJoinUrl: async () => 'https://customer.shareat.net/join?token=abc', seat });
    expect(r).toEqual({ linked: true });
    expect(seat).toHaveBeenCalledTimes(1);
    expect(seat).toHaveBeenCalledWith({ ...base, joinUrl: 'https://customer.shareat.net/join?token=abc' });
  });
  it('the seat call fails (409, 503, network): no throw, "Retry link", and a retry with the same inputs can then succeed [kills: M6]', async () => {
    let up = false;
    const seat = vi.fn(async (_b: unknown) => {
      if (!up) throw Object.assign(new Error('down'), { status: 503 });
      return { ok: true };
    });
    const args = { ...base, fetchJoinUrl: async () => 'https://customer.shareat.net/join?token=abc', seat };
    const first = await linkSeatedSession(args);
    expect(first).toEqual({ linked: false, retryLabel: 'Retry link' });
    expect(LOBBY_RETRY_LABEL).toBe('Retry link');
    up = true;
    expect(await linkSeatedSession(args)).toEqual({ linked: true });
    expect(seat).toHaveBeenCalledTimes(2);
  });
  it('the join-URL fetch fails: no throw, "Retry link", and seat is NOT called [kills: M7]', async () => {
    const seat = vi.fn(async (_b: unknown) => ({ ok: true }));
    const r = await linkSeatedSession({
      ...base,
      fetchJoinUrl: async () => {
        throw new Error('join-url 500');
      },
      seat,
    });
    expect(r).toEqual({ linked: false, retryLabel: 'Retry link' });
    expect(seat).not.toHaveBeenCalled();
  });
});
