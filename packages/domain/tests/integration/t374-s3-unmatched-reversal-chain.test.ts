import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S3 (DEF-580) — `interStoreLineUnmatched` reads a reversal chain by PARITY. `docs/tasks/374-money-push-follow-ups.md` §S3, R3.
 *
 * A bad 1250 line (party code names no store) is posted as A, then reversed through the real `reverseEntry` 0..3 times.
 * The live tail of an odd chain (A,R1 / A,R1,R2,R3) cancels the root; the live tail of an even chain (A / A,R1,R2) re-states it.
 *
 * TESTER. T3 is the defect (red on HEAD: the live R2 is hidden because its original R1 is 'reversed'). T1/T2/T4 are pins
 * (green on HEAD). T4 kills the register's proposed rule (exclude a reversal whose original is reversed and is not itself
 * a reversal: it counts R3 and flags a net-zero chain). Every "no finding" leg has a positive control: the bad line
 * demonstrably fires first (A alone), so a detector that never fires cannot pass.
 *
 * MUTANTS (analysed; the tester does not edit source):
 *   - the register's rule                  -> T4 red (R3 counted).
 *   - drop the depth test, keep status     -> T2 and T4 red (live R1 / live R3 counted); T3 stays green.
 *   - `depth % 2 = 1`                      -> T1 and T3 red.
 *   - drop `status <> 'draft'`             -> T6 red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { listFindings } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { reverseEntry } from '../../src/ledger/reverse-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = '2026-01';
const UNMATCHED = 'interStoreLineUnmatched';

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

async function fixture(hint: string) {
  const code = uid(`t374s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const c = uid('lipa');
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${c}, 'Lipa', '2020-01-01') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s!.id})`;
  return { orgId, storeId: s!.id, adminId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A balanced entry whose 1250 line names a party code that is no store: the line no pair can read. */
function badLine(f: Fixture, amount: string): Promise<string> {
  return asOrg(f.orgId, async (tx) => {
    const r = await postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-10', sourceType: 'manual_journal', sourceId: uid('bad'), idempotencyKey: uid('bad'), memo: 'fixture unmatched inter-store line', postedBy: f.adminId,
      lines: [
        { accountCode: '1250', storeId: f.storeId, debit: amount, partyType: 'store', partyId: 'NO-SUCH-STORE' },
        { accountCode: '3300', storeId: f.storeId, credit: amount },
      ],
    });
    return (r as any).entryId as string;
  });
}

/** Reverse through the real writer. Returns the reversal's id. */
function reverse(f: Fixture, entryId: string): Promise<string> {
  return asOrg(f.orgId, async (tx) => {
    const r = await reverseEntry(tx, { entryId, reason: 'Wrong party', reversalDate: '2026-01-12', reversedBy: f.adminId });
    return r.reversalEntryId;
  });
}

/** A -> R1 -> ... -> Rn. Returns every id, root first. */
async function chain(f: Fixture, amount: string, hops: number): Promise<string[]> {
  const ids = [await badLine(f, amount)];
  for (let i = 0; i < hops; i++) ids.push(await reverse(f, ids[ids.length - 1]!));
  return ids;
}

const unmatched = async (f: Fixture) =>
  (await asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }))).findings.filter((x) => x.kind === UNMATCHED);

/** Control: the chain really has the shape the rule reads (each points at the previous; only the tail is live). */
async function expectShape(ids: string[]) {
  const rows = await sql<{ id: string; status: string; reversal_of_entry_id: string | null }[]>`
    select id, status, reversal_of_entry_id from journal_entries where id in ${sql(ids)}`;
  const by = new Map(rows.map((r) => [r.id, r]));
  ids.forEach((id, i) => {
    expect(by.get(id)!.reversal_of_entry_id, `entry ${i} points at ${i - 1}`).toBe(i === 0 ? null : ids[i - 1]);
    expect(by.get(id)!.status, `entry ${i} status`).toBe(i === ids.length - 1 ? 'posted' : 'reversed');
  });
}

describe('T1 — pin: A alone', () => {
  it('one finding, count 1, the amount of A', async () => {
    const f = await fixture('t1');
    const ids = await chain(f, '100.00', 0);
    await expectShape(ids);
    const found = await unmatched(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/\b1 due-from\/due-to line/);
    expect(found[0]!.detail).toContain('₱100.00');
  });
});

describe('T2 — pin: A -> R1 cancels', () => {
  it('no finding (control: A alone fired first)', async () => {
    const f = await fixture('t2');
    const a = await badLine(f, '100.00');
    expect(await unmatched(f), 'control: the bad line fires before it is reversed').toHaveLength(1);
    const r1 = await reverse(f, a);
    await expectShape([a, r1]);
    expect(await unmatched(f)).toEqual([]);
  });
});

describe('T3 — the defect: A -> R1 -> R2 re-states A, so it is a finding', () => {
  it('one finding, count 1, the amount of A (RED on HEAD: R2 is hidden because its original R1 is reversed)', async () => {
    const f = await fixture('t3');
    const a = await badLine(f, '100.00');
    expect(await unmatched(f), 'control: the bad line fires').toHaveLength(1);
    const r1 = await reverse(f, a);
    expect(await unmatched(f), 'control: A + R1 cancel').toEqual([]);
    const r2 = await reverse(f, r1);
    await expectShape([a, r1, r2]);
    const found = await unmatched(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/\b1 due-from\/due-to line/);
    expect(found[0]!.detail).toContain('₱100.00');
  });
});

describe('T4 — the chain of four nets to zero', () => {
  it('A -> R1 -> R2 -> R3: no finding (kills the register rule, which counts R3)', async () => {
    const f = await fixture('t4');
    const ids = await chain(f, '100.00', 2);
    expect(await unmatched(f), 'control: A,R1,R2 fires (green only once T3 is fixed)').toHaveLength(1);
    const r3 = await reverse(f, ids[2]!);
    ids.push(r3);
    await expectShape(ids);
    expect(await unmatched(f)).toEqual([]);
  });
});

describe('T5 — mixed: a cancelled pair beside a live chain', () => {
  it('cancelled A->R1 (40.00) plus live A2->R1b->R2b (100.00) -> count 1 (only R2b), not 2', async () => {
    const f = await fixture('t5');
    await chain(f, '40.00', 1);
    expect(await unmatched(f), 'control: the cancelled pair alone is silent').toEqual([]);
    await chain(f, '100.00', 2);
    const found = await unmatched(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/\b1 due-from\/due-to line/);
    expect(found[0]!.detail).toContain('₱100.00');
    expect(found[0]!.detail).not.toContain('₱140.00');
  });
});

describe('T6 — a draft reversal is ignored', () => {
  it('a draft entry pointing at A changes nothing: A still fires once; the draft adds no line', async () => {
    const f = await fixture('t6');
    const a = await badLine(f, '100.00');
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
    const ids = await sql<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1250', '3300')`;
    const by = new Map(ids.map((r) => [r.code, r.id]));
    await sql.begin(async (t) => {
      const [row] = await t<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, reversal_of_entry_id)
        values (${f.orgId}, '2026-01-12', ${period!.id}, 'manual_journal', ${uid('draftrev')}, 'draft', ${a}) returning id`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
              values (${row!.id}, 1, ${by.get('1250')!}, ${f.storeId}, 0, 100, 'store', 'NO-SUCH-STORE')`;
      await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
              values (${row!.id}, 2, ${by.get('3300')!}, ${f.storeId}, 100, 0)`;
    });
    const [d] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId} and status = 'draft' and reversal_of_entry_id = ${a}`;
    expect(d!.n, 'control: the draft reversal exists').toBe('1');
    const found = await unmatched(f);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/\b1 due-from\/due-to line/);
    expect(found[0]!.detail).toContain('₱100.00');
  });
});
