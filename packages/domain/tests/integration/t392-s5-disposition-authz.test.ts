import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-392 S5 (TESTER) - recording a disposition: who may, what it stores, what it refuses.
 * docs/tasks/392-dual-run-comparator.md "S5 spec (refinements)" invariants 45-48 and "Ian rulings, 2026-10-13".
 * Real Postgres. Synthetic data.
 *
 * ---- PINNED CONTRACT (the spec names the signature; the builder follows these or says why not) ----
 * packages/domain/src/dual-run/dispositions.ts, exported from @shareat/domain (packages/domain/src/index.ts directly):
 *   recordDualRunDisposition(tx: Tx, actor: Actor, input: { storeId; weekStart; kind; lineKey; class; ref; note }): Promise<{ id: string; deltaAt: string }>
 *   Order: authorize run_cutover (org) + view_financial_reports (at input.storeId) + role in {admin, super_admin} (checked in the domain);
 *   ANY of those failing throws AuthorizationError and writes nothing (no disposition row, no audit row). Then input checks (a plain Error that is
 *   NOT AuthorizationError), then a read of the CURRENT version's line, then insert + audit_log action 'dual_run.disposition'.
 * packages/domain/src/dual-run/pack.ts, exported from @shareat/domain:
 *   dualRunWeekView(tx: Tx, actor: Actor, input: { storeId; weekStart }): Promise<{ report: { id; verdict; comparedDays };
 *     lines: { kind; lineKey; class; delta: string (2dp); reCheck: boolean; latestDisposition: { ref; class; deltaAt: string } | null }[];
 *     versions: { id: string }[] }>
 *
 * Ian's ruling (binding, supersedes invariant 45's "run_cutover holder is enough"): ONLY admin / super_admin may record, and ALSO they need
 * run_cutover and view_financial_reports at the line's store. A default manager (holds run_cutover) is refused.
 *
 * Red today: recordDualRunDisposition / dualRunWeekView do not exist in @shareat/domain. Each test therefore first asserts the function is
 * there, so the failure is "expected 'undefined' to be 'function'" and not a TypeError passing as a refusal.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, heldCapabilities, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { line, makeFixture, seedReport, type S5Fixture } from './t392-s5-fixture';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 8 });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const W = '2026-10-19';
const record = (): ((tx: Tx, actor: Actor, input: Any) => Promise<{ id: string; deltaAt: string }>) => {
  const fn = (domain as Any).recordDualRunDisposition;
  expect(typeof fn, 'recordDualRunDisposition must be exported from @shareat/domain').toBe('function');
  return fn;
};
const weekView = (): ((tx: Tx, actor: Actor, input: Any) => Promise<Any>) => {
  const fn = (domain as Any).dualRunWeekView;
  expect(typeof fn, 'dualRunWeekView must be exported from @shareat/domain').toBe('function');
  return fn;
};

const base = (f: S5Fixture, over: Any = {}): Any => ({
  storeId: f.lipa.id, weekStart: W, kind: 'ap_supplier', lineKey: 'S1', class: 'V2_DEFECT', ref: 'DEF-701', note: 'invoice never entered in v2', ...over,
});

/** Runs the call in ONE committed transaction, catching its error INSIDE it, so rows written before a late refusal would survive. */
async function attempt(orgId: string, actor: Actor, input: Any): Promise<{ err?: Any; res?: Any }> {
  const fn = record();
  let out: { err?: Any; res?: Any } = {};
  await asOrg(orgId, async (tx) => {
    try {
      out = { res: await fn(tx, actor, input) };
    } catch (e) {
      out = { err: e };
    }
  });
  return out;
}

const rows = async (f: S5Fixture) => ({
  disp: Number((await sql<Any[]>`select count(*)::int n from dual_run_dispositions where org_id = ${f.orgId}`)[0]!.n),
  audit: Number((await sql<Any[]>`select count(*)::int n from audit_log where org_id = ${f.orgId} and action = 'dual_run.disposition'`)[0]!.n),
});

async function seedWeek(f: S5Fixture): Promise<void> {
  const lines = [
    line('ap_supplier', 'S1', '500.00', '0.00', 'UNEXPLAINED'),
    line('ap_supplier', 'S0', '100.00', '100.00', 'TIES'),
    line('ap_supplier', 'v1:ap__x', '300.00', '0.00', 'UNMAPPED_KEY'),
    line('inventory_basis', '1310', '200.00', '0.00', 'INVENTORY_BASIS'),
    line('ap_supplier', '1240:SUPX', '50.00', '0.00', 'SUPPLIER_ADVANCE_1240'),
    line('sales_tender', 'none', '10.00', '0.00', 'NOT_DOUBLE_ENTERED'),
  ];
  await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W, verdict: 'open', days: 2, lines, createdBy: f.admin.personId });
  await seedReport(sql, f.orgId, { storeId: f.malvar.id, weekStart: W, verdict: 'open', days: 2, lines: [line('ap_supplier', 'S1', '500.00', '0.00', 'UNEXPLAINED')], createdBy: f.admin.personId });
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('45. who may record a disposition (admin-only ruling; every refusal writes nothing)', () => {
  it(
    '45a: an actor holding neither capability (staff) gets AuthorizationError, no disposition row, no audit row. Mutants: no authorize; authorize after the insert. Red today: recordDualRunDisposition not exported',
    async () => {
      const f = await makeFixture(sql, '45a');
      await seedWeek(f);
      const { err, res } = await attempt(f.orgId, f.staff, base(f));
      expect(res).toBeUndefined();
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(await rows(f)).toEqual({ disp: 0, audit: 0 });
    },
    60_000,
  );

  it(
    '45b (Ian ruling): a DEFAULT manager, who really holds run_cutover and view_financial_reports at both stores, is refused (AuthorizationError), nothing written. Mutant: capability check only, no admin-role check. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '45b');
      await seedWeek(f);
      const held = await asOrg(f.orgId, (tx) => heldCapabilities(tx, f.manager));
      expect(held.has('run_cutover') && held.has('view_financial_reports'), 'fixture premise: a default manager holds both').toBe(true);
      const { err, res } = await attempt(f.orgId, f.manager, base(f));
      expect(res).toBeUndefined();
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(await rows(f)).toEqual({ disp: 0, audit: 0 });
    },
    60_000,
  );

  it(
    '45c: a staff person who was GRANTED run_cutover and view_financial_reports (holds both, is not an admin) is refused too. Mutant: "holds the capabilities" treated as enough. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '45c');
      await seedWeek(f);
      const held = await asOrg(f.orgId, (tx) => heldCapabilities(tx, f.staffWithGrants));
      expect(held.has('run_cutover') && held.has('view_financial_reports'), 'fixture premise: the grants are live').toBe(true);
      const { err, res } = await attempt(f.orgId, f.staffWithGrants, base(f));
      expect(res).toBeUndefined();
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(await rows(f)).toEqual({ disp: 0, audit: 0 });
    },
    60_000,
  );

  it(
    "45d: an admin scoped to Lipa only recording on MALVAR is refused (view_financial_reports at the line's store); the same admin on Lipa succeeds. Mutant: no store check (run_cutover is org-scoped). Red today: not exported",
    async () => {
      const f = await makeFixture(sql, '45d');
      await seedWeek(f);
      const bad = await attempt(f.orgId, f.adminLipaOnly, base(f, { storeId: f.malvar.id }));
      expect(bad.res).toBeUndefined();
      expect(bad.err).toBeInstanceOf(AuthorizationError);
      expect(await rows(f)).toEqual({ disp: 0, audit: 0 });
      const good = await attempt(f.orgId, f.adminLipaOnly, base(f));
      expect(good.err).toBeUndefined();
      expect(await rows(f)).toEqual({ disp: 1, audit: 1 });
    },
    60_000,
  );

  it(
    '45e: admin and super_admin both succeed; the row names the actor, the audit row is dual_run.disposition. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '45e');
      await seedWeek(f);
      const a = await attempt(f.orgId, f.admin, base(f, { ref: 'DEF-701' }));
      expect(a.err).toBeUndefined();
      const s = await attempt(f.orgId, f.superAdmin, base(f, { ref: 'DEF-702' }));
      expect(s.err).toBeUndefined();
      const got = await sql<Any[]>`select created_by, ref, class from dual_run_dispositions where org_id = ${f.orgId} order by ref`;
      expect(got.map((r) => [r.created_by, r.ref, r.class])).toEqual([
        [f.admin.personId, 'DEF-701', 'V2_DEFECT'],
        [f.superAdmin.personId, 'DEF-702', 'V2_DEFECT'],
      ]);
      expect((await rows(f)).audit).toBe(2);
    },
    60_000,
  );
});

describe("46. delta_at is the CURRENT version's line delta, read from the database", () => {
  it(
    'version 1 (delta -500.00) superseded by version 2 (delta -450.00): the disposition stores -450.00 and returns it. Mutant: delta from the oldest version. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '46');
      await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W, verdict: 'open', days: 1, v2fp: 'v2-old', createdAt: '2026-10-26T00:00:00Z', lines: [line('ap_supplier', 'S1', '500.00', '0.00', 'UNEXPLAINED')], createdBy: f.admin.personId });
      await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W, verdict: 'open', days: 1, v2fp: 'v2-new', createdAt: '2026-10-27T00:00:00Z', lines: [line('ap_supplier', 'S1', '500.00', '50.00', 'UNEXPLAINED')], createdBy: f.admin.personId });
      const { err, res } = await attempt(f.orgId, f.admin, base(f));
      expect(err).toBeUndefined();
      expect(String(res!.deltaAt)).toBe('-450.00');
      const [row] = await sql<Any[]>`select delta_at::text d from dual_run_dispositions where id = ${res!.id}`;
      expect(row!.d).toBe('-450.00');
      const [a] = await sql<Any[]>`select actor_person_id from audit_log where org_id = ${f.orgId} and action = 'dual_run.disposition'`;
      expect(a).toMatchObject({ actor_person_id: f.admin.personId });
    },
    60_000,
  );
});

describe('47. refused before any write', () => {
  it(
    'class INVENTORY_BASIS / UNEXPLAINED; ref def-12, DEF-12a, empty; empty note; a delta-0 line; UNMAPPED_KEY, INVENTORY_BASIS, SUPPLIER_ADVANCE_1240 and sales_tender "none" lines; an unknown line; a week with no report: each throws a plain Error (not AuthorizationError, not TypeError), nothing written; a valid call then succeeds. Mutant: relying on the DB CHECK alone (accepts the UNMAPPED_KEY line). Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '47');
      await seedWeek(f);
      record();
      const bad: [string, Any][] = [
        ['class INVENTORY_BASIS', base(f, { class: 'INVENTORY_BASIS' })],
        ['class UNEXPLAINED', base(f, { class: 'UNEXPLAINED' })],
        ['ref def-12', base(f, { ref: 'def-12' })],
        ['ref DEF-12a', base(f, { ref: 'DEF-12a' })],
        ['empty ref', base(f, { ref: '' })],
        ['empty note', base(f, { note: '' })],
        ['blank note', base(f, { note: '   ' })],
        ['note over 500 chars', base(f, { note: 'x'.repeat(501) })],
        ['delta-0 line', base(f, { lineKey: 'S0' })],
        ['UNMAPPED_KEY line', base(f, { lineKey: 'v1:ap__x' })],
        ['INVENTORY_BASIS line', base(f, { kind: 'inventory_basis', lineKey: '1310' })],
        ['SUPPLIER_ADVANCE_1240 line', base(f, { lineKey: '1240:SUPX' })],
        ['sales_tender none line', base(f, { kind: 'sales_tender', lineKey: 'none' })],
        ['unknown line', base(f, { lineKey: 'NOPE' })],
        ['same key, other kind', base(f, { kind: 'cash_bank' })],
        ['week with no report', base(f, { weekStart: '2026-11-02' })],
      ];
      for (const [name, input] of bad) {
        const { err, res } = await attempt(f.orgId, f.admin, input);
        expect(res, `${name} must not succeed`).toBeUndefined();
        expect(err, `${name} must throw`).toBeInstanceOf(Error);
        expect(err, `${name} must not be a TypeError`).not.toBeInstanceOf(TypeError);
        expect(err, `${name} is an input refusal, not an authorization one`).not.toBeInstanceOf(AuthorizationError);
        expect(await rows(f), `${name} wrote something`).toEqual({ disp: 0, audit: 0 });
      }
      const ok = await attempt(f.orgId, f.admin, base(f));
      expect(ok.err).toBeUndefined();
      expect(await rows(f)).toEqual({ disp: 1, audit: 1 });
    },
    120_000,
  );
});

describe('48. append-only', () => {
  it(
    'a second disposition on the same line adds a row, the first is intact, and the week view shows the latest. Mutant: upsert. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '48a');
      await seedWeek(f);
      const first = await attempt(f.orgId, f.admin, base(f, { class: 'V1_DEFECT', ref: 'DEF-801' }));
      expect(first.err).toBeUndefined();
      const second = await attempt(f.orgId, f.admin, base(f, { class: 'V2_DEFECT', ref: 'DEF-802' }));
      expect(second.err).toBeUndefined();
      const got = await sql<Any[]>`select id, ref, class from dual_run_dispositions where org_id = ${f.orgId} order by created_at, id`;
      expect(got.map((r) => [r.ref, r.class])).toEqual([['DEF-801', 'V1_DEFECT'], ['DEF-802', 'V2_DEFECT']]);
      expect(got[0]!.id).toBe(first.res!.id);
      const view = await asOrg(f.orgId, (tx) => weekView()(tx, f.admin, { storeId: f.lipa.id, weekStart: W }));
      const l = view.lines.find((x: Any) => x.kind === 'ap_supplier' && x.lineKey === 'S1');
      expect(l.latestDisposition).toMatchObject({ ref: 'DEF-802', class: 'V2_DEFECT' });
      expect(l.reCheck).toBe(false);
    },
    60_000,
  );

  it(
    'an org-B admin cannot record against an org-A store (AuthorizationError), and nothing lands in org A. Mutant: store id trusted without the org check. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '48b');
      await seedWeek(f);
      const { err, res } = await attempt(f.foreignAdmin.orgId, f.foreignAdmin, base(f));
      expect(res).toBeUndefined();
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(await rows(f)).toEqual({ disp: 0, audit: 0 });
    },
    60_000,
  );
});
