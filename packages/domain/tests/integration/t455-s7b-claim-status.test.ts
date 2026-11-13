import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S7b (BUILDER, BOSS ruling 2 Nov): claimStatusForTerminal returns { status } only; another store's claim answers like a ghost id; no audit row.
 * Fixtures copied from t455-s7a-claims-staff.test.ts. Original header follows.
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
import { approveClaimForTerminal, claimStatusForTerminal } from '../../src/lobby/claims';
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
  expect(t, `${what}: full ID number`).not.toMatch(/0042|5566|00425566/);
};

describe('claimStatusForTerminal: the exact status of one claim, nothing else', () => {
  it('pending, approved and rejected claims each answer { status } with no other key; no audit row; no name or ID', async () => {
    const f = await fx('s7b-status');
    const a = await claim(f, f.A, { status: 'seated' });
    const r = await claim(f, f.A);
    const before = (await auditFor(f.A)).length;
    const pending = await asOrg(f.orgId, (tx) => claimStatusForTerminal(tx, f.tabletFor(f.A), a.id));
    expect(pending).toEqual({ status: 'pending' });
    await asOrg(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(a.id)));
    const approved = await asOrg(f.orgId, (tx) => claimStatusForTerminal(tx, f.tabletFor(f.A), a.id));
    expect(approved).toEqual({ status: 'approved' });
    await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, decided_at = now(), reject_reason = 'x' where id = ${r.id}`;
    expect(await asOrg(f.orgId, (tx) => claimStatusForTerminal(tx, f.tabletFor(f.A), r.id))).toEqual({ status: 'rejected' });
    noPii([pending, approved], 'status answers');
    expect(await auditFor(f.A), 'the status read writes no audit row (only the approve did)').toHaveLength(before + 1);
  });

  it("another store's claim, a ghost id and junk all answer LOBBY_NOT_FOUND and write nothing", async () => {
    const f = await fx('s7b-status-x');
    const foreign = await claim(f, f.B);
    expectRefusal(await refusedIn(f.orgId, (tx) => claimStatusForTerminal(tx, f.tabletFor(f.A), foreign.id)), 'LOBBY_NOT_FOUND', "other store's claim");
    expectRefusal(await refusedIn(f.orgId, (tx) => claimStatusForTerminal(tx, f.tabletFor(f.A), '00000000-0000-4000-8000-000000000000')), 'LOBBY_NOT_FOUND', 'ghost id');
    expectRefusal(await refusedIn(f.orgId, (tx) => claimStatusForTerminal(tx, f.tabletFor(f.A), 'junk')), 'LOBBY_NOT_FOUND', 'junk id');
    expect(await auditFor(f.B)).toHaveLength(0);
  });
});

describe('approve: one statutory diner is linked to one approved claim per entry (auditor ruling 1)', () => {
  it('claim B on the same entry cannot reuse the diner of claim A: LOBBY_CLAIM_DINER_TAKEN, B stays pending; another ref, or the same ref on another entry, is fine', async () => {
    const f = await fx('s7b-taken');
    const entryId = await entry(f.A, { status: 'seated', party: 4 });
    const a = await claim(f, f.A, { entryId });
    const b = await claim(f, f.A, { entryId, last4: '2200' });
    await asOrg(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(a.id, { statutoryDinerRef: 'SD-A' })));
    const e = expectRefusal(await refusedIn(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(b.id, { statutoryDinerRef: 'SD-A' }))), 'LOBBY_CLAIM_DINER_TAKEN', 'reused diner');
    expect(e.userMessage).toBe('This senior / PWD diner is already linked to another claim on this table.');
    expect(await rowOf(b.id)).toMatchObject({ status: 'pending', statutory_diner_ref: null });
    expect(await asOrg(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(b.id, { statutoryDinerRef: 'SD-B' })))).toMatchObject({ status: 'approved' });
    const other = await claim(f, f.A, { status: 'seated' });
    expect(await asOrg(f.orgId, (tx) => approveClaimForTerminal(tx, f.tabletFor(f.A), approveInput(other.id, { statutoryDinerRef: 'SD-A' })))).toMatchObject({ status: 'approved' });
  });
});
