// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_CLOSED_NOW,
  CLAIM_REJECT_REASONS,
  CLAIM_UNSURE,
  CLAIMS_NOT_LOADED,
  DINER_NO_MAX,
  claimApproveBlock,
  claimHint,
  claimLine,
  claimOfferLabel,
  claimRejectText,
  createClaimsPoller,
  decideWithRecheck,
  dinerNoOfRef,
  dinerRefOf,
  loadApprovedClaims,
  type ApprovedClaimView,
  type ClaimListResult,
  type ClaimView,
} from '../src/app/pos/_lobby/claims';
import type { LobbyResult } from '../src/app/pos/_lobby/logic';
import { DiscountSheet } from '../src/app/pos/_payment/DiscountSheet';
import type { BillLine } from '../src/app/pos/_payment/logic';

/**
 * T-644 S4 - senior / PWD discount claims in the live POS: the pure half (fixed reject reasons, the statutory-diner reference, the approve gate, the lost-reply recheck, the strip poller,
 * the payment-screen offers) and its wiring. No database, no network. The Server Actions are proved against Postgres in tests/integration/t644-s4-claim-actions.test.ts.
 * MUTANT INDEX (each title ends with "[kills: ...]"): a reject reason typed by hand or a label accepted as a code; a reference built another way, over 80 characters, or read back from another
 * session; a list line that prints a full ID number; an approve allowed with no seat, no diner number or no card tick; a lost reply shown as a failure, or counted as done without asking the server,
 * or a wrong status counted as done; a poll with no single-flight rule or a stale answer applied; an offer on the payment screen that is already chosen, that adds the discount itself, or that
 * carries a name; a name or ID number kept in storage, in a list view or in an input with a hand-written limit; a field rule judged before authorize; a store read from the body.
 */
const SRC = resolve(__dirname, '..', 'src', 'app', 'pos');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** Code only: block comments and whole-line `//` comments out, so a comment that SAYS "never localStorage" does not trip a scan for it. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SESSION = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';

describe('the four fixed reject reasons', () => {
  it('each code gives its sentence, every sentence fits the domain cap of 80, and anything else is null [kills: a free-text or label accepted as a code, a sentence the domain would refuse]', () => {
    expect(CLAIM_REJECT_REASONS.map((r) => r.code)).toEqual(['card_not_shown', 'id_mismatch', 'card_not_valid', 'already_claimed']);
    for (const r of CLAIM_REJECT_REASONS) {
      expect(claimRejectText(r.code)).toBe(r.label);
      expect(r.label.length).toBeGreaterThan(10);
      expect(r.label.length).toBeLessThanOrEqual(80);
    }
    for (const bad of ['The ID is fake', '', '   ', 'CARD_NOT_SHOWN', 'card_not_shown ', CLAIM_REJECT_REASONS[0].label, undefined, null, 7, {}]) {
      expect(claimRejectText(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('ruling 6: the statutory-diner reference is `${sessionId}:${dinerNo}`', () => {
  it('is built that way, stays far under 80 characters for every diner, and reads back [kills: a reference built another way, a reference over the 80 cap]', () => {
    expect(dinerRefOf(SESSION, 3)).toBe(`${SESSION}:3`);
    for (let n = 1; n <= DINER_NO_MAX; n += 1) {
      const ref = dinerRefOf(SESSION, n);
      expect(ref.length).toBeLessThanOrEqual(80);
      expect(dinerNoOfRef(SESSION, ref)).toBe(n);
    }
  });

  it('a reference of another session, a malformed tail or a number out of range is not read as a diner [kills: the claim of another table offered on this bill, a diner 0, 31 or "01"]', () => {
    const other = '0192a3b4-c5d6-7e8f-9a0b-ffffffffffff';
    for (const ref of [`${other}:2`, `${SESSION}:0`, `${SESSION}:31`, `${SESSION}:01`, `${SESSION}:1a`, `${SESSION}:`, SESSION, `${SESSION}:-1`, `${SESSION}:1.5`, `${SESSION}:2:3`, '']) {
      expect(dinerNoOfRef(SESSION, ref), JSON.stringify(ref)).toBeNull();
    }
  });
});

describe('the list line', () => {
  const row = { code: '4821', standLabel: '7', kind: 'senior' as const, idMasked: '****1187' };
  it('shows the code, the stand, the kind and the masked ID [kills: a line that drops the mask]', () => {
    expect(claimLine(row)).toBe('4821 · Stand 7 · Senior · ****1187');
    expect(claimLine({ ...row, standLabel: null, kind: 'pwd' })).toBe('4821 · PWD · ****1187');
  });
  it('a masked field that is not ****last4 prints as **** so a full ID number never reaches the screen [kills: a list line that prints a full ID number]', () => {
    for (const bad of ['OSCA-9990042', '99900421187', '', '****', '*****1187']) expect(claimLine({ ...row, idMasked: bad }), bad).not.toMatch(/OSCA|9990042|11871/);
    expect(claimLine({ ...row, idMasked: 'OSCA-9990042' })).toBe('4821 · Stand 7 · Senior · ****');
  });
});

describe('the approve gate', () => {
  it('needs a seat, then a diner number, then the card tick, in that order [kills: an approve allowed with no seat, no diner number or no card tick]', () => {
    expect(claimApproveBlock({ sessionRef: null, dinerNo: 1, cardSeen: true })).toMatch(/Seat the party/);
    expect(claimApproveBlock({ sessionRef: '  ', dinerNo: 1, cardSeen: true })).toMatch(/Seat the party/);
    expect(claimApproveBlock({ sessionRef: SESSION, dinerNo: null, cardSeen: true })).toMatch(/diner/i);
    expect(claimApproveBlock({ sessionRef: SESSION, dinerNo: 2, cardSeen: false })).toMatch(/Tick the box/);
    expect(claimApproveBlock({ sessionRef: SESSION, dinerNo: 2, cardSeen: true })).toBeNull();
  });
});

describe('decide, and ask the server when the answer is lost', () => {
  const ok = async (): Promise<LobbyResult> => ({ ok: true });
  const status = (s: string) => vi.fn(async (): Promise<LobbyResult<{ status: string }>> => ({ ok: true, status: s }));

  it('a reply that says ok is done and the status is not asked [kills: a status call after every move]', async () => {
    const st = status('approved');
    expect(await decideWithRecheck('approved', { act: ok, status: st })).toEqual({ done: true });
    expect(st).not.toHaveBeenCalled();
  });

  it('a refusal that may pass (not final) shows its sentence and asks nothing [kills: a refusal turned into a status guess]', async () => {
    const st = status('approved');
    const r = await decideWithRecheck('approved', { act: async () => ({ ok: false, error: 'Please check the card first, then tick that you have seen it.' }), status: st });
    expect(r).toEqual({ done: false, message: 'Please check the card first, then tick that you have seen it.' });
    expect(st).not.toHaveBeenCalled();
  });

  it('a lost reply (the call threw) asks the server and is done only when the claim is in fact approved [kills: a lost reply shown as a failure]', async () => {
    const st = status('approved');
    expect(await decideWithRecheck('approved', { act: async () => Promise.reject(new Error('offline')), status: st })).toEqual({ done: true });
    expect(st).toHaveBeenCalledTimes(1);
  });

  it('a lost reply on a claim that is still pending is NOT done: try again [kills: a lost reply counted as success without asking]', async () => {
    const r = await decideWithRecheck('approved', { act: async () => Promise.reject(new Error('offline')), status: status('pending') });
    expect(r).toEqual({ done: false, message: CLAIM_UNSURE });
  });

  it('a retry refused as closed is done when the claim is approved and not done when it was rejected or expired [kills: a wrong status counted as done]', async () => {
    const closed = async (): Promise<LobbyResult> => ({ ok: false, error: 'That discount claim can no longer be changed.', final: true });
    expect(await decideWithRecheck('approved', { act: closed, status: status('approved') })).toEqual({ done: true });
    expect(await decideWithRecheck('approved', { act: closed, status: status('rejected') })).toEqual({ done: false, message: CLAIM_CLOSED_NOW });
    expect(await decideWithRecheck('rejected', { act: closed, status: status('approved') })).toEqual({ done: false, message: CLAIM_CLOSED_NOW });
    expect(await decideWithRecheck('rejected', { act: closed, status: status('rejected') })).toEqual({ done: true });
  });

  it('when the status call itself fails the answer is one plain sentence, never a thrown error [kills: a recheck that throws into the dialog]', async () => {
    const r1 = await decideWithRecheck('approved', { act: async () => Promise.reject(new Error('offline')), status: async () => Promise.reject(new Error('offline')) });
    expect(r1).toEqual({ done: false, message: CLAIM_UNSURE });
    const r2 = await decideWithRecheck('approved', { act: async () => Promise.reject(new Error('offline')), status: async () => ({ ok: false, error: 'We could not find that place in line.' }) });
    expect(r2).toEqual({ done: false, message: 'We could not find that place in line.' });
  });
});

describe('the strip poller', () => {
  const view = (n: number): ClaimView => ({ claimId: `c${n}`, entryId: 'e', code: '4821', displayName: 'Ana', standLabel: '7', partySize: 4, kind: 'senior', idMasked: '****1187', status: 'pending', createdAt: '2026-11-26T10:00:00.000Z' });

  it('keeps ONE list call in flight and re-runs once when a tick came meanwhile [kills: a second request per tick]', async () => {
    let release!: (r: ClaimListResult) => void;
    let calls = 0;
    const applied: unknown[] = [];
    const p = createClaimsPoller({
      list: () => {
        calls += 1;
        return calls === 1 ? new Promise<ClaimListResult>((res) => (release = res)) : Promise.resolve<ClaimListResult>({ ok: true, claims: [view(2)] });
      },
      apply: (o) => void applied.push(o),
    });
    const first = p.poll();
    await p.poll();
    await p.poll();
    expect(calls).toBe(1);
    release({ ok: true, claims: [view(1)] });
    await first;
    await vi.waitFor(() => expect(applied).toHaveLength(2));
    expect(calls).toBe(2);
    expect(applied).toEqual([{ claims: [view(1)] }, { claims: [view(2)] }]);
  });

  it('a thrown call and a refusal become one sentence and never an empty list [kills: a failed poll that wipes the strip]', async () => {
    const applied: unknown[] = [];
    await createClaimsPoller({ list: async () => Promise.reject(new Error('offline')), apply: (o) => void applied.push(o) }).poll();
    await createClaimsPoller({ list: async () => ({ ok: false, error: "Open the lobby on the store's paired tablet." }), apply: (o) => void applied.push(o) }).poll();
    expect(applied).toEqual([{ error: CLAIMS_NOT_LOADED }, { error: "Open the lobby on the store's paired tablet." }]);
  });
});

describe('the payment screen offers approved claims', () => {
  const claim: ApprovedClaimView = { kind: 'senior', idLast4: '1187', dinerNo: 2 };

  it('a refusal, a thrown call and an old answer are an empty list, never an error on the payment screen [kills: a payment screen that breaks when the lobby is unreachable]', async () => {
    expect(await loadApprovedClaims(async () => ({ ok: true, claims: [claim] }), SESSION)).toEqual([claim]);
    expect(await loadApprovedClaims(async () => ({ ok: false, error: 'x' }), SESSION)).toEqual([]);
    expect(await loadApprovedClaims(async () => Promise.reject(new Error('offline')), SESSION)).toEqual([]);
  });

  it('the offer names the kind, the diner and the last 4 only; the hint appears only for that diner and kind [kills: an offer that carries a name or a full number, a hint on the wrong diner]', () => {
    expect(claimOfferLabel(claim)).toBe('Senior · diner 2 · ID ****1187');
    expect(claimOfferLabel({ kind: 'pwd', idLast4: 'A9', dinerNo: 1 })).toBe('PWD · diner 1 · ID ****A9');
    expect(claimHint([claim], { dinerNo: 2, kind: 'senior' })).toBe('Approved at the lobby: the ID ends in 1187. Check it against the card.');
    expect(claimHint([claim], { dinerNo: 3, kind: 'senior' })).toBeNull();
    expect(claimHint([claim], { dinerNo: 2, kind: 'pwd' })).toBeNull();
    expect(claimHint([], { dinerNo: 2, kind: 'senior' })).toBeNull();
  });

  const line: BillLine = { lineId: '0192a3b4-0000-7000-8000-000000000001', name: 'Pork belly', kind: 'item', qty: 2, bundleHeads: null, unitPrice: '100.00', discounts: [] };
  const sheet = (over: Record<string, unknown>) => {
    const onAdd = vi.fn(async () => null);
    const html = renderToStaticMarkup(createElement(DiscountSheet, { target: { kind: 'line', line }, bill: [line], heads: 4, presets: [], onClose: () => undefined, onAdd, onApplyAll: async () => null, ...over } as never));
    return { html, onAdd };
  };

  it('the sheet lists the claim as a quick-pick, with NOTHING chosen and Add discount off, and calls nothing on render [kills: an offer that is already chosen, a pre-fill that adds the discount itself]', () => {
    const { html, onAdd } = sheet({ lobbyClaims: [claim] });
    expect(html).toContain('Approved at the lobby');
    expect(html).toContain('Senior · diner 2 · ID ****1187');
    expect(html).toContain('Nothing is taken off until you do.');
    expect(html.match(/aria-pressed="true"/g) ?? [], 'nothing is pre-chosen').toHaveLength(0);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add discount<\/button>/);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('no claims, or a sheet for every line, shows no offer section [kills: an offer section with nothing to offer]', () => {
    expect(sheet({}).html).not.toContain('Approved at the lobby');
    expect(sheet({ lobbyClaims: [] }).html).not.toContain('Approved at the lobby');
    expect(sheet({ target: { kind: 'all' }, lobbyClaims: [claim] }).html).not.toContain('Approved at the lobby');
  });
});

describe('the wiring', () => {
  it('the dialog and the strip keep the name and ID number out of storage, out of lists and out of typed inputs [kills: a name or number in localStorage, in the list view, or in an input with a hand-written limit]', () => {
    for (const f of ['_lobby/ClaimDialog.tsx', '_lobby/ClaimsStrip.tsx', '_lobby/claims.ts']) {
      expect(code(f), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|console\./);
    }
    const dialog = code('_lobby/ClaimDialog.tsx');
    expect(dialog).toContain('setOpened(null)'); // closing drops the opened claim
    expect([...dialog.matchAll(/<(?:input|Checkbox)\b[^>]*/g)].map((m) => m[0])).toHaveLength(1); // only the "I have seen the card" tick: no typed field at all
    expect(dialog).not.toMatch(/<textarea|maxLength=|pattern=/i);
    expect(dialog).toMatch(/CLAIM_REJECT_REASONS\.map/);
    expect(code('_lobby/ClaimsStrip.tsx')).not.toMatch(/holderName|idNumber/);
    const claims = code('_lobby/claims.ts');
    expect(claims.slice(claims.indexOf('export interface ClaimView'), claims.indexOf('export type ClaimListResult'))).not.toMatch(/holderName|idNumber/);
    expect(read('_lobby/Lobby.tsx')).toContain('<ClaimsStrip ready={ready} />');
  });

  it('every claim action needs the pairing, passes the pairing store as onlyStoreId, names no store in the body, and judges field rules only AFTER authorize [kills: a store read from the body, a claim probe across stores, a field rule before authorize]', () => {
    const actions = read('lobby/actions.ts');
    const claims = actions.slice(actions.indexOf('T-644 S4 - the senior / PWD discount claims'));
    expect(claims.length).toBeGreaterThan(1500);
    expect(claims).not.toMatch(/input\.storeId|storeId:\s*string/);
    expect(claims.match(/onlyStoreId: storeId/g)).toHaveLength(4); // open, status, approve, reject
    expect(claims.match(/\r?\n    true,\r?\n/g)).toHaveLength(6); // every one of the six needs the pairing
    for (const name of ['approveClaimAction', 'rejectClaimAction']) {
      const body = claims.slice(claims.indexOf(`export async function ${name}`));
      const end = body.indexOf('\nexport async function', 10);
      const one = end < 0 ? body : body.slice(0, end);
      expect(one.indexOf("await authorize(tx, actor, 'record_sale', { storeId })"), name).toBeGreaterThan(0);
      expect(one.indexOf("await authorize(tx, actor, 'record_sale', { storeId })"), name).toBeLessThan(one.indexOf('refuse('));
    }
    expect(claims).toContain('statutoryDinerRef: dinerRefOf(sessionId, dinerNo)');
    expect(actions).toMatch(/'LOBBY_BIRTHDAY_CLOSED' \|\| code === 'LOBBY_CLAIM_CLOSED' \|\| code === 'LOBBY_NOT_FOUND'/);
  });

  it('the payment screen only OFFERS: the claims effect sets state and nothing else, and no discount event is built from a claim [kills: a pre-fill that adds a discount without the cashier]', () => {
    const panel = read('_payment/PaymentPanel.tsx');
    const effect = panel.slice(panel.indexOf('const { loadLobbyClaims'), panel.indexOf('const askRepeat'));
    expect(effect).toContain('setLobbyClaims(c)');
    expect(effect).not.toMatch(/discountAddedEvent|sendEvent|setHolders|onAdd|addDiscount/);
    const sheet = read('_payment/DiscountSheet.tsx');
    const offer = sheet.slice(sheet.indexOf('lobbyClaims.map'), sheet.indexOf("choice?.type === 'custom' ? ("));
    expect(offer).toContain('setChoice({ type: c.kind }), setDinerNo(c.dinerNo)');
    expect(offer).not.toMatch(/onAdd|confirm\(/);
    expect(read('_orders/Orders.tsx')).toContain('loadLobbyClaims={pos.lobby?.approvedClaims}');
    expect(read('_lobby/use-lobby-poll.ts')).toContain('approvedClaimsForSessionAction');
  });
});
