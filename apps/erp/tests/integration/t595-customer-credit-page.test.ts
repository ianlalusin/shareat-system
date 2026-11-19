import { afterAll, describe, expect, it, vi } from 'vitest';
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';

/**
 * T-595 S4 (DEF-880, ruled B) - the collection form's store credit figure is what ONE store can spend, not the sum over the viewer's stores.
 * `spendableCreditAt(actor, customerId, storeId)` (customers/lib.ts): 500.00 at the store that earned it, 0.00 at the other, 0.00 for a store the
 * viewer does not hold. Mutant: hand the form the viewer's-stores total -> the Malvar figure reads 500.00 and the test is red.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import type { Actor } from '@shareat/auth';
import { createCustomer, postEntry } from '@shareat/domain';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function world() {
  const code = uid('t595web');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (label: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`)[0]!.id;
  const lipaId = await mkStore('lipa');
  const malvarId = await mkStore('malvar');
  const mkPerson = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { personId: p!.id, orgId } as Actor;
  };
  const both = await mkPerson('Admin both', 'admin', [lipaId, malvarId]);
  const lipaOnly = await mkPerson('Admin Lipa', 'admin', [lipaId]);
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, both, { name: `Resto ${code}` }));
  // 500.00 of store credit EARNED at Lipa (an overpayment's own entry: Dr cash / Cr 2140).
  await asOrg(orgId, (tx) =>
    postEntry(tx, {
      orgId, entryDate: '2026-01-10', sourceType: 'manual_journal', sourceId: uid('credit'), idempotencyKey: uid('credit'), memo: 'credit earned at Lipa', postedBy: both.personId,
      lines: [
        { accountCode: '1110', storeId: lipaId, debit: '500.00' },
        { accountCode: '2140', storeId: lipaId, credit: '500.00', partyType: 'customer', partyId: customer.id },
      ],
    }),
  );
  return { orgId, lipaId, malvarId, both, lipaOnly, customerId: customer.id };
}

const lib = () => import('../../src/app/customers/lib');

describe('T-595 S4 - the collection form offers only the credit the chosen store can spend', () => {
  it('an admin holding both stores: 500.00 at Lipa (earned there), 0.00 at Malvar [kills: handing the form the viewer\'s-stores total]', async () => {
    const w = await world();
    const { spendableCreditAt, creditBalance } = await lib();
    expect(await creditBalance(w.both, w.customerId)).toBe('500.00'); // the header total is unchanged
    expect(await spendableCreditAt(w.both, w.customerId, w.lipaId)).toBe('500.00');
    expect(await spendableCreditAt(w.both, w.customerId, w.malvarId)).toBe('0.00');
  });

  it('a store the viewer does not hold is 0.00, even where the credit sits', async () => {
    const w = await world();
    const { spendableCreditAt } = await lib();
    expect(await spendableCreditAt(w.lipaOnly, w.customerId, w.malvarId)).toBe('0.00');
    expect(await spendableCreditAt(w.lipaOnly, w.customerId, w.lipaId)).toBe('500.00');
  });
});
