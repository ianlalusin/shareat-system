import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-455 S7a (TESTER) - the senior/PWD discount claim, DOMAIN, diner side + expiry + purge: docs/tasks/455-customer-lobby.md sections 2.2 (lobby_discount_claims),
 * 3.1 (/lobby/discount), 4.1 (<= party_size claims), 4.4 (no field over 40 chars), 4.5, 4.7 (retention), and the S7a row of section 5.
 * Real Postgres via TEST_DATABASE_URL. THIS SLICE HANDLES PERSONAL DATA: every claim holder name and ID number below is a SYNTHETIC test value.
 *
 * RED TODAY, for one reason: packages/domain/src/lobby/claims.ts does not exist (the import below fails to resolve). Case D4 also names a second,
 * independent reason (the existing nightly sweep kills claims on seated entries).
 *
 * CONTRACT ASSUMED (the orchestrator rules on every ASSUMED line in the hand-back):
 *   submitClaim(tx, key: MyEntryKey, { kind: 'senior'|'pwd', holderName: string, idNumber: string, ocrAssisted?: boolean }): Promise<{ claimId: string; status: 'pending'; idMasked: string }>
 *   listMyClaims(tx, key): Promise<MyClaimView[]>   MyClaimView = { claimId, kind, status, idMasked ('****1187'), rejectReason: string | null, ocrAssisted: boolean }
 *       a key that owns no entry -> LOBBY_NOT_FOUND; an owner who never claimed -> []. NEVER holderName, idNumber, entryId, hashes (data minimisation, ASSUMED).
 *   cancelMyClaim(tx, key, claimId): Promise<{ claimId: string; status: 'expired' }>   (the table has no 'cancelled' status: ASSUMED a withdrawn claim = expired,
 *       name/ID nulled by the DB CHECK, slot freed; only own PENDING claims; a decided one -> LOBBY_CLAIM_CLOSED; a stranger's / ghost id -> LOBBY_NOT_FOUND)
 *   New LobbyRefusal codes, each ONE plain sentence, none naming a limit: LOBBY_CLAIM_FULL (already party_size live claims), LOBBY_CLAIM_OFF (lobby_stores.claims_enabled false),
 *       LOBBY_CLAIM_CLOSED (a move the claim's state does not allow), LOBBY_CLAIM_NEEDS_SEAT, LOBBY_CLAIM_NEEDS_CARD (staff side, other file).
 *   A claim may be made only on a LIVE entry (waiting|called) - ASSUMED: once seated the phone hands off to Customer v1; seated/closed -> LOBBY_ENTRY_CLOSED.
 *   FIELDS: kind senior|pwd (else LOBBY_BAD_INPUT); holderName trimmed 1..40; idNumber trimmed 4..40 (ASSUMED: at least 4 characters so a last-4 exists);
 *       all strings (a number/object -> LOBBY_BAD_INPUT); nothing is written on a refusal. id_last4 = the last 4 characters of the ID after removing spaces and hyphens.
 *   Slots: pending + approved claims <= party_size (rejected and expired free their slot). Refused in the DOMAIN as LOBBY_CLAIM_FULL (not a raw check_violation).
 *   CLOSE: closing an entry UNSEATED (diner cancel, staff remove, 3 h expiry) expires its PENDING claims (name/ID NULL). SEATING leaves them pending (approval needs a seated entry).
 *   NIGHTLY (ASSUMED ruling needed): a pending claim of a SEATED entry is NOT swept until the entry has been closed 3 h (as S6a ruling 13 does for birthday requests) or
 *       the claim is 24 h old. TODAY sweepStalePendingClaims sweeps any claim whose entry is seated - that would kill every claim the moment the party sits.
 *
 * MUTANT INDEX: claim > party size allowed / cap only by DB / race leaks 23514; rejected or expired not freeing the slot; approved not counting; kind other than senior/pwd;
 * name 41+ or ID 41+ or ID < 4 or non-string accepted; blank name kept; id_last4 wrong (first 4, unstripped separators); full ID/name returned in a view; another device/store reading or
 * cancelling my claims; cancel of a decided claim; claims_enabled ignored; claim on closed/seated entry; close leaving a pending claim with a name; seat expiring the claim; nightly missing the
 * 24 h sweep; nightly sweeping a fresh seated claim; purge damaging an approved claim's record; refusal with database wording.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { cancelMyClaim, listMyClaims, submitClaim } from '../../src/lobby/claims';
import { cancelMyEntry } from '../../src/lobby/checkin';
import { expireStaleLobbyEntries, runLobbyNightly } from '../../src/lobby/purge';
import { LobbyRefusal } from '../../src/lobby/refusal';
import { removeEntry, seatEntry } from '../../src/lobby/staff';

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
  expect(`${e.message} ${e.userMessage}`, `${what}: PII in the refusal`).not.toMatch(/Quillfeather|Tuckerman|1187/);
  return e;
}

type S = { orgId: string; storeId: string };
type Raw = Record<string, string | number | boolean | null>;
const HOLDER = 'Zanzibar Quillfeather';
const ID_NO = '0042-5566-1187'; // synthetic
const DINER = 'Ana Tuckerman';

async function fx(hint: string) {
  const code = uid(`t455s7a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const store = async (o: { claims?: boolean } = {}): Promise<S> => {
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
    await sql`insert into lobby_stores (org_id, store_id, enabled, paused, max_live_entries, claims_enabled, pos_seen_at)
              values (${orgId}, ${st!.id}, true, false, 60, ${o.claims ?? true}, now())`;
    return { orgId, storeId: st!.id };
  };
  const A = await store();
  const B = await store();
  const person = async (name: string, role: string | null, scope: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of scope) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId };
  };
  const cashierA = await person('Cashier A', 'manager', [A.storeId]);
  return { orgId, A, B, store, cashierA };
}
type Fx = Awaited<ReturnType<typeof fx>>;

let codeN = Math.floor(Math.random() * 3000);
async function entry(s: S, o: { status?: string; party?: number; ageMin?: number; closedMinAgo?: number; extra?: Raw } = {}) {
  const deviceHash = uid('dev');
  const status = o.status ?? 'waiting';
  const row: Raw = {
    org_id: s.orgId, store_id: s.storeId, source: 'lobby', code: String(1000 + (++codeN % 9000)), display_name: DINER, party_size: o.party ?? 3,
    status, device_hash: deviceHash, ip_hash: uid('ip'), client_request_id: uid('req'), created_at: ago(o.ageMin ?? 5),
    ...(status === 'called' ? { called_at: ago(1) } : {}),
    ...(status === 'seated' ? { session_ref: 'S-1', stand_label: '7', closed_at: ago(o.closedMinAgo ?? 1), seated_at: ago(o.closedMinAgo ?? 1) } : {}),
    ...(['cancelled', 'removed', 'expired'].includes(status) ? { closed_at: ago(o.closedMinAgo ?? 1) } : {}),
    ...(o.extra ?? {}),
  };
  const [r] = await sql<{ id: string }[]>`insert into lobby_entries ${sql(row)} returning id`;
  return { id: r!.id, key: { orgId: s.orgId, storeId: s.storeId, deviceHash } };
}
const claimRows = async (entryId: string) => await sql<Record<string, any>[]>`select * from lobby_discount_claims where entry_id = ${entryId} order by created_at, id`;
const claimOf = async (id: string) => (await sql<Record<string, any>[]>`select * from lobby_discount_claims where id = ${id}`)[0]!;
type State = 'pending' | 'approved' | 'rejected' | 'expired';
/** A raw claim row in any state; pending carries name + ID, the rest do not (the DB CHECK). */
async function rawClaim(f: Fx, entryId: string, state: State = 'pending', o: { createdMinAgo?: number; last4?: string } = {}): Promise<string> {
  const last4 = o.last4 ?? '1187';
  const created = ago(o.createdMinAgo ?? 1);
  const [c] = await sql<{ id: string }[]>`insert into lobby_discount_claims (org_id, entry_id, kind, holder_name, id_number, id_last4, created_at) values (${f.orgId}, ${entryId}, 'senior', ${HOLDER}, ${ID_NO}, ${last4}, ${created}) returning id`;
  const id = c!.id;
  if (state === 'approved')
    await sql`update lobby_discount_claims set status = 'approved', holder_name = null, id_number = null, session_ref = 'S-1', statutory_diner_ref = 'SD-1', acted_by_person_id = ${f.cashierA.personId}, card_seen_at = now(), decided_at = now() where id = ${id}`;
  if (state === 'rejected')
    await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, reject_reason = 'Card expired', acted_by_person_id = ${f.cashierA.personId}, decided_at = now() where id = ${id}`;
  if (state === 'expired') await sql`update lobby_discount_claims set status = 'expired', holder_name = null, id_number = null, decided_at = now() where id = ${id}`;
  return id;
}
const noPii = (o: unknown, what: string) => {
  const t = JSON.stringify(o);
  expect(t, `${what}: holder name`).not.toContain('Quillfeather');
  expect(t, `${what}: full ID number`).not.toMatch(/0042|5566|00425566/);
};

// ================================================================================================ A. submitting
describe('A. submitClaim: fields, kinds, id_last4', () => {
  it('A1 a diner on a waiting entry claims: one pending row for THAT entry, name trimmed, ID trimmed, last4 derived, ocr_assisted false, nobody acted; the reply carries the masked ID only [kills: wrong entry, not trimmed, status other than pending, full ID in the reply]', async () => {
    const f = await fx('a1');
    const e = await entry(f.A);
    const r = await asOrg(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: `  ${HOLDER}  `, idNumber: ` ${ID_NO} ` }));
    expect(r).toMatchObject({ status: 'pending', idMasked: '****1187' });
    noPii(r, 'submit reply');
    const rows = await claimRows(e.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: r.claimId, org_id: f.orgId, entry_id: e.id, kind: 'senior', holder_name: HOLDER, id_number: ID_NO, id_last4: '1187', ocr_assisted: false, status: 'pending', acted_by_person_id: null, card_seen_at: null });
  });

  it('A2 kind pwd works, a called entry may claim, ocrAssisted true is stored; any other kind (or none, or a number) is LOBBY_BAD_INPUT and writes nothing [kills: kind not validated (DB CHECK only), ocr flag dropped]', async () => {
    const f = await fx('a2');
    const called = await entry(f.A, { status: 'called' });
    await asOrg(f.orgId, (tx) => submitClaim(tx, called.key, { kind: 'pwd', holderName: HOLDER, idNumber: ID_NO, ocrAssisted: true }));
    expect(await claimRows(called.id)).toMatchObject([{ kind: 'pwd', ocr_assisted: true }]);
    for (const kind of ['child', 'SENIOR', '', undefined, 3] as unknown[]) {
      const e = await entry(f.A);
      const err = await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: kind as 'senior', holderName: HOLDER, idNumber: ID_NO }));
      expectRefusal(err, 'LOBBY_BAD_INPUT', `kind ${JSON.stringify(kind)}`);
      expect(await claimRows(e.id)).toHaveLength(0);
    }
  });

  it('A3 holder name 1..40 after trimming: 40 kept, 41 / blank / number / object refused LOBBY_BAD_INPUT, nothing written (4.4: an image cannot ride in a text field) [kills: no limit, off by one, blank accepted, non-string accepted]', async () => {
    const f = await fx('a3');
    const ok = await entry(f.A);
    await asOrg(f.orgId, (tx) => submitClaim(tx, ok.key, { kind: 'senior', holderName: ` ${'x'.repeat(40)} `, idNumber: ID_NO }));
    expect((await claimRows(ok.id))[0]!.holder_name).toBe('x'.repeat(40));
    for (const bad of ['y'.repeat(41), '', '   ', 7, { a: 1 }] as unknown[]) {
      const e = await entry(f.A);
      const err = await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: bad as string, idNumber: ID_NO }));
      expectRefusal(err, 'LOBBY_BAD_INPUT', `name ${JSON.stringify(bad)}`);
      expect(await claimRows(e.id)).toHaveLength(0);
    }
  });

  it('A4 ID number 4..40 after trimming: 40 kept, 3 / 41 / blank / number refused LOBBY_BAD_INPUT, nothing written [kills: no limit, no minimum (a last4 of fewer than 4), non-string accepted]', async () => {
    const f = await fx('a4');
    const ok = await entry(f.A);
    await asOrg(f.orgId, (tx) => submitClaim(tx, ok.key, { kind: 'senior', holderName: HOLDER, idNumber: ` ${'7'.repeat(40)} ` }));
    expect((await claimRows(ok.id))[0]).toMatchObject({ id_number: '7'.repeat(40), id_last4: '7777' });
    for (const bad of ['123', '9'.repeat(41), '', '   ', 1234, ['1187']] as unknown[]) {
      const e = await entry(f.A);
      const err = await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: bad as string }));
      expectRefusal(err, 'LOBBY_BAD_INPUT', `id ${JSON.stringify(bad)}`);
      expect(await claimRows(e.id)).toHaveLength(0);
    }
  });

  it('A5 ID_LAST4 DERIVATION: the last four characters after removing spaces and hyphens - "0042-5566-1187" and "00425566 1187" -> 1187; "12-34" -> 1234; "9 9 9 9 5-6" -> 9956; never the FIRST four and never a separator [kills: first 4, last 4 of the raw string, separators kept]', async () => {
    const f = await fx('a5');
    const cases: Array<[string, string]> = [['0042-5566-1187', '1187'], ['00425566 1187', '1187'], ['12-34', '1234'], ['9 9 9 9 5-6', '9956']];
    for (const [id, last4] of cases) {
      const e = await entry(f.A);
      const r = await asOrg(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: id }));
      expect((await claimRows(e.id))[0]!.id_last4, id).toBe(last4);
      expect(r.idMasked, id).toBe(`****${last4}`);
    }
  });

  it('A6 a closed entry (cancelled, removed, expired) and a SEATED one cannot claim: LOBBY_ENTRY_CLOSED, nothing written; a key that owns no entry, and my device at ANOTHER store, is LOBBY_NOT_FOUND [kills: claim on a dead entry, ownership/store not part of the key]', async () => {
    const f = await fx('a6');
    for (const status of ['cancelled', 'removed', 'expired', 'seated']) {
      const e = await entry(f.A, { status });
      expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: ID_NO })), 'LOBBY_ENTRY_CLOSED', `claim on ${status}`);
      expect(await claimRows(e.id)).toHaveLength(0);
    }
    const mine = await entry(f.A);
    const stranger = { orgId: f.orgId, storeId: f.A.storeId, deviceHash: uid('nobody') };
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, stranger, { kind: 'senior', holderName: HOLDER, idNumber: ID_NO })), 'LOBBY_NOT_FOUND', 'stranger');
    const other = { ...mine.key, storeId: f.B.storeId };
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, other, { kind: 'senior', holderName: HOLDER, idNumber: ID_NO })), 'LOBBY_NOT_FOUND', 'other store');
    expect(await claimRows(mine.id)).toHaveLength(0);
  });

  it('A7 a store with claims_enabled = false refuses with LOBBY_CLAIM_OFF and a plain sentence, nothing written [kills: the switch ignored]', async () => {
    const f = await fx('a7');
    const off = await f.store({ claims: false });
    const e = await entry(off);
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: ID_NO })), 'LOBBY_CLAIM_OFF', 'claims off');
    expect(await claimRows(e.id)).toHaveLength(0);
  });
});

// ================================================================================================ B. slots = party size
describe('B. claims are limited to the party size, in the domain', () => {
  const claim = (f: Fx, key: any, id = ID_NO) => asOrg(f.orgId, (tx) => submitClaim(tx, key, { kind: 'senior', holderName: HOLDER, idNumber: id }));

  it('B1 CLAIM > PARTY SIZE REFUSED: a party of 2 takes 2 claims, the 3rd is LOBBY_CLAIM_FULL (plain sentence, no limit named), still 2 rows; a party of 1 takes exactly 1 [kills: no cap, cap by DB only (raw check_violation), off by one]', async () => {
    const f = await fx('b1');
    const e = await entry(f.A, { party: 2 });
    await claim(f, e.key, '1111-2222');
    await claim(f, e.key, '3333-4444');
    const err = await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'pwd', holderName: HOLDER, idNumber: '5555-6666' }));
    const r = expectRefusal(err, 'LOBBY_CLAIM_FULL', 'third claim');
    expect(r.userMessage).not.toMatch(/party|\b2\b|two|limit/i);
    expect(await claimRows(e.id)).toHaveLength(2);
    const one = await entry(f.A, { party: 1 });
    await claim(f, one.key);
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, one.key, { kind: 'senior', holderName: HOLDER, idNumber: '7777-8888' })), 'LOBBY_CLAIM_FULL', 'second claim of a party of 1');
  });

  it('B2 rejected and expired claims free their slot; approved and pending ones keep it [kills: counting every status, not counting approved]', async () => {
    const f = await fx('b2');
    const e = await entry(f.A, { party: 3 });
    await rawClaim(f, e.id, 'approved');
    await rawClaim(f, e.id, 'rejected');
    await rawClaim(f, e.id, 'expired');
    await claim(f, e.key, '1111-2222');
    await claim(f, e.key, '3333-4444');
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: '5555-6666' })), 'LOBBY_CLAIM_FULL', 'approved + 2 pending fills a party of 3');
  });

  it('B3 cancelling my own pending claim frees the slot and nulls name and ID; the row is kept as expired [kills: cancel deleting the row, name kept, slot not freed]', async () => {
    const f = await fx('b3');
    const e = await entry(f.A, { party: 1 });
    const c = await claim(f, e.key);
    const out = await asOrg(f.orgId, (tx) => cancelMyClaim(tx, e.key, c.claimId));
    expect(out).toEqual({ claimId: c.claimId, status: 'expired' });
    expect(await claimOf(c.claimId)).toMatchObject({ status: 'expired', holder_name: null, id_number: null, id_last4: '1187' });
    await claim(f, e.key, '9999-0000');
    expect(await claimRows(e.id)).toHaveLength(2);
  });

  it('B4 two simultaneous claims for the last slot: exactly one wins, the other gets LOBBY_CLAIM_FULL (not a raw check violation) [kills: check-then-insert without the entry lock]', async () => {
    const f = await fx('b4');
    const e = await entry(f.A, { party: 1 });
    const attempt = (id: string) =>
      asOrg(f.orgId, async (tx) => {
        try {
          await submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: id });
          return { ok: true as const };
        } catch (err) {
          return { ok: false as const, err };
        }
      });
    const [x, y] = await Promise.all([attempt('1111-2222'), attempt('3333-4444')]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    const lost = [x, y].filter((r): r is { ok: false; err: unknown } => !r.ok);
    expect(lost).toHaveLength(1);
    expectRefusal(lost[0]!.err, 'LOBBY_CLAIM_FULL', 'the race loser');
    expect(await claimRows(e.id)).toHaveLength(1);
  });
});

// ================================================================================================ C. reading and cancelling my own
describe('C. listMyClaims / cancelMyClaim: only the owner, only masked', () => {
  it('C1 the owner sees her claims with exactly the six view keys, ID as ****1187; no name, no full ID, no entry id, no hashes; empty before any claim; a stranger / other store is LOBBY_NOT_FOUND [kills: full ID or name in a view, other keys, any cookie reads any claim, cross-store read]', async () => {
    const f = await fx('c1');
    const a = await entry(f.A);
    const b = await entry(f.A);
    expect(await asOrg(f.orgId, (tx) => listMyClaims(tx, a.key))).toEqual([]);
    const c = await asOrg(f.orgId, (tx) => submitClaim(tx, a.key, { kind: 'pwd', holderName: HOLDER, idNumber: ID_NO }));
    const mine = await asOrg(f.orgId, (tx) => listMyClaims(tx, a.key));
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]!).sort()).toEqual(['claimId', 'idMasked', 'kind', 'ocrAssisted', 'rejectReason', 'status']);
    expect(mine[0]).toEqual({ claimId: c.claimId, kind: 'pwd', status: 'pending', idMasked: '****1187', rejectReason: null, ocrAssisted: false });
    noPii(mine, 'my claims');
    expect(await asOrg(f.orgId, (tx) => listMyClaims(tx, b.key)), 'another diner sees none of mine').toEqual([]);
    const stranger = { orgId: f.orgId, storeId: f.A.storeId, deviceHash: uid('nobody') };
    expectRefusal(await refusedIn(f.orgId, (tx) => listMyClaims(tx, stranger)), 'LOBBY_NOT_FOUND', 'stranger lists');
    expectRefusal(await refusedIn(f.orgId, (tx) => listMyClaims(tx, { ...a.key, storeId: f.B.storeId })), 'LOBBY_NOT_FOUND', 'other store lists');
  });

  it('C2 after the cashier decides, the diner sees the status and (rejected) the reason, still masked; name and ID are gone from the row [kills: reject reason not shown, full ID kept after a decision]', async () => {
    const f = await fx('c2');
    const e = await entry(f.A);
    const rej = await rawClaim(f, e.id, 'rejected');
    const acc = await rawClaim(f, e.id, 'approved', { last4: '4455' });
    const mine = await asOrg(f.orgId, (tx) => listMyClaims(tx, e.key));
    const byId = new Map(mine.map((m) => [m.claimId, m]));
    expect(byId.get(rej)).toMatchObject({ status: 'rejected', rejectReason: 'Card expired', idMasked: '****1187' });
    expect(byId.get(acc)).toMatchObject({ status: 'approved', rejectReason: null, idMasked: '****4455' });
    noPii(mine, 'after decision');
  });

  it('C3 cancel: another diner at the same store, my cookie at another store and a ghost/junk id are LOBBY_NOT_FOUND and my claim stays pending; a decided claim is LOBBY_CLAIM_CLOSED and unchanged [kills: cancelling by guessed id, cancelling a decided claim]', async () => {
    const f = await fx('c3');
    const mine = await entry(f.A);
    const other = await entry(f.A);
    const c = await asOrg(f.orgId, (tx) => submitClaim(tx, mine.key, { kind: 'senior', holderName: HOLDER, idNumber: ID_NO }));
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyClaim(tx, other.key, c.claimId)), 'LOBBY_NOT_FOUND', 'other diner cancels');
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyClaim(tx, { ...mine.key, storeId: f.B.storeId }, c.claimId)), 'LOBBY_NOT_FOUND', 'other store cancels');
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyClaim(tx, mine.key, '00000000-0000-4000-8000-000000000000')), 'LOBBY_NOT_FOUND', 'ghost id');
    expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyClaim(tx, mine.key, 'not-a-uuid')), 'LOBBY_NOT_FOUND', 'junk id');
    expect((await claimOf(c.claimId)).status).toBe('pending');
    for (const state of ['approved', 'rejected', 'expired'] as const) {
      const e = await entry(f.A);
      const id = await rawClaim(f, e.id, state);
      const before = await claimOf(id);
      expectRefusal(await refusedIn(f.orgId, (tx) => cancelMyClaim(tx, e.key, id)), 'LOBBY_CLAIM_CLOSED', `cancel ${state}`);
      expect(await claimOf(id)).toEqual(before);
    }
  });
});

// ================================================================================================ D. expiry and purge
describe('D. a pending claim never outlives its reason: close, nightly, purge', () => {
  it('D1 an entry closed UNSEATED (diner cancel, staff remove, 3 h expiry) expires its pending claims: name and ID NULL, last4 and kind kept, approved ones untouched [kills: close leaving a pending claim holding a name (4.7)]', async () => {
    const f = await fx('d1');
    const viaCancel = await entry(f.A);
    const viaRemove = await entry(f.A);
    const viaExpiry = await entry(f.A, { ageMin: 200 });
    const ids: string[] = [];
    for (const e of [viaCancel, viaRemove, viaExpiry]) ids.push(await rawClaim(f, e.id, 'pending'));
    const approved = await rawClaim(f, viaCancel.id, 'approved');
    const apprBefore = await claimOf(approved);
    await asOrg(f.orgId, (tx) => cancelMyEntry(tx, viaCancel.key));
    await asOrg(f.orgId, (tx) => removeEntry(tx, f.cashierA, viaRemove.id));
    await asOrg(f.orgId, (tx) => expireStaleLobbyEntries(tx, f.orgId));
    for (const id of ids) expect(await claimOf(id), `claim ${id}`).toMatchObject({ status: 'expired', holder_name: null, id_number: null, id_last4: '1187', kind: 'senior' });
    expect(await claimOf(approved)).toEqual(apprBefore);
  });

  it('D2 SEATING leaves a pending claim pending (approval needs the seated entry) [kills: seat expiring the claim]', async () => {
    const f = await fx('d2');
    const e = await entry(f.A);
    const id = await rawClaim(f, e.id, 'pending');
    await asOrg(f.orgId, (tx) => seatEntry(tx, f.cashierA, { entryId: e.id, sessionId: 'SESS-7A', standLabel: '7' }));
    expect(await claimOf(id)).toMatchObject({ status: 'pending', holder_name: HOLDER, id_number: ID_NO });
  });

  it('D3 NIGHTLY SWEEP, 24 h: a pending claim older than 24 h on a LIVE entry is expired with name/ID NULL; a 23 h one is untouched [kills: sweep missing, wrong boundary]', async () => {
    const f = await fx('d3');
    const e = await entry(f.A);
    const old = await rawClaim(f, e.id, 'pending', { createdMinAgo: 25 * 60 });
    const young = await rawClaim(f, e.id, 'pending', { createdMinAgo: 23 * 60 });
    await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    expect(await claimOf(old)).toMatchObject({ status: 'expired', holder_name: null, id_number: null });
    expect(await claimOf(young)).toMatchObject({ status: 'pending', holder_name: HOLDER });
  });

  it('D4 NIGHTLY MUST NOT KILL A FRESH SEATED CLAIM (RED on its own today: sweepStalePendingClaims sweeps every claim whose entry is seated): a pending claim on an entry seated 1 minute ago survives runLobbyNightly; one whose seated entry closed 4 h ago and is 5 h old is swept [kills: the sweep expiring the claim the moment the party sits; seated-and-gone claims living on]', async () => {
    const f = await fx('d4');
    const fresh = await entry(f.A, { status: 'seated', closedMinAgo: 1 });
    const gone = await entry(f.A, { status: 'seated', closedMinAgo: 240 });
    const freshClaim = await rawClaim(f, fresh.id, 'pending', { createdMinAgo: 10 });
    const goneClaim = await rawClaim(f, gone.id, 'pending', { createdMinAgo: 300 });
    await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    expect(await claimOf(freshClaim), 'a claim awaiting approval at a seated table must live').toMatchObject({ status: 'pending', holder_name: HOLDER, id_number: ID_NO });
    expect(await claimOf(goneClaim)).toMatchObject({ status: 'expired', holder_name: null, id_number: null });
  });

  it('D5 PURGE: runLobbyNightly leaves approved, rejected and expired claims exactly as they were (session_ref, statutory_diner_ref, last4, reason, times) and never deletes a claim row; a second run changes nothing [kills: purge damaging the receipt record, deleting rows, non-idempotent]', async () => {
    const f = await fx('d5');
    const e = await entry(f.A, { status: 'seated', closedMinAgo: 30 * 60 });
    const approved = await rawClaim(f, e.id, 'approved');
    const rejected = await rawClaim(f, e.id, 'rejected');
    const expired = await rawClaim(f, e.id, 'expired');
    const before = await Promise.all([approved, rejected, expired].map(claimOf));
    await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    await asOrg(f.orgId, (tx) => runLobbyNightly(tx, f.orgId));
    expect(await Promise.all([approved, rejected, expired].map(claimOf))).toEqual(before);
    expect(before[0]).toMatchObject({ session_ref: 'S-1', statutory_diner_ref: 'SD-1', id_last4: '1187' });
    expect(await claimRows(e.id)).toHaveLength(3);
  });
});

// ================================================================================================ E. the same card twice (S7a ruling: duplicate card in one entry)
describe('E. a second PENDING claim with the same ID in one entry is refused', () => {
  const claim = (f: Fx, key: any, id: string) => asOrg(f.orgId, (tx) => submitClaim(tx, key, { kind: 'senior', holderName: HOLDER, idNumber: id }));

  it('E1 the same ID typed again is LOBBY_CLAIM_DUPLICATE however it is spaced, hyphenated or cased ("0042-5566-1187" = "004255661187" = "0042 5566 1187"; "ab12-CD34" = "AB12 cd34"); one row, a plain sentence without the ID [kills: no duplicate check, comparing the raw text, case-sensitive match]', async () => {
    const f = await fx('e1');
    const e = await entry(f.A, { party: 5 });
    await claim(f, e.key, ID_NO);
    for (const again of ['004255661187', '0042 5566 1187', ' 0042-5566-1187 ', '0-0-4-2-5-5-6-6-1-1-8-7']) {
      const err = await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'pwd', holderName: 'Someone Else', idNumber: again }));
      expectRefusal(err, 'LOBBY_CLAIM_DUPLICATE', `again ${again}`);
    }
    expect(await claimRows(e.id)).toHaveLength(1);
    await claim(f, e.key, 'ab12-CD34');
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: 'AB12 cd34' })), 'LOBBY_CLAIM_DUPLICATE', 'case');
    expect(await claimRows(e.id)).toHaveLength(2);
  });

  it('E2 a DIFFERENT ID, and the SAME ID in ANOTHER entry, are accepted; the same ID after the first claim was cancelled or rejected is accepted again (only a PENDING claim blocks) [kills: blocking across entries, blocking after a cancel/reject, matching on the last four only]', async () => {
    const f = await fx('e2');
    const e = await entry(f.A, { party: 5 });
    const other = await entry(f.A, { party: 5 });
    const first = await claim(f, e.key, ID_NO);
    await claim(f, e.key, '9999-5566-1187'); // same last four, different number
    await claim(f, other.key, ID_NO); // another diner's entry
    expect(await claimRows(e.id)).toHaveLength(2);
    await asOrg(f.orgId, (tx) => cancelMyClaim(tx, e.key, first.claimId));
    await claim(f, e.key, ID_NO); // the withdrawn claim no longer blocks
    expect(await claimRows(e.id)).toHaveLength(3);
    const rej = await entry(f.A, { party: 5 });
    const rejId = await rawClaim(f, rej.id, 'pending');
    await sql`update lobby_discount_claims set status = 'rejected', holder_name = null, id_number = null, reject_reason = 'No card', decided_at = now() where id = ${rejId}`;
    await claim(f, rej.key, ID_NO);
    expect(await claimRows(rej.id)).toHaveLength(2);
  });

  it('E4 unicode spaces and hyphen look-alikes are the same card: "1234 5678" vs NBSP vs non-breaking hyphen is LOBBY_CLAIM_DUPLICATE [kills: SQL and JS normalising differently]', async () => {
    const f = await fx('e4');
    const e = await entry(f.A, { party: 5 });
    await claim(f, e.key, '1234 5678');
    for (const again of ['1234\u00a05678', '1234\u20115678', '1234\u30005678', '1234\u2013\u200b5678']) {
      expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: again })), 'LOBBY_CLAIM_DUPLICATE', JSON.stringify(again));
    }
    expect(await claimRows(e.id)).toHaveLength(1);
  });

  it('E5 LIFETIME CAP: an entry holds at most 10 claim rows of any status; the 11th is refused LOBBY_CLAIM_FULL even with free slots [kills: submit/cancel loops growing rows forever]', async () => {
    const f = await fx('e5');
    const e = await entry(f.A, { party: 5 });
    for (let i = 0; i < 10; i++) await rawClaim(f, e.id, 'expired');
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: HOLDER, idNumber: '9999-0000' })), 'LOBBY_CLAIM_FULL', '11th row');
    expect(await claimRows(e.id)).toHaveLength(10);
    const g = await entry(f.A, { party: 5 });
    for (let i = 0; i < 9; i++) await rawClaim(f, g.id, 'rejected');
    await claim(f, g.key, '9999-0000');
    expect(await claimRows(g.id)).toHaveLength(10);
  });

  it('E3 a refused duplicate writes nothing and leaves the first claim pending with its name [kills: a duplicate replacing or expiring the first]', async () => {
    const f = await fx('e3');
    const e = await entry(f.A, { party: 3 });
    const first = await claim(f, e.key, ID_NO);
    expectRefusal(await refusedIn(f.orgId, (tx) => submitClaim(tx, e.key, { kind: 'senior', holderName: 'Other Name', idNumber: ID_NO })), 'LOBBY_CLAIM_DUPLICATE', 'dup');
    expect(await claimOf(first.claimId)).toMatchObject({ status: 'pending', holder_name: HOLDER, id_number: ID_NO });
    expect(await claimRows(e.id)).toHaveLength(1);
  });
});
