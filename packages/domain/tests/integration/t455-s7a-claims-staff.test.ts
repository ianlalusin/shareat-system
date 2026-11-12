import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S7a (TESTER) - the senior/PWD discount claim, DOMAIN, cashier + tablet side: docs/tasks/455-customer-lobby.md 3.2 (discount claim approval), 4.5 (OCR/typed is
 * never trusted: approve needs a SEATED entry, this store's session, a pending claim), 4.6 (who sees a claim; open = audit row; every approve/reject audited),
 * 4.7, "S5 rulings" 1-2 (terminal actor), "S6a rulings" 1 (three doors, one core) and the S7a row of section 5. Real Postgres via TEST_DATABASE_URL.
 * PERSONAL DATA: every name and ID number is a SYNTHETIC test value. S7a does NOT touch POS: `sessionRef` / `statutoryDinerRef` are plain strings the POS (S7b) will pass.
 *
 * RED TODAY, for one reason: packages/domain/src/lobby/claims.ts does not exist (the import below fails to resolve).
 *
 * CONTRACT ASSUMED (the orchestrator rules on every ASSUMED line):
 *   Staff (an ERP person, authorize(record_sale) at the CLAIM's own store, like birthday.ts):
 *     listClaimRequests(tx, actor, storeId), openClaim(tx, actor, claimId), approveClaim(tx, actor, { claimId, cardSeen, sessionRef, statutoryDinerRef }), rejectClaim(tx, actor, { claimId, reason })
 *   Terminal (TerminalActor, no authorize(); another store's claim answers exactly like a ghost id = LOBBY_NOT_FOUND):
 *     listClaimsForTerminal(tx, t), openClaimForTerminal(tx, t, claimId), approveClaimForTerminal(tx, t, input), rejectClaimForTerminal(tx, t, input)
 *   One shared core for both doors.
 *   LIST ROW (pending claims of the store, oldest first, entries live OR seated; closed-unseated claims are already expired): { claimId, entryId, code, displayName, standLabel (null until seated),
 *     partySize, kind, idMasked ('****1187'), ocrAssisted, status: 'pending', createdAt }. NEVER holderName / idNumber / deviceHash / ipHash / handoffUrl / phone. The list writes NO audit row.
 *   OPEN ("Open claim"): the ONLY call that returns the full holderName + idNumber; pending claims only (a decided claim has nothing left: LOBBY_CLAIM_CLOSED). Writes ONE audit row
 *     'lobby.claim_open' every time. Returns { claimId, entryId, code, kind, holderName, idNumber, idLast4, ocrAssisted, partySize, standLabel, sessionRef }.
 *   APPROVE: entry must be SEATED (else LOBBY_CLAIM_NEEDS_SEAT), `sessionRef` must equal the entry's session_ref (another store's / another table's session -> LOBBY_CLAIM_NEEDS_SEAT too, ASSUMED:
 *     one code), `cardSeen` must be exactly true (else LOBBY_CLAIM_NEEDS_CARD), `statutoryDinerRef` a non-blank string <= 80 (else LOBBY_BAD_INPUT), claim must be pending (else LOBBY_CLAIM_CLOSED:
 *     a retried approve is refused, not repeated). Writes status approved, session_ref, statutory_diner_ref, acted_by_person_id, card_seen_at, decided_at; name and ID become NULL (the DB CHECK).
 *     Audit 'lobby.claim_approve'. Result { claimId, status: 'approved' }.
 *   REJECT: reason trimmed 1..80 (else LOBBY_BAD_INPUT); pending only (else LOBBY_CLAIM_CLOSED); allowed on a live OR seated entry; name/ID NULL; reject_reason stored; slot freed. Audit 'lobby.claim_reject'.
 *   AUDIT: actions lobby.claim_open / lobby.claim_approve / lobby.claim_reject (catalogue cap raised by 3), entity_id = claim id, store_id = the entry's store, source 'pos', actor = the acting person
 *     (terminal: the terminal person, after.cashier = the cashier's name). Payloads hold the booking code, kind, status and idLast4 at most: NO holder name, NO ID number, NO diner name, NO session secret.
 *   A refused move is not audited. Order of checks: store guard first (ghost / other store), then state.
 *
 * MUTANT INDEX: approve on a waiting/called entry; approve with the wrong store's session; approve without cardSeen (false, missing, "true", 1); approve twice; approve not nulling name/ID; acted_by/card_seen missing;
 * statutory_diner_ref dropped; open without audit / audit with name or ID / open of a decided claim returning data; list leaking name or ID or showing other stores' / decided claims; a store-B cashier or
 * a role without record_sale approving/opening/rejecting; terminal calling authorize(); other store answered differently from a ghost id; reject without or with a huge reason; reject not freeing the
 * slot; refused move audited; audit payload carrying the name or ID; approve/approve race double-writing.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, flushSecurityEvents, type Actor } from '@shareat/auth';
import {
  approveClaim,
  approveClaimForTerminal,
  listClaimRequests,
  listClaimsForTerminal,
  openClaim,
  openClaimForTerminal,
  rejectClaim,
  rejectClaimForTerminal,
  submitClaim,
} from '../../src/lobby/claims';
import { LobbyRefusal } from '../../src/lobby/refusal';
import type { TerminalActor } from '../../src/lobby/terminal';

const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ------------------------------------------------------------------------------------------------ helpers
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
async function refusedIn(orgId: string, fn: (tx: Tx) => Promise<unknown>): Promise<unknown> {
  return asOrg(orgId, async (tx) => {
    let err: unknown;
    try {
      await fn(tx);
    } catch (e) {
      if (e instanceof TypeError && /is not a function|is not defined/.test(e.message)) throw e;
      err = e;
    }
    await tx.execute(dsql`select 1`);
    return err;
  });
}
function expectRefusal(err: unknown, code: string, what: string): LobbyRefusal {
  expect(err, `${what}: was not refused (or not a LobbyRefusal)`).toBeInstanceOf(LobbyRefusal);
  const e = err as LobbyRefusal;
  expect(e.code, `${what}: wrong code (${e.message})`).toBe(code);
  expect(e.userMessage, `${what}: plain sentence`).toMatch(/^[A-Z][^\n]{8,160}[.]$/);
  expect(e.userMessage, `${what}: database wording`).not.toMatch(/violates|constraint|duplicate|relation|lobby_|null value|23\d{3}|LOBBY_/i);
  expect(`${e.message} ${e.userMessage}`, `${what}: PII in the refusal`).not.toMatch(/Quillfeather|Tuckerman|1187|0042/);
  return e;
}
function expectAuthRefusal(err: unknown, what: string) {
  expect(err, `${what}: not refused with AuthorizationError`).toBeInstanceOf(AuthorizationError);
  expect(`${(err as Error).message}`, `${what}: database wording`).not.toMatch(/violates|duplicate key|relation "/i);
}

type S = { orgId: string; storeId: string };
type Raw = Record<string, string | number | boolean | null>;
const HOLDER = 'Zanzibar Quillfeather';
const ID_NO = '0042-5566-1187'; // synthetic
const DINER = 'Ana Tuckerman';
const CASHIER = 'Cora Cashier';
const SESSION = 'SESS-S7A-1';
const SD_REF = 'SD-0001';

async function fx(hint: string) {
  const code = uid(`t455s7a-staff-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, claims_enabled, pos_seen_at) values (${orgId}, ${st!.id}, true, false, 60, true, now())`;
    return { orgId, storeId: st!.id };
  };
  const A = await store();
  const B = await store();
  const person = async (name: string, role: string | null, scope: string[]): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const cashierA = await person('Cashier A', 'manager', [A.storeId]);
  const cashierB = await person('Cashier B', 'manager', [B.storeId]);
  const floorA = await person('Floor A', 'staff', [A.storeId]); // a role without record_sale
  const terminal = await person('Terminal 01', null, []);
  const tabletFor = (s: S): TerminalActor => ({ orgId, erpStoreId: s.storeId, terminalPersonId: terminal.personId, cashierName: CASHIER });
  return { orgId, A, B, cashierA, cashierB, floorA, terminal, tabletFor };
}
type Fx = Awaited<ReturnType<typeof fx>>;

let codeN = Math.floor(Math.random() * 3000);
async function entry(s: S, o: { status?: string; party?: number; extra?: Raw } = {}): Promise<string> {
  const status = o.status ?? 'waiting';
  const row: Raw = {
    org_id: s.orgId, store_id: s.storeId, source: 'lobby', code: String(1000 + (++codeN % 9000)), display_name: DINER, party_size: o.party ?? 3,
    status, device_hash: uid('dev'), ip_hash: uid('ip'), client_request_id: uid('req'), created_at: ago(5),
    ...(status === 'called' ? { called_at: ago(1) } : {}),
    ...(status === 'seated' ? { session_ref: SESSION, stand_label: '7', closed_at: ago(1), seated_at: ago(1) } : {}),
    ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return r!.id;
}
/** A pending claim (via raw SQL, with name + ID) on a fresh entry at store s. */
async function claim(f: Fx, s: S, o: { status?: string; party?: number; entryId?: string; last4?: string } = {}): Promise<{ id: string; entryId: string }> {
  const entryId = o.entryId ?? (await entry(s, { status: o.status, party: o.party }));
  const [c] = await sql<{ id: string }[]>`insert into lobby_discount_claims (org_id, entry_id, kind, holder_name, id_number, id_last4) values (${f.orgId}, ${entryId}, 'senior', ${HOLDER}, ${ID_NO}, ${o.last4 ?? '1187'}) returning id`;
  return { id: c!.id, entryId };
}
const rowOf = async (id: string) => (await sql<Record<string, any>[]>`select * from lobby_discount_claims where id = ${id}`)[0]!;
const auditFor = async (s: S, action?: string) =>
  await sql<{ action: string; actor_person_id: string | null; source: string; before: unknown; after: unknown; entity_id: string }[]>`
    select action, actor_person_id, source, before, after, entity_id from audit_log
     where org_id = ${s.orgId} and store_id = ${s.storeId} and action like 'lobby.claim%' ${action ? sql`and action = ${action}` : sql``} order by occurred_at, id`;
const denials = async (f: Fx, actor: Actor) => {
  await flushSecurityEvents();
  return sql<{ after: { capability?: string } | null }[]>`select after from audit_log where org_id = ${f.orgId} and action = 'security.authorize_denied' and actor_person_id = ${actor.personId}`;
};
const approveInput = (id: string, o: Record<string, unknown> = {}) => ({ claimId: id, cardSeen: true, sessionRef: SESSION, statutoryDinerRef: SD_REF, ...o }) as { claimId: string; cardSeen: boolean; sessionRef: string; statutoryDinerRef: string };
const noPii = (o: unknown, what: string) => {
  const t = JSON.stringify(o);
  expect(t, `${what}: holder name`).not.toContain('Quillfeather');
  expect(t, `${what}: diner name`).not.toContain('Tuckerman');
  expect(t, `${what}: full ID number`).not.toMatch(/0042-5566|00425566/);
};

// ================================================================================================ A. the list
describe('A. listClaimRequests / listClaimsForTerminal: masked, own store, pending only', () => {
  it('A1 the list holds only this store\'s PENDING claims (live and seated entries), oldest first, with exactly the row keys and ****1187; no name or full ID anywhere; no audit row is written [kills: leaking name/ID, other stores\' or decided claims, hashes, audit on list]', async () => {
    const f = await fx('a1');
    const waiting = await claim(f, f.A);
    const seated = await claim(f, f.A, { status: 'seated', last4: '4455' });
    const otherStore = await claim(f, f.B);
    const decidedEntry = await entry(f.A);
    const [d] = await sql<{ id: string }[]>`insert into lobby_discount_claims (org_id, entry_id, kind, holder_name, id_number, id_last4) values (${f.orgId}, ${decidedEntry}, 'pwd', ${HOLDER}, ${ID_NO}, '9999') returning id`;
    await sql`update lobby_discount_claims set status = 'expired', holder_name = null, id_number = null where id = ${d!.id}`;
    const rows = await asOrg(f.orgId, (tx) => listClaimRequests(tx, f.cashierA, f.A.storeId));
    expect(rows.map((r) => r.claimId)).toEqual([waiting.id, seated.id]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['claimId', 'code', 'createdAt', 'displayName', 'entryId', 'idMasked', 'kind', 'ocrAssisted', 'partySize', 'standLabel', 'status']);
    expect(rows[0]).toMatchObject({ entryId: waiting.entryId, status: 'pending', idMasked: '****1187', standLabel: null, kind: 'senior', partySize: 3, displayName: DINER });
    expect(rows[1]).toMatchObject({ idMasked: '****4455', standLabel: '7' });
    expect(rows.map((r) => r.claimId)).not.toContain(otherStore.id);
    const json = JSON.stringify(rows);
    expect(json).not.toContain('Quillfeather');
    expect(json).not.toMatch(/0042-5566|00425566/);
    expect(json).not.toMatch(/deviceHash|ipHash|handoffUrl|phone|idNumber|holderName/);
    expect(await auditFor(f.A)).toHaveLength(0);
    const viaTablet = await asOrg(f.orgId, (tx) => listClaimsForTerminal(tx, f.tabletFor(f.A)));
    expect(viaTablet.map((r) => r.claimId)).toEqual([waiting.id, seated.id]);
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('A2 a cashier scoped to ANOTHER store, and a role without record_sale, cannot list store A (AuthorizationError, denial recorded) [kills: list without authorize, store taken from the caller]', async () => {
    const f = await fx('a2');
    await claim(f, f.A);
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => listClaimRequests(tx, f.cashierB, f.A.storeId)), 'store-B cashier');
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => listClaimRequests(tx, f.floorA, f.A.storeId)), 'floor role');
    expect((await denials(f, f.cashierB)).some((d) => d.after?.capability === 'record_sale')).toBe(true);
  });
});

// ================================================================================================ B. open (the only full view)
describe('B. openClaim: the only call that returns the full name and ID, and it leaves an audit row', () => {
  it('B1 OPEN returns the full holderName + idNumber of a pending claim and writes ONE lobby.claim_open audit row (actor, store, claim id); the audit payload holds no name and no ID number [kills: no audit on view, PII in the audit row, wrong actor/store]', async () => {
    const f = await fx('b1');
    const c = await claim(f, f.A, { status: 'seated' });
    const full = await asOrg(f.orgId, (tx) => openClaim(tx, f.cashierA, c.id));
    expect(full).toMatchObject({ claimId: c.id, entryId: c.entryId, kind: 'senior', holderName: HOLDER, idNumber: ID_NO, idLast4: '1187', ocrAssisted: false, partySize: 3, standLabel: '7', sessionRef: SESSION });
    const audit = await auditFor(f.A);
    expect(audit.map((a) => a.action)).toEqual(['lobby.claim_open']);
    expect(audit[0]).toMatchObject({ actor_person_id: f.cashierA.personId, entity_id: c.id, source: 'pos' });
    noPii(audit, 'open audit');
    await asOrg(f.orgId, (tx) => openClaim(tx, f.cashierA, c.id));
    expect(await auditFor(f.A, 'lobby.claim_open'), 'each view is its own row').toHaveLength(2);
    expect((await rowOf(c.id)).status, 'viewing does not decide').toBe('pending');
  });

  it('B2 the tablet door: same data, audit row by the terminal person with after.cashier; another store\'s claim answers like a ghost id and writes nothing [kills: terminal door unaudited, other store distinguishable]', async () => {
    const f = await fx('b2');
    const c = await claim(f, f.A);
    const full = await asOrg(f.orgId, (tx) => openClaimForTerminal(tx, f.tabletFor(f.A), c.id));
    expect(full).toMatchObject({ holderName: HOLDER, idNumber: ID_NO });
    const audit = await auditFor(f.A, 'lobby.claim_open');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_person_id).toBe(f.terminal.personId);
    expect((audit[0]!.after as { cashier?: string }).cashier).toBe(CASHIER);
    noPii(audit, 'tablet open audit');
    const foreign = await claim(f, f.B);
    expectRefusal(await refusedIn(f.orgId, (tx) => openClaimForTerminal(tx, f.tabletFor(f.A), foreign.id)), 'LOBBY_NOT_FOUND', 'other store\'s claim');
    expectRefusal(await refusedIn(f.orgId, (tx) => openClaimForTerminal(tx, f.tabletFor(f.A), '00000000-0000-4000-8000-000000000000')), 'LOBBY_NOT_FOUND', 'ghost id');
    expectRefusal(await refusedIn(f.orgId, (tx) => openClaimForTerminal(tx, f.tabletFor(f.A), 'junk')), 'LOBBY_NOT_FOUND', 'junk id');
    expect(await auditFor(f.B)).toHaveLength(0);
  });

  it('B3 a store-B cashier and a floor role cannot open store A\'s claim (AuthorizationError at the claim\'s own store); no audit, nothing returned [kills: open without authorize]', async () => {
    const f = await fx('b3');
    const c = await claim(f, f.A);
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => openClaim(tx, f.cashierB, c.id)), 'store-B cashier');
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => openClaim(tx, f.floorA, c.id)), 'floor role');
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('B4 AFTER A DECISION THE FULL ID IS GONE: opening an approved, rejected or expired claim is LOBBY_CLAIM_CLOSED, returns nothing, writes no audit row [kills: showing a decided claim, full ID kept after the decision]', async () => {
    const f = await fx('b4');
    for (const state of ['approved', 'rejected', 'expired']) {
      const c = await claim(f, f.A, { status: 'seated' });
      if (state === 'approved') await sql`update lobby_discount_claims set status = 'approved', holder_name = null, id_number = null, session_ref = ${SESSION}, statutory_diner_ref = 'SD-9', acted_by_person_id = ${f.cashierA.personId}, card_seen_at = now(), decided_at = now() where id = ${c.id}`;
      if (state === 'rejected') await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, reject_reason = 'No card', acted_by_person_id = ${f.cashierA.personId}, decided_at = now() where id = ${c.id}`;
      if (state === 'expired') await sql`update lobby_discount_claims set status = 'expired', holder_name = null, id_number = null, decided_at = now() where id = ${c.id}`;
      expectRefusal(await refusedIn(f.orgId, (tx) => openClaim(tx, f.cashierA, c.id)), 'LOBBY_CLAIM_CLOSED', `open ${state}`);
    }
    expect(await auditFor(f.A)).toHaveLength(0);
  });
});

// ================================================================================================ C. approve
describe('C. approve: seated, this store\'s session, card seen, pending', () => {
  it('C1 APPROVE stores status, session, statutory ref, who acted, card_seen_at and decided_at; name and ID become NULL, last4 stays; one lobby.claim_approve audit row without name or ID; the entry is untouched [kills: nulling missing, refs or actor dropped, no audit, name in audit]', async () => {
    const f = await fx('c1');
    const c = await claim(f, f.A, { status: 'seated' });
    const out = await asOrg(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(c.id)));
    expect(out).toEqual({ claimId: c.id, status: 'approved' });
    const row = await rowOf(c.id);
    expect(row).toMatchObject({ status: 'approved', holder_name: null, id_number: null, id_last4: '1187', session_ref: SESSION, statutory_diner_ref: SD_REF, acted_by_person_id: f.cashierA.personId });
    expect(row.card_seen_at).not.toBeNull();
    expect(row.decided_at).not.toBeNull();
    const e = (await sql<Record<string, any>[]>`select status, session_ref from lobby_entries where id = ${c.entryId}`)[0]!;
    expect(e).toMatchObject({ status: 'seated', session_ref: SESSION });
    const audit = await auditFor(f.A);
    expect(audit.map((a) => a.action)).toEqual(['lobby.claim_approve']);
    expect(audit[0]).toMatchObject({ actor_person_id: f.cashierA.personId, entity_id: c.id, source: 'pos' });
    noPii(audit, 'approve audit');
  });

  it('C2 APPROVE UNSEATED REFUSED: a waiting or called entry -> LOBBY_CLAIM_NEEDS_SEAT, the claim stays pending with its name, nothing audited [kills: approving before the party sits (4.5), DB shape CHECK as the only guard]', async () => {
    const f = await fx('c2');
    for (const status of ['waiting', 'called']) {
      const c = await claim(f, f.A, { status });
      expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(c.id))), 'LOBBY_CLAIM_NEEDS_SEAT', `approve on ${status}`);
      expect(await rowOf(c.id)).toMatchObject({ status: 'pending', holder_name: HOLDER, id_number: ID_NO, session_ref: null });
    }
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('C3 APPROVE WITHOUT cardSeen REFUSED: false, missing, "true", 1 and null are all LOBBY_CLAIM_NEEDS_CARD; the claim stays pending; nothing audited [kills: cardSeen optional, truthy check instead of === true]', async () => {
    const f = await fx('c3');
    const c = await claim(f, f.A, { status: 'seated' });
    for (const v of [false, undefined, 'true', 1, null] as unknown[]) {
      const input = approveInput(c.id, { cardSeen: v });
      if (v === undefined) delete (input as Partial<typeof input>).cardSeen;
      expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, input)), 'LOBBY_CLAIM_NEEDS_CARD', `cardSeen ${JSON.stringify(v)}`);
    }
    expect(await rowOf(c.id)).toMatchObject({ status: 'pending', card_seen_at: null, holder_name: HOLDER });
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('C4 THE WRONG SESSION: a sessionRef that is not the entry\'s own (another table, another store\'s session, blank) is LOBBY_CLAIM_NEEDS_SEAT; a blank or 81-char statutoryDinerRef is LOBBY_BAD_INPUT; the claim stays pending [kills: any session accepted (4.5: another store\'s session), ref unchecked]', async () => {
    const f = await fx('c4');
    const c = await claim(f, f.A, { status: 'seated' });
    for (const s of ['SESS-OTHER-TABLE', '', '   ']) expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(c.id, { sessionRef: s }))), 'LOBBY_CLAIM_NEEDS_SEAT', `session ${JSON.stringify(s)}`);
    for (const r of ['', '  ', 'r'.repeat(81), 5]) expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(c.id, { statutoryDinerRef: r }))), 'LOBBY_BAD_INPUT', `ref ${JSON.stringify(r)}`);
    expect(await rowOf(c.id)).toMatchObject({ status: 'pending', session_ref: null, statutory_diner_ref: null });
  });

  it('C5 A RETRIED APPROVE IS REFUSED, NOT REPEATED: the second approve (same input) is LOBBY_CLAIM_CLOSED, the row and its audit are unchanged (one approve row); an approve of a rejected or expired claim is LOBBY_CLAIM_CLOSED too [kills: approving twice, approving a decided claim, a second audit row]', async () => {
    const f = await fx('c5');
    const c = await claim(f, f.A, { status: 'seated' });
    await asOrg(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(c.id)));
    const before = await rowOf(c.id);
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(c.id))), 'LOBBY_CLAIM_CLOSED', 'second approve');
    expect(await rowOf(c.id)).toEqual(before);
    expect(await auditFor(f.A, 'lobby.claim_approve')).toHaveLength(1);
    const rej = await claim(f, f.A, { status: 'seated' });
    await asOrg(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: rej.id, reason: 'No card' }));
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(rej.id))), 'LOBBY_CLAIM_CLOSED', 'approve after reject');
  });

  it('C6 two simultaneous approves of one claim: exactly one wins, the other is LOBBY_CLAIM_CLOSED, one audit row [kills: no row lock on the claim]', async () => {
    const f = await fx('c6');
    const c = await claim(f, f.A, { status: 'seated' });
    const attempt = () =>
      asOrg(f.orgId, async (tx) => {
        try {
          await approveClaim(tx, f.cashierA, approveInput(c.id));
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, err };
        }
      });
    const [x, y] = await Promise.all([attempt(), attempt()]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    const lost = [x, y].filter((r): r is { ok: false; err: unknown } => !r.ok);
    expect(lost).toHaveLength(1);
    expectRefusal(lost[0]!.err, 'LOBBY_CLAIM_CLOSED', 'race loser');
    expect(await auditFor(f.A, 'lobby.claim_approve')).toHaveLength(1);
  });

  it('C7 OTHER STORE: a store-B cashier and a floor role cannot approve store A\'s claim (AuthorizationError at the claim\'s own store, denial recorded); a ghost id is LOBBY_NOT_FOUND; the claim is untouched [kills: authorize at the caller\'s store, role check missing]', async () => {
    const f = await fx('c7');
    const c = await claim(f, f.A, { status: 'seated' });
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierB, approveInput(c.id))), 'store-B cashier');
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.floorA, approveInput(c.id))), 'floor role');
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput('00000000-0000-4000-8000-000000000000'))), 'LOBBY_NOT_FOUND', 'ghost');
    expect((await denials(f, f.cashierB)).some((d) => d.after?.capability === 'record_sale')).toBe(true);
    expect(await rowOf(c.id)).toMatchObject({ status: 'pending', holder_name: HOLDER });
    expect(await auditFor(f.A)).toHaveLength(0);
  });

  it('C8 THE TABLET DOOR approves with no role and no scope (the terminal person is not authorize()d): same writes, audit by the terminal person with after.cashier; another store\'s claim answers like a ghost id and stays pending [kills: terminal calling authorize(), another store\'s claim approved, cashier missing]', async () => {
    const f = await fx('c8');
    const c = await claim(f, f.A, { status: 'seated' });
    const foreign = await claim(f, f.B, { status: 'seated' });
    const out = await asOrg(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(c.id)));
    expect(out).toEqual({ claimId: c.id, status: 'approved' });
    expect(await rowOf(c.id)).toMatchObject({ status: 'approved', acted_by_person_id: f.terminal.personId, holder_name: null, id_number: null });
    const audit = await auditFor(f.A, 'lobby.claim_approve');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor_person_id).toBe(f.terminal.personId);
    expect((audit[0]!.after as { cashier?: string }).cashier).toBe(CASHIER);
    noPii(audit, 'tablet approve audit');
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(foreign.id))), 'LOBBY_NOT_FOUND', 'other store\'s claim');
    expect((await rowOf(foreign.id)).status).toBe('pending');
    // the tablet checks the same state rules as the cashier door
    const waiting = await claim(f, f.A);
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(waiting.id))), 'LOBBY_CLAIM_NEEDS_SEAT', 'tablet unseated');
    const noCard = await claim(f, f.A, { status: 'seated' });
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(noCard.id, { cardSeen: false }))), 'LOBBY_CLAIM_NEEDS_CARD', 'tablet no card');
  });
});

// ================================================================================================ D. reject
describe('D. reject: a reason, any pending claim, name and ID gone', () => {
  it('D1 REJECT stores the trimmed reason, who acted, decided_at; name and ID NULL; no card_seen_at; works on a waiting AND a seated entry; one lobby.claim_reject audit row without name/ID; the slot is free again [kills: reason dropped/untrimmed, name kept (4.7), slot not freed, no audit]', async () => {
    const f = await fx('d1');
    const e = await entry(f.A, { party: 1 });
    const c = await claim(f, f.A, { entryId: e });
    const out = await asOrg(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: c.id, reason: '  Card is expired  ' }));
    expect(out).toEqual({ claimId: c.id, status: 'rejected' });
    expect(await rowOf(c.id)).toMatchObject({ status: 'rejected', reject_reason: 'Card is expired', holder_name: null, id_number: null, id_last4: '1187', acted_by_person_id: f.cashierA.personId, card_seen_at: null, session_ref: null });
    const audit = await auditFor(f.A);
    expect(audit.map((a) => a.action)).toEqual(['lobby.claim_reject']);
    expect(audit[0]).toMatchObject({ actor_person_id: f.cashierA.personId, entity_id: c.id, source: 'pos' });
    noPii(audit, 'reject audit');
    await claim(f, f.A, { entryId: e }); // the freed slot of a party of 1 accepts another claim row
    const seated = await claim(f, f.A, { status: 'seated' });
    await asOrg(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: seated.id, reason: 'Wrong person' }));
    expect((await rowOf(seated.id)).status).toBe('rejected');
  });

  it('D2 REJECT NEEDS A REASON: missing, blank, 81 chars, a number -> LOBBY_BAD_INPUT, claim stays pending; 80 chars kept [kills: reason optional, no limit, off by one, DB CHECK as the only guard]', async () => {
    const f = await fx('d2');
    const c = await claim(f, f.A);
    for (const r of [undefined, '', '   ', 'r'.repeat(81), 12] as unknown[]) {
      expectRefusal(await refusedIn(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: c.id, reason: r as string })), 'LOBBY_BAD_INPUT', `reason ${JSON.stringify(r)}`);
    }
    expect((await rowOf(c.id)).status).toBe('pending');
    await asOrg(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: c.id, reason: 'r'.repeat(80) }));
    expect((await rowOf(c.id)).reject_reason).toBe('r'.repeat(80));
  });

  it('D3 a decided claim cannot be rejected (LOBBY_CLAIM_CLOSED, unchanged, not audited); other store and role without record_sale are AuthorizationError; the tablet rejects with its person and another store\'s claim is LOBBY_NOT_FOUND [kills: reject after decision, authorize missing, terminal door missing]', async () => {
    const f = await fx('d3');
    const done = await claim(f, f.A, { status: 'seated' });
    await asOrg(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(done.id)));
    const before = await rowOf(done.id);
    expectRefusal(await refusedIn(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: done.id, reason: 'Changed mind' })), 'LOBBY_CLAIM_CLOSED', 'reject approved');
    expect(await rowOf(done.id)).toEqual(before);
    const c = await claim(f, f.A);
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => rejectClaim(tx, f.cashierB, { claimId: c.id, reason: 'Nope' })), 'store-B cashier');
    expectAuthRefusal(await refusedIn(f.orgId, (tx) => rejectClaim(tx, f.floorA, { claimId: c.id, reason: 'Nope' })), 'floor role');
    expect((await rowOf(c.id)).status).toBe('pending');
    const foreign = await claim(f, f.B);
    expectRefusal(await refusedIn(f.orgId, (tx) => rejectClaimForTerminal(tx, f.tabletFor(f.A), { claimId: foreign.id, reason: 'Nope' })), 'LOBBY_NOT_FOUND', 'other store');
    await asOrg(f.orgId, (tx) => rejectClaimForTerminal(tx, f.tabletFor(f.A), { claimId: c.id, reason: 'Not the cardholder' }));
    expect(await rowOf(c.id)).toMatchObject({ status: 'rejected', acted_by_person_id: f.terminal.personId });
    const rej = (await auditFor(f.A, 'lobby.claim_reject')).find((a) => a.entity_id === c.id)!;
    expect((rej.after as { cashier?: string }).cashier).toBe(CASHIER);
    noPii(await auditFor(f.A), 'all audit');
  });

  it('D4 A REFUSED MOVE IS NEVER AUDITED and the diner/PII fields never reach any audit row: after every refusal above plus a real submit through the diner door, the org\'s audit log has no name or ID number [kills: refused move audited, PII in the log]', async () => {
    const f = await fx('d4');
    const e = await entry(f.A, { party: 2 });
    const key = { orgId: f.orgId, storeId: f.A.storeId, deviceHash: (await sql<{ device_hash: string }[]>`select device_hash from lobby_entries where id = ${e}`)[0]!.device_hash };
    const made = await asOrg(f.orgId, (tx) => submitClaim(tx, key, { kind: 'senior', holderName: HOLDER, idNumber: ID_NO }));
    expectRefusal(await refusedIn(f.orgId, (tx) => approveClaim(tx, f.cashierA, approveInput(made.claimId))), 'LOBBY_CLAIM_NEEDS_SEAT', 'unseated');
    expectRefusal(await refusedIn(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: made.claimId, reason: '' })), 'LOBBY_BAD_INPUT', 'blank reason');
    await asOrg(f.orgId, (tx) => openClaim(tx, f.cashierA, made.claimId));
    await asOrg(f.orgId, (tx) => rejectClaim(tx, f.cashierA, { claimId: made.claimId, reason: 'No card' }));
    const all = await sql`select action, actor_person_id, entity_id, before, after from audit_log where org_id = ${f.orgId} and action like 'lobby.%'`;
    noPii(all, 'audit log');
    expect((await auditFor(f.A)).map((a) => a.action)).toEqual(['lobby.claim_open', 'lobby.claim_reject']);
  });
});
