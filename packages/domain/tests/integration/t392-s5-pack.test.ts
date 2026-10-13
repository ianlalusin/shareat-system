import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-392 S5 (TESTER) - the go/no-go pack and the week view's re-check. docs/tasks/392-dual-run-comparator.md "S5 spec (refinements)"
 * invariants 49, 50, 51 (and the re-check rule of the week view). Real Postgres. Synthetic data; reports seeded through
 * dualRunRepo.insertReport / insertLines (no snapshot, no ledger).
 *
 * ---- PINNED CONTRACT (the spec names the signature and the rules; the result shape below is this tester's pin) ----
 * packages/domain/src/dual-run/pack.ts, exported from @shareat/domain:
 *   dualRunPack(tx: Tx, actor: Actor, input: { fromWeek: string; toWeek: string }): Promise<{
 *     signable: boolean;
 *     reasons: string[];            // one entry per failed criterion; a per-store shortfall reads `${stores.name} ${days} < ${MIN_STORE_DAYS}`, e.g. "Malvar 9 < 10"
 *     totalDays: number;            // compared days over COUNTED weeks of CURRENT versions only
 *     countedWeeks: number;         // current versions whose verdict is not no_data
 *     stores: { storeId: string; days: number }[];     // every store with >= 1 version in range
 *     noData: { storeId: string; weekStart: string }[]; // no_data weeks, listed apart, never counted
 *     stale: { storeId: string; weekStart: string }[];  // a disposition created after the store-week's current version
 *     classTotals: { class: string; family: string; lines: number; absDelta: string (2dp, sum of abs delta) }[];  // counted weeks, delta != 0 lines only
 *     defects: { storeId: string; weekStart: string; kind: string; lineKey: string; class: string; ref: string }[]; // every V1_DEFECT / V2_DEFECT line
 *   }>
 *   MIN_TOTAL_DAYS = 15, MIN_STORE_DAYS = 10. The pack authorizes view_financial_reports for EVERY active store of the org (AuthorizationError otherwise).
 * dualRunWeekView: see t392-s5-disposition-authz.test.ts (lines[].reCheck, lines[].latestDisposition).
 *
 * Red today: dualRunPack / dualRunWeekView do not exist in @shareat/domain; every test first asserts they do.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { line, makeFixture, seedDisposition, seedReport, type S5Fixture, type SeedLine } from './t392-s5-fixture';

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

const W1 = '2026-10-19';
const W2 = '2026-10-26';
const W3 = '2026-11-02';

const pack = (f: S5Fixture, actor: Actor = f.admin): Promise<Any> => {
  const fn = (domain as Any).dualRunPack;
  expect(typeof fn, 'dualRunPack must be exported from @shareat/domain').toBe('function');
  return asOrg(f.orgId, (tx) => fn(tx, actor, { fromWeek: W1, toWeek: W3 }));
};
const weekView = (f: S5Fixture, storeId: string, weekStart: string): Promise<Any> => {
  const fn = (domain as Any).dualRunWeekView;
  expect(typeof fn, 'dualRunWeekView must be exported from @shareat/domain').toBe('function');
  return asOrg(f.orgId, (tx) => fn(tx, f.admin, { storeId, weekStart }));
};

/**
 * Lipa: ties 7 (19 Oct), explained 6 (26 Oct), no_data (2 Nov).  Malvar: explained 5 (19 Oct, with a SUPERSEDED open 0-day version beneath it),
 * explained `malvarSecond` (26 Oct).  Total 7+6+5+5 = 23 with the default; Lipa 13, Malvar 10.
 */
async function seedPack(f: S5Fixture, o: { malvarSecond?: number; lipaSecond?: 'explained' | 'open'; lipaLines?: SeedLine[] } = {}): Promise<void> {
  const by = f.admin.personId;
  await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W1, verdict: 'ties', days: 7, lines: o.lipaLines ?? [], createdBy: by });
  await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W2, verdict: o.lipaSecond ?? 'explained', days: 6, createdBy: by });
  await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W3, verdict: 'no_data', days: 0, createdBy: by });
  await seedReport(sql, f.orgId, { storeId: f.malvar.id, weekStart: W1, verdict: 'open', days: 0, v2fp: 'v2-superseded', createdAt: '2026-10-25T00:00:00Z', createdBy: by });
  await seedReport(sql, f.orgId, { storeId: f.malvar.id, weekStart: W1, verdict: 'explained', days: 5, v2fp: 'v2-current', createdAt: '2026-10-27T00:00:00Z', createdBy: by });
  await seedReport(sql, f.orgId, { storeId: f.malvar.id, weekStart: W2, verdict: 'explained', days: o.malvarSecond ?? 5, createdBy: by });
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('49. the pack counts current versions only, applies both thresholds, lists no_data apart', () => {
  it(
    'Lipa 7+6+no_data and Malvar 5+5 (plus a superseded 0-day open version): total 23, Lipa 13, Malvar 10, 4 counted weeks, one no_data week listed apart, signable. Mutants: all versions counted (the superseded open one blocks); no_data counted. Red today: dualRunPack not exported',
    async () => {
      const f = await makeFixture(sql, '49a');
      await seedPack(f);
      const p = await pack(f);
      expect(p.totalDays).toBe(23);
      expect(p.countedWeeks).toBe(4);
      expect(p.stores.find((s: Any) => s.storeId === f.lipa.id).days).toBe(13);
      expect(p.stores.find((s: Any) => s.storeId === f.malvar.id).days).toBe(10);
      expect(p.noData).toEqual([{ storeId: f.lipa.id, weekStart: W3 }]);
      expect(p.stale).toEqual([]);
      expect(p.reasons).toEqual([]);
      expect(p.signable).toBe(true);
    },
    60_000,
  );

  it(
    "Malvar's second week at 4 days: not signable, and the reason names \"Malvar 9 < 10\" (total 22 still passes). Mutant: per-store threshold dropped. Red today: not exported",
    async () => {
      const f = await makeFixture(sql, '49b');
      await seedPack(f, { malvarSecond: 4 });
      const p = await pack(f);
      expect(p.totalDays).toBe(22);
      expect(p.signable).toBe(false);
      expect(p.reasons.join(' | ')).toContain('Malvar 9 < 10');
    },
    60_000,
  );

  it(
    'any open week makes it not signable even with enough days. Mutant: verdict ignored. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '49c');
      await seedPack(f, { lipaSecond: 'open' });
      const p = await pack(f);
      expect(p.totalDays).toBe(23);
      expect(p.signable).toBe(false);
      expect(p.reasons.join(' | ')).toMatch(/open/i);
    },
    60_000,
  );

  it(
    'the total threshold: Lipa 7 + Malvar 5 = 12 < 15 is not signable and says so. Mutant: total threshold dropped. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '49d');
      await seedReport(sql, f.orgId, { storeId: f.lipa.id, weekStart: W1, verdict: 'ties', days: 7, createdBy: f.admin.personId });
      await seedReport(sql, f.orgId, { storeId: f.malvar.id, weekStart: W1, verdict: 'explained', days: 5, createdBy: f.admin.personId });
      const p = await pack(f);
      expect(p.totalDays).toBe(12);
      expect(p.signable).toBe(false);
      expect(p.reasons.join(' | ')).toMatch(/12\s*<\s*15/);
    },
    60_000,
  );
});

describe('50. staleness and the whole-org authorization', () => {
  it(
    'a disposition created AFTER its store-week\'s current version makes the pack stale and not signable (the re-run rule, Ian 2026-10-13). Mutant: staleness ignored. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '50a');
      await seedPack(f);
      expect((await pack(f)).signable, 'premise: signable before the disposition').toBe(true);
      await seedDisposition(sql, f, { storeId: f.malvar.id, weekStart: W2, kind: 'ap_supplier', lineKey: 'S1', deltaAt: '-10.00', class: 'V2_DEFECT', ref: 'DEF-500' });
      const p = await pack(f);
      expect(p.stale).toEqual([{ storeId: f.malvar.id, weekStart: W2 }]);
      expect(p.signable).toBe(false);
      expect(p.reasons.join(' | ')).toMatch(/re-run compare/i);
    },
    60_000,
  );

  it(
    'an admin scoped to ONE store calling dualRunPack gets AuthorizationError (a pack over a subset must never read signable); so does staff. Mutant: authorize only the stores that have reports. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '50b');
      await seedPack(f);
      await expect(pack(f, f.adminLipaOnly)).rejects.toBeInstanceOf(AuthorizationError);
      await expect(pack(f, f.staff)).rejects.toBeInstanceOf(AuthorizationError);
    },
    60_000,
  );

  it(
    'a store with NO reports is still authorized: a Lipa+Malvar-scoped actor in a three-store org is refused. Mutant: authorize per reported store only. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '50c');
      await seedPack(f);
      await sql`insert into stores (org_id, code, name) values (${f.orgId}, ${`ZZ${Date.now()}`}, 'Padre') `;
      await expect(pack(f)).rejects.toBeInstanceOf(AuthorizationError);
    },
    60_000,
  );
});

describe('51. defect list and class totals', () => {
  const lines: SeedLine[] = [
    line('cash_bank', 'A', '0.00', '100.00', 'V2_DEFECT'),
    line('cash_bank', 'B', '100.00', '0.00', 'V2_DEFECT'),
    line('ap_supplier', 'C', '0.00', '50.00', 'V1_DEFECT'),
    line('ap_supplier', 'D', '10.00', '10.00', 'TIES'),
    line('ap_supplier', 'E', '0.00', '25.00', 'PENDING_V2'),
  ];

  it(
    'each V2_DEFECT line shows its DEF-nnn (the latest disposition created at or before the version, not a newer one); class totals use the sum of |delta| (+100 and -100 give 200.00); TIES lines are not totalled. Mutants: signed sum; ref of a disposition newer than the version. Red today: not exported',
    async () => {
      const f = await makeFixture(sql, '51');
      await seedPack(f, { lipaLines: lines });
      const d = (lineKey: string, deltaAt: string, cls: 'V1_DEFECT' | 'V2_DEFECT', ref: string, createdAt: string, kind = 'cash_bank') =>
        seedDisposition(sql, f, { storeId: f.lipa.id, weekStart: W1, kind, lineKey, deltaAt, class: cls, ref, createdAt });
      await d('A', '100.00', 'V2_DEFECT', 'DEF-901', '2026-10-26T00:00:00Z');
      await d('B', '-100.00', 'V2_DEFECT', 'DEF-902', '2026-10-26T00:00:00Z');
      await d('B', '-100.00', 'V2_DEFECT', 'DEF-999', '2026-10-28T00:00:00Z'); // newer than the version: not the ref shown
      await d('C', '50.00', 'V1_DEFECT', 'DEF-903', '2026-10-26T00:00:00Z', 'ap_supplier');
      const p = await pack(f);
      const refOf = (kind: string, key: string) => p.defects.find((x: Any) => x.kind === kind && x.lineKey === key && x.storeId === f.lipa.id)?.ref;
      expect(p.defects).toHaveLength(3);
      expect(refOf('cash_bank', 'A')).toBe('DEF-901');
      expect(refOf('cash_bank', 'B')).toBe('DEF-902');
      expect(refOf('ap_supplier', 'C')).toBe('DEF-903');
      expect(p.defects.filter((x: Any) => x.class === 'V2_DEFECT').map((x: Any) => x.ref).sort()).toEqual(['DEF-901', 'DEF-902']);
      const tot = (c: string) => p.classTotals.find((x: Any) => x.class === c);
      expect(tot('V2_DEFECT')).toMatchObject({ family: 'defect', lines: 2 });
      expect(String(tot('V2_DEFECT').absDelta)).toBe('200.00');
      expect(String(tot('V1_DEFECT').absDelta)).toBe('50.00');
      expect(tot('PENDING_V2')).toMatchObject({ family: 'timing', lines: 1 });
      expect(tot('TIES')).toBeUndefined();
    },
    60_000,
  );

  it(
    "the week view's re-check uses the same cut-off: a line whose latest disposition at or before the version has delta_at = delta is NOT re-check even when a newer one disagrees; a disagreeing latest one IS. Mutant: latest overall. Red today: not exported",
    async () => {
      const f = await makeFixture(sql, '51b');
      await seedPack(f, { lipaLines: lines });
      const d = (lineKey: string, deltaAt: string, ref: string, createdAt: string) =>
        seedDisposition(sql, f, { storeId: f.lipa.id, weekStart: W1, kind: 'cash_bank', lineKey, deltaAt, class: 'V2_DEFECT', ref, createdAt });
      await d('A', '100.00', 'DEF-901', '2026-10-26T00:00:00Z'); // matches delta 100.00
      await d('A', '90.00', 'DEF-950', '2026-10-28T00:00:00Z'); // newer than the version, disagrees: ignored by the cut-off
      await d('B', '-80.00', 'DEF-902', '2026-10-26T00:00:00Z'); // latest at/before the version disagrees with delta -100.00
      const v = await weekView(f, f.lipa.id, W1);
      const l = (kind: string, key: string) => v.lines.find((x: Any) => x.kind === kind && x.lineKey === key);
      expect(l('cash_bank', 'A').reCheck).toBe(false);
      expect(l('cash_bank', 'B').reCheck).toBe(true);
      expect(l('cash_bank', 'B').latestDisposition).toMatchObject({ ref: 'DEF-902' });
      expect(String(l('cash_bank', 'B').delta)).toBe('-100.00');
    },
    60_000,
  );
});
