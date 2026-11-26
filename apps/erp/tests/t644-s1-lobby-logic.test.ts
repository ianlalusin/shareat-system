import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { byHandLines, createLobbyPoller, createPollGuard, filterByCode, keypadPress, LOBBY_NOT_LOADED, lobbyRowSummary, type LobbyEntryView, type LobbyListView, type LobbyResult } from '../src/app/pos/_lobby/logic';

/**
 * T-644 S1 - the Lobby tab's pure half and its wiring into the shell. No database, no DOM.
 * MUTANT INDEX (each title ends with "[kills: ...]"): a poller with no single-flight rule; a poll mounted only on the Lobby tab (or on a phone / offline);
 * a stale answer replacing a newer one; a keypad that takes a fifth digit or a letter; a code search that matches names; an unmatched line not shown for hand entry.
 */
const SRC = resolve(__dirname, '..', 'src', 'app', 'pos');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

const entry = (over: Partial<LobbyEntryView> = {}): LobbyEntryView => ({
  entryId: 'e1', code: '4821', displayName: 'Ana', partySize: 5, status: 'waiting', source: 'lobby', note: null, phone: null,
  createdAt: '2026-11-26T10:00:00.000Z', calledAt: null, lines: [], ...over,
});
const LIST: LobbyListView = { lobbyEnabled: true, paused: false, entries: [entry()] };
const ok = (list: LobbyListView): LobbyResult<LobbyListView> => ({ ok: true, ...list });

describe('the poller is single-flight', () => {
  it('asks the server ONCE while a call is open, then once more (not once per skipped tick) when it ends [kills: a poller with no single-flight rule: a second request per tick on a slow connection]', async () => {
    let calls = 0;
    const open: ((r: LobbyResult<LobbyListView>) => void)[] = [];
    const seen: unknown[] = [];
    const poller = createLobbyPoller({ list: () => (calls++, new Promise<LobbyResult<LobbyListView>>((res) => open.push(res))), apply: (o) => seen.push(o) });
    const first = poller.poll();
    void poller.poll();
    void poller.poll();
    void poller.poll();
    expect(calls).toBe(1);
    open[0]!(ok(LIST));
    await first;
    expect(calls, 'the three skipped ticks collapse into ONE re-run').toBe(2);
    open[1]!(ok(LIST));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(seen).toHaveLength(2);
    // once idle, the next tick runs again
    const next = poller.poll();
    expect(calls).toBe(3);
    open[2]!(ok(LIST));
    await next;
  });

  it('a refused or failed call keeps the last list and says one plain sentence [kills: a failed poll that blanks the line]', async () => {
    const seen: unknown[] = [];
    let mode: 'ok' | 'refused' | 'throws' = 'ok';
    const poller = createLobbyPoller({
      list: async () => {
        if (mode === 'throws') throw new Error('network');
        return mode === 'refused' ? { ok: false, error: 'That is not allowed.' } : ok(LIST);
      },
      apply: (o) => seen.push(o),
    });
    await poller.poll();
    mode = 'refused';
    await poller.poll();
    mode = 'throws';
    await poller.poll();
    expect(seen).toEqual([{ list: LIST }, { error: 'That is not allowed.' }, { error: LOBBY_NOT_LOADED }]);
  });

  it('an answer older than one already applied is dropped [kills: a stale answer replacing a newer one]', () => {
    const g = createPollGuard();
    const a = g.begin()!;
    expect(g.end()).toBe(false);
    const b = g.begin()!;
    expect(g.accept(b)).toBe(true);
    expect(g.accept(a)).toBe(false);
  });
});

describe('the code keypad and the row', () => {
  it('takes digits up to four, drops the last, clears, ignores anything else [kills: a fifth digit, a letter, a broken Del]', () => {
    expect(['4', '8', '2', '1', '9'].reduce(keypadPress, '')).toBe('4821');
    expect(keypadPress('48', 'back')).toBe('4');
    expect(keypadPress('48', 'clear')).toBe('');
    expect(keypadPress('48', 'a')).toBe('48');
    expect(keypadPress('', 'back')).toBe('');
  });

  it('narrows the line by CODE only: a name or phone typed as digits does not match [kills: a search that matches names]', () => {
    const rows = [entry({ code: '4821' }), entry({ entryId: 'e2', code: '4830', displayName: '4821 Cruz' }), entry({ entryId: 'e3', code: '7100', phone: '4821' })];
    expect(filterByCode(rows, '').map((r) => r.entryId)).toEqual(['e1', 'e2', 'e3']);
    expect(filterByCode(rows, '48').map((r) => r.entryId)).toEqual(['e1', 'e2']);
    expect(filterByCode(rows, '4821').map((r) => r.entryId)).toEqual(['e1']);
  });

  it('the one-line summary names code, guest, pax, package and minutes [kills: a missing package or wait time]', () => {
    const now = new Date('2026-11-26T10:12:30.000Z').getTime();
    const lines = [{ lineKind: 'package' as const, qty: 5, variantId: 'v1', label: 'Pork', posItemKey: 'k1' }, { lineKind: 'package' as const, qty: 5, variantId: 'v2', label: 'Chicken', posItemKey: 'k2' }];
    expect(lobbyRowSummary(entry({ lines }), now)).toBe('4821 · Ana · 5 pax · Pork+Chicken · 12 min');
    expect(lobbyRowSummary(entry({ displayName: null }), now)).toBe('4821 · Guest · 5 pax · 12 min');
  });

  it('a line with no menu match is listed for the cashier to tap in by hand; a matched one is not [kills: an unmatched line silently dropped]', () => {
    const lines = [{ lineKind: 'a_la_carte' as const, qty: 2, variantId: 'v1', label: 'Pork belly', posItemKey: null }, { lineKind: 'a_la_carte' as const, qty: 1, variantId: 'v2', label: 'Cola', posItemKey: 'k2' }];
    expect(byHandLines({ lines })).toEqual(['2 x Pork belly (tap in by hand)']);
  });
});

describe('the wiring: the shell polls on every tab, the Lobby tab only reads', () => {
  it('PosShell mounts the poll for a paired, online, signed-in tablet with record_sale, and hands it down in the context [kills: a poll that lives only on the Lobby tab, on a phone, or on an offline sign-in]', () => {
    const shell = read('_shell/PosShell.tsx');
    expect(shell).toContain("import { useLobbyPoll } from '../_lobby/use-lobby-poll';");
    expect(shell).toMatch(/useLobbyPoll\(\{ enabled: pairedStoreId !== null && state\.online && !actor && caps\.has\('record_sale'\), storeId \}\)/);
    expect(shell).toMatch(/^\s+lobby,$/m);
    expect(read('_lobby/Lobby.tsx')).not.toMatch(/listLobbyAction|useLobbyPoll|setInterval/);
  });

  it('the poll hook runs the list action every 10 s and the server action is the stamping list, with the store named by the pairing helper only [kills: a list that skips the domain twin, a store read straight from the body]', () => {
    const hook = read('_lobby/use-lobby-poll.ts');
    expect(hook).toContain('LOBBY_POLL_MS');
    expect(hook).toContain('listLobbyAction');
    expect(read('_lobby/logic.ts')).toContain('export const LOBBY_POLL_MS = 10_000;');
    const actions = read('lobby/actions.ts');
    expect(actions).toContain('await listLobby(tx, actor, { storeId })');
    expect(actions).toContain('actionStore(actor');
    expect(actions).not.toMatch(/storeId:\s*input\.storeId/);
    expect(actions).toContain('onlyStoreId: storeId');
  });

  it('the Lobby tab is in the tab list under record_sale\'s prefix, and the page is gated like Reservations [kills: a tab with no page gate]', () => {
    expect(read('_shell/tabs.ts')).toContain("{ key: 'lobby', label: 'Lobby', href: '/pos/lobby' }");
    const page = read('lobby/page.tsx');
    expect(page).toContain("requirePageAccess('/pos/lobby')");
    expect(page).toContain("storeRefused(actor, storeId, 'record_sale')");
  });
});
