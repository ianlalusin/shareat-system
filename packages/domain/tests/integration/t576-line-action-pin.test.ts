import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-576 (TESTER) - a store setting that makes a LINE cancel / a LINE discount (custom, preset, apply-to-all) / a discount removal need a manager PIN.
 * docs/tasks/576-pos-manager-pin-setting-line-actions.md as amended by the planner review (13 Nov 2026). Everything goes through the real inbox against real Postgres.
 *
 * THE RULE: business rule `pos.require_pin_line_actions` (0 = off, the default; 1 = on), read from the database for the event's business date (no injected reader).
 *   OFF  = today's behaviour exactly: a cashier cancels and discounts with no PIN, and no extra audit row is written.
 *   ON   = the actor holds approve_pos_correction, else the event carries `approval: { token, approverId, exp }`: a signed token that `grantLineApproval` (POST /api/pos/line-approval)
 *          issued after checking a manager PIN. THE PIN IS NEVER IN AN EVENT. A wrong PIN is refused (and charged one miss) when the till ASKS, before anything is saved. The gate
 *          checks the signature, the expiry (15 minutes), and that store, tablet, action and target all match; the approver is recorded as `approvedBy` on the line audit row.
 *          No approval: `offline: true` -> applied + audit `pos.line_action_unapproved` { tableId, lineId, action } (the audit redactor blanks any key named like a session token, so the table id is `tableId`, not `sessionId`); `offline` false/absent -> refused with the sentence below.
 *          Senior/PWD discounts are the statutory rate, not a cashier's choice: never gated.
 *   REPLAY of a quarantined line action: the replaying manager (approve_pos_correction) IS the approval.
 */
import { catalogueEntry } from '@shareat/db';
import { signPosLineApproval } from '@shareat/auth';
import { actorOf, asOrg, auditRows, closeAll, eventsOf, ev, fixture, linesAddedPayload, newStand, nowIso, pinOf, pinSession, signedIn, sql, standOpenedPayload, uuid, type Ev, type Fx } from './_fixtures/t525-pos';
import { putRule } from './_fixtures/t512-rules';
import * as inbox from '../../src/pos/inbox';
import { grantLineApproval, LINE_APPROVAL_INVALID, type LineAction, type LineDetailInput } from '../../src/pos/line-approval';
import { buildPosSnapshot } from '../../src/pos/snapshot';

afterAll(closeAll);

const KEY = 'pos.require_pin_line_actions';
const NEED_PIN = 'A manager PIN is needed for this. Ask a manager.';
const WRONG_PIN = 'That PIN cannot approve this. Ask a store manager.';
/** No injected reader: the rule comes from the database. */
const REAL = {};

const seqOf = new WeakMap<Fx, number>();
const nextSeq = (f: Fx): number => {
  const n = (seqOf.get(f) ?? 0) + 1;
  seqOf.set(f, n);
  return n;
};
const send = async (f: Fx, kind: string, who: string, payload: Record<string, unknown>, at: Date = new Date()) => {
  const e: Ev = ev(nextSeq(f), kind, who, payload, at);
  const r = await inbox.applyPosEvents({ pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId }, events: [e] }, REAL);
  expect(r.results, 'one result per event').toHaveLength(1);
  return r.results[0]!;
};
const on = (f: Fx) => putRule(sql, f.orgId, KEY, '1.000000', '2000-01-01');

/** A fresh store with a table of two queued pork lines; cashier and admin signed in on the tablet. The rule is OFF (the default) until a case turns it on. */
async function table() {
  const f = await fixture();
  await signedIn(f, f.counterId, f.adminId);
  const sessionId = uuid();
  const [a, b] = [uuid(), uuid()] as [string, string];
  expect((await send(f, 'stand.opened', f.counterId, standOpenedPayload(sessionId, (await newStand(f)).id))).status).toBe('applied');
  expect((await send(f, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId: a, item: f.menu.pork, qty: 2 }, { lineId: b, item: f.menu.pork, qty: 1 }]))).status).toBe('applied');
  return { f, sessionId, a, b };
}
type T = Awaited<ReturnType<typeof table>>;

const cancel = (t: T, lineId: string, extra: Record<string, unknown> = {}, who = t.f.counterId) => send(t.f, 'line.cancelled', who, { lineId, reason: 'Wrong order', ...extra });
const custom = (t: T, lineId: string, extra: Record<string, unknown> = {}, who = t.f.counterId, discountId = uuid()) =>
  send(t.f, 'discount.added', who, { discountId, lineId, kind: 'custom', valueType: 'percent', value: '10', qty: 1, appliedAtDevice: nowIso(), ...extra });
const preset = (t: T, lineId: string, extra: Record<string, unknown> = {}, who = t.f.counterId) =>
  send(t.f, 'discount.added', who, { discountId: uuid(), lineId, kind: 'preset', presetId: t.f.emp10, qty: 1, appliedAtDevice: nowIso(), ...extra });
const remove = (t: T, discountId: string, extra: Record<string, unknown> = {}, who = t.f.counterId) => send(t.f, 'discount.removed', who, { discountId, removedAtDevice: nowIso(), ...extra });
const lineStatus = async (id: string) => (await sql<{ s: string }[]>`select kitchen_status s from table_session_lines where id = ${id}`)[0]!.s;
const discountStatus = async (id: string) => (await sql<{ s: string }[]>`select status s from table_session_line_discounts where id = ${id}`)[0]!.s;
const activeDiscounts = async (f: Fx) => Number((await sql<{ n: number }[]>`select count(*)::int n from table_session_line_discounts where org_id = ${f.orgId} and status = 'active'`)[0]!.n);
const review = (f: Fx) => auditRows(f, 'pos.line_action_unapproved');
/** What the till does online: ask for a manager's approval of ONE action on ONE target. Returns the event's `approval`. */
const grant = (t: T, action: LineAction, targetId: string, pin: string, deps: { now?: () => Date } = {}, detail?: LineDetailInput, pairingId = t.f.pairingId) =>
  asOrg(t.f.orgId, (tx) => grantLineApproval(tx, actorOf(t.f.orgId, t.f.counterId), { storeId: t.f.storeId, pairingId, pin, action, targetId, detail }, deps));
const managerGrant = async (t: T, action: LineAction, targetId: string, deps: { now?: () => Date } = {}, detail?: LineDetailInput, pairingId = t.f.pairingId) =>
  grant(t, action, targetId, await pinOf(t.f, t.f.managerId), deps, detail, pairingId);
/** The details the tests approve: 10% custom for one unit; the Employee 10% preset for one unit. */
const C10 = (lineId: string): LineDetailInput => ({ kind: 'custom', valueType: 'percent', value: '10', qty: 1, lineId });
const presetDetail = (t: T, lineId: string, presetId = t.f.emp10): LineDetailInput => ({ kind: 'preset', presetId, qty: 1, lineId });
const misses = async (f: Fx) => Number((await sql<{ n: number }[]>`select count(*)::int n from sign_in_attempts where org_id = ${f.orgId} and kind = 'miss'`)[0]!.n);
const approvedBy = (row: { after: unknown } | undefined) => (row?.after as { approvedBy?: string } | undefined)?.approvedBy;
const refusedWith = (r: { status: string; error?: string }, sentence: string) => {
  expect(r.status).toBe('quarantined');
  expect(r.error).toContain(sentence);
};

describe('T-576 the snapshot carries the rule (the tablet reads it to ask for the PIN)', () => {
  const rulesOf = async (f: Fx) => (await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, REAL))).body.rules as unknown as { requirePinLineActions: unknown };
  it('false by default, true once the rule is on, as a plain boolean', async () => {
    const f = await fixture();
    expect((await rulesOf(f)).requirePinLineActions).toBe(false);
    await on(f);
    expect((await rulesOf(f)).requirePinLineActions).toBe(true);
  });
});

describe('T-576 catalogue', () => {
  it('pos.line_action_unapproved is a catalogued audit action', () => {
    expect(catalogueEntry('pos.line_action_unapproved')).toBeDefined();
  });
});

describe('T-576 rule OFF (the default) - exactly today (regression)', () => {
  it('a cashier cancels a line, adds a custom and a preset discount and removes one, with no PIN, and nothing extra is audited', async () => {
    const t = await table();
    expect((await cancel(t, t.b)).status).toBe('applied');
    expect(await lineStatus(t.b)).toBe('cancelled');
    const id = uuid();
    expect((await custom(t, t.a, {}, t.f.counterId, id)).status).toBe('applied');
    expect((await preset(t, t.a)).status).toBe('applied');
    expect((await remove(t, id)).status).toBe('applied');
    expect(await discountStatus(id)).toBe('removed');
    expect(await review(t.f)).toHaveLength(0);
    const [row] = await auditRows(t.f, 'pos.line_cancelled');
    expect(row!.after, 'rule off: the audit row is the one written before this task').toEqual({ status: 'cancelled', reason: 'Wrong order' });
  });

  it('an approval sent while the rule is off is ignored (even a bogus one): still applied, no approver recorded', async () => {
    const t = await table();
    expect((await cancel(t, t.a, { approval: { token: 'nonsense', approverId: uuid(), exp: 1 } })).status).toBe('applied');
    const [row] = await auditRows(t.f, 'pos.line_cancelled');
    expect(approvedBy(row)).toBeUndefined();
  });
});

describe('T-576 rule ON, online - the PIN is checked when the till ASKS (grantLineApproval), never inside an event', () => {
  it('a wrong PIN is refused with the one approval sentence and charges exactly ONE miss; no event exists to quarantine [kills: a PIN burn per typo twice over]', async () => {
    const t = await table();
    await on(t.f);
    expect(await misses(t.f)).toBe(0);
    await expect(grant(t, 'line.cancelled', t.a, '000001')).rejects.toThrow(WRONG_PIN);
    expect(await misses(t.f)).toBe(1);
    expect(await lineStatus(t.a)).toBe('queued');
    expect((await eventsOf(t.f)).filter((e) => e.kind === 'line.cancelled')).toHaveLength(0);
  });

  it('a right PIN charges nothing and answers { token, approverId, exp } with exp 15 minutes out', async () => {
    const t = await table();
    await on(t.f);
    const at = new Date('2030-01-01T00:00:00.000Z');
    const g = await managerGrant(t, 'line.cancelled', t.a, { now: () => at });
    expect(Object.keys(g).sort()).toEqual(['approverId', 'exp', 'token']);
    expect(g.approverId).toBe(t.f.managerId);
    expect(g.exp).toBe(at.getTime() + 15 * 60_000);
    expect(await misses(t.f)).toBe(0);
  });

  it('a PIN of someone who cannot approve at this store (a manager of another store), and a bad action or target, are refused', async () => {
    const t = await table();
    await on(t.f);
    await expect(grant(t, 'line.cancelled', t.a, await pinOf(t.f, t.f.managerOtherId))).rejects.toThrow(WRONG_PIN);
    expect(await misses(t.f)).toBe(1);
    const pin = await pinOf(t.f, t.f.managerId);
    await expect(grant(t, 'session.voided' as LineAction, t.a, pin)).rejects.toThrow();
    await expect(grant(t, 'line.cancelled', 'not-a-uuid', pin)).rejects.toThrow();
  });
});

describe('T-576 rule ON, online - cancel a line (the event carries the token)', () => {
  it('no approval (offline absent) is refused with the plain sentence and the line stays queued', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await cancel(t, t.a), NEED_PIN);
    expect(await lineStatus(t.a)).toBe('queued');
    expect(await review(t.f)).toHaveLength(0);
  });

  it('no approval with offline: false is refused the same way', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await cancel(t, t.a, { offline: false }), NEED_PIN);
    expect(await lineStatus(t.a)).toBe('queued');
  });

  it("the manager's token applies it; the approver is recorded; the PIN is stored nowhere (not in pos_events, not in the audit row)", async () => {
    const t = await table();
    await on(t.f);
    const pin = await pinOf(t.f, t.f.managerId);
    const g = await grant(t, 'line.cancelled', t.a, pin);
    expect((await cancel(t, t.a, { approval: g })).status).toBe('applied');
    expect(await lineStatus(t.a)).toBe('cancelled');
    const [row] = await auditRows(t.f, 'pos.line_cancelled');
    expect(approvedBy(row)).toBe(t.f.managerId);
    expect(await review(t.f)).toHaveLength(0);
    const stored = (await eventsOf(t.f)).find((e) => e.kind === 'line.cancelled')!;
    expect(stored.payload.approval).toEqual(g);
    expect(JSON.stringify(stored.payload)).not.toContain(pin);
    expect(JSON.stringify(row)).not.toContain(pin);
  });

  it('a PIN in the event (the old shape) is refused as invalid and never stored [kills: a PIN back in the outbox]', async () => {
    const t = await table();
    await on(t.f);
    const pin = await pinOf(t.f, t.f.managerId);
    const r = await cancel(t, t.a, { approval: { pin } });
    expect(r.status).toBe('quarantined');
    expect(r.error).toMatch(/^POS_EVENT_INVALID: /);
    expect(await lineStatus(t.a)).toBe('queued');
    expect(JSON.stringify((await eventsOf(t.f)).map((e) => e.payload))).not.toContain(pin);
    expect(await misses(t.f), 'a malformed event charges no miss').toBe(0);
  });

  it('an actor who holds approve_pos_correction needs no token, and is the recorded approver', async () => {
    const t = await table();
    await on(t.f);
    expect((await cancel(t, t.a, {}, t.f.adminId)).status).toBe('applied');
    const [row] = await auditRows(t.f, 'pos.line_cancelled');
    expect(approvedBy(row)).toBe(t.f.adminId);
  });

  it('a replay of an already-cancelled line is still a no-op that asks for nothing [kills: the gate running before the replay check]', async () => {
    const t = await table();
    expect((await cancel(t, t.a)).status).toBe('applied'); // rule off
    await on(t.f);
    expect((await cancel(t, t.a)).status).toBe('applied');
  });
});

describe('T-576 rule ON - a token that does not fit is refused (the event quarantines; a manager can replay it)', () => {
  const sentence = (r: { status: string; error?: string }) => refusedWith(r, LINE_APPROVAL_INVALID);

  it('a TAMPERED token (one character changed) is refused [MUTANT: skip the HMAC check -> this goes red]', async () => {
    const t = await table();
    await on(t.f);
    const g = await managerGrant(t, 'line.cancelled', t.a);
    const bad = { ...g, token: g.token.slice(0, -1) + (g.token.endsWith('A') ? 'B' : 'A') };
    sentence(await cancel(t, t.a, { approval: bad }));
    expect(await lineStatus(t.a)).toBe('queued');
  });

  it('a token whose approver or expiry was edited is refused (the signature covers them)', async () => {
    const t = await table();
    await on(t.f);
    const g = await managerGrant(t, 'line.cancelled', t.a);
    sentence(await cancel(t, t.a, { approval: { ...g, approverId: t.f.adminId } }));
    sentence(await cancel(t, t.a, { approval: { ...g, exp: g.exp + 3600e3 } }));
    expect(await lineStatus(t.a)).toBe('queued');
  });

  it('an EXPIRED token is refused at apply time', async () => {
    const t = await table();
    await on(t.f);
    const g = await managerGrant(t, 'line.cancelled', t.a, { now: () => new Date(Date.now() - 3600e3) });
    expect(g.exp).toBeLessThan(Date.now());
    sentence(await cancel(t, t.a, { approval: g }));
    expect(await lineStatus(t.a)).toBe('queued');
  });

  it('a token for ANOTHER line is refused: one approval, one target', async () => {
    const t = await table();
    await on(t.f);
    const g = await managerGrant(t, 'line.cancelled', t.b);
    sentence(await cancel(t, t.a, { approval: g }));
    expect(await lineStatus(t.a)).toBe('queued');
    expect((await cancel(t, t.b, { approval: g })).status).toBe('applied');
  });

  it('a token for ANOTHER action on the same line is refused: a cancel approval does not give a discount', async () => {
    const t = await table();
    await on(t.f);
    const g = await managerGrant(t, 'line.cancelled', t.a);
    sentence(await custom(t, t.a, { approval: g }));
    expect(await activeDiscounts(t.f)).toBe(0);
  });

  it('a token signed for ANOTHER store, ANOTHER tablet or ANOTHER organisation is refused (all three are in the signature)', async () => {
    const t = await table();
    await on(t.f);
    const exp = Date.now() + 600e3;
    const claim = { orgId: t.f.orgId, storeId: t.f.storeId, pairingId: t.f.pairingId, approverId: t.f.managerId, action: 'line.cancelled', targetId: t.a, exp, detail: '' };
    // the same claim signed correctly applies (so the three refusals below are the changed field, nothing else)
    const mint = (c: typeof claim) => ({ token: signPosLineApproval(c), approverId: c.approverId, exp: c.exp });
    sentence(await cancel(t, t.a, { approval: mint({ ...claim, storeId: t.f.store2Id }) }));
    sentence(await cancel(t, t.a, { approval: mint({ ...claim, pairingId: uuid() }) }));
    sentence(await cancel(t, t.a, { approval: mint({ ...claim, orgId: uuid() }) }));
    expect(await lineStatus(t.a)).toBe('queued');
    expect((await cancel(t, t.a, { approval: mint(claim) })).status).toBe('applied');
  });

  it('a payload that names its own approver of a replay (replayApprovedBy) or its own pairing is refused [the schema, not the gate: a device can never claim a manager replayed it]', async () => {
    const t = await table();
    await on(t.f);
    for (const extra of [{ replayApprovedBy: t.f.managerId }, { madeOnPairingId: t.f.pairingId }]) {
      const r = await cancel(t, t.a, extra);
      expect(r.status).toBe('quarantined');
      expect(r.error).toMatch(/^POS_EVENT_INVALID: /);
    }
    expect(await lineStatus(t.a)).toBe('queued');
  });
});

describe('T-576 rule ON, online - discounts', () => {
  it('a custom discount: no approval refused, a token for it applies with the approver recorded', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await custom(t, t.a), NEED_PIN);
    expect(await activeDiscounts(t.f)).toBe(0);
    const id = uuid();
    const g = await managerGrant(t, 'discount.added', id, {}, C10(t.a));
    expect((await custom(t, t.a, { approval: g }, t.f.counterId, id)).status).toBe('applied');
    expect(await activeDiscounts(t.f)).toBe(1);
    const [row] = await auditRows(t.f, 'pos.discount_added');
    expect(approvedBy(row)).toBe(t.f.managerId);
  });

  it('an approval for 10% on a line is refused when the event asks 100% [MUTANT: drop the detail from the signed text -> this goes red]', async () => {
    const t = await table();
    await on(t.f);
    const id = uuid();
    const g = await managerGrant(t, 'discount.added', id, {}, C10(t.a));
    refusedWith(await custom(t, t.a, { approval: g, value: '100' }, t.f.counterId, id), LINE_APPROVAL_INVALID);
    refusedWith(await custom(t, t.a, { approval: g, qty: 2 }, t.f.counterId, id), LINE_APPROVAL_INVALID); // more units
    refusedWith(await custom(t, t.a, { approval: g, valueType: 'fixed' }, t.f.counterId, id), LINE_APPROVAL_INVALID); // pesos, not percent
    expect(await activeDiscounts(t.f)).toBe(0);
    expect((await custom(t, t.a, { approval: g, value: '10.00' }, t.f.counterId, id)).status, '10 and 10.00 are the same amount').toBe('applied');
  });

  it('a token minted for line X (same discountId, same detail) is refused on line Y: one approval, one line', async () => {
    const t = await table();
    await on(t.f);
    const id = uuid();
    const g = await managerGrant(t, 'discount.added', id, {}, C10(t.a));
    refusedWith(await custom(t, t.b, { approval: g }, t.f.counterId, id), LINE_APPROVAL_INVALID);
    expect(await activeDiscounts(t.f)).toBe(0);
    expect((await custom(t, t.a, { approval: g }, t.f.counterId, id)).status).toBe('applied');
  });

  it('one approval cannot be reused for a second discount (the token names the NEW discount id) [kills: a stacked discount on one approval]', async () => {
    const t = await table();
    await on(t.f);
    const first = uuid();
    const g = await managerGrant(t, 'discount.added', first, {}, C10(t.a));
    expect((await custom(t, t.a, { approval: g }, t.f.counterId, first)).status).toBe('applied');
    refusedWith(await custom(t, t.a, { approval: g }, t.f.counterId, uuid()), LINE_APPROVAL_INVALID);
    expect(await activeDiscounts(t.f)).toBe(1);
  });

  it('a preset swap is refused: an approval for one preset does not give another, and a preset is not a custom discount', async () => {
    const t = await table();
    await on(t.f);
    const id = uuid();
    const g = await managerGrant(t, 'discount.added', id, {}, presetDetail(t, t.a));
    const asPreset = (extra: Record<string, unknown>) => send(t.f, 'discount.added', t.f.counterId, { discountId: id, lineId: t.a, kind: 'preset', presetId: t.f.emp10, qty: 1, appliedAtDevice: nowIso(), approval: g, ...extra });
    refusedWith(await asPreset({ presetId: t.f.promo50 }), LINE_APPROVAL_INVALID);
    refusedWith(await custom(t, t.a, { approval: g }, t.f.counterId, id), LINE_APPROVAL_INVALID);
    expect(await activeDiscounts(t.f)).toBe(0);
    expect((await asPreset({})).status, 'the matching detail applies').toBe('applied');
    expect(await activeDiscounts(t.f)).toBe(1);
  });

  it('a grant for a discount without its kind / value / units, or for a senior discount, is refused', async () => {
    const t = await table();
    await on(t.f);
    const pin = await pinOf(t.f, t.f.managerId);
    await expect(grant(t, 'discount.added', uuid(), pin)).rejects.toThrow();
    await expect(grant(t, 'discount.added', uuid(), pin, {}, { kind: 'senior', qty: 1, lineId: t.a })).rejects.toThrow();
    await expect(grant(t, 'discount.added', uuid(), pin, {}, { kind: 'custom', valueType: 'percent', value: 'abc', qty: 1, lineId: t.a })).rejects.toThrow();
    await expect(grant(t, 'discount.applied_to_all', t.sessionId, pin)).rejects.toThrow();
  });

  it('a 100% custom discount (mark free) is the same gate [kills: gating percent below 100 only]', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await custom(t, t.a, { value: '100' }), NEED_PIN);
    expect(await activeDiscounts(t.f)).toBe(0);
  });

  it('a preset discount: no approval refused; an approve_pos_correction actor applies it with none', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await preset(t, t.a), NEED_PIN);
    expect((await preset(t, t.a, {}, t.f.adminId)).status).toBe('applied');
    expect(await activeDiscounts(t.f)).toBe(1);
  });

  it('a senior discount is never gated (the statutory rate is not a cashier choice)', async () => {
    const t = await table();
    await on(t.f);
    expect((await send(t.f, 'discount.added', t.f.counterId, { discountId: uuid(), lineId: t.a, kind: 'senior', dinerNo: 1, qty: 1, appliedAtDevice: nowIso() })).status).toBe('applied');
    expect(await review(t.f)).toHaveLength(0);
  });

  it('apply-to-all is the same gate as a preset on one line, and its token names the TABLE [kills: the bulk button as a way round the rule]', async () => {
    const t = await table();
    await on(t.f);
    const all = (extra: Record<string, unknown> = {}) => send(t.f, 'discount.applied_to_all', t.f.counterId, { sessionId: t.sessionId, presetId: t.f.emp10, applyId: uuid(), appliedAtDevice: nowIso(), ...extra });
    refusedWith(await all(), NEED_PIN);
    expect(await activeDiscounts(t.f)).toBe(0);
    const detail = { presetId: t.f.emp10 };
    refusedWith(await all({ approval: await managerGrant(t, 'discount.applied_to_all', t.a, {}, detail) }), LINE_APPROVAL_INVALID); // a line is not the table
    refusedWith(await all({ approval: await managerGrant(t, 'discount.applied_to_all', t.sessionId, {}, { presetId: t.f.promo50 }) }), LINE_APPROVAL_INVALID); // another preset
    expect((await all({ approval: await managerGrant(t, 'discount.applied_to_all', t.sessionId, {}, detail) })).status).toBe('applied');
    expect(await activeDiscounts(t.f)).toBe(2);
  });

  it('removing a discount: no approval refused; a token for THAT discount applies', async () => {
    const t = await table();
    const id = uuid();
    expect((await custom(t, t.a, {}, t.f.counterId, id)).status).toBe('applied'); // rule off
    await on(t.f);
    refusedWith(await remove(t, id), NEED_PIN);
    expect(await discountStatus(id)).toBe('active');
    refusedWith(await remove(t, id, { approval: await managerGrant(t, 'discount.removed', t.a) }), LINE_APPROVAL_INVALID); // the line, not the discount
    expect((await remove(t, id, { approval: await managerGrant(t, 'discount.removed', id) })).status).toBe('applied');
    expect(await discountStatus(id)).toBe('removed');
  });
});

describe('T-576 rule ON, offline drain - applied, never silently', () => {
  it('a cancel with offline: true and no approval is applied and leaves ONE pos.line_action_unapproved row {sessionId, lineId, action}', async () => {
    const t = await table();
    await on(t.f);
    expect((await cancel(t, t.a, { offline: true })).status).toBe('applied');
    expect(await lineStatus(t.a)).toBe('cancelled');
    const rows = await review(t.f);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toEqual({ tableId: t.sessionId, lineId: t.a, action: 'line.cancelled' });
    expect(rows[0]!.actor_person_id).toBe(t.f.counterId);
  });

  it('a FORGED offline: true (sent while online) still leaves the manager-review row: there is no silent bypass', async () => {
    const t = await table();
    await on(t.f);
    expect((await custom(t, t.a, { offline: true })).status).toBe('applied');
    const rows = await review(t.f);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as { action: string }).action).toBe('discount.added');
  });

  it('a preset, an apply-to-all and a removal offline each leave their own row, with the action named', async () => {
    const t = await table();
    const id = uuid();
    expect((await custom(t, t.a, {}, t.f.counterId, id)).status).toBe('applied');
    await on(t.f);
    expect((await preset(t, t.b, { offline: true })).status).toBe('applied');
    expect((await remove(t, id, { offline: true })).status).toBe('applied');
    expect((await send(t.f, 'discount.applied_to_all', t.f.counterId, { sessionId: t.sessionId, presetId: t.f.emp10, applyId: uuid(), appliedAtDevice: nowIso(), offline: true })).status).toBe('applied');
    const rows = await review(t.f);
    expect(rows.map((r) => (r.after as { action: string }).action)).toEqual(['discount.added', 'discount.removed', 'discount.applied_to_all']);
    expect((rows[1]!.after as { lineId: string }).lineId, "a removal names the discount's line").toBe(t.a);
  });

  it('an offline event that carries a good token is approved: no review row', async () => {
    const t = await table();
    await on(t.f);
    expect((await cancel(t, t.a, { offline: true, approval: await managerGrant(t, 'line.cancelled', t.a) })).status).toBe('applied');
    expect(await review(t.f)).toHaveLength(0);
  });

  it('an offline event that carries a BAD token is refused, not waved through by offline: true [kills: offline as a way round a bad approval]', async () => {
    const t = await table();
    await on(t.f);
    const g = await managerGrant(t, 'line.cancelled', t.b);
    refusedWith(await cancel(t, t.a, { offline: true, approval: g }), LINE_APPROVAL_INVALID);
    expect(await lineStatus(t.a)).toBe('queued');
    expect(await review(t.f)).toHaveLength(0);
  });

  it('an actor who holds approve_pos_correction offline needs no review row', async () => {
    const t = await table();
    await on(t.f);
    expect((await cancel(t, t.a, { offline: true }, t.f.adminId)).status).toBe('applied');
    expect(await review(t.f)).toHaveLength(0);
  });

  it('offline must be a true/false [kills: a string that slips past the schema]', async () => {
    const t = await table();
    await on(t.f);
    const r = await cancel(t, t.a, { offline: 'yes' });
    expect(r.status).toBe('quarantined');
    expect(r.error).toMatch(/^POS_EVENT_INVALID: /);
  });

  it('rule OFF: offline: true writes no review row (the flag is inert)', async () => {
    const t = await table();
    expect((await cancel(t, t.a, { offline: true })).status).toBe('applied');
    expect(await review(t.f)).toHaveLength(0);
  });
});

describe("T-576 replay of a quarantined line action - the replaying manager's approve_pos_correction is the approval", () => {
  const replay = (f: Fx, eventId: string) => asOrg(f.orgId, (tx) => inbox.replayQuarantinedEvent(tx, f.manager, { storeId: f.storeId, eventId }, REAL));
  const quarantinedId = async (f: Fx, kind: string) => (await eventsOf(f)).find((e) => e.kind === kind && e.status === 'quarantined')!.id;

  it('a cancel refused for want of an approval is replayed by a manager: applied, approved by that manager, no review row', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await cancel(t, t.a), NEED_PIN);
    expect(await replay(t.f, await quarantinedId(t.f, 'line.cancelled'))).toEqual({ replayed: true });
    expect(await lineStatus(t.a)).toBe('cancelled');
    const [row] = await auditRows(t.f, 'pos.line_cancelled');
    expect(approvedBy(row)).toBe(t.f.managerId);
    expect(await review(t.f)).toHaveLength(0);
  });

  it('a cancel with a good token that arrived before its line existed is stored with the token (no PIN), and a manager can still replay it', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    await on(f);
    const sessionId = uuid();
    const lineId = uuid();
    const g = await asOrg(f.orgId, async (tx) => grantLineApproval(tx, actorOf(f.orgId, f.counterId), { storeId: f.storeId, pairingId: f.pairingId, pin: await pinOf(f, f.managerId), action: 'line.cancelled', targetId: lineId }));
    expect((await send(f, 'line.cancelled', f.counterId, { lineId, reason: 'Wrong order', approval: g })).status).toBe('quarantined'); // no such line yet
    expect((await send(f, 'stand.opened', f.counterId, standOpenedPayload(sessionId, (await newStand(f)).id))).status).toBe('applied');
    expect((await send(f, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId, item: f.menu.pork, qty: 1 }]))).status).toBe('applied');
    const row = (await eventsOf(f)).find((e) => e.kind === 'line.cancelled')!;
    expect(row.payload.approval).toEqual(g);
    expect(await replay(f, row.id)).toEqual({ replayed: true });
    expect(await lineStatus(lineId)).toBe('cancelled');
  });

  it('a discount refused for want of an approval is replayed by a manager: applied', async () => {
    const t = await table();
    await on(t.f);
    refusedWith(await custom(t, t.a), NEED_PIN);
    expect(await replay(t.f, await quarantinedId(t.f, 'discount.added'))).toEqual({ replayed: true });
    expect(await activeDiscounts(t.f)).toBe(1);
  });
});

describe('T-576 x T-563 - an approval follows the tablet the event was MADE on', () => {
  /** A table built on the till pairing (P2, the cookie of the drain); P1 is the origin tablet the cashier made the event on, signed in there. */
  async function carried() {
    const t = await table();
    await on(t.f);
    // One live pairing per store, so after the re-pair the origin tablet is a replaced one (revoked an hour from now: the event was made before that).
    const replacedAt = new Date(Date.now() + 3600e3);
    const [p1] = await sql<{ id: string }[]>`
      insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by, revoked_at, revoked_by) values (${t.f.orgId}, ${t.f.storeId}, 'origin tablet', ${uuid()}, ${t.f.adminId}, ${replacedAt}, ${t.f.adminId}) returning id`;
    await pinSession(t.f, t.f.counterId, { pairingId: p1!.id });
    const drain = (payload: Record<string, unknown>) =>
      inbox
        .applyPosEvents({ pairing: { pairingId: t.f.pairingId, orgId: t.f.orgId, storeId: t.f.storeId }, madeOn: { pairingId: p1!.id, revokedAt: replacedAt }, events: [ev(1, 'line.cancelled', t.f.counterId, { lineId: t.a, reason: 'Wrong order', ...payload })] }, REAL)
        .then((r) => r.results[0]!);
    return { t, p1: p1!.id, drain };
  }

  it('a token minted under origin tablet P1, for an event made on P1, drained under cookie P2 of the same store, applies', async () => {
    const { t, p1, drain } = await carried();
    const exp = Date.now() + 600e3; // minted while P1 was still the till (the grant route signs the cookie's pairing; here P1's claim is signed directly)
    const g = { token: signPosLineApproval({ orgId: t.f.orgId, storeId: t.f.storeId, pairingId: p1, approverId: t.f.managerId, action: 'line.cancelled', targetId: t.a, exp, detail: '' }), approverId: t.f.managerId, exp };
    expect((await drain({ approval: g })).status).toBe('applied');
    expect(await lineStatus(t.a)).toBe('cancelled');
  });

  // The fail-closed window (documented in line-approval.ts): minted under P2 for an event still stamped P1 -> refused, quarantined, a manager can replay it.
  it('a token minted under P2 for an event still stamped P1 is refused and quarantines for manager replay', async () => {
    const { t, drain } = await carried();
    const g = await managerGrant(t, 'line.cancelled', t.a);
    refusedWith(await drain({ approval: g }), LINE_APPROVAL_INVALID);
    expect(await lineStatus(t.a)).toBe('queued');
  });
});
