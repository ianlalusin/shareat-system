import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-615 item 2 — the journal-lines drill-down totals in SQL, then caps the rows it draws.
 * The oracle is the uncapped row list: the totals must equal its sum for any filter.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — name must contain "_test".`);
}

import { closeDb, reportsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 2 });
const uid = (p: string) => `${p}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const N = 505;

/** N posted entries on account 9001 (debit 1.10 + i/100, credit side 9002), plus one year-close entry. One tx: the balance check is deferred to COMMIT. */
async function fixture() {
  const code = uid('drill');
  return sql.begin(async (tx) => {
    const [org] = await tx<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    const [jan] = await tx<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
    const [dec] = await tx<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-12-01', '2026-12-31', 'open') returning id`;
    const mk = async (c: string, type: string) =>
      (await tx<{ id: string }[]>`
        insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
        values (${orgId}, ${c}, ${`Probe ${c}`}, ${type}, 'debit', true, true, 'active') returning id`)[0]!.id;
    const a = await mk('9001', 'expense');
    const b = await mk('9002', 'asset');
    const entries = Array.from({ length: N + 1 }, (_, i) => ({
      org_id: orgId, period_id: (i < N ? jan : dec)!.id, entry_date: i < N ? `2026-01-${String((i % 28) + 1).padStart(2, '0')}` : '2026-12-31',
      source_type: i < N ? 'manual_journal' : 'year_close', source_id: uid('src'), idempotency_key: uid('idem'), memo: 'drill probe', status: 'draft',
    }));
    const ids = await tx<{ id: string }[]>`insert into journal_entries ${tx(entries)} returning id`;
    const lines = ids.flatMap((e, i) => {
      const amt = (1.1 + i / 100).toFixed(2);
      return [
        { entry_id: e.id, account_id: a, line_no: 1, debit: amt, credit: '0' },
        { entry_id: e.id, account_id: b, line_no: 2, debit: '0', credit: amt },
      ];
    });
    await tx`insert into journal_lines ${tx(lines)}`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where org_id = ${orgId}`;
    return { orgId, accountId: a };
  });
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-615 getAccountDrill: totals over the whole filter, rows capped at 500', () => {
  it('more than 500 lines: 500 rows, count = all, and the totals equal the uncapped sum — for several filters', async () => {
    const f = await fixture();
    const filters = [
      { orgId: f.orgId, accountId: f.accountId, fromDate: '2026-01-01', toDate: '2026-12-31' },
      { orgId: f.orgId, accountId: f.accountId, fromDate: '2026-01-01', toDate: '2026-12-31', includeYearClose: false },
      { orgId: f.orgId, accountId: f.accountId, fromDate: '2026-01-05', toDate: '2026-01-20' },
    ];
    for (const filter of filters) {
      const all = await asOrg(f.orgId, (tx) => reportsRepo.getAccountEntries(tx, filter));
      const drill = await asOrg(f.orgId, (tx) => reportsRepo.getAccountDrill(tx, filter));
      const cents = (xs: string[]) => xs.reduce((s, x) => s + Math.round(Number(x) * 100), 0);
      expect(drill.count).toBe(all.length);
      expect(drill.rows).toHaveLength(Math.min(500, all.length));
      expect(drill.rows.map((r) => r.entryId + r.entryDate)).toEqual(all.slice(0, 500).map((r) => r.entryId + r.entryDate));
      expect(Math.round(Number(drill.debit) * 100)).toBe(cents(all.map((r) => r.debit)));
      expect(Math.round(Number(drill.credit) * 100)).toBe(cents(all.map((r) => r.credit)));
    }
    const full = await asOrg(f.orgId, (tx) => reportsRepo.getAccountDrill(tx, filters[0]!));
    expect(full.count).toBe(N + 1);
    expect(full.rows).toHaveLength(500);
    const noClose = await asOrg(f.orgId, (tx) => reportsRepo.getAccountDrill(tx, filters[1]!));
    expect(noClose.count).toBe(N);
  });
});
