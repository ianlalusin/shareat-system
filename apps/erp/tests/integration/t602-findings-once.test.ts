/**
 * T-602 S2 - `findingsFor` (apps/erp/src/app/findings/lib.ts) computes the ~45 detectors ONCE per load: the feed is built by `listFindings` and the
 * close verdict is `readinessOf(feed)`, not a second `closeReadiness` call (which would run `listFindings` again).
 *
 * Real Postgres. `@shareat/domain` is mocked with pass-through `vi.fn` wrappers so the calls can be counted; nothing is stubbed.
 * MUTANT (run by hand, recorded in the commit): put `await closeReadiness(tx, orgId, period)` back in `findingsFor` -> the first test goes red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);

vi.mock('@shareat/domain', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shareat/domain')>();
  return { ...real, listFindings: vi.fn(real.listFindings), closeReadiness: vi.fn(real.closeReadiness) };
});

import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { closeReadiness, listFindings } from '@shareat/domain';
import { sql as dsql } from 'drizzle-orm';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { postEntry } from '../../../../packages/domain/src/ledger/post-entry';
import { findingsFor } from '../../src/app/findings/lib';

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const PERIOD = '2026-01';
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const asOrg = <T,>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });

/** An org whose books carry one HARD finding: a due-from with no matching due-to (the same recipe as findings.test.ts). */
async function worldWithOneHardFinding() {
  const code = uid('t602f');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Store', '2020-01-01') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const key = uid('k');
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-10', sourceType: 'manual_journal', sourceId: key, idempotencyKey: key, memo: 'fixture', postedBy: p!.id,
      lines: [
        { accountCode: '1250', storeId: store!.id, debit: '500.00', partyType: 'store', partyId: 'STORE-X' },
        { accountCode: '1110', storeId: store!.id, credit: '500.00' },
      ],
    }),
  );
  return { orgId };
}

beforeEach(() => {
  vi.mocked(listFindings).mockClear();
  vi.mocked(closeReadiness).mockClear();
});

describe('T-602 S2 - the findings feed is computed once per load', () => {
  it('findingsFor runs listFindings once and closeReadiness never; readiness equals a separate closeReadiness', async () => {
    const w = await worldWithOneHardFinding();
    const out = await findingsFor(w.orgId, PERIOD);
    expect(vi.mocked(listFindings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeReadiness)).toHaveBeenCalledTimes(0);
    expect(out.readiness!.ready).toBe(false);
    expect(out.readiness!.blocking.length).toBeGreaterThan(0);
    const separate = await asOrg(w.orgId, (tx) => closeReadiness(tx, w.orgId, PERIOD));
    expect(out.readiness).toEqual(separate);
  });

  it('a store-limited viewer still gets no readiness and one feed computation', async () => {
    const w = await worldWithOneHardFinding();
    const out = await findingsFor(w.orgId, PERIOD, []);
    expect(out.readiness).toBeNull();
    expect(vi.mocked(listFindings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeReadiness)).toHaveBeenCalledTimes(0);
  });
});
