import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-398 S6c (TESTER) - break-glass logging on every sign-in path and both PIN approvals, through the REAL functions.
 * docs/tasks/398-s6/{S6-REFRESH s5 + s8 row S6c, TESTS S6c (P1, V8a-f, D1), QUESTIONS QO-4}.md.
 *
 * Ian's person INSIDE Padre Garcia (ianPG) is the agreement's franchisor_person_id. Every session created for him (email, PIN, Employee-ID tablet)
 * and every PIN approval he gives (verifyAdminApproval, verifyPosManagerApproval) must leave exactly ONE franchise_access_log row; nobody else leaves any.
 * Sign-ins go through signInWithFirebase / signInWithPin / signInOnPairedTablet (never a raw INSERT into sessions); approvals through the verifiers
 * with tx = null, the shape the app's actions use (the app's own action is in apps/erp/tests/integration/t398-s6c-actions-through-app.test.ts).
 * Log counts are read AS OWNER (a missing row cannot hide behind RLS). Runs on any _test DB; every org is new.
 *
 * WHAT IS RED TODAY, AND WHY: the sign-in rows come from the sessions trigger of migration 0220 (S6b), so V8a/b/d/e/f are GREEN pins here: they stay green
 * only while the trigger writes on all three paths and rolls back with the session. The approval legs (V8c) are RED: verifyAdminApproval /
 * verifyPosManagerApproval do not call log_break_glass_approval, so the log has 0 rows where the leg expects 1.
 *
 * ## PLAN GAP the builder must close (S6-REFRESH s5 says only "calls log_break_glass_approval on its success path, in the lookup transaction")
 * log_break_glass_approval (0220) raises 42501 "Only the franchisor person himself can log his own approval" unless app.person_id = p_person. The verifier's
 * lookup transaction is a plain withOrgPrincipal (org only, NO person). So a call that just passes the approver's id is REFUSED by the database, and the
 * refusal would be thrown from inside the approval: Ian's PIN would stop approving anything. V8c-2 (a manager's button, Ian's PIN) is the leg that needs
 * the verifier to set app.person_id to the APPROVER (credential.personId) in the lookup transaction before the call; V8c-1 (Ian's own button) has the same need
 * when tx = null. Mutant: call the function without setting the person -> every V8c leg red with 42501 text in the thrown error.
 *
 * MUTANTS: drop the trigger -> V8a/b/d; trigger filters credential_kind -> V8b; drop either verifier's call -> V8c-1/V8c-3; log before the success checks ->
 *   V8c-4 (a refused approval leaves a row); log for every approver -> V8e; log outside the transaction -> V8f.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, closeDb, transaction, withActorPrincipal, withOrgPrincipal, type Tx } from '@shareat/db';
import {
  AuthorizationError,
  hashPin,
  pairPosTablet,
  pinLookupHash,
  signInOnPairedTablet,
  signInWithFirebase,
  signInWithPin,
  verifyAdminApproval,
  verifyPosManagerApproval,
} from '@shareat/auth';
import * as domain from '@shareat/domain';
import { D0, franchiseWorld, insertLogRow, sql, uid, type FranchiseWorld, type Person } from '../../../db/tests/integration/_fixtures/t398-s6-franchise';

afterAll(async () => {
  await closeDb();
});

let pinSeq = 0;
const nextPin = () => String(810100 + ++pinSeq * 13);
let codeSeq = 500;

interface Armed {
  pin: string;
  uid: string;
  staffCode: string;
}
let W: FranchiseWorld;
let armed: { ian: Armed; mgr: Armed; admin: Armed; staff: Armed };
let term: string; // a terminal person credentialed to PG store 1
let termOther: string; // a terminal person credentialed to PG store 2 only
let tabletToken: string;

/** Give a PG person what it needs to sign in three ways: scope at store 1, an employment with a staff code, a PIN, and a firebase login. */
async function arm(p: Person): Promise<Armed> {
  const pin = nextPin();
  const fb = uid('fbuid-s6c');
  const staffCode = `SE-${++codeSeq}`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${p.id}, ${W.pg.storeId}, 'manual')`;
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
            values (${W.pg.orgId}, ${W.pg.storeId}, ${p.id}, ${staffCode}, 'regular', '2025-01-01')`;
  await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
            values (${p.id}, 'pin', ${W.pg.storeId}, ${await hashPin(pin)}, ${pinLookupHash(W.pg.orgId, pin)})`;
  await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${p.id}, 'firebase', null, ${fb})`;
  return { pin, uid: fb, staffCode };
}

async function asPgOrg<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${W.pg.orgId}, true)`);
    return fn(tx);
  });
}

beforeAll(async () => {
  W = await franchiseWorld();
  armed = { ian: await arm(W.ianPG), mgr: await arm(W.mgrPG), admin: await arm(W.adminPG), staff: await arm(W.staffPG) };
  const mkTerminal = async (store: string): Promise<string> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name, kind) values (${W.pg.orgId}, ${uid('Terminal')}, 'terminal') returning id`;
    await sql`insert into person_credentials (person_id, kind, store_id, external_id) values (${p!.id}, 'firebase', ${store}, ${uid('fbuid-term')})`;
    return p!.id;
  };
  term = await mkTerminal(W.pg.storeId);
  termOther = await mkTerminal(W.pg.store2Id);
  const paired = await asPgOrg((tx) => pairPosTablet(tx, { personId: W.adminPG.id, orgId: W.pg.orgId }, { storeId: W.pg.storeId, label: 'S6c counter' }));
  tabletToken = paired.token;
  // a log row of ANOTHER franchisee, so "only PG's rows" (D1) has something to leak
  await insertLogRow(sql, { franchisee: W.y, franchisor: W.x, agreementId: W.agreementXId, readerPersonId: W.readerX.id });
}, 120_000);

// ------------------------------------------------------------------------------------------------ helpers

interface LogRow {
  id: string;
  what: string;
  franchisee_person_id: string | null;
  person_name: string;
  session_id: string | null;
  credential_kind: string | null;
  capability: string | null;
  store_id: string | null;
}
/** PG's break-glass rows for one person, read as OWNER. */
const rowsOf = (personId: string, what?: string): Promise<LogRow[]> =>
  sql<LogRow[]>`
    select id, what, franchisee_person_id, person_name, session_id, credential_kind, capability, store_id
    from franchise_access_log
    where org_id = ${W.pg.orgId} and franchisee_person_id = ${personId} and (${what ?? null}::text is null or what = ${what ?? null})
    order by occurred_at, id`;
const pgBreakGlassTotal = async () =>
  (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log where org_id = ${W.pg.orgId} and what in ('break_glass_sign_in', 'break_glass_approval')`)[0]!.n;

const caught = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e);

// ------------------------------------------------------------------------------------------------ P1

describe('P1 withActorPrincipal carries the person for one transaction only', () => {
  it('P1: app.person_id and app.org_id are set inside; the NEXT transaction on the same pool sees both empty (kills: session-scoped set_config)', async () => {
    const seen = async (tx: Tx) => {
      const r = (await tx.execute(dsql`select nullif(current_setting('app.person_id', true), '') as p, nullif(current_setting('app.org_id', true), '') as o`)) as unknown as { p: string | null; o: string | null }[];
      return r[0]!;
    };
    const inside = await withActorPrincipal(W.pg.orgId, W.ianPG.id, seen);
    expect(inside, 'the person and the org are visible inside').toEqual({ p: W.ianPG.id, o: W.pg.orgId });
    // several round trips so the pool hands back the SAME connection at least once
    for (let i = 0; i < 6; i++) {
      const after = await transaction(seen);
      expect(after, `transaction ${i + 1} after: the previous person leaked`).toEqual({ p: null, o: null });
    }
  });
});

// ------------------------------------------------------------------------------------------------ V8a-d

describe('V8a/b/d Ian\'s person in PG signs in: one break_glass_sign_in row per session, on every path', () => {
  it('V8a: email (signInWithFirebase), null form and tx form -> exactly 1 row each, with the session id and credential kind firebase', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_sign_in')).length;
    const viaDoor = await signInWithFirebase(null, { verifiedUid: armed.ian.uid });
    const afterDoor = await rowsOf(W.ianPG.id, 'break_glass_sign_in');
    expect(afterDoor.length - before, 'null form (the auth door): exactly one new row').toBe(1);
    const row = afterDoor[afterDoor.length - 1]!;
    expect({ session: row.session_id, kind: row.credential_kind, name: row.person_name }).toEqual({ session: viaDoor.sessionId, kind: 'firebase', name: W.ianPG.name });

    const viaTx = await withOrgPrincipal(W.pg.orgId, (tx) => signInWithFirebase(tx, { verifiedUid: armed.ian.uid }));
    const afterTx = await rowsOf(W.ianPG.id, 'break_glass_sign_in');
    expect(afterTx.length - afterDoor.length, 'tx form: exactly one new row').toBe(1);
    expect(afterTx[afterTx.length - 1]!.session_id).toBe(viaTx.sessionId);

    // PG's manager sees it through the screen's own domain read; PG's staff may not
    const seen = await withActorPrincipal(W.pg.orgId, W.mgrPG.id, (tx) =>
      domain.listFranchiseAccessLog(tx, { personId: W.mgrPG.id, orgId: W.pg.orgId }, { what: 'break_glass_sign_in' }),
    );
    expect(seen.map((r) => r.sessionId), 'mgrPG reads both sign-ins').toEqual(expect.arrayContaining([viaDoor.sessionId, viaTx.sessionId]));
    const refused = await caught(
      withActorPrincipal(W.pg.orgId, W.staffPG.id, (tx) => domain.listFranchiseAccessLog(tx, { personId: W.staffPG.id, orgId: W.pg.orgId })),
    );
    expect(refused, 'staffPG is refused the access log').toBeInstanceOf(AuthorizationError);
  });

  it('V8b: PIN at a PG store (signInWithPin) -> exactly 1 row, credential kind pin, the store id', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_sign_in')).length;
    const r = await signInWithPin(null, { orgId: W.pg.orgId, storeId: W.pg.storeId, pin: armed.ian.pin });
    const rows = await rowsOf(W.ianPG.id, 'break_glass_sign_in');
    expect(rows.length - before, 'kills: trigger filtered to firebase').toBe(1);
    expect({ session: rows.at(-1)!.session_id, kind: rows.at(-1)!.credential_kind, store: rows.at(-1)!.store_id }).toEqual({ session: r.sessionId, kind: 'pin', store: W.pg.storeId });
  });

  it('V8d: Employee-ID tablet (signInOnPairedTablet, K4: the third path) -> exactly 1 row with the session id and the tablet\'s store', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_sign_in')).length;
    const r = await signInOnPairedTablet(null, { cookieToken: tabletToken, staffCode: armed.ian.staffCode.slice(3), pin: armed.ian.pin });
    const rows = await rowsOf(W.ianPG.id, 'break_glass_sign_in');
    expect(rows.length - before, 'the paired-tablet path writes one row too').toBe(1);
    expect({ session: rows.at(-1)!.session_id, store: rows.at(-1)!.store_id }).toEqual({ session: r.sessionId, store: W.pg.storeId });
  });
});

// ------------------------------------------------------------------------------------------------ V8e / V8f

describe('V8e/V8f nobody else, and nothing that did not happen', () => {
  it('V8e: mgrPG, adminPG and staffPG sign in all three ways and approve with a PIN: ZERO break-glass rows; a failed attempt at Ian\'s PIN leaves none', async () => {
    const before = await pgBreakGlassTotal();
    for (const a of [armed.mgr, armed.admin, armed.staff]) {
      if (a !== armed.staff) await signInWithFirebase(null, { verifiedUid: a.uid }); // staff sign in with a PIN only
      await signInWithPin(null, { orgId: W.pg.orgId, storeId: W.pg.storeId, pin: a.pin });
      await signInOnPairedTablet(null, { cookieToken: tabletToken, staffCode: a.staffCode.slice(3), pin: a.pin }).catch((e: Error) => { throw new Error(`tablet ${a.staffCode}: ${e.message}`); });
    }
    await verifyAdminApproval(null, { actor: { personId: W.mgrPG.id, orgId: W.pg.orgId }, storeId: W.pg.storeId, pin: armed.admin.pin, capability: 'void_expense' });
    await verifyPosManagerApproval(null, { orgId: W.pg.orgId, erpStoreId: W.pg.storeId, pin: armed.admin.pin, terminalPersonId: term });
    expect(await pgBreakGlassTotal() - before, 'kills: log every sign-in / every approver').toBe(0);

    // Ian's PIN is real but the attempts fail for other reasons: a wrong store for the PIN, a PIN of nobody
    const failures = [
      caught(signInWithPin(null, { orgId: W.pg.orgId, storeId: W.pg.storeId, pin: '000000' })),
      caught(signInWithFirebase(null, { verifiedUid: uid('nobody') })),
      caught(signInOnPairedTablet(null, { cookieToken: tabletToken, staffCode: armed.ian.staffCode.slice(3), pin: '000001' })),
    ];
    for (const e of await Promise.all(failures)) expect(e, 'the failed attempt really failed').toBeInstanceOf(Error);
    expect(await pgBreakGlassTotal() - before, 'a failed attempt logs nothing').toBe(0);
  });

  it('V8f: a PIN sign-in whose transaction rolls back after the session is issued leaves 0 log rows and 0 sessions (kills: log written outside the transaction)', async () => {
    const before = (await rowsOf(W.ianPG.id)).length;
    const sessionsBefore = (await sql<{ n: number }[]>`select count(*)::int n from sessions where person_id = ${W.ianPG.id}`)[0]!.n;
    const boom = new Error('rolled back on purpose');
    const e = await caught(
      withOrgPrincipal(W.pg.orgId, async (tx) => {
        await signInWithPin(tx, { orgId: W.pg.orgId, storeId: W.pg.storeId, pin: armed.ian.pin });
        throw boom;
      }),
    );
    expect(e).toBe(boom);
    expect((await rowsOf(W.ianPG.id)).length, 'no log row survives the rollback').toBe(before);
    expect((await sql<{ n: number }[]>`select count(*)::int n from sessions where person_id = ${W.ianPG.id}`)[0]!.n, 'and no session').toBe(sessionsBefore);
  });
});

// ------------------------------------------------------------------------------------------------ V8c

describe('V8c Ian\'s PIN approves: one break_glass_approval row per approval, through the real verifiers (RED today: the verifiers never call the logger)', () => {
  const pgActor = (p: Person) => ({ personId: p.id, orgId: W.pg.orgId });

  it('V8c-1: Ian\'s OWN button, his own PIN (verifyAdminApproval, tx = null) -> approver is Ian, exactly 1 row with the capability and the record\'s store', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_approval')).length;
    const r = await verifyAdminApproval(null, { actor: pgActor(W.ianPG), storeId: W.pg.storeId, pin: armed.ian.pin, capability: 'void_expense' });
    expect(r.approverPersonId).toBe(W.ianPG.id);
    const rows = await rowsOf(W.ianPG.id, 'break_glass_approval');
    expect(rows.length - before, 'kills: verifyAdminApproval does not log').toBe(1);
    expect({ cap: rows.at(-1)!.capability, store: rows.at(-1)!.store_id, name: rows.at(-1)!.person_name }).toEqual({ cap: 'void_expense', store: W.pg.storeId, name: W.ianPG.name });
  });

  it('V8c-2: a PG MANAGER\'s button, Ian types his PIN (the real case: the actor is not Ian) -> the approval SUCCEEDS and logs exactly 1 row naming Ian (kills: logger called without setting the approver as the principal person -> 42501)', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_approval')).length;
    const r = await verifyAdminApproval(null, { actor: pgActor(W.mgrPG), storeId: W.pg.storeId, pin: armed.ian.pin, capability: 'approve_expense' });
    expect(r.approverPersonId, 'the PIN\'s owner approves').toBe(W.ianPG.id);
    const rows = await rowsOf(W.ianPG.id, 'break_glass_approval');
    expect(rows.length - before).toBe(1);
    expect(rows.at(-1)!.capability).toBe('approve_expense');
  });

  it('V8c-3: POS manager approval (verifyPosManagerApproval, tx = null) with Ian\'s PIN at a credentialed terminal -> exactly 1 row, capability approve_pos_correction, the ERP store', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_approval')).length;
    const r = await verifyPosManagerApproval(null, { orgId: W.pg.orgId, erpStoreId: W.pg.storeId, pin: armed.ian.pin, terminalPersonId: term });
    expect(r.approverPersonId).toBe(W.ianPG.id);
    const rows = await rowsOf(W.ianPG.id, 'break_glass_approval');
    expect(rows.length - before, 'kills: verifyPosManagerApproval does not log').toBe(1);
    expect({ cap: rows.at(-1)!.capability, store: rows.at(-1)!.store_id }).toEqual({ cap: 'approve_pos_correction', store: W.pg.storeId });
  });

  it('V8c-4: a REFUSED approval with Ian\'s real PIN (POS terminal not credentialed to the store) logs nothing (kills: logging before the success checks)', async () => {
    const before = (await rowsOf(W.ianPG.id, 'break_glass_approval')).length;
    const e = await caught(verifyPosManagerApproval(null, { orgId: W.pg.orgId, erpStoreId: W.pg.storeId, pin: armed.ian.pin, terminalPersonId: termOther }));
    expect(e, 'the approval is refused').toBeInstanceOf(Error);
    expect((e as Error).message, 'refused in the POS sentence, not by the logger').toMatch(/cannot approve/i);
    expect((await rowsOf(W.ianPG.id, 'break_glass_approval')).length - before).toBe(0);
  });

  it('V8c-5: PG\'s own admin approving leaves no row, and the one approval Ian gave never reaches another franchisee\'s log', async () => {
    const before = await pgBreakGlassTotal();
    await verifyAdminApproval(null, { actor: pgActor(W.mgrPG), storeId: W.pg.storeId, pin: armed.admin.pin, capability: 'void_expense' });
    expect(await pgBreakGlassTotal() - before).toBe(0);
    const foreign = (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log where org_id = ${W.y.orgId} and what like 'break_glass%'`)[0]!.n;
    expect(foreign, 'Y\'s log has no break-glass rows from PG\'s approvals').toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ D1

describe('D1 the domain reads', () => {
  it('D1a: viewFranchiseSales as ianL returns Money strings equal to V1\'s figures for the first verified day, and writes one log row', async () => {
    const actor = { personId: W.ianL.id, orgId: W.l.orgId };
    const before = (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log where org_id = ${W.pg.orgId} and what = 'sales_daily'`)[0]!.n;
    const rows = await withActorPrincipal(W.l.orgId, W.ianL.id, (tx) =>
      domain.viewFranchiseSales(tx, actor, { franchiseeOrgId: W.pg.orgId, from: D0, to: D0 }),
    );
    const day = rows.find((r) => r.rowKind === 'day')!;
    expect({ gross: day.grossSales, discounts: day.discounts, comps: day.comps, refunds: day.refunds, net: day.netSales, cash: day.cashCollected, online: day.onlineCollected, credit: day.creditSales }).toEqual({
      gross: '1000.00', discounts: '85.00', comps: '15.00', refunds: '0.00', net: '900.00', cash: '700.00', online: '250.00', credit: '50.00',
    });
    const after = (await sql<{ n: number }[]>`select count(*)::int n from franchise_access_log where org_id = ${W.pg.orgId} and what = 'sales_daily'`)[0]!.n;
    expect(after - before, 'one call, one row').toBe(1);
  });

  it('D1b: listFranchiseAccessLog as mgrPG returns only PG\'s rows, none of Y\'s (kills: repo read without the org filter)', async () => {
    const mine = new Set((await sql<{ id: string }[]>`select id from franchise_access_log where org_id = ${W.pg.orgId}`).map((r) => r.id));
    const others = new Set((await sql<{ id: string }[]>`select id from franchise_access_log where org_id <> ${W.pg.orgId}`).map((r) => r.id));
    expect(others.size, 'the fixture really holds foreign rows').toBeGreaterThan(0);
    const rows = await withActorPrincipal(W.pg.orgId, W.mgrPG.id, (tx) => domain.listFranchiseAccessLog(tx, { personId: W.mgrPG.id, orgId: W.pg.orgId }, { limit: 500 }));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(mine.has(r.id), `row ${r.id} (${r.what}) is PG's`).toBe(true);
      expect(others.has(r.id), `row ${r.id} belongs to another franchisee`).toBe(false);
    }
  });
});
