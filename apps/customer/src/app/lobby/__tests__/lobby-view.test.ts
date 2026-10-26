import { describe, it, expect } from 'vitest';
import {
  LOBBY_NAME_MAX,
  LOBBY_PARTY_MIN,
  LOBBY_PARTY_MAX,
  LOBBY_NOTE_MAX,
  COUNTER_NOTICE,
  CALLED_NOTICE,
  validateCheckIn,
  createCheckInAttempt,
  positionText,
  waitingText,
  storeScreenView,
  waitView,
} from '@/app/lobby/lobby-view';
import type { LobbyMyEntry } from '@/data/http-lobby-data';

/**
 * T-455 S4 tester: the PURE view-model behind the lobby screens (no jsdom / @testing-library in this repo, so the screens are
 * thin shells over these functions and the rules are pinned here). Every test names the mutant it kills.
 * Exact sentences come from docs/tasks/455-customer-lobby.md 3.1.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const good = { displayName: 'Ana', partySize: 4, note: '', lines: [] as unknown[] };
const form = (over: Record<string, unknown> = {}) => ({ ...good, ...over }) as Parameters<typeof validateCheckIn>[1];
const V = (over: Record<string, unknown> = {}, newId = () => '0190aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') =>
  validateCheckIn('LIPA', form(over), createCheckInAttempt(newId));

describe('check-in form bounds (3.1: name 1-40, party 1-30, note 60)', () => {
  it('exports the bounds the spec names', () => {
    // kills: a drifted constant (e.g. name 50) that the other cases would then agree with
    expect([LOBBY_NAME_MAX, LOBBY_PARTY_MIN, LOBBY_PARTY_MAX, LOBBY_NOTE_MAX]).toEqual([40, 1, 30, 60]);
  });

  it('accepts the edges: 1-char and 40-char name, party 1 and 30, 60-char note', () => {
    // kills: off-by-one that refuses the legal edge (< instead of <=)
    for (const o of [{ displayName: 'A' }, { displayName: 'a'.repeat(40) }, { partySize: 1 }, { partySize: 30 }, { note: 'n'.repeat(60) }]) {
      expect(V(o).ok, JSON.stringify(o)).toBe(true);
    }
  });

  it('refuses an empty / blank name and a 41-char name, with the error on displayName only', () => {
    // kills: no trim (a blank name passes), name cap 41+
    for (const name of ['', '   ', 'a'.repeat(41)]) {
      const r = V({ displayName: name });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['displayName']);
    }
  });

  it('trims the name before measuring and sending it', () => {
    // kills: sending the untrimmed name
    const r = V({ displayName: '  Ana  ' });
    expect(r.ok && r.value.displayName).toBe('Ana');
  });

  it('refuses party 0, 31, negative, fractional and NaN, error on partySize only', () => {
    // kills: no integer check, upper bound 31+, lower bound 0
    for (const p of [0, 31, -1, 2.5, Number.NaN]) {
      const r = V({ partySize: p });
      expect(r.ok, String(p)).toBe(false);
      if (!r.ok) expect(Object.keys(r.errors)).toEqual(['partySize']);
    }
  });

  it('refuses a 61-char note; an empty note is sent as no note', () => {
    // kills: note cap 61+; sending an empty string (server sees a blank note)
    const bad = V({ note: 'n'.repeat(61) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors)).toEqual(['note']);
    const empty = V({ note: '' });
    expect(empty.ok && (empty.value.note ?? null)).toBeNull();
  });

  it('refuses more than 20 lines (server limit, 4.1) and a qty below 1', () => {
    // kills: no client-side line bound (the diner sees a server error instead of the form hint)
    const line = (qty: number) => ({ variantId: 'v1', qty, lineKind: 'a_la_carte' as const });
    expect(V({ lines: Array.from({ length: 20 }, () => line(1)) }).ok).toBe(true);
    expect(V({ lines: Array.from({ length: 21 }, () => line(1)) }).ok).toBe(false);
    expect(V({ lines: [line(0)] }).ok).toBe(false);
  });

  it('reports every bad field at once', () => {
    // kills: returning on the first error only
    const r = V({ displayName: '', partySize: 0, note: 'n'.repeat(61) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['displayName', 'note', 'partySize']);
  });
});

describe('clientRequestId: a uuid generated ONCE per attempt', () => {
  it('is a uuid and the same value on a retry of the same attempt', () => {
    // kills: a new id per submit (a retry then creates a second place); a non-uuid id (S2 audit: S3 requires uuid shape)
    let n = 0;
    const attempt = createCheckInAttempt(() => `0190000${n++}-bbbb-4ccc-8ddd-eeeeeeeeeeee`);
    const a = validateCheckIn('LIPA', form(), attempt);
    const b = validateCheckIn('LIPA', form({ partySize: 5 }), attempt);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.clientRequestId).toMatch(UUID);
      expect(b.value.clientRequestId).toBe(a.value.clientRequestId);
    }
    expect(n).toBe(1);
  });

  it('a NEW attempt gets a NEW id, and the default generator makes real uuids', () => {
    // kills: a module-level constant id; an id derived from the name
    const a = validateCheckIn('LIPA', form(), createCheckInAttempt());
    const b = validateCheckIn('LIPA', form(), createCheckInAttempt());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.clientRequestId).toMatch(UUID);
      expect(b.value.clientRequestId).not.toBe(a.value.clientRequestId);
    }
  });
});

describe('payload privacy and no money (4, 3.1)', () => {
  const allowed = ['clientRequestId', 'displayName', 'lines', 'note', 'partySize', 'storeCode'];
  const dirty = {
    phone: '09171234567',
    email: 'a@b.ph',
    price: 1299,
    total: 5196,
    lines: [
      { variantId: 'v1', qty: 4, lineKind: 'package', optionValueIds: ['o1'], price: 599, unitPrice: 599, name: 'Pork', amount: 2396, total: 2396 },
    ],
  };

  it('carries only the allow-listed keys: no phone, no email, no price/total', () => {
    // kills: spreading the form into the payload (extra keys leak)
    const r = V(dirty as Record<string, unknown>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const keys = Object.keys(r.value).filter((k) => (r.value as unknown as Record<string, unknown>)[k] !== undefined);
      for (const k of keys) expect(allowed, k).toContain(k);
      expect(JSON.stringify(r.value)).not.toMatch(/09171234567|a@b\.ph/);
    }
  });

  it('each line carries only variantId, qty, lineKind, optionValueIds', () => {
    // kills: copying the whole line (the menu price rides along)
    const r = V(dirty as Record<string, unknown>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const line = (r.value.lines ?? [])[0] as unknown as Record<string, unknown>;
      expect(Object.keys(line).sort()).toEqual(['lineKind', 'optionValueIds', 'qty', 'variantId']);
      expect(JSON.stringify(r.value)).not.toMatch(/price|amount|total|cost|centavo|peso/i);
    }
  });

  it('puts the store code in the payload and nowhere else (no entry id, no code)', () => {
    // kills: a client-chosen entry id / queue code in the body
    const r = V();
    expect(r.ok && r.value.storeCode).toBe('LIPA');
    expect(r.ok && Object.keys(r.value)).not.toContain('entryId');
    expect(r.ok && Object.keys(r.value)).not.toContain('code');
  });
});

describe('position and waiting text', () => {
  it('plural: "3 parties ahead of you"', () => {
    // kills: wrong sentence / wrong number
    expect(positionText(3)).toBe('3 parties ahead of you');
    expect(positionText(12)).toBe('12 parties ahead of you');
  });
  it('singular: "1 party ahead of you" (not "1 parties")', () => {
    // kills: no singular branch
    expect(positionText(1)).toBe('1 party ahead of you');
  });
  it('zero: "You are next" (spec gives no sentence for 0; QUESTION in CONTRACT.md)', () => {
    // kills: "0 parties ahead of you" shown to the diner at the front of the line
    expect(positionText(0)).toBe('You are next');
  });
  it('store line: "N parties waiting", singular "1 party waiting", zero', () => {
    // kills: no singular branch
    expect(waitingText(5)).toBe('5 parties waiting');
    expect(waitingText(1)).toBe('1 party waiting');
    expect(waitingText(0)).toBe('0 parties waiting');
  });
});

const entry = (over: Partial<LobbyMyEntry> = {}): LobbyMyEntry => ({
  entryId: 'e1',
  code: '4821',
  status: 'waiting',
  partiesAhead: 3,
  displayName: 'Ana',
  partySize: 4,
  standLabel: null,
  handoffUrl: null,
  ...over,
});

describe('wait view: waiting, called, hand-off, closed', () => {
  it('waiting: shows the code and the position text, a Cancel button, no called notice', () => {
    // kills: code missing; cancel hidden while waiting
    const v = waitView(entry());
    expect(v.kind).toBe('waiting');
    expect(v.code).toBe('4821');
    expect(v.positionText).toBe('3 parties ahead of you');
    expect(v.notice).toBeNull();
    expect(v.canCancel).toBe(true);
    expect(v.handoffUrl).toBeNull();
  });

  it('called: the notice is exactly "Please come to the counter"', () => {
    // kills: notice only on waiting; a reworded notice
    const v = waitView(entry({ status: 'called', partiesAhead: 0 }));
    expect(v.kind).toBe('called');
    expect(v.notice).toBe(CALLED_NOTICE);
    expect(CALLED_NOTICE).toBe('Please come to the counter');
    expect(v.canCancel).toBe(true);
  });

  it('seated with a link: hand-off, URL is exactly the server value, Cancel gone', () => {
    // kills: building the URL client-side; keeping Cancel on a seated party
    const url = 'https://customer.shareat.net/join?t=SERVERTOKEN';
    const v = waitView(entry({ status: 'seated', handoffUrl: url, standLabel: '7' }));
    expect(v.kind).toBe('handoff');
    expect(v.handoffUrl).toBe(url);
    expect(v.canCancel).toBe(false);
  });

  it('seated WITHOUT a link (already handed off / lost): no URL is invented', () => {
    // kills: fabricating a customer.shareat.net URL from the stand label or code
    const v = waitView(entry({ status: 'seated', handoffUrl: null, standLabel: '7' }));
    expect(v.handoffUrl).toBeNull();
    expect(v.kind).not.toBe('waiting');
  });

  it('cancelled / removed / expired: closed, no Cancel, no link', () => {
    // kills: terminal states treated as waiting (a poll loop on a dead entry); a link leaking from a closed entry
    for (const status of ['cancelled', 'removed', 'expired'] as const) {
      const v = waitView(entry({ status, handoffUrl: 'https://x.test/leak' }));
      expect(v.kind, status).toBe('closed');
      expect(v.canCancel).toBe(false);
      expect(v.handoffUrl).toBeNull();
    }
  });
});

describe('store screen: a paused / disabled / stale store shows the counter sentence and NO form', () => {
  const open = { storeCode: 'LIPA', storeName: 'Shareat Lipa', partiesWaiting: 5, accepting: true };

  it('open store: name, "5 parties waiting", the form link, the menu, no counter notice', () => {
    // kills: form link hidden on the happy path
    const v = storeScreenView({ ok: true, value: open });
    expect(v.title).toBe('Shareat Lipa');
    expect(v.waitingText).toBe('5 parties waiting');
    expect(v.showForm).toBe(true);
    expect(v.checkInHref).toBe('/lobby/check-in?s=LIPA');
    expect(v.showMenu).toBe(true);
    expect(v.notice).toBeNull();
  });

  it('store says accepting:false (paused, disabled or POS unseen > 5 min): counter sentence, menu only, no form, no link', () => {
    // kills: the form still rendered but "disabled"; the Join button reachable by link
    const v = storeScreenView({ ok: true, value: { ...open, accepting: false } });
    expect(v.notice).toContain('Please check in at the counter');
    expect(v.showForm).toBe(false);
    expect(v.checkInHref).toBeNull();
    expect(v.showMenu).toBe(true);
  });

  it('server refusal 409 (limit/paused/disabled/stale/unknown store): same screen, still no form', () => {
    // kills: surfacing the raw error or an empty page; treating a refusal as "open"
    const v = storeScreenView({ ok: false, status: 409, error: 'Please check in at the counter.' });
    expect(v.notice).toContain('Please check in at the counter');
    expect(v.showForm).toBe(false);
    expect(v.checkInHref).toBeNull();
  });

  it('phone offline (status 0), 404 and 500: no form either, never an open store', () => {
    // kills: fail-open when the store snapshot cannot be read
    for (const status of [0, 404, 500]) {
      const v = storeScreenView({ ok: false, status, error: 'x' });
      expect(v.showForm, String(status)).toBe(false);
      expect(v.checkInHref, String(status)).toBeNull();
    }
  });

  it('the counter notice constant is the spec sentence', () => {
    // kills: reworded sentence
    expect(COUNTER_NOTICE).toBe('Please check in at the counter');
  });
});
