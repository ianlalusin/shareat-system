import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-454 S4 / T13 (TESTER) - a store that is INACTIVE and has no rows is never demanded by the cutover.
 * docs/tasks/454-drop-banay-banay.md section 4 S4 last bullet, section 6 T13. Real PostgreSQL.
 *
 * (a) openingTieOut with an inactive, empty store: passes and never names it.      GREEN-AS-GUARD (measured: it already does).
 * (b) the cutover wizard's store list (apps/erp/src/app/cutover/lib.ts `listStores`, which re-exports expenses/lib `listStores`)
 *     leaves the inactive store out, so cutoverProgress(tx, org, ids) is never asked for per-store steps of it.
 *     RED today: that query is `where org_id = ...` with no is_active filter (apps/erp/src/app/expenses/lib.ts:66-73), and
 *     apps/erp/src/app/cutover/page.tsx:26-31 feeds every returned id to cutoverProgress.
 *     Mutant killed: inactive store demanded (no is_active filter on the wizard's store list).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { cutoverProgress, openingTieOut } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
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

let orgId = '';
let activeId = '';
let inactiveId = '';
const INACTIVE_NAME = 'Zzz Closed Store T454';

beforeAll(async () => {
  const code = uid('t454');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('a')}, 'Active Store T454') returning id`;
  activeId = a!.id;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, is_active) values (${orgId}, ${uid('b')}, ${INACTIVE_NAME}, false) returning id`;
  inactiveId = b!.id;
}, 300_000);
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-454 T13a the tie-out does not demand anything of an inactive, empty store', () => {
  it('holds, and no line names the inactive store', async () => {
    const t = await asOrg(orgId, (tx) => openingTieOut(tx, orgId));
    const everything = JSON.stringify(t);
    expect(everything).not.toContain(INACTIVE_NAME);
    expect(everything).not.toContain(inactiveId);
  });
});

describe('T-454 T13b the cutover wizard asks about active stores only', () => {
  it('its store list holds the active store and not the inactive one', async () => {
    // Imported lazily: the module pulls the ERP app's server helpers.
    const lib = await import('../../src/app/cutover/lib');
    const ids = (await lib.listStores(orgId)).map((s) => s.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(inactiveId);
  });
  it('cutoverProgress over that list has no per-store step for the inactive store', async () => {
    const lib = await import('../../src/app/cutover/lib');
    const ids = (await lib.listStores(orgId)).map((s) => s.id);
    const p = await asOrg(orgId, (tx) => cutoverProgress(tx, orgId, ids));
    const mine = (p.steps as unknown as Array<{ storeId?: string | null }>).filter((s) => s.storeId === inactiveId);
    expect(mine).toEqual([]);
  });
});
