/**
 * T-455 S7b (TESTER) - the cashier-side rules of the senior / PWD discount claim (pure: no React, no Firebase, no fetch).
 * docs/tasks/455-customer-lobby.md S7b row + "S7a rulings"; T-426 (docs/tasks/426-pos-v2-sc-pwd-per-diner.md) capture rules.
 *
 * RED FOR THE RIGHT REASON: `@/lib/pos2/lobbyClaims` does not exist, so every case fails on "Failed to resolve import".
 *
 * ASSUMPTIONS NEEDING A RULING (numbered; the builder matches these unless Ian/BOSS rules otherwise)
 *  1. New pure module src/lib/pos2/lobbyClaims.ts (client-safe, also imported by the server route for the reject list). Exports below.
 *  2. FIXED REJECT LIST, 4 reasons, each 1..80 chars (the domain cap), diner-facing plain words, codes stable, order stable:
 *       card_not_shown   "We could not see your ID card. Please show it to the cashier."
 *       id_mismatch      "The ID number did not match the card."
 *       card_not_valid   "This card cannot be used for the discount."
 *       already_claimed  "This card was already used for this table."
 *     The screen offers chips only (no text field); the route takes `reasonCode`, never free text.
 *  3. The BADGE: (a) on each LobbyCard row whose entry has pending claims ("1 SC/PWD claim" / "2 SC/PWD claims", matched by entryId);
 *     (b) a "Discount claims" strip under the list (seated parties leave the live list, but their claims stay pending until approved), one line per
 *     claim: "4821 · Stand 7 · Senior · ****1187" with an Open button. The strip also shows when no row is on the list.
 *  4. Claim lists carry ****last4 only: the line builder drops any other field it is handed (defence in depth against a leaky route).
 *  5. T-426 dialog: a new LobbyClaimDialog (not a change to the bill-screen panel) is pre-filled from `claimOpen` (kind, name, ID number), shows the
 *     "I have seen the card" tick UNTICKED every time it opens; saving needs the tick, a name, an ID, and a seated session (open.sessionRef).
 *  6. Save = (a) write the T-426 diner through the SAME transactional writer (mutateStatutoryDiners 'add'), (b) call claim-approve with
 *     statutoryDinerRef = that diner's id and sessionRef = the session id. A retry after a failed approve finds the diner by NORMALISED ID
 *     (normalizeIdNo: spaces/hyphens/case ignored) in the session's diners and does NOT add a second one (T-426 duplicate-id refusal stays the net).
 *  7. A 409 on approve is a refusal, shown with the server's own sentence, NOT "already done" (unlike S5's seat): it may be "card not seen",
 *     "seat first" or "closed". The diner stays written once; the next poll drops a closed claim from the badge.
 *  8. Offline / 503 / status 0: claim lists say CLAIMS_UNAVAILABLE and the strip hides the Open buttons; an approve that fails that way keeps the
 *     diner written on the bill and answers reason 'retry' with CLAIM_RETRY_MESSAGE (never claims the discount is confirmed).
 *  9. The opened name and ID number live in component memory only (never localStorage / sessionStorage / the pending-links store).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CLAIMS_UNAVAILABLE,
  CLAIM_RETRY_MESSAGE,
  LOBBY_REJECT_REASONS,
  approveClaimFlow,
  claimBadgeLabel,
  claimFailure,
  claimListLine,
  claimSaveBlock,
  claimsByEntry,
  emptyClaimForm,
  prefillFromClaim,
  rejectClaimFlow,
  rejectReasonText,
} from '@/lib/pos2/lobbyClaims';

const DOT = '·';
const OPEN = {
  claimId: '019e4444-4444-7444-8444-444444444444',
  entryId: '019e3333-3333-7333-8333-333333333333',
  code: '4821',
  kind: 'senior' as const,
  holderName: 'Maria Santos',
  idNumber: '123-456-1187',
  idLast4: '1187',
  partySize: 5,
  standLabel: '7',
  sessionRef: 'SESS-1',
};
const FORM = { kind: 'senior' as const, name: 'Maria Santos', idNo: '123-456-1187', cardSeen: true };

describe('the fixed reject list (no free text reaches the diner)', () => {
  it('has 3-4 reasons, unique codes, each 1..80 chars, plain sentences [kills: free-text / over-long reason refused by the server]', () => {
    expect(LOBBY_REJECT_REASONS.length).toBeGreaterThanOrEqual(3);
    expect(LOBBY_REJECT_REASONS.length).toBeLessThanOrEqual(4);
    expect(new Set(LOBBY_REJECT_REASONS.map((r) => r.code)).size).toBe(LOBBY_REJECT_REASONS.length);
    for (const r of LOBBY_REJECT_REASONS) {
      expect(r.label.trim()).toBe(r.label);
      expect(r.label.length).toBeGreaterThanOrEqual(1);
      expect(r.label.length).toBeLessThanOrEqual(80);
      expect(r.label).toMatch(/[.]$/);
    }
  });

  it('proposed wording is exactly the four sentences in assumption 2', () => {
    expect(LOBBY_REJECT_REASONS.map((r) => [r.code, r.label])).toEqual([
      ['card_not_shown', 'We could not see your ID card. Please show it to the cashier.'],
      ['id_mismatch', 'The ID number did not match the card.'],
      ['card_not_valid', 'This card cannot be used for the discount.'],
      ['already_claimed', 'This card was already used for this table.'],
    ]);
  });

  it('rejectReasonText maps a known code to its sentence and anything else (free text, a label, junk, non-string) to null [kills: M1 free text accepted]', () => {
    expect(rejectReasonText('id_mismatch')).toBe('The ID number did not match the card.');
    for (const bad of ['Maria is rude', 'The ID number did not match the card.', '', ' id_mismatch', 'ID_MISMATCH', 7, null, undefined, {}]) {
      expect(rejectReasonText(bad as never), String(bad)).toBeNull();
    }
  });
});

describe('badge and list line show ****last4 only', () => {
  const rows = [
    { claimId: 'c1', entryId: 'e1', kind: 'senior' },
    { claimId: 'c2', entryId: 'e1', kind: 'pwd' },
    { claimId: 'c3', entryId: 'e2', kind: 'senior' },
  ];

  it('claimsByEntry counts pending claims per entry id', () => {
    const m = claimsByEntry(rows as never);
    expect(m.e1).toEqual({ count: 2, seniors: 1, pwds: 1 });
    expect(m.e2).toEqual({ count: 1, seniors: 1, pwds: 0 });
    expect(m.e3).toBeUndefined();
    expect(claimsByEntry([])).toEqual({});
  });

  it('claimBadgeLabel: null for none, singular / plural otherwise [kills: M2 badge on a row with no claims]', () => {
    expect(claimBadgeLabel(undefined)).toBeNull();
    expect(claimBadgeLabel({ count: 0, seniors: 0, pwds: 0 })).toBeNull();
    expect(claimBadgeLabel({ count: 1, seniors: 1, pwds: 0 })).toBe('1 SC/PWD claim');
    expect(claimBadgeLabel({ count: 2, seniors: 1, pwds: 1 })).toBe('2 SC/PWD claims');
  });

  it('claimListLine reads "4821 · Stand 7 · Senior · ****1187" and never prints a name or a full ID even if the row carries them [kills: M3 PII in lists]', () => {
    const line = claimListLine({ code: '4821', standLabel: '7', kind: 'senior', idMasked: '****1187', holderName: 'Maria Santos', idNumber: '123-456-1187', idLast4: '1187' } as never);
    expect(line).toBe(['4821', 'Stand 7', 'Senior', '****1187'].join(` ${DOT} `));
    expect(line).not.toMatch(/Maria|Santos|123-456|1234561187/);
    expect(claimListLine({ code: '4821', standLabel: null, kind: 'pwd', idMasked: '****0042' } as never)).toBe(['4821', 'PWD', '****0042'].join(` ${DOT} `));
  });

  it('claimListLine refuses to print an unmasked "idMasked" (a full ID smuggled into that field is replaced by ****)', () => {
    const line = claimListLine({ code: '4821', standLabel: '7', kind: 'senior', idMasked: '123-456-1187' } as never);
    expect(line).not.toContain('123-456-1187');
    expect(line).toContain('****');
  });
});

describe('prefill and the "card seen" tick', () => {
  it('prefillFromClaim copies kind, name and ID number and starts with the tick OFF every time [kills: M4 tick pre-ticked]', () => {
    expect(prefillFromClaim(OPEN)).toEqual({ kind: 'senior', name: 'Maria Santos', idNo: '123-456-1187', cardSeen: false });
    expect(prefillFromClaim({ ...OPEN, kind: 'pwd' as const }).kind).toBe('pwd');
  });

  it('claimSaveBlock: ticked + name + ID + seated session = ok; unticked blocks save [kills: M5 untick still saves]', () => {
    expect(claimSaveBlock(FORM, OPEN.sessionRef)).toEqual({ ok: true });
    expect(claimSaveBlock({ ...FORM, cardSeen: false }, OPEN.sessionRef)).toMatchObject({ ok: false, reason: 'card-not-seen' });
    for (const bad of [undefined, null, 'true', 1]) {
      expect(claimSaveBlock({ ...FORM, cardSeen: bad as never }, OPEN.sessionRef), String(bad)).toMatchObject({ ok: false, reason: 'card-not-seen' });
    }
  });

  it('claimSaveBlock: a blank name, a blank ID, or a party not seated yet (sessionRef null) also blocks, each with its own reason', () => {
    expect(claimSaveBlock({ ...FORM, name: '  ' }, OPEN.sessionRef)).toMatchObject({ ok: false, reason: 'name' });
    expect(claimSaveBlock({ ...FORM, idNo: '' }, OPEN.sessionRef)).toMatchObject({ ok: false, reason: 'id' });
    expect(claimSaveBlock(FORM, null)).toMatchObject({ ok: false, reason: 'needs-seat' });
    for (const r of [claimSaveBlock({ ...FORM, cardSeen: false }, OPEN.sessionRef), claimSaveBlock(FORM, null)]) {
      expect((r as { message: string }).message.length).toBeGreaterThan(0);
    }
  });
});

describe('approveClaimFlow: the T-426 diner is written once, even when approve is retried', () => {
  const mk = (over: Record<string, unknown> = {}) => {
    const addDiner = vi.fn(async (_e: { kind: string; name: string; idNo: string }) => ({ dinerId: 'diner-1' }));
    const approve = vi.fn(async (_b: Record<string, unknown>) => ({ ok: true }));
    return { addDiner, approve, base: { open: OPEN, form: FORM, diners: [] as { id: string; idNo: string }[], addDiner, approve, ...over } };
  };

  it('happy path: diner written with the form values, THEN approve with cardSeen true, the session and the diner id [kills: M6 approve before diner, M7 wrong ref]', async () => {
    const t = mk();
    const r = await approveClaimFlow(t.base as never);
    expect(r).toMatchObject({ done: true, dinerId: 'diner-1' });
    expect(t.addDiner).toHaveBeenCalledTimes(1);
    expect(t.addDiner).toHaveBeenCalledWith({ kind: 'senior', name: 'Maria Santos', idNo: '123-456-1187' });
    expect(t.approve).toHaveBeenCalledTimes(1);
    expect(t.approve).toHaveBeenCalledWith({ claimId: OPEN.claimId, cardSeen: true, sessionRef: 'SESS-1', statutoryDinerRef: 'diner-1' });
    expect(t.addDiner.mock.invocationCallOrder[0]).toBeLessThan(t.approve.mock.invocationCallOrder[0]!);
  });

  it("uses the CASHIER-EDITED form values (a corrected name / ID), not the diner's typed ones", async () => {
    const t = mk({ form: { ...FORM, name: 'Maria L. Santos', idNo: '123-456-1188' } });
    await approveClaimFlow(t.base as never);
    expect(t.addDiner).toHaveBeenCalledWith({ kind: 'senior', name: 'Maria L. Santos', idNo: '123-456-1188' });
  });

  it('retried approve: approve failed offline first (diner stays written), the retry reuses that diner by normalised ID; writes happen ONCE in total [kills: M8 second diner on retry]', async () => {
    const t = mk();
    t.approve.mockRejectedValueOnce(Object.assign(new Error('offline'), { status: 503 }));
    const first = await approveClaimFlow(t.base as never);
    expect(first).toMatchObject({ done: false, reason: 'retry', dinerId: 'diner-1', message: CLAIM_RETRY_MESSAGE });
    // the screen re-reads the session: the diner is now on it, typed with different spacing / case
    const second = await approveClaimFlow({ ...t.base, diners: [{ id: 'diner-1', idNo: '123 456 1187' }] } as never);
    expect(second).toMatchObject({ done: true, dinerId: 'diner-1' });
    expect(t.addDiner).toHaveBeenCalledTimes(1);
    expect(t.approve).toHaveBeenCalledTimes(2);
    expect(t.approve.mock.calls[1]![0]).toMatchObject({ claimId: OPEN.claimId, statutoryDinerRef: 'diner-1', sessionRef: 'SESS-1' });
  });

  it('a person already on the bill under letters in another case is found too (ID normalisation is the T-426 one)', async () => {
    const t = mk({ open: { ...OPEN, idNumber: 'pwd-ab 12' }, form: { ...FORM, kind: 'pwd', idNo: 'pwd-ab 12' }, diners: [{ id: 'd9', idNo: 'PWDAB12' }] });
    const r = await approveClaimFlow(t.base as never);
    expect(t.addDiner).not.toHaveBeenCalled();
    expect(t.approve).toHaveBeenCalledWith(expect.objectContaining({ statutoryDinerRef: 'd9' }));
    expect(r).toMatchObject({ done: true, dinerId: 'd9' });
  });

  it("status 0 (no answer) is a retry too; a 409 is a refusal with the server's own sentence and the diner is not added again on the next try [kills: M9 409 treated as done]", async () => {
    const t = mk();
    t.approve.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 0 }));
    expect(await approveClaimFlow(t.base as never)).toMatchObject({ done: false, reason: 'retry' });
    t.approve.mockRejectedValueOnce(Object.assign(new Error('Ask the diner to show the card first.'), { status: 409 }));
    const r = await approveClaimFlow({ ...t.base, diners: [{ id: 'diner-1', idNo: '123-456-1187' }] } as never);
    expect(r).toMatchObject({ done: false, reason: 'refused', message: 'Ask the diner to show the card first.' });
    expect(t.addDiner).toHaveBeenCalledTimes(1);
  });

  it('untick: nothing is written and approve is never called [kills: M5]', async () => {
    const t = mk({ form: { ...FORM, cardSeen: false } });
    const r = await approveClaimFlow(t.base as never);
    expect(r).toMatchObject({ done: false, reason: 'blocked' });
    expect(t.addDiner).not.toHaveBeenCalled();
    expect(t.approve).not.toHaveBeenCalled();
  });

  it('party not seated (sessionRef null): blocked, nothing written, nothing approved', async () => {
    const t = mk({ open: { ...OPEN, sessionRef: null } });
    expect(await approveClaimFlow(t.base as never)).toMatchObject({ done: false, reason: 'blocked' });
    expect(t.addDiner).not.toHaveBeenCalled();
    expect(t.approve).not.toHaveBeenCalled();
  });

  it('the diner could not be written (T-426 refusal: more diners than heads, duplicate ID...): approve is NOT called and the T-426 sentence is shown [kills: M10 approved without a statutory record]', async () => {
    const t = mk();
    t.addDiner.mockRejectedValueOnce(new Error('There cannot be more qualifying diners than people at the table.'));
    const r = await approveClaimFlow(t.base as never);
    expect(r).toMatchObject({ done: false, reason: 'diner', message: 'There cannot be more qualifying diners than people at the table.' });
    expect(t.approve).not.toHaveBeenCalled();
  });

  it('never throws and the result never carries the holder name or the ID number', async () => {
    const t = mk();
    t.approve.mockRejectedValueOnce(Object.assign(new Error('boom Maria Santos 123-456-1187'), { status: 500 }));
    const r = await approveClaimFlow(t.base as never);
    expect(r.done).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/Maria|Santos|123-456|1234561187/);
  });
});

describe('rejectClaimFlow: fixed reasons only', () => {
  it('a known code calls reject once with the claim id and that code', async () => {
    const reject = vi.fn(async (_b: Record<string, unknown>) => ({ ok: true }));
    const r = await rejectClaimFlow({ claimId: OPEN.claimId, reasonCode: 'id_mismatch', reject });
    expect(r).toMatchObject({ done: true });
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject).toHaveBeenCalledWith({ claimId: OPEN.claimId, reasonCode: 'id_mismatch' });
  });

  it('an unknown code or free text is blocked before any call [kills: M1]', async () => {
    const reject = vi.fn();
    for (const bad of ['rude', 'We could not see your ID card. Please show it to the cashier.', '', undefined]) {
      const r = await rejectClaimFlow({ claimId: OPEN.claimId, reasonCode: bad as never, reject });
      expect(r, String(bad)).toMatchObject({ done: false, reason: 'blocked' });
    }
    expect(reject).not.toHaveBeenCalled();
  });

  it('a failed call is reported (offline = the claims sentence, 409 = the server sentence), never thrown', async () => {
    const off = await rejectClaimFlow({ claimId: OPEN.claimId, reasonCode: 'id_mismatch', reject: async () => { throw Object.assign(new Error('x'), { status: 503 }); } });
    expect(off).toMatchObject({ done: false, message: CLAIMS_UNAVAILABLE });
    const refused = await rejectClaimFlow({ claimId: OPEN.claimId, reasonCode: 'id_mismatch', reject: async () => { throw Object.assign(new Error('This claim is already decided.'), { status: 409 }); } });
    expect(refused).toMatchObject({ done: false, message: 'This claim is already decided.' });
  });
});

describe('failure wording', () => {
  it('503 and status 0 read the one claims sentence; 409 keeps the server sentence; others get a non-empty generic one', () => {
    expect(CLAIMS_UNAVAILABLE).toBe('Discount claims need the POS server. Record the senior / PWD discount by hand as usual.');
    expect(CLAIM_RETRY_MESSAGE).toBe('Saved on this bill. The claim is not confirmed yet. Try again when the POS server is back.');
    expect(claimFailure({ status: 503, message: 'x' })).toEqual({ kind: 'unavailable', message: CLAIMS_UNAVAILABLE });
    expect(claimFailure({ status: 0 })).toEqual({ kind: 'unavailable', message: CLAIMS_UNAVAILABLE });
    expect(claimFailure({ status: 409, message: 'Not found.' })).toEqual({ kind: 'refused', message: 'Not found.' });
    const other = claimFailure({ status: 500 });
    expect(other.kind).toBe('error');
    expect(other.message.length).toBeGreaterThan(0);
    expect(claimFailure(null).kind).toBe('error');
  });
});

describe('S7b rulings 9 and 11 (added by the builder)', () => {
  const mk = () => {
    const addDiner = vi.fn(async (_e: { kind: string; name: string; idNo: string }) => ({ dinerId: 'diner-1' }));
    const approve = vi.fn(async (_b: Record<string, unknown>) => ({ ok: true }));
    return { addDiner, approve };
  };

  it('(b) a 409 on a retried approve, then a refetch showing the claim approved: shown as done, no second diner', async () => {
    const t = mk();
    t.approve.mockRejectedValueOnce(Object.assign(new Error('Already decided.'), { status: 409 }));
    const isApproved = vi.fn(async (_id: string) => true);
    const r = await approveClaimFlow({ open: OPEN, form: FORM, diners: [{ id: 'diner-1', idNo: '123-456-1187' }], addDiner: t.addDiner, approve: t.approve, isApproved } as never);
    expect(r).toMatchObject({ done: true, dinerId: 'diner-1' });
    expect(isApproved).toHaveBeenCalledWith(OPEN.claimId);
    expect(t.addDiner).not.toHaveBeenCalled();
  });

  it('(b) the status check runs only after a 409 (never on success or on an offline retry)', async () => {
    const t = mk();
    const isApproved = vi.fn(async (_id: string) => true);
    await approveClaimFlow({ open: OPEN, form: FORM, diners: [], addDiner: t.addDiner, approve: t.approve, isApproved } as never);
    t.approve.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 503 }));
    await approveClaimFlow({ open: OPEN, form: FORM, diners: [{ id: 'diner-1', idNo: '123-456-1187' }], addDiner: t.addDiner, approve: t.approve, isApproved } as never);
    expect(isApproved).not.toHaveBeenCalled();
  });

  it('(b) a 409 where the refetch does NOT show approved, or the refetch fails, stays a refusal with the server sentence', async () => {
    for (const isApproved of [async () => false, async () => { throw new Error('offline'); }]) {
      const t = mk();
      t.approve.mockRejectedValueOnce(Object.assign(new Error('Ask the diner to show the card first.'), { status: 409 }));
      const r = await approveClaimFlow({ open: OPEN, form: FORM, diners: [], addDiner: t.addDiner, approve: t.approve, isApproved } as never);
      expect(r).toMatchObject({ done: false, reason: 'refused', message: 'Ask the diner to show the card first.' });
    }
  });

  it('(c) the empty form (what the dialog resets to on close) holds no name, no ID number and the tick off', () => {
    expect(emptyClaimForm()).toEqual({ kind: 'senior', name: '', idNo: '', cardSeen: false });
    expect(emptyClaimForm()).not.toBe(emptyClaimForm());
  });
});
