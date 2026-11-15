import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * T-525 (TESTER) - the POS v2 inbox, the person check, quarantine review and the snapshot. docs/tasks/525-pos-v2-apis.md R2-R7, R10.
 * Real Postgres on a scratch "_test" database (any name: nothing here pins a lane database). Raw SQL is the oracle; the domain is the subject.
 * The route envelope and the state poll are in apps/erp/tests/integration/t525-pos-routes.test.ts (same fixture: _fixtures/t525-pos.ts).
 *
 * ASSUMED API (the spec names the functions, not every shape; the builder matches these or says why not):
 *   packages/domain/src/pos/inbox.ts
 *     applyPosEvents(input, deps?) -> { stateVersion: number, results: { seq, status, error?, storedKind? }[] }
 *         input = { pairing: { pairingId, orgId, storeId }, events: [{ seq, kind, personId, occurredAtDevice, payload }] }.
 *         NO tx/db argument (the lead's sketch had one): R2/R5 run EACH event in its OWN top-level transaction (withOrgPrincipal), so the function
 *         opens them and cannot take a caller's tx. `deps` is T-524's PosDeps ({ readRules?, now? }); an absent reader is the production default.
 *         `status` is applied | duplicate | conflict | quarantined | retry. A conflict names the STORED kind in `storedKind`. A retry stops the batch:
 *         later events get NO result.
 *     listPosQuarantine(tx, actor, { storeId }) -> { id, seq, kind, personName, occurredAtDevice, receivedAt, error, payload }[]  (unresolved rows only)
 *     replayQuarantinedEvent(tx, actor, { storeId, eventId }) -> { replayed: true } | { replayed: false, error: <the new sentence> }
 *     discardQuarantinedEvent(tx, actor, { storeId, eventId, reason }) -> { discarded: true }   (a bad input / handled row / missing capability THROWS)
 *   packages/domain/src/pos/snapshot.ts
 *     buildPosSnapshot(tx, { pairing: { pairingId, orgId, storeId } }, deps?) -> { body, etag, nextChangeAt }
 *         body has EXACTLY the R7 keys; etag is the quoted sha256 text ("<64 hex>"); nextChangeAt is the menu's (string | null). Percent rules are JSON-safe
 *         (a bigint cannot be JSON): numbers or numeric strings, compared here with Number().
 *   Error codes (R5 says `error = "<CODE>: <sentence>"`), as RULED by the planner (7 Nov): POS_EVENT_INVALID, POS_EVENT_UNKNOWN_KIND, POS_EVENT_PERSON_REFUSED;
 *     a T-524 RefusalError keeps its own code when its raw message starts with one (RECORDED_DIFFERENTLY), else POS_EVENT_REFUSED; an
 *     AuthorizationError is POS_EVENT_NOT_ALLOWED; a wrong manager PIN (AuthenticationError) is POS_EVENT_PIN_REFUSED. The domain's own sentence follows the code.
 *   An unknown person (R4 clause 1): pos_events.person_id has an FK to persons, so the quarantined row stores person_id NULL, and the sentence names the id that was sent (ruling 5).
 *
 * RED NOW FOR THE RIGHT REASON: packages/domain/src/pos/inbox.ts and snapshot.ts do not exist. They are loaded lazily, so each case fails with
 * "MISSING MODULE ... not built" AFTER its fixture ran. The "fixture sanity" cases run for real (they prove the world the cases assume).
 */
import { authorize, AuthorizationError, can, POS_APPROVAL_PIN_CAPPED } from '@shareat/auth';
import { accessRepo, catalogueEntry, goneSentence, posV2Repo, RefusalError } from '@shareat/db';
import { loadStoreMenu } from '@shareat/domain';
import { addLineDiscount, addLines, currentBusinessDate, openStand } from '../../src/pos';
import { uuidv5 } from '../../src/pos/shared';
import {
  asOrg, auditRows, closeAll, counts, DAY, eventsOf, ev, fixture, HOLDER, linesAddedPayload, makeServer0240, makeStaff, newStand, nowIso, pinOf, pinSession,
  plainDay, RATES, receiptOfSession, salePayload, seniorDay, seniorEntry, sessionRow, signedIn, sql, standOpenedPayload, stateVersionOf, uuid,
  type Ev, type Fx,
} from './_fixtures/t525-pos';
import { putRule } from './_fixtures/t512-rules';
import { insOffer } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(closeAll);
afterEach(() => {
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------------------------------------------
// The subject, loaded lazily so a missing module fails each case with its own message instead of killing the file at import.
// ------------------------------------------------------------------------------------------------------------------------------
type Result = { seq: number; status: 'applied' | 'duplicate' | 'conflict' | 'quarantined' | 'retry'; error?: string; storedKind?: string };
type Applied = { stateVersion: number; results: Result[] };
type Deps = { readRules?: (tx: unknown, orgId: string, businessDate: string) => Promise<{ vatPercentBasisPoints: bigint; scPwdPercentBasisPoints: bigint; businessDayStartHour: number; tableWarnMinutes: number }>; now?: () => Date };
const lazy = <K extends string>(path: string, label: string) =>
  new Proxy({} as Record<K, (...a: unknown[]) => Promise<unknown>>, {
    get: (_t, name: string) => async (...args: unknown[]) => {
      let mod: Record<string, unknown> | undefined;
      try {
        mod = await import(/* @vite-ignore */ path);
      } catch (e) {
        throw new Error(`MISSING MODULE: ${label} cannot be loaded (T-525 not built): ${String((e as Error).message).slice(0, 160)}`);
      }
      const fn = mod?.[name];
      if (typeof fn !== 'function') throw new Error(`MISSING EXPORT: ${label} does not export ${name} (T-525 not built).`);
      return (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  });
const INBOX = lazy<'applyPosEvents' | 'listPosQuarantine' | 'replayQuarantinedEvent' | 'discardQuarantinedEvent'>('../../src/pos/inbox', 'packages/domain/src/pos/inbox.ts');
const SNAPSHOT = lazy<'buildPosSnapshot'>('../../src/pos/snapshot', 'packages/domain/src/pos/snapshot.ts');

const send = (f: Fx, events: Ev[], deps: Deps | undefined = RATES, pairingId = f.pairingId): Promise<Applied> =>
  INBOX.applyPosEvents({ pairing: { pairingId, orgId: f.orgId, storeId: f.storeId }, events }, deps) as Promise<Applied>;
const statuses = (r: Applied) => r.results.map((x) => x.status);
const PERSON_REFUSED = 'POS_EVENT_PERSON_REFUSED: ';
const REFUSED = 'POS_EVENT_REFUSED: ';
const NOT_ALLOWED = 'POS_EVENT_NOT_ALLOWED: ';
const PIN_REFUSED = 'POS_EVENT_PIN_REFUSED: ';
const NO_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** One event, one outcome: send it and return its single result. */
async function sendOne(f: Fx, e: Ev, deps: Deps | undefined = RATES) {
  const r = await send(f, [e], deps);
  expect(r.results, 'one result per event processed').toHaveLength(1);
  return r.results[0]!;
}
function expectQuarantined(r: Result, prefix: string, namesId?: string) {
  expect(r.status).toBe('quarantined');
  expect(r.error, 'the result carries the error').toBeDefined();
  expect(r.error!.startsWith(prefix), `error "${r.error}" starts with ${prefix}`).toBe(true);
  expect(r.error!.length, 'a sentence follows the code').toBeGreaterThan(prefix.length + 8);
  if (namesId !== undefined) expect(r.error!, 'ruling 5: the sentence names the id that was sent').toContain(namesId);
  else expect(r.error!, 'no UUID in a sentence').not.toMatch(NO_UUID);
}
async function expectRefusal(p: Promise<unknown>, sentence?: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  if (sentence !== undefined) expect((err as RefusalError).userMessage).toBe(sentence);
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

/** A session with a senior discount, built straight through T-524 (no inbox rows): the sale then NEEDS the rule reader. */
async function seniorSessionDirect(f: Fx) {
  const st = await newStand(f);
  const sessionId = uuid();
  const lineId = uuid();
  const base = { storeId: f.storeId, pairingId: f.pairingId };
  await asOrg(f.orgId, async (tx) => {
    await openStand(tx, f.counter, { ...base, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() });
    await addLines(tx, f.counter, { ...base, sessionId, lines: [{ lineId, menuItemId: f.menu.pork.itemId, variantId: f.menu.pork.variantId, qty: 2, addedAtDevice: nowIso() }] });
    await addLineDiscount(tx, f.counter, { ...base, discountId: uuid(), lineId, kind: 'senior', qty: 1, dinerNo: 1, appliedAtDevice: nowIso() }, RATES);
  });
  return { sessionId, lineId };
}
const seniorSaleEvent = (f: Fx, seq: number, s: { sessionId: string; lineId: string }) =>
  ev(seq, 'sale.completed', f.counterId, salePayload(f, { sessionId: s.sessionId, porkLineId: s.lineId, cashPaid: '1000.00', seniors: [seniorEntry(1)] }));

// ==============================================================================================================================
describe('fixture sanity (runs now: proves the world the cases below assume)', () => {
  it('the pairing, terminal and people exist; the counter may sign in at store A, the other store\'s manager may not', async () => {
    const f = await fixture();
    expect((await sql`select 1 from pos_terminals where pairing_id = ${f.pairingId} and terminal_no = 1`).length).toBe(1);
    expect((await sql`select 1 from pos_stores where store_id = ${f.storeId} and mode = 'test'`).length).toBe(1);
    expect((await sql`select 1 from pos_stores where store_id = ${f.store2Id}`).length, 'store B has no pos_stores row').toBe(0);
    await asOrg(f.orgId, async (tx) => {
      expect(await accessRepo.personMaySignInAtStore(tx, f.counterId, f.storeId)).toBe(true);
      expect(await accessRepo.personMaySignInAtStore(tx, f.managerId, f.storeId)).toBe(true);
      expect(await accessRepo.personMaySignInAtStore(tx, f.managerOtherId, f.storeId)).toBe(false);
    });
  });

  it('the lazy loader reaches a module that exists; a PIN session row can be written with any issue time and an ended reason', async () => {
    expect(typeof uuidv5).toBe('function');
    const f = await fixture();
    await pinSession(f, f.counterId, { issuedAt: new Date(Date.now() - 30 * DAY) });
    await pinSession(f, f.counterId, { ended: 'revoked' });
    const rows = await sql<{ ended_reason: string | null }[]>`select ended_reason from sessions where person_id = ${f.counterId} order by issued_at`;
    expect(rows.map((r) => r.ended_reason)).toEqual([null, 'revoked']);
  });

  it('a Server built by the REAL B0240 block holds request_pos_refill and confirm_pos_heads, and neither serve_pos_ticket nor record_sale (by the real authorize)', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    await asOrg(f.orgId, async (tx) => {
      expect(await can(tx, server, 'request_pos_refill', { storeId: f.storeId })).toBe(true);
      expect(await can(tx, server, 'confirm_pos_heads', { storeId: f.storeId })).toBe(true);
      expect(await can(tx, server, 'serve_pos_ticket', { storeId: f.storeId })).toBe(false);
      expect(await can(tx, server, 'record_sale', { storeId: f.storeId })).toBe(false);
      await expectAuthRefusal(authorize(tx, server, 'record_sale', { storeId: f.storeId }));
    });
  });

  it('a pairing with no terminal row can be made (the snapshot 409 case)', async () => {
    const f = await fixture();
    await sql`delete from pos_terminals where pairing_id = ${f.pairingId}`;
    expect((await sql`select 1 from pos_terminals where store_id = ${f.storeId}`).length).toBe(0);
  });
});

// ==============================================================================================================================
describe('R2 / R5 - applying a batch: applied, duplicate, conflict, quarantined, retry', () => {
  it('stand.opened + lines.added + sale.completed in one batch: three applied, the receipt exists, the events are stored applied, state version is higher', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = plainDay(f);
    const before = await stateVersionOf(f);
    const r = await send(f, day.events);
    expect(statuses(r)).toEqual(['applied', 'applied', 'applied']);
    expect(r.results.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect((await receiptOfSession(day.sessionId))?.id).toBe(day.receiptId);
    expect((await receiptOfSession(day.sessionId))?.total).toBe('500.00');
    expect((await sessionRow(day.sessionId))?.status).toBe('paid');
    const rows = await eventsOf(f);
    expect(rows.map((x) => [Number(x.seq), x.kind, x.status, x.error])).toEqual([
      [1, 'stand.opened', 'applied', null], [2, 'lines.added', 'applied', null], [3, 'sale.completed', 'applied', null],
    ]);
    expect(rows.every((x) => x.person_id === f.counterId && x.pairing_id === f.pairingId)).toBe(true);
    expect(rows[0]!.payload).toEqual(day.events[0]!.payload);
    expect(new Date(rows[0]!.occurred_at_device).toISOString()).toBe(day.events[0]!.occurredAtDevice);
    const after = await stateVersionOf(f);
    expect(after).toBeGreaterThan(before);
    expect(r.stateVersion, 'stateVersion in the answer is read after the batch').toBe(after);
  });

  it('the same batch sent again is three duplicates, and no rule reader is needed to say so: counts, the state version and the audit are unchanged', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = seniorDay(f);
    expect(statuses(await send(f, day.events, RATES))).toEqual(['applied', 'applied', 'applied', 'applied']);
    const c1 = await counts(f);
    expect(c1).toMatchObject({ events: 4, receipts: 1, statutory: 1, sessions: 1, lines: 1 });
    const v1 = await stateVersionOf(f);
    const sales1 = (await auditRows(f, 'pos.sale_completed')).length;
    // A replay is answered by the (pairing, seq) insert BEFORE the domain runs: it needs no rules, so an unwired reader changes nothing.
    const again = await send(f, day.events, {});
    expect(statuses(again)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(await counts(f)).toEqual(c1);
    expect(await stateVersionOf(f)).toBe(v1);
    expect(again.stateVersion).toBe(v1);
    expect((await auditRows(f, 'pos.sale_completed')).length).toBe(sales1);
  });

  it('two copies of one batch sent at the same moment: exactly one applies each event, the other is a duplicate, one receipt', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const day = plainDay(f);
    const [a, b] = await Promise.all([send(f, day.events), send(f, day.events)]);
    for (let i = 0; i < 3; i++) expect([a.results[i]!.status, b.results[i]!.status].sort(), `seq ${i + 1}`).toEqual(['applied', 'duplicate']);
    expect(await counts(f)).toMatchObject({ events: 3, receipts: 1, sessions: 1 });
  });

  it('the same seq with a different payload is a conflict and nothing is written; the same seq with a different kind is a conflict that names the stored kind', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const sessionId = uuid();
    const open = ev(1, 'stand.opened', f.counterId, { ...standOpenedPayload(sessionId, f.stand7), headsCashier: 3 });
    expect(await sendOne(f, open)).toMatchObject({ seq: 1, status: 'applied' });
    const v = await stateVersionOf(f);

    const changed = await sendOne(f, ev(1, 'stand.opened', f.counterId, { ...open.payload, headsCashier: 6 }));
    expect(changed.status).toBe('conflict');
    const otherKind = await sendOne(f, ev(1, 'heads.set', f.counterId, { sessionId, headsCashier: 5, }));
    expect(otherKind).toMatchObject({ status: 'conflict', storedKind: 'stand.opened' });

    expect((await sessionRow(sessionId))?.heads_cashier, 'the stored session is untouched').toBe(3);
    expect(await stateVersionOf(f)).toBe(v);
    const rows = await eventsOf(f);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'stand.opened', status: 'applied' });
    expect(rows[0]!.payload).toEqual(open.payload);
  });

  it('a refused event (lines.added on an unknown table) is quarantined with its code and sentence, and the events after it still run', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const ghost = uuid();
    const sessionId = uuid();
    const r = await send(f, [
      ev(1, 'lines.added', f.counterId, linesAddedPayload(ghost, [{ lineId: uuid(), item: f.menu.pork, qty: 1 }])),
      ev(2, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
    ]);
    expect(statuses(r)).toEqual(['quarantined', 'applied']);
    expectQuarantined(r.results[0]!, REFUSED);
    expect(r.results[0]!.error).toBe(`${REFUSED}${goneSentence('table')}`);
    expect((await sessionRow(sessionId))?.status, 'the event after the refusal ran').toBe('open');
    const rows = await eventsOf(f);
    expect(rows.map((x) => [Number(x.seq), x.status])).toEqual([[1, 'quarantined'], [2, 'applied']]);
    expect(rows[0]!.error).toBe(r.results[0]!.error);
    expect(rows[0]!.resolution).toBeNull();
    expect((await counts(f)).lines, 'the refused event wrote no line').toBe(0);
    expect(r.stateVersion).toBe(await stateVersionOf(f));
  });

  it('T-539 S2: with NO reader injected a senior sale applies from the database rules (registry defaults on a fresh org), and so does the event after it', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const s = await seniorSessionDirect(f);
    const stand2 = await newStand(f);
    const r = await send(f, [seniorSaleEvent(f, 1, s), ev(2, 'stand.opened', f.counterId, standOpenedPayload(uuid(), stand2.id))], {});
    expect(statuses(r)).toEqual(['applied', 'applied']);
    expect((await receiptOfSession(s.sessionId))?.id).toBeDefined();
    expect((await eventsOf(f)).map((x) => [Number(x.seq), x.status])).toEqual([[1, 'applied'], [2, 'applied']]);
  });

  it('a bug or a temporary failure is a retry too, never a quarantine: a plain Error from the reader, and a serialization failure (40001)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const s1 = await seniorSessionDirect(f);
    const boom = await send(f, [seniorSaleEvent(f, 1, s1)], { readRules: async () => { throw new Error('boom: a bug, not the sale\'s fault'); } });
    expect(boom.results).toEqual([{ seq: 1, status: 'retry' }]);
    const s2 = await seniorSessionDirect(f);
    const serial = await send(f, [seniorSaleEvent(f, 2, s2)], { readRules: async () => { throw Object.assign(new Error('could not serialize access'), { code: '40001' }); } });
    expect(serial.results).toEqual([{ seq: 2, status: 'retry' }]);
    expect(await eventsOf(f), 'nothing stored, nothing quarantined').toHaveLength(0);
    expect(await receiptOfSession(s1.sessionId)).toBeUndefined();
    expect(await receiptOfSession(s2.sessionId)).toBeUndefined();
  });
});

// ==============================================================================================================================
describe('R4 - who did it: the person check, each clause on its own', () => {
  const openEvent = (f: Fx, who: string, seq = 1, at = new Date()) => ev(seq, 'stand.opened', who, standOpenedPayload(uuid(), f.stand7), at);
  async function expectPersonRefused(f: Fx, e: Ev, namesId?: string) {
    const r = await sendOne(f, e);
    expectQuarantined(r, PERSON_REFUSED, namesId);
    expect((await counts(f)).sessions, 'the domain never ran').toBe(0);
    return r;
  }

  it('the good case first: a person with a live PIN session on this pairing, now, is applied', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    expect((await sendOne(f, openEvent(f, f.counterId))).status).toBe('applied');
  });

  it('clause 1: an unknown person is quarantined (the row keeps no person id); so is a person of another organisation; so is an inactive person', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const stranger = uuid();
    await expectPersonRefused(f, openEvent(f, stranger, 1), stranger);
    const g = await fixture();
    await signedIn(g, g.counterId);
    await expectPersonRefused(f, openEvent(f, g.counterId, 2), g.counterId);
    const rows = await eventsOf(f);
    expect(rows.map((x) => [Number(x.seq), x.status, x.person_id])).toEqual([[1, 'quarantined', null], [2, 'quarantined', null]]);

    const idle = await makeStaff(f, 'Ina Inactive');
    await signedIn(f, idle);
    await sql`update persons set is_active = false where id = ${idle}`;
    await expectPersonRefused(f, openEvent(f, idle, 3));
  });

  it('clause 2: a person who may not sign in at this store is quarantined, even with a PIN session on the pairing; a staffer removed since stops, and their applied events stay', async () => {
    const f = await fixture();
    await pinSession(f, f.managerOtherId); // store B's manager, a PIN session row on A's pairing: only clause 2 can refuse
    await expectPersonRefused(f, openEvent(f, f.managerOtherId, 1));

    const leaver = await makeStaff(f, 'Lee Leaver');
    await signedIn(f, leaver);
    expect((await sendOne(f, openEvent(f, leaver, 2))).status).toBe('applied');
    await sql`delete from person_store_scope where person_id = ${leaver}`;
    await sql`update employments set ended_on = '2025-06-01', employment_status = 'resigned' where person_id = ${leaver}`;
    const sessionsBefore = (await counts(f)).sessions;
    const r = await sendOne(f, openEvent(f, leaver, 3));
    expectQuarantined(r, PERSON_REFUSED);
    expect((await counts(f)).sessions, 'the removed person wrote nothing more').toBe(sessionsBefore);
    const rows = await eventsOf(f);
    expect(rows.map((x) => [Number(x.seq), x.status])).toEqual([[1, 'quarantined'], [2, 'applied'], [3, 'quarantined']]);
  });

  it('clause 3: no PIN session on this pairing; only a session on another pairing; only a revoked one; only a non-PIN one; one older than 7 days; one issued after the event', async () => {
    const f = await fixture();
    const mk = (name: string) => makeStaff(f, name);
    const none = await mk('Nora None');
    await expectPersonRefused(f, openEvent(f, none, 1));

    const elsewhere = await mk('Ella Elsewhere');
    await pinSession(f, elsewhere, { pairingId: f.pairingBId });
    await expectPersonRefused(f, openEvent(f, elsewhere, 2));

    const revoked = await mk('Rex Revoked');
    await pinSession(f, revoked, { ended: 'revoked' });
    await expectPersonRefused(f, openEvent(f, revoked, 3));

    const firebase = await mk('Fia Firebase');
    await pinSession(f, firebase, { kind: 'firebase' });
    await expectPersonRefused(f, openEvent(f, firebase, 4));

    const old = await mk('Olga Old');
    await pinSession(f, old, { issuedAt: new Date(Date.now() - 8 * DAY) });
    await expectPersonRefused(f, openEvent(f, old, 5));

    const late = await mk('Lia Late');
    await pinSession(f, late, { issuedAt: new Date() }); // signed in NOW, but the event claims to be from 2 days ago
    await expectPersonRefused(f, openEvent(f, late, 6, new Date(Date.now() - 2 * DAY)));
  });

  it('clause 3, the other side: an ended (signed out) session counts, and one issued 6 days before the event counts', async () => {
    const f = await fixture();
    const out = await makeStaff(f, 'Sol Signedout');
    await pinSession(f, out, { ended: 'signed_out' });
    expect((await sendOne(f, openEvent(f, out, 1))).status).toBe('applied');
    const six = await makeStaff(f, 'Sia Six');
    await pinSession(f, six, { issuedAt: new Date(Date.now() - 6 * DAY) });
    // a stand of its own: the first event of this case already opened stand 7, and a second open of it is the domain's refusal, not the person check's
    expect((await sendOne(f, ev(2, 'stand.opened', six, standOpenedPayload(uuid(), (await newStand(f)).id)))).status).toBe('applied');
  });

  it('clause 3, ruling 4: the PIN session may be issued up to 10 minutes AFTER the event (a tablet clock a little behind); 11 minutes after does not count', async () => {
    const f = await fixture();
    const MIN = 60e3;
    const behind = await makeStaff(f, 'Bea Behind');
    await pinSession(f, behind, { issuedAt: new Date() });
    expect((await sendOne(f, openEvent(f, behind, 1, new Date(Date.now() - 9 * MIN)))).status, 'issued 9 minutes after the event: inside the slack').toBe('applied');
    const wayBehind = await makeStaff(f, 'Wes Wayback');
    await pinSession(f, wayBehind, { issuedAt: new Date() });
    expectQuarantined(await sendOne(f, ev(2, 'stand.opened', wayBehind, standOpenedPayload(uuid(), (await newStand(f)).id), new Date(Date.now() - 11 * MIN))), PERSON_REFUSED);
  });

  it('clause 4: an event 4 days in the past and one 4 days in the future are quarantined; 2 days either way is applied (the session is valid for all of them)', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId, { issuedAt: new Date(Date.now() - 5 * DAY) }); // within 7 days before the past event; the future event is later still
    await pinSession(f, f.counterId);
    await expectPersonRefused(f, openEvent(f, f.counterId, 1, new Date(Date.now() - 4 * DAY)));
    await expectPersonRefused(f, openEvent(f, f.counterId, 2, new Date(Date.now() + 4 * DAY)));
    expect((await sendOne(f, openEvent(f, f.counterId, 3, new Date(Date.now() - 2 * DAY)))).status).toBe('applied');
    const f2 = await newStand(f);
    expect((await sendOne(f, ev(4, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f2.id), new Date(Date.now() + 2 * DAY)))).status).toBe('applied');
  });

  it('clause 3 edge: a PIN session issued exactly 7 days before the event counts; 7 days and 1 minute before does not', async () => {
    const f = await fixture();
    const at = new Date();
    const exact = await makeStaff(f, 'Eve Exact');
    await pinSession(f, exact, { issuedAt: new Date(at.getTime() - 7 * DAY) });
    expect((await sendOne(f, ev(1, 'stand.opened', exact, standOpenedPayload(uuid(), f.stand7), at))).status).toBe('applied');
    const over = await makeStaff(f, 'Ova Over');
    await pinSession(f, over, { issuedAt: new Date(at.getTime() - 7 * DAY - 60e3) });
    expectQuarantined(await sendOne(f, ev(2, 'stand.opened', over, standOpenedPayload(uuid(), (await newStand(f)).id), at)), PERSON_REFUSED);
  });

  it('clause 4 edge: an event exactly 3 days before or after the server clock is accepted; one minute past either is refused', async () => {
    const f = await fixture();
    const now = new Date();
    const deps = { ...RATES, now: () => now };
    const cases: [string, number, boolean][] = [['past exact', -3 * DAY, true], ['future exact', 3 * DAY, true], ['past +1 minute', -3 * DAY - 60e3, false], ['future +1 minute', 3 * DAY + 60e3, false]];
    let seq = 0;
    for (const [label, offset, accepted] of cases) {
      const who = await makeStaff(f, `Edge ${label}`);
      const at = new Date(now.getTime() + offset);
      await pinSession(f, who, { issuedAt: at }); // clause 3 holds, so only the clock can refuse
      const r = await sendOne(f, ev(++seq, 'stand.opened', who, standOpenedPayload(uuid(), (await newStand(f)).id), at), deps);
      if (accepted) expect(r.status, label).toBe('applied');
      else expectQuarantined(r, PERSON_REFUSED);
    }
  });

  it('a quarantined person-refused row still holds the raw event so a manager can see it', async () => {
    const f = await fixture();
    const none = await makeStaff(f, 'Nora None');
    const e = openEvent(f, none, 1);
    await sendOne(f, e);
    const [row] = await eventsOf(f);
    expect(row).toMatchObject({ kind: 'stand.opened', status: 'quarantined', person_id: none, resolution: null });
    expect(row!.payload).toEqual(e.payload);
  });
});

// ==============================================================================================================================
describe('capability: the domain\'s own authorize() decides, as it does online', () => {
  it('a Server (the 0240 defaults) sending sale.completed is quarantined by authorize(); the same Server\'s refill.requested is applied', async () => {
    const f = await fixture();
    const server = await makeServer0240(f);
    await signedIn(f, f.counterId, server.personId);
    // The counter opens a package table through the inbox; the Server asks for a refill (a capability they hold) and then tries to take payment.
    const sessionId = uuid();
    const pkgLine = uuid();
    const open = await send(f, [
      ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
      ev(2, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId: pkgLine, item: f.menu.unli, qty: 2 }])),
    ]);
    expect(statuses(open)).toEqual(['applied', 'applied']);
    const refillId = uuid();
    const refill = await sendOne(f, ev(3, 'refill.requested', server.personId, {
      sessionId, lines: [{ lineId: refillId, menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }],
    }));
    expect(refill.status).toBe('applied');
    expect((await sql`select 1 from table_session_lines where id = ${refillId} and added_by = ${server.personId} and kind = 'refill'`).length).toBe(1);

    const sale = await sendOne(f, ev(4, 'sale.completed', server.personId, salePayload(f, { sessionId, porkLineId: pkgLine, qty: 2 })));
    expectQuarantined(sale, NOT_ALLOWED);
    expect(await receiptOfSession(sessionId), 'no receipt: the Server cannot take payment').toBeUndefined();
    expect((await sessionRow(sessionId))?.status).toBe('open');
    const rows = await eventsOf(f);
    expect(rows.find((x) => Number(x.seq) === 4)).toMatchObject({ status: 'quarantined', person_id: server.personId });
  });

  it('a kitchen person (no record_sale) opening a stand is quarantined by authorize(); a cashier is applied', async () => {
    const f = await fixture();
    await signedIn(f, f.kitchenId, f.counterId);
    const k = await sendOne(f, ev(1, 'stand.opened', f.kitchenId, standOpenedPayload(uuid(), f.stand7)));
    expectQuarantined(k, NOT_ALLOWED);
    expect((await counts(f)).sessions).toBe(0);
    expect((await sendOne(f, ev(2, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f.stand7)))).status).toBe('applied');
  });
});

// ==============================================================================================================================
describe('R3 - kinds and payloads are checked before the domain runs', () => {
  it('a payload carrying storeId, or pairingId, or any unknown key, or missing a required field is quarantined POS_EVENT_INVALID; nothing reaches the domain', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const sessionId = uuid();
    const good = standOpenedPayload(sessionId, f.stand7);
    const bad: [string, Record<string, unknown>][] = [
      ['storeId', { ...good, storeId: f.storeId }],
      ['pairingId', { ...good, pairingId: f.pairingId }],
      ['unknown key', { ...good, discountPercent: 100 }],
      ['wrong type', { ...good, headsCashier: 'two' }],
    ];
    let seq = 0;
    for (const [label, payload] of bad) {
      const r = await sendOne(f, ev(++seq, 'stand.opened', f.counterId, payload));
      expectQuarantined(r, 'POS_EVENT_INVALID: ');
      expect(r.error, label).not.toContain(f.storeId);
    }
    // a lines.added with no lines at all
    expectQuarantined(await sendOne(f, ev(++seq, 'lines.added', f.counterId, { sessionId })), 'POS_EVENT_INVALID: ');
    expect(await counts(f)).toMatchObject({ sessions: 0, lines: 0 });
    const rows = await eventsOf(f);
    expect(rows).toHaveLength(seq);
    expect(rows.every((x) => x.status === 'quarantined' && x.error!.startsWith('POS_EVENT_INVALID: '))).toBe(true);
    // ...and the same event without the offending key applies (the x cases were about the key, not the event)
    expect((await sendOne(f, ev(++seq, 'stand.opened', f.counterId, good))).status).toBe('applied');
  });

  it('an unknown kind is quarantined POS_EVENT_UNKNOWN_KIND and does not block the queue behind it', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const sessionId = uuid();
    const r = await send(f, [
      ev(1, 'table.teleported', f.counterId, { sessionId }),
      ev(2, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
    ]);
    expect(statuses(r)).toEqual(['quarantined', 'applied']);
    expectQuarantined(r.results[0]!, 'POS_EVENT_UNKNOWN_KIND: ');
    expect((await eventsOf(f))[0]).toMatchObject({ kind: 'table.teleported', status: 'quarantined' });
  });

  it('the server-phone kinds heads.confirmed and line.served are not tablet kinds: they quarantine as unknown', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const sessionId = uuid();
    await send(f, [ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7))]);
    const r = await send(f, [
      ev(2, 'heads.confirmed', f.counterId, { sessionId, headsServer: 3 }),
      ev(3, 'line.served', f.counterId, { lineId: uuid(), servedAtDevice: nowIso() }),
    ]);
    expect(statuses(r)).toEqual(['quarantined', 'quarantined']);
    for (const x of r.results) expectQuarantined(x, 'POS_EVENT_UNKNOWN_KIND: ');
  });

  it('every other tablet kind reaches its T-524 function: heads.set, refill.requested, line.cancelled, discount.added/removed, discount.applied_to_all', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId, f.kitchenId);
    const sessionId = uuid();
    const pkgLine = uuid();
    const porkLine = uuid();
    const discountId = uuid();
    const refillLine = uuid();
    const r = await send(f, [
      ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7, 3)),
      ev(2, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId: pkgLine, item: f.menu.unli, qty: 3 }, { lineId: porkLine, item: f.menu.pork, qty: 2 }])),
      ev(3, 'heads.set', f.counterId, { sessionId, headsCashier: 4 }),
      ev(4, 'refill.requested', f.kitchenId, { sessionId, lines: [{ lineId: refillLine, menuItemId: f.menu.refillRice.itemId, qty: 1, addedAtDevice: nowIso() }] }),
      ev(5, 'discount.added', f.counterId, { discountId, lineId: porkLine, kind: 'preset', presetId: f.emp10, qty: 1, appliedAtDevice: nowIso() }),
      ev(6, 'discount.removed', f.counterId, { discountId, removedAtDevice: nowIso() }),
      ev(7, 'discount.applied_to_all', f.counterId, { sessionId, presetId: f.emp10, applyId: uuid(), appliedAtDevice: nowIso() }),
      ev(8, 'line.cancelled', f.counterId, { lineId: porkLine, reason: 'Customer changed mind' }),
    ]);
    expect(statuses(r), JSON.stringify(r.results.filter((x) => x.status !== 'applied'))).toEqual(Array(8).fill('applied'));
    expect((await sessionRow(sessionId))?.heads_cashier).toBe(4);
    expect((await sql`select 1 from table_session_lines where id = ${porkLine} and kitchen_status = 'cancelled'`).length).toBe(1);
  });
});

// ==============================================================================================================================
describe('R3 - a PIN never lands in a table', () => {
  async function tableWithPork(f: Fx, startSeq: number) {
    const sessionId = uuid();
    const lineId = uuid();
    const r = await send(f, [
      ev(startSeq, 'stand.opened', f.counterId, standOpenedPayload(sessionId, (await newStand(f)).id)),
      ev(startSeq + 1, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId, item: f.menu.pork, qty: 2 }])),
    ]);
    expect(statuses(r)).toEqual(['applied', 'applied']);
    return { sessionId, lineId };
  }

  it('an online void with the manager\'s PIN is applied and the stored payload has pinGiven instead of the PIN (asserted on the raw row)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const managerPin = await pinOf(f, f.managerId);
    const t = await tableWithPork(f, 1);
    const r = await sendOne(f, ev(3, 'session.voided', f.counterId, { sessionId: t.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin: managerPin } }));
    expect(r.status).toBe('applied');
    expect((await sessionRow(t.sessionId))?.status).toBe('voided');
    const [row] = await sql<{ payload: Record<string, unknown> }[]>`select payload from pos_events where org_id = ${f.orgId} and seq = 3`;
    expect(row!.payload.approval).toEqual({ pinGiven: true });
    expect(JSON.stringify(row!.payload), 'the PIN text is nowhere in the row').not.toContain(managerPin);
    expect(Object.keys(row!.payload.approval as object)).not.toContain('pin');
    expect(JSON.stringify(row!.payload.reason)).toBe('"Walked out"');
  });

  it('a WRONG manager PIN is quarantined POS_EVENT_PIN_REFUSED (never retry); the table stays open and the row holds pinGiven, not the PIN', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const t = await tableWithPork(f, 1);
    const wrong = '999999';
    await expect(pinOf(f, f.managerId)).resolves.not.toBe(wrong);
    const r = await sendOne(f, ev(3, 'session.voided', f.counterId, { sessionId: t.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin: wrong } }));
    expectQuarantined(r, PIN_REFUSED);
    expect((await sessionRow(t.sessionId))?.status).toBe('open');
    const [row] = await sql<{ payload: Record<string, unknown>; status: string }[]>`select payload, status from pos_events where org_id = ${f.orgId} and seq = 3`;
    expect(row!.status).toBe('quarantined');
    expect(row!.payload.approval).toEqual({ pinGiven: true });
    expect(JSON.stringify(row!.payload)).not.toContain(wrong);
  });

  it('a wrong PIN counts although the event rolled back, and exactly once: 4 wrong PINs leave the right one working', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const managerPin = await pinOf(f, f.managerId);
    const t = await tableWithPork(f, 1);
    const voidWith = (seq: number, pin: string) => ev(seq, 'session.voided', f.counterId, { sessionId: t.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin } });
    for (let seq = 3; seq <= 6; seq++) expectQuarantined(await sendOne(f, voidWith(seq, '999999')), PIN_REFUSED);
    expect((await sendOne(f, voidWith(7, managerPin))).status, 'four misses are under the cap of five: a double charge would have capped it').toBe('applied');
    expect((await sessionRow(t.sessionId))?.status).toBe('voided');
  });

  it('six wrong PINs trip the cap, and the next attempt, even with the RIGHT PIN, is refused the way the cap refuses', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const managerPin = await pinOf(f, f.managerId);
    const t = await tableWithPork(f, 1);
    const voidWith = (seq: number, pin: string) => ev(seq, 'session.voided', f.counterId, { sessionId: t.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin } });
    const wrong = await send(f, [3, 4, 5, 6, 7, 8].map((seq) => voidWith(seq, '999999')));
    expect(statuses(wrong)).toEqual(Array(6).fill('quarantined'));
    const right = await sendOne(f, voidWith(9, managerPin));
    expectQuarantined(right, PIN_REFUSED);
    expect(right.error).toContain(POS_APPROVAL_PIN_CAPPED);
    expect((await sessionRow(t.sessionId))?.status, 'the right PIN did not void the table: the bucket is capped').toBe('open');
  });

  it('resending an online void that carried a PIN is a duplicate, not a conflict (both sides compare the stripped payload)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const managerPin = await pinOf(f, f.managerId);
    const t = await tableWithPork(f, 1);
    const e = ev(3, 'session.voided', f.counterId, { sessionId: t.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin: managerPin } });
    expect((await sendOne(f, e)).status).toBe('applied');
    expect((await sendOne(f, e)).status).toBe('duplicate');
  });

  it('a PIN is stripped on EVERY kind and at any depth: a top-level pin and an approval.pin on kinds that never carry one are quarantined invalid with pinGiven stored', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const sessionId = uuid();
    const r = await send(f, [
      ev(1, 'heads.set', f.counterId, { sessionId, headsCashier: 3, pin: '482913' }),
      ev(2, 'refill.requested', f.counterId, { sessionId, lines: [], approval: { pin: '482913' } }), // T-576: line.cancelled now carries an optional approval, so a kind that never does
    ]);
    expect(statuses(r)).toEqual(['quarantined', 'quarantined']);
    for (const x of r.results) expectQuarantined(x, 'POS_EVENT_INVALID: ');
    const rows = await eventsOf(f);
    expect(rows[0]!.payload).toEqual({ sessionId, headsCashier: 3, pinGiven: true });
    expect(rows[1]!.payload.approval).toEqual({ pinGiven: true });
    expect(JSON.stringify(rows.map((x) => x.payload))).not.toContain('482913');
  });

  it('a NUL character in any text is quarantined invalid (Postgres cannot store it), stored cleaned; a resend is a duplicate', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const e = ev(1, 'line.cancelled', f.counterId, { lineId: uuid(), reason: 'bad\u0000text' });
    const r = await sendOne(f, e);
    expectQuarantined(r, 'POS_EVENT_INVALID: ');
    expect(r.error).toContain('NUL');
    const [row] = await eventsOf(f);
    expect(row!.payload.reason).toBe('bad\uFFFDtext');
    expect((await sendOne(f, e)).status).toBe('duplicate');
  });

  it('an unpaired UTF-16 surrogate in a value is quarantined invalid and stored as U+FFFD (it would have wedged the queue: jsonb cannot hold it)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const r = await send(f, [ev(1, 'line.cancelled', f.counterId, { lineId: uuid(), reason: 'half \ud800 pair' }), ev(2, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f.stand7))]);
    expect(statuses(r), 'the queue behind it still runs').toEqual(['quarantined', 'applied']);
    expectQuarantined(r.results[0]!, 'POS_EVENT_INVALID: ');
    const [row] = await eventsOf(f);
    expect(row!.payload.reason).toBe('half \uFFFD pair');
  });

  it('an unpaired surrogate in a KEY is handled the same way', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const r = await sendOne(f, ev(1, 'line.cancelled', f.counterId, { lineId: uuid(), reason: 'fine', ['bad\udc00key']: 1 }));
    expectQuarantined(r, 'POS_EVENT_INVALID: ');
    const [row] = await eventsOf(f);
    expect(Object.keys(row!.payload)).toContain('bad\uFFFDkey');
  });

  it('an occurredAtDevice outside the years 1 to 9999 (year +275760) is quarantined invalid for that event only, stored with the received time, the original text in the sentence', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const far = '+275760-09-13T00:00:00.000Z';
    const r = await send(f, [{ ...ev(1, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f.stand7)), occurredAtDevice: far }, ev(2, 'stand.opened', f.counterId, standOpenedPayload(uuid(), (await newStand(f)).id))]);
    expect(statuses(r)).toEqual(['quarantined', 'applied']);
    expectQuarantined(r.results[0]!, 'POS_EVENT_INVALID: ');
    expect(r.results[0]!.error).toContain(far);
    const [row] = await eventsOf(f);
    expect(Math.abs(new Date(row!.occurred_at_device).getTime() - Date.now()), 'stored with the received time').toBeLessThan(5 * 60e3);
    expect((await counts(f)).sessions, 'the far-future event opened nothing').toBe(1);
  });

  it('the safety net: when the quarantine insert fails with a class-22 error, the event is stored once more with payload {unstorable: true}; a resend is a duplicate', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const real = posV2Repo.insertPosEvent;
    vi.spyOn(posV2Repo, 'insertPosEvent').mockImplementation(async (tx, e) => {
      if (e.status === 'quarantined' && !('unstorable' in e.payload)) throw Object.assign(new Error('forced'), { code: '22P05' });
      return real(tx, e);
    });
    const e = ev(1, 'table.teleported', f.counterId, { sessionId: uuid() });
    const r = await sendOne(f, e);
    expect(r.status).toBe('quarantined');
    expect(r.error).toContain('POS_EVENT_UNKNOWN_KIND: ');
    expect(r.error).toContain('22P05');
    const [row] = await eventsOf(f);
    expect(row).toMatchObject({ kind: 'table.teleported', status: 'quarantined', payload: { unstorable: true } });
    expect((await sendOne(f, e)).status).toBe('duplicate');
  });

  it('only if the bare retry fails too is it a retry (nothing stored, the batch stops)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const real = posV2Repo.insertPosEvent;
    vi.spyOn(posV2Repo, 'insertPosEvent').mockImplementation(async (tx, e) => {
      if (e.status === 'quarantined') throw Object.assign(new Error('forced'), { code: '22P05' });
      return real(tx, e);
    });
    const r = await send(f, [ev(1, 'table.teleported', f.counterId, {}), ev(2, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f.stand7))]);
    expect(r.results).toEqual([{ seq: 1, status: 'retry' }]);
    expect(await eventsOf(f)).toHaveLength(0);
  });

  it('a database error of class 22 or 23 is the event\'s own fault (quarantined invalid, SQLSTATE in the sentence); 40001, class 08, 53 and 57 are retries', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const failing = (code: string) => ({ readRules: async () => { throw Object.assign(new Error('forced'), { code }); } });
    let seq = 0;
    for (const code of ['22003', '23514']) {
      const s1 = await seniorSessionDirect(f);
      const r = await sendOne(f, seniorSaleEvent(f, ++seq, s1), failing(code));
      expectQuarantined(r, 'POS_EVENT_INVALID: ');
      expect(r.error).toContain(code);
    }
    for (const code of ['40001', '40P01', '08006', '53200', '57014']) {
      const s2 = await seniorSessionDirect(f);
      const r = await send(f, [seniorSaleEvent(f, ++seq, s2)], failing(code));
      expect(r.results, code).toEqual([{ seq, status: 'retry' }]);
    }
    expect((await eventsOf(f)).map((x) => x.status), 'only the two invalid ones were stored').toEqual(['quarantined', 'quarantined']);
  });

  it('a void that is REFUSED keeps no PIN either: the quarantined row has pinGiven, not the PIN', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const managerPin = await pinOf(f, f.managerId);
    const t = await tableWithPork(f, 1);
    // pay the table first, so the void is refused for the plain reason that it is already paid
    expect((await sendOne(f, ev(3, 'sale.completed', f.counterId, salePayload(f, { sessionId: t.sessionId, porkLineId: t.lineId })))).status).toBe('applied');
    const r = await sendOne(f, ev(4, 'session.voided', f.counterId, { sessionId: t.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin: managerPin } }));
    expectQuarantined(r, REFUSED);
    expect(r.error).toBe(`${REFUSED}This table is already paid.`);
    const [row] = await sql<{ payload: Record<string, unknown>; status: string }[]>`select payload, status from pos_events where org_id = ${f.orgId} and seq = 4`;
    expect(row!.status).toBe('quarantined');
    expect(row!.payload.approval).toEqual({ pinGiven: true });
    expect(JSON.stringify(row!.payload)).not.toContain(managerPin);
  });

  it('an offline void carries offline:true and no PIN: a person who may approve corrections is applied; a cashier is quarantined with the domain\'s sentence', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId, f.adminId);
    const t1 = await tableWithPork(f, 1);
    const cashier = await sendOne(f, ev(3, 'session.voided', f.counterId, { sessionId: t1.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: true }));
    expectQuarantined(cashier, REFUSED);
    expect(cashier.error).toBe(`${REFUSED}A manager must approve voiding a table, and that needs the internet.`);
    expect((await sessionRow(t1.sessionId))?.status).toBe('open');
    const boss = await sendOne(f, ev(4, 'session.voided', f.adminId, { sessionId: t1.sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: true }));
    expect(boss.status).toBe('applied');
    expect((await sessionRow(t1.sessionId))?.status).toBe('voided');
  });
});

// ==============================================================================================================================
describe('R6 - quarantine review (domain only)', () => {
  /** A quarantined lines.added: its table does not exist yet. Returns the event row id and the session the later stand.opened will create. */
  async function quarantinedLines(f: Fx) {
    const sessionId = uuid();
    const lineId = uuid();
    const r = await send(f, [ev(1, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId, item: f.menu.pork, qty: 1 }]))]);
    expect(statuses(r)).toEqual(['quarantined']);
    const [row] = await eventsOf(f);
    return { sessionId, lineId, eventId: row!.id };
  }
  const list = (f: Fx, who = f.manager, storeId = f.storeId) => asOrg(f.orgId, (tx) => INBOX.listPosQuarantine(tx, who, { storeId })) as Promise<Record<string, unknown>[]>;
  const replay = (f: Fx, eventId: string, who = f.manager, storeId = f.storeId) =>
    asOrg(f.orgId, (tx) => INBOX.replayQuarantinedEvent(tx, who, { storeId, eventId })) as Promise<{ replayed: boolean; error?: string }>;
  const discard = (f: Fx, eventId: string, reason: string, who = f.manager, storeId = f.storeId) =>
    asOrg(f.orgId, (tx) => INBOX.discardQuarantinedEvent(tx, who, { storeId, eventId, reason }));
  const rowOf = async (id: string) => (await sql<{ status: string; resolution: string | null; resolved_by: string | null; resolved_at: Date | null; error: string | null }[]>`
    select status, resolution, resolved_by, resolved_at, error from pos_events where id = ${id}`)[0]!;

  async function setup(f: Fx) {
    await signedIn(f, f.counterId);
    return quarantinedLines(f);
  }

  it('the manager\'s list shows seq, kind, who, when it happened, when it arrived, the error and the payload; resolved rows leave the list', async () => {
    const f = await fixture();
    const q = await setup(f);
    const items = await list(f);
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0).toMatchObject({ id: q.eventId, seq: 1, kind: 'lines.added', personName: 'Cara Counter' });
    expect(String(it0.error).startsWith(REFUSED)).toBe(true);
    expect(it0.occurredAtDevice).toBeDefined();
    expect(it0.receivedAt).toBeDefined();
    expect((it0.payload as { sessionId: string }).sessionId).toBe(q.sessionId);
    await discard(f, q.eventId, 'Test row');
    expect(await list(f), 'a resolved row is not in the list').toHaveLength(0);
  });

  it('replay while the cause is still there: still refused, the new sentence comes back, the row stays unresolved and nothing is audited', async () => {
    const f = await fixture();
    const q = await setup(f);
    const res = await replay(f, q.eventId);
    expect(res).toEqual({ replayed: false, error: goneSentence('table') });
    const row = await rowOf(q.eventId);
    expect(row).toMatchObject({ status: 'quarantined', resolution: null, resolved_by: null, resolved_at: null });
    expect(await auditRows(f, 'pos.event_replayed')).toHaveLength(0);
    expect((await counts(f)).lines).toBe(0);
  });

  it('a manager replays after the missing stand.opened arrives: resolution replayed, resolved by the manager, the line exists and belongs to the ORIGINAL person, audited', async () => {
    const f = await fixture();
    const q = await setup(f);
    expect((await sendOne(f, ev(2, 'stand.opened', f.counterId, standOpenedPayload(q.sessionId, f.stand7)))).status).toBe('applied');
    const v = await stateVersionOf(f);
    const res = await replay(f, q.eventId);
    expect(res).toMatchObject({ replayed: true });
    const row = await rowOf(q.eventId);
    expect(row).toMatchObject({ status: 'quarantined', resolution: 'replayed', resolved_by: f.managerId });
    expect(row.resolved_at).not.toBeNull();
    const lines = await sql<{ id: string; added_by: string }[]>`select id, added_by from table_session_lines where session_id = ${q.sessionId}`;
    expect(lines.map((l) => [l.id, l.added_by])).toEqual([[q.lineId, f.counterId]]);
    expect(await stateVersionOf(f)).toBeGreaterThan(v);
    const a = await auditRows(f, 'pos.event_replayed');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_person_id: f.managerId, store_id: f.storeId });
    expect(await list(f)).toHaveLength(0);
  });

  it('a replay of a stored online void cannot re-check the PIN, which was never stored: refused with the one sentence, row unresolved', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const managerPin = await pinOf(f, f.managerId);
    const sessionId = uuid();
    const lineId = uuid();
    await send(f, [
      ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
      ev(2, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId, item: f.menu.pork, qty: 2 }])),
      ev(3, 'sale.completed', f.counterId, salePayload(f, { sessionId, porkLineId: lineId })),
      ev(4, 'session.voided', f.counterId, { sessionId, reason: 'Walked out', voidedAtDevice: nowIso(), offline: false, approval: { pin: managerPin } }),
    ]);
    const [void4] = (await eventsOf(f)).filter((x) => Number(x.seq) === 4);
    expect(void4).toMatchObject({ status: 'quarantined' });
    const res = await replay(f, void4!.id);
    expect(res).toEqual({ replayed: false, error: 'Ask the manager to void this table again from the till.' });
    expect(await rowOf(void4!.id)).toMatchObject({ resolution: null, resolved_by: null });
  });

  it('discard needs a reason of 1 to 200 characters: none, blank and 201 are refused and leave the row open; 200 is accepted', async () => {
    const f = await fixture();
    const q = await setup(f);
    for (const bad of ['', '   ', 'x'.repeat(201)]) {
      await expectRefusal(discard(f, q.eventId, bad));
      expect(await rowOf(q.eventId), `reason "${bad.slice(0, 5)}..." left it open`).toMatchObject({ resolution: null });
    }
    await discard(f, q.eventId, 'x'.repeat(200));
    expect(await rowOf(q.eventId)).toMatchObject({ resolution: 'discarded' });
  });

  it('discard sets resolution discarded and the resolver, audits pos.event_discarded with the reason, and the row is never deleted', async () => {
    const f = await fixture();
    const q = await setup(f);
    const before = (await eventsOf(f)).length;
    await discard(f, q.eventId, 'Duplicate of a paper note');
    const row = await rowOf(q.eventId);
    expect(row).toMatchObject({ status: 'quarantined', resolution: 'discarded', resolved_by: f.managerId });
    expect(row.resolved_at).not.toBeNull();
    expect(row.error, 'the original error is kept').not.toBeNull();
    expect((await eventsOf(f)).length, 'never deleted').toBe(before);
    const a = await auditRows(f, 'pos.event_discarded');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_person_id: f.managerId, store_id: f.storeId });
    expect(JSON.stringify(a[0])).toContain('Duplicate of a paper note');
  });

  it('a row can be resolved once: replay after replay, discard after replay, replay after discard and discard after discard are all "This event was already handled."', async () => {
    const f = await fixture();
    const q = await setup(f);
    await discard(f, q.eventId, 'first');
    const HANDLED = 'This event was already handled.';
    await expectRefusal(discard(f, q.eventId, 'second'), HANDLED);
    await expectRefusal(replay(f, q.eventId), HANDLED);
    expect(await rowOf(q.eventId)).toMatchObject({ resolution: 'discarded' });

    const g = await fixture();
    const q2 = await setup(g);
    await sendOne(g, ev(2, 'stand.opened', g.counterId, standOpenedPayload(q2.sessionId, g.stand7)));
    expect(await replay(g, q2.eventId)).toMatchObject({ replayed: true });
    await expectRefusal(replay(g, q2.eventId), HANDLED);
    await expectRefusal(discard(g, q2.eventId, 'late'), HANDLED);
    expect(await rowOf(q2.eventId)).toMatchObject({ resolution: 'replayed' });
    expect((await sql`select 1 from table_session_lines where session_id = ${q2.sessionId}`).length, 'the second replay wrote nothing').toBe(1);
  });

  it('a cashier without approve_pos_correction is refused by authorize() on list, replay and discard; the row is untouched', async () => {
    const f = await fixture();
    const q = await setup(f);
    await expectAuthRefusal(list(f, f.counter));
    await expectAuthRefusal(replay(f, q.eventId, f.counter));
    await expectAuthRefusal(discard(f, q.eventId, 'I am only a cashier', f.counter));
    expect(await rowOf(q.eventId)).toMatchObject({ resolution: null, resolved_by: null });
  });

  it('another store\'s manager is refused: at this store by authorize(), and with their own store plus this store\'s event id as "not found"; the row is untouched', async () => {
    const f = await fixture();
    const q = await setup(f);
    await expectAuthRefusal(list(f, f.managerOther, f.storeId));
    await expectAuthRefusal(replay(f, q.eventId, f.managerOther, f.storeId));
    await expectAuthRefusal(discard(f, q.eventId, 'not mine', f.managerOther, f.storeId));
    // their OWN store, but another store's event id: the event is invisible to them
    await expectRefusal(replay(f, q.eventId, f.managerOther, f.store2Id));
    await expectRefusal(discard(f, q.eventId, 'not mine', f.managerOther, f.store2Id));
    expect(await list(f, f.managerOther, f.store2Id), 'their own store has nothing').toHaveLength(0);
    expect(await rowOf(q.eventId)).toMatchObject({ resolution: null, resolved_by: null });
    expect(await list(f), 'and the real manager still sees it').toHaveLength(1);
  });

  const replayWith = (f: Fx, eventId: string) => asOrg(f.orgId, (tx) => INBOX.replayQuarantinedEvent(tx, f.manager, { storeId: f.storeId, eventId }, RATES)) as Promise<{ replayed: boolean; error?: string }>;

  it('a quarantined sale is replayed once its table is ready: one receipt, resolution replayed (T-572: a senior sale is refused instead - see t572-senior-id-scrub)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const [open, lines, sale] = plainDay(f).events as [Ev, Ev, Ev];
    // the sale arrives BEFORE the lines it sells: refused, so quarantined; the lines then land
    const r = await send(f, [open, { ...sale, seq: 2 }, { ...lines, seq: 3 }], RATES);
    expect(statuses(r)).toEqual(['applied', 'quarantined', 'applied']);
    const row = (await eventsOf(f)).find((x) => Number(x.seq) === 2)!;
    expect(await replayWith(f, row.id)).toMatchObject({ replayed: true });
    expect(await counts(f)).toMatchObject({ receipts: 1, statutory: 0 });
    expect(await rowOf(row.id)).toMatchObject({ resolution: 'replayed', resolved_by: f.managerId });
  });

  it('a sale replay that refuses THROWS (the manager transaction aborts): no receipt, the row stays unresolved', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const [open, , sale] = plainDay(f).events as [Ev, Ev, Ev];
    const r = await send(f, [open, { ...sale, seq: 2 }], RATES); // its lines never arrive
    expect(statuses(r)).toEqual(['applied', 'quarantined']);
    const row = (await eventsOf(f)).find((x) => Number(x.seq) === 2)!;
    await expectRefusal(replayWith(f, row.id));
    expect(await counts(f)).toMatchObject({ receipts: 0, statutory: 0 });
    expect(await rowOf(row.id)).toMatchObject({ resolution: null, resolved_by: null });
  });

  it('replay keeps the clock rule against the arrival time: a 4-day-old event stays refused; a 2.9-day-old one replays', async () => {
    const f = await fixture();
    await pinSession(f, f.counterId, { issuedAt: new Date(Date.now() - 5 * DAY) });
    const old = ev(1, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f.stand7), new Date(Date.now() - 4 * DAY));
    expect(statuses(await send(f, [old]))).toEqual(['quarantined']);
    const oldRow = (await eventsOf(f))[0]!;
    const refused = await replayWith(f, oldRow.id);
    expect(refused.replayed).toBe(false);
    expect(refused.error).toMatch(/clock/i);
    expect(await rowOf(oldRow.id)).toMatchObject({ resolution: null });

    const sessionId = uuid();
    const heads = ev(2, 'heads.set', f.counterId, { sessionId, headsCashier: 4 }, new Date(Date.now() - 2.9 * DAY));
    const open = ev(3, 'stand.opened', f.counterId, standOpenedPayload(sessionId, (await newStand(f)).id));
    expect(statuses(await send(f, [heads, open]))).toEqual(['quarantined', 'applied']);
    const headsRow = (await eventsOf(f)).find((x) => Number(x.seq) === 2)!;
    expect(await replayWith(f, headsRow.id)).toMatchObject({ replayed: true });
    expect((await sessionRow(sessionId))?.heads_cashier).toBe(4);
  });

  it('replay refuses a row that was invalid as sent: "This event was not valid as sent. Discard it and re-enter the sale on the till."; it can only be discarded', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    expectQuarantined(await sendOne(f, ev(1, 'line.cancelled', f.counterId, { lineId: uuid(), reason: 'bad\u0000text' })), 'POS_EVENT_INVALID: ');
    const row = (await eventsOf(f))[0]!;
    expect(await replayWith(f, row.id)).toEqual({ replayed: false, error: 'This event was not valid as sent. Discard it and re-enter the sale on the till.' });
    expect(await rowOf(row.id)).toMatchObject({ resolution: null });
    await discard(f, row.id, 'Re-entered on the till');
    expect(await rowOf(row.id)).toMatchObject({ resolution: 'discarded' });
  });

  it('both review actions are in the audit catalogue, owned by T-525', () => {
    for (const a of ['pos.event_replayed', 'pos.event_discarded']) expect(catalogueEntry(a), a).toMatchObject({ owner: 'T-525' });
  });
});

// ==============================================================================================================================
describe('R7 - the snapshot (domain: buildPosSnapshot)', () => {
  type Snap = { body: Record<string, unknown>; etag: string; nextChangeAt: string | null };
  const pairingOf = (f: Fx) => ({ pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId });
  const snapshot = (f: Fx, deps: Deps | undefined = RATES) => asOrg(f.orgId, (tx) => SNAPSHOT.buildPosSnapshot(tx, { pairing: pairingOf(f) }, deps)) as Promise<Snap>;
  const keysDeep = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
    return out;
  };
  const ids = (xs: unknown) => (xs as { id: string }[]).map((x) => x.id).sort();

  it('contains exactly the R7 keys, in a body that survives JSON (no bigint)', async () => {
    const f = await fixture();
    const s = await snapshot(f);
    expect(Object.keys(s.body).sort()).toEqual(['businessDate', 'device', 'discountPresets', 'menu', 'rules', 'staff', 'stands', 'store', 'tenders']);
    expect(() => JSON.stringify(s.body)).not.toThrow();
    expect(s.etag).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it('store: id, name, mode and this pairing\'s till number', async () => {
    const f = await fixture();
    const s = await snapshot(f);
    expect(s.body.store).toEqual({ storeId: f.storeId, name: f.storeName, mode: 'test', terminalNo: 1, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1 }); // T-546: the till's printer settings ride in store; the fixture's organization is VAT (tax_type 'vat')
  });

  it('T-528 R1: a non-VAT organization has store.vatRegistered false, and the ETag changes when tax_type changes (the tablet refetches)', async () => {
    const f = await fixture();
    const vat = await snapshot(f);
    expect((vat.body.store as { vatRegistered: boolean }).vatRegistered).toBe(true);
    await sql`update organizations set tax_type = 'non_vat' where id = ${f.orgId}`;
    const nonVat = await snapshot(f);
    expect((nonVat.body.store as { vatRegistered: boolean }).vatRegistered).toBe(false);
    expect(nonVat.etag).not.toBe(vat.etag);
    await sql`update organizations set tax_type = 'vat' where id = ${f.orgId}`;
    expect((await snapshot(f)).etag, 'back to VAT: the same body, the same ETag').toBe(vat.etag);
  });

  it('menu is loadStoreMenu\'s own answer: the menu, its content hash, and the next change time', async () => {
    const f = await fixture();
    const s = await snapshot(f);
    const menu = s.body.menu as { menu: { items: { id: string }[] }; contentHash: string };
    expect(typeof menu.contentHash).toBe('string');
    expect(menu.menu.items.map((i) => i.id)).toContain(f.menu.pork.itemId);
    const direct = await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, new Date()));
    expect(menu.contentHash).toBe(direct.contentHash);
    expect(s.nextChangeAt ?? null).toBe(direct.nextChangeAt ?? null);
  });

  it('stands: this store\'s ACTIVE stands only; tenders: this store\'s ACTIVE tenders only; presets: this store\'s ACTIVE presets only', async () => {
    const f = await fixture();
    const s = await snapshot(f);
    expect(ids(s.body.stands)).toEqual([f.stand7]);
    expect(ids(s.body.tenders)).toEqual([f.cash, f.gcash].sort());
    for (const t of s.body.tenders as { id: string; name: string; kind: string }[]) expect(Object.keys(t)).toEqual(expect.arrayContaining(['id', 'name', 'kind']));
    expect((s.body.tenders as { id: string; kind: string }[]).find((t) => t.id === f.gcash)?.kind).toBe('wallet');
    expect(ids(s.body.discountPresets)).toEqual([f.emp10, f.promo50].sort());
    const emp = (s.body.discountPresets as { id: string; name: string; valueType: string; value: string }[]).find((p) => p.id === f.emp10)!;
    expect(emp).toMatchObject({ name: 'Employee 10%', valueType: 'percent' });
    expect(Number(emp.value)).toBe(10);
  });

  it('rules: the three business rules in basis points and the day-start hour; the default reader (no deps) returns the same real values', async () => {
    const f = await fixture();
    const s = await snapshot(f);
    const r = s.body.rules as Record<string, unknown>;
    expect(Number(r.vatPercentBasisPoints)).toBe(1200);
    expect(Number(r.scPwdPercentBasisPoints)).toBe(2000);
    expect(r.businessDayStartHour).toBe(4);
    expect(r.tableWarnMinutes).toBe(90);
    const d = (await snapshot(f, {})).body.rules as Record<string, unknown>;
    expect([Number(d.vatPercentBasisPoints), Number(d.scPwdPercentBasisPoints), d.businessDayStartHour, d.tableWarnMinutes]).toEqual([1200, 2000, 4, 90]);
  });

  it('rules (T-539 S3): the snapshot carries pos.table_warn_minutes; a dated change to 30 shows through the default reader and an injected reader is passed through [kills: tableWarnMinutes dropped from the snapshot body]', async () => {
    const f = await fixture();
    await putRule(sql, f.orgId, 'pos.table_warn_minutes', '30.000000', '2000-01-02');
    expect(((await snapshot(f, {})).body.rules as Record<string, unknown>).tableWarnMinutes).toBe(30);
    const injected = { readRules: async () => ({ vatPercentBasisPoints: 1200n, scPwdPercentBasisPoints: 2000n, businessDayStartHour: 4, tableWarnMinutes: 45, saleVarianceToleranceCentavos: 1n, requirePinLineActions: false }) };
    expect(((await snapshot(f, injected)).body.rules as Record<string, unknown>).tableWarnMinutes).toBe(45);
  });

  it('staff: who may sign in now, with the 3-digit code and ONLY the POS capabilities they hold; nobody who may not; no PIN material anywhere', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId, f.kitchenId); // creates their PIN credentials (secret and lookup hashes now exist)
    const gone = await makeStaff(f, 'Gil Gone');
    await sql`delete from person_store_scope where person_id = ${gone}`;
    await sql`update employments set ended_on = '2025-06-01', employment_status = 'resigned' where person_id = ${gone}`;
    const s = await snapshot(f);
    const staff = s.body.staff as { personId: string; displayName: string; employeeId: string | number; posCapabilities: string[] }[];
    const by = new Map(staff.map((p) => [p.personId, p]));
    expect(by.has(f.counterId) && by.has(f.kitchenId)).toBe(true);
    expect(by.has(f.managerOtherId), 'store B\'s manager may not sign in here').toBe(false);
    expect(by.has(gone), 'a person whose employment ended is gone').toBe(false);
    for (const p of staff) expect(Object.keys(p).sort()).toEqual(['displayName', 'employeeId', 'personId', 'posCapabilities']);
    expect(by.get(f.counterId)!.displayName).toBe('Cara Counter');
    expect(String(by.get(f.counterId)!.employeeId).padStart(3, '0')).toBe(f.staffCodes.get(f.counterId)!.slice(3));
    expect(by.get(f.counterId)!.posCapabilities).toEqual(['record_sale']);
    expect([...by.get(f.kitchenId)!.posCapabilities].sort()).toEqual(['request_pos_refill', 'serve_pos_ticket']);
    // the closed list is the only thing a capability array may hold
    const POS = ['record_sale', 'request_pos_refill', 'serve_pos_ticket', 'confirm_pos_heads', 'approve_pos_correction'];
    for (const p of staff) for (const c of p.posCapabilities) expect(POS).toContain(c);

    expect(keysDeep(staff).filter((k) => /pin|hash|secret|salt/i.test(k)), 'no key that looks like PIN material').toEqual([]);
    const text = JSON.stringify(staff);
    const creds = await sql<{ secret_hash: string; lookup_hash: string }[]>`select secret_hash, lookup_hash from person_credentials where person_id in ${sql([f.counterId, f.kitchenId])} and kind = 'pin'`;
    expect(creds.length).toBeGreaterThan(0);
    for (const c of creds) {
      expect(text).not.toContain(c.secret_hash);
      expect(text).not.toContain(c.lookup_hash);
    }
    for (const id of [f.counterId, f.kitchenId]) expect(text).not.toContain(await pinOf(f, id));
  });

  it('device: lastSeq is the highest stored seq of ANY status and lastTerminalSeq the highest receipt number, both 0 before the first sale', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    expect((await snapshot(f)).body.device).toEqual({ pairingId: f.pairingId, lastSeq: 0, lastTerminalSeq: 0 });
    const day = plainDay(f);
    await send(f, [...day.events, ev(4, 'table.teleported', f.counterId, {})]);
    expect((await snapshot(f)).body.device, 'a quarantined seq counts, so a reinstalled tablet never reuses it').toEqual({ pairingId: f.pairingId, lastSeq: 4, lastTerminalSeq: day.terminalSeq });
  });

  it('businessDate is T-524\'s currentBusinessDate for the store', async () => {
    const f = await fixture();
    const s = await snapshot(f);
    const direct = await asOrg(f.orgId, (tx) => currentBusinessDate(tx, f.storeId, RATES));
    expect(s.body.businessDate).toBe(direct);
    expect(String(s.body.businessDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('the ETag is stable for an unchanged body, and changes when a price changes', async () => {
    const f = await fixture();
    const a = await snapshot(f);
    const b = await snapshot(f);
    expect(b.etag).toBe(a.etag);
    await insOffer(f, f.menu.pork.variantId, '275.00'); // a newer store offer for the pork: its price is now 275.00
    // The offer is stored at now() (microseconds); the snapshot reads the menu at now() cut to the millisecond (a JS Date). Taken in the same millisecond the new offer is still "upcoming" and the ETag is unchanged, so wait (at most ~2 ms, on the database clock) until it is past.
    await sql`select pg_sleep(greatest(0, extract(epoch from (select max(effective_from) from menu_offers where variant_id = ${f.menu.pork.variantId}) + interval '2 milliseconds' - clock_timestamp())))`;
    const c = await snapshot(f);
    expect(c.etag).not.toBe(a.etag);
    expect((c.body.menu as { contentHash: string }).contentHash).not.toBe((a.body.menu as { contentHash: string }).contentHash);
  });

  it('the ETag changes when the tablet\'s own counters move (a new event is stored)', async () => {
    const f = await fixture();
    await signedIn(f, f.counterId);
    const a = await snapshot(f);
    await send(f, [ev(1, 'stand.opened', f.counterId, standOpenedPayload(uuid(), f.stand7))]);
    expect((await snapshot(f)).etag).not.toBe(a.etag);
  });

  it('a pairing with no terminal row is refused: "This tablet has no till number yet. Ask a manager."', async () => {
    const f = await fixture();
    await sql`delete from pos_terminals where pairing_id = ${f.pairingId}`;
    await expectRefusal(snapshot(f), 'This tablet has no till number yet. Ask a manager.');
  });
});
