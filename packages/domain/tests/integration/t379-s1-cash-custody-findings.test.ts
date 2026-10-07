import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-379 S1 (DEF-570) - `listCashCustodyFindings(tx, org)`: the three cash kinds only, decorated exactly as `listFindings` does.
 * `docs/tasks/379-erp-small-follow-ups.md` S1, F1 and F2. Fixture from `findings.test.ts` (an un-remitted-ceiling breach).
 * TESTER, not BUILDER. On HEAD `listCashCustodyFindings` does not exist, so F1 and F2 fail with "is not a function".
 * (The full-feed side of F1 is the positive control: `listFindings` is the oracle and is called here today.)
 *
 *   F1  parity with the full feed filtered to the three kinds: same keys, order, status, acknowledgedAt, counts - once before
 *       and once after `acknowledgeFinding`.
 *       Mutants: `decorate` skipped in the cash path -> the acknowledged leg is red (status stays 'open'); a different
 *                detector order -> the order check is red.
 *   F2  no non-cash kind on a fixture that also raises `itemHasNoThreshold`.
 *       Mutant: a fourth detector added to the cash path -> red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { acknowledgeFinding, listFindings, seedAttendanceConfig } from '@shareat/domain';
import * as domain from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = new Date().toISOString().slice(0, 7);
const CASH_KINDS = ['unremittedCeilingBreached', 'remittanceOverdue', 'serviceChargeFloatAgeing'];

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t379s1f-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }));
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${store!.id}, 'manual')`;
  // whole-month open periods from 45 days ago to 5 days ahead (0174's whole-month CHECK), as findings.test.ts openRecentPeriod
  const from = new Date(Date.now() - 45 * 86_400_000);
  const to = new Date(Date.now() + 5 * 86_400_000);
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  while (y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth())) {
    const starts = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const ends = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${starts}, ${ends}, 'open') on conflict do nothing`;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return { orgId, storeId: store!.id, admin: actor(orgId, p!.id), personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
async function postOn(f: Fixture, on: string, legs: { code: string; debit?: string; credit?: string }[]) {
  const key = uid('k');
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: on, sourceType: 'manual_journal', sourceId: key, idempotencyKey: key, memo: 'fixture', postedBy: f.personId,
      lines: legs.map((l) => ({ accountCode: l.code, storeId: f.storeId, ...(l.debit ? { debit: l.debit } : {}), ...(l.credit ? { credit: l.credit } : {}) })),
    }),
  );
}
/** An un-remitted-ceiling breach, plus an old service-charge float so a second cash kind fires too. */
async function breach(f: Fixture) {
  await sql`update stores set remittance_cadence = 'weekly', unremitted_ceiling = '5000.00' where id = ${f.storeId}`;
  await postOn(f, daysAgo(2), [{ code: '1110', debit: '9000.00' }, { code: '4100', credit: '9000.00' }]);
  await postOn(f, daysAgo(40), [{ code: '1110', debit: '700.00' }, { code: '2160', credit: '700.00' }]);
}

type CashFn = (tx: Tx, orgId: string) => Promise<{ findings: { key: string; kind: string; status: string; acknowledgedAt: Date | null }[]; openCount: number; acknowledgedCount: number; hardCount: number }>;
const cashFeed = (f: Fixture) => {
  const fn = (domain as unknown as { listCashCustodyFindings?: CashFn }).listCashCustodyFindings;
  if (typeof fn !== 'function') throw new Error('listCashCustodyFindings is not a function (not exported from @shareat/domain)');
  return asOrg(f.orgId, (tx) => fn(tx, f.orgId));
};
const fullFiltered = async (f: Fixture) => {
  const full = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
  const findings = full.findings.filter((x) => CASH_KINDS.includes(x.kind));
  return {
    findings,
    openCount: findings.filter((x) => x.status === 'open').length,
    acknowledgedCount: findings.filter((x) => x.status === 'acknowledged').length,
    hardCount: findings.filter((x) => x.severity === 'hard').length,
  };
};

describe('F1 - parity with the full feed, filtered to the three cash kinds', () => {
  it('before an acknowledgement: same findings, same order, same counts - red on HEAD (no such export)', async () => {
    const f = await fixture('f1a');
    await breach(f);
    const want = await fullFiltered(f);
    expect(want.findings.length, 'fixture: at least the ceiling breach fires').toBeGreaterThanOrEqual(1);
    expect(want.findings.map((x) => x.kind)).toContain('unremittedCeilingBreached');
    const got = await cashFeed(f);
    expect(got.findings.map((x) => x.key)).toEqual(want.findings.map((x) => x.key));
    expect(got).toEqual(want);
  });

  it('after acknowledgeFinding: status acknowledged, acknowledgedAt and counts equal the full feed - red on HEAD; mutant "decorate skipped" is red here', async () => {
    const f = await fixture('f1b');
    await breach(f);
    const key = (await fullFiltered(f)).findings.find((x) => x.kind === 'unremittedCeilingBreached')!.key;
    await asOrg(f.orgId, (tx) => acknowledgeFinding(tx, f.admin, { findingKey: key, note: 'seen', period: PERIOD }));
    const want = await fullFiltered(f);
    expect(want.acknowledgedCount, 'fixture: the oracle sees the acknowledgement').toBe(1);
    const got = await cashFeed(f);
    expect(got.findings.find((x) => x.key === key)).toMatchObject({ status: 'acknowledged' });
    expect(got.findings.find((x) => x.key === key)!.acknowledgedAt).toEqual(want.findings.find((x) => x.key === key)!.acknowledgedAt);
    expect(got).toEqual(want);
  });
});

describe('F2 - no non-cash kind', () => {
  it('a store that also raises itemHasNoThreshold: the cash feed carries only the three cash kinds - red on HEAD (no such export)', async () => {
    const f = await fixture('f2');
    await breach(f);
    // itemHasNoThreshold: a branch store with an active commissary link and a stock movement for an item with no threshold.
    const [com] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${f.orgId}, ${uid('com')}, 'Commissary', '2020-01-01') returning id`;
    await sql`insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by) values (${f.orgId}, ${com!.id}, ${f.storeId}, ${f.personId})`;
    const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
    const [loc] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${f.orgId}, ${f.storeId}, 'A', 'Stockroom A', ${lt!.id}, 'operating', true, ${f.personId}) returning id`;
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('I')}, 'Rice', 'raw_material', 'kg', ${f.personId}) returning id`;
    await sql`
      insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
      values (${f.orgId}, ${f.storeId}, ${loc!.id}, ${item!.id}, now(), 5, 'opening', 'fixture', ${f.personId}, ${f.personId})`;
    const full = await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
    expect(full.findings.map((x) => x.kind), 'fixture: the full feed raises itemHasNoThreshold').toContain('itemHasNoThreshold');
    const got = await cashFeed(f);
    expect(got.findings.length).toBeGreaterThanOrEqual(1);
    expect(got.findings.every((x) => CASH_KINDS.includes(x.kind)), `non-cash kind in the cash feed: ${got.findings.map((x) => x.kind)}`).toBe(true);
  });
});
