import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-171 / DEF-129 — the commissary catalogue's writers: links, offerings and the cross-store item
 * map. Before this pass `commissary_item_map` had NO writer anywhere in application code —
 * grepped, exactly two INSERTs existed in the whole tree and both were test fixtures — so a real
 * internal branch↔commissary receipt was guaranteed to throw
 * (`packages/domain/src/trade/index.ts`'s `receiveTradeOrder` names this table by hand). These
 * tests exercise the admin surface that fixes it: `packages/domain/src/commissary/catalogue.ts`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, commissaryRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createItem, removeMap, upsertCommissaryLink, upsertMap, upsertOffering } from '@shareat/domain';

const sql = postgres(url, { max: 3 });
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

beforeEach(async () => {
  await sql`
    truncate table commissary_item_map, commissary_item_offerings, commissary_links,
      customers, expense_categories, person_store_scope, person_roles,
      items, persons, stores, organizations restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture() {
  const code = uid('org');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
    return s!.id;
  };
  const commissaryId = await mkStore('com');
  const branchId = await mkStore('br');
  const otherBranchId = await mkStore('br2');

  // ⭐ Deliberately NOT trade.test.ts's fixture shape — that one scopes every person to BOTH
  // stores, which is exactly wrong here: tests 3/4 need actors scoped to only ONE side of the
  // pair, so a store-scope refusal can be told apart from a role refusal.
  const mkPerson = async (name: string, role: string, storeIds: string[]) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const storeId of storeIds) {
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    }
    return p!.id;
  };

  // T-148 made adding an item super-admin only.
  const superAdminId = await mkPerson('Super', 'super_admin', [commissaryId, branchId, otherBranchId]);
  const comManagerId = await mkPerson('Commissary Manager', 'manager', [commissaryId]);
  const comStaffId = await mkPerson('Commissary Staff', 'staff', [commissaryId]);
  const brManagerId = await mkPerson('Branch Manager', 'manager', [branchId]);
  const brStaffId = await mkPerson('Branch Staff', 'staff', [branchId]);

  const actor = (personId: string): Actor => ({ personId, orgId });

  return {
    orgId,
    commissaryId,
    branchId,
    otherBranchId,
    superAdmin: actor(superAdminId),
    comManager: actor(comManagerId),
    comStaff: actor(comStaffId),
    brManager: actor(brManagerId),
    brStaff: actor(brStaffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mkItem(
  f: Fixture,
  name: string,
  opts: { baseUnit?: 'kg' | 'pcs'; isPurchasable?: boolean } = {},
): Promise<string> {
  const item = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, {
      code: uid('IT'),
      name: `${name} ${uid('n')}`,
      kind: 'raw_material',
      baseUnit: opts.baseUnit ?? 'kg',
      isPurchasable: opts.isPurchasable ?? true,
    }),
  );
  return item.id;
}

/** Establishes an active link, commissary → branch, as a correctly-scoped commissary manager. */
async function link(f: Fixture, by: Actor = f.comManager): Promise<void> {
  await asOrg(f.orgId, (tx) =>
    upsertCommissaryLink(tx, by, { commissaryStoreId: f.commissaryId, branchStoreId: f.branchId }),
  );
}

async function expenseCategory(f: Fixture): Promise<string> {
  const [c] = await sql<{ id: string }[]>`
    insert into expense_categories (org_id, "group", category, account_code)
    values (${f.orgId}, 'COGS', ${uid('Cat')}, '5110') returning id`;
  return c!.id;
}

describe('T-171 / DEF-129 — commissary_links', () => {
  it('a self-link is refused', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) =>
        upsertCommissaryLink(tx, f.comManager, { commissaryStoreId: f.commissaryId, branchStoreId: f.commissaryId }),
      ),
    ).rejects.toThrow(/itself/);
  });

  it('⭐ upserting a link creates the internal customer once and reuses it the second time', async () => {
    const f = await fixture();
    const first = await asOrg(f.orgId, (tx) =>
      upsertCommissaryLink(tx, f.comManager, { commissaryStoreId: f.commissaryId, branchStoreId: f.branchId }),
    );
    expect(first.customerCreated).toBe(true);

    const second = await asOrg(f.orgId, (tx) =>
      upsertCommissaryLink(tx, f.comManager, { commissaryStoreId: f.commissaryId, branchStoreId: f.branchId }),
    );
    expect(second.customerCreated).toBe(false);
    expect(second.customerId).toBe(first.customerId);
    // ⭐ The link itself is idempotent too — re-linking the same pair updates the one row.
    expect(second.linkId).toBe(first.linkId);

    const [n] = await sql<{ c: string }[]>`
      select count(*)::text c from customers where counterparty_store_id = ${f.branchId}`;
    expect(n!.c).toBe('1');
  });
});

describe('T-171 / DEF-129 — store scope and role gates', () => {
  it("a branch-scoped manager cannot edit the commissary's offerings", async () => {
    const f = await fixture();
    const itemId = await mkItem(f, 'Pork');
    await expect(
      asOrg(f.orgId, (tx) => upsertOffering(tx, f.brManager, { commissaryStoreId: f.commissaryId, itemId })),
    ).rejects.toThrow(/may not|no store scope/);
  });

  it("a commissary-scoped manager cannot edit the branch's map", async () => {
    const f = await fixture();
    await link(f);
    const commItem = await mkItem(f, 'Pork');
    const branchItem = await mkItem(f, 'Pork (branch)');
    await expect(
      asOrg(f.orgId, (tx) =>
        upsertMap(tx, f.comManager, {
          commissaryStoreId: f.commissaryId,
          branchStoreId: f.branchId,
          commissaryItemId: commItem,
          branchItemId: branchItem,
        }),
      ),
    ).rejects.toThrow(/may not|no store scope/);
  });

  it('staff is refused manage_commissary_offerings', async () => {
    const f = await fixture();
    const itemId = await mkItem(f, 'Pork');
    await expect(
      asOrg(f.orgId, (tx) => upsertOffering(tx, f.comStaff, { commissaryStoreId: f.commissaryId, itemId })),
    ).rejects.toThrow(/may not/);
  });

  it('staff is refused manage_commissary_map', async () => {
    const f = await fixture();
    await link(f);
    const commItem = await mkItem(f, 'Pork');
    const branchItem = await mkItem(f, 'Pork (branch)');
    await expect(
      asOrg(f.orgId, (tx) =>
        upsertMap(tx, f.brStaff, {
          commissaryStoreId: f.commissaryId,
          branchStoreId: f.branchId,
          commissaryItemId: commItem,
          branchItemId: branchItem,
        }),
      ),
    ).rejects.toThrow(/may not/);
  });
});

describe('T-171 / DEF-129 — commissary_item_offerings', () => {
  it('⛔ an offering for a non-purchasable item is refused', async () => {
    const f = await fixture();
    const itemId = await mkItem(f, 'Cooked bento', { isPurchasable: false });
    await expect(
      asOrg(f.orgId, (tx) => upsertOffering(tx, f.comManager, { commissaryStoreId: f.commissaryId, itemId })),
    ).rejects.toThrow(/purchasable/);
  });
});

describe('T-171 / DEF-129 — commissary_item_map', () => {
  it('⛔ a map for an unlinked pair is refused', async () => {
    const f = await fixture();
    const commItem = await mkItem(f, 'Pork');
    const branchItem = await mkItem(f, 'Pork (branch)');
    await expect(
      asOrg(f.orgId, (tx) =>
        upsertMap(tx, f.brManager, {
          commissaryStoreId: f.commissaryId,
          branchStoreId: f.branchId,
          commissaryItemId: commItem,
          branchItemId: branchItem,
        }),
      ),
    ).rejects.toThrow(/no active link/);
  });

  it('⛔ a map with mismatched base units is refused, and NOT written', async () => {
    const f = await fixture();
    await link(f);
    const commItem = await mkItem(f, 'Pork', { baseUnit: 'kg' });
    const branchItem = await mkItem(f, 'Pork (branch)', { baseUnit: 'pcs' });

    await expect(
      asOrg(f.orgId, (tx) =>
        upsertMap(tx, f.brManager, {
          commissaryStoreId: f.commissaryId,
          branchStoreId: f.branchId,
          commissaryItemId: commItem,
          branchItemId: branchItem,
        }),
      ),
    ).rejects.toThrow(/base unit/);

    const row = await asOrg(f.orgId, (tx) => commissaryRepo.mapItem(tx, f.commissaryId, f.branchId, commItem));
    expect(row).toBeUndefined();
  });

  it('⭐ upsertMap twice updates rather than duplicates, and mapItem reads back the latest', async () => {
    const f = await fixture();
    await link(f);
    const commItem = await mkItem(f, 'Pork', { baseUnit: 'kg' });
    const branchItem1 = await mkItem(f, 'Pork (branch 1)', { baseUnit: 'kg' });
    const branchItem2 = await mkItem(f, 'Pork (branch 2)', { baseUnit: 'kg' });
    const categoryId = await expenseCategory(f);

    const first = await asOrg(f.orgId, (tx) =>
      upsertMap(tx, f.brManager, {
        commissaryStoreId: f.commissaryId,
        branchStoreId: f.branchId,
        commissaryItemId: commItem,
        branchItemId: branchItem1,
      }),
    );

    const second = await asOrg(f.orgId, (tx) =>
      upsertMap(tx, f.brManager, {
        commissaryStoreId: f.commissaryId,
        branchStoreId: f.branchId,
        commissaryItemId: commItem,
        branchItemId: branchItem2,
        isLedgerOnly: true,
        expenseCategoryId: categoryId,
      }),
    );
    expect(second.id).toBe(first.id);

    const row = await asOrg(f.orgId, (tx) => commissaryRepo.mapItem(tx, f.commissaryId, f.branchId, commItem));
    expect(row?.branchItemId).toBe(branchItem2);
    expect(row?.isLedgerOnly).toBe(true);
    expect(row?.expenseCategoryId).toBe(categoryId);

    const [n] = await sql<{ c: string }[]>`select count(*)::text c from commissary_item_map`;
    expect(n!.c).toBe('1');
  });

  it('removeMap deletes it', async () => {
    const f = await fixture();
    await link(f);
    const commItem = await mkItem(f, 'Pork', { baseUnit: 'kg' });
    const branchItem = await mkItem(f, 'Pork (branch)', { baseUnit: 'kg' });
    const { id } = await asOrg(f.orgId, (tx) =>
      upsertMap(tx, f.brManager, {
        commissaryStoreId: f.commissaryId,
        branchStoreId: f.branchId,
        commissaryItemId: commItem,
        branchItemId: branchItem,
      }),
    );

    const result = await asOrg(f.orgId, (tx) => removeMap(tx, f.brManager, { id }));
    expect(result.removed).toBe(true);

    const row = await asOrg(f.orgId, (tx) => commissaryRepo.mapItem(tx, f.commissaryId, f.branchId, commItem));
    expect(row).toBeUndefined();
  });
});

describe('T-343 S5.3 — upsertCommissaryLink refuses a store supplying itself, in human terms', () => {
  it('userMessage is the plain rule-4 sentence, never the raw function-name prefix', async () => {
    const f = await fixture();
    const caught = await asOrg(f.orgId, (tx) =>
      upsertCommissaryLink(tx, f.comManager, { commissaryStoreId: f.commissaryId, branchStoreId: f.commissaryId }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(caught, 'the self-supply link was not refused at all').not.toBeNull();
    expect(caught!.message).toMatch(/^upsertCommissaryLink:/);
    const userMessage = (caught as { userMessage?: string }).userMessage;
    expect(userMessage, 'must carry a userMessage').toBeDefined();
    expect(userMessage).not.toMatch(/^upsertCommissaryLink:/);
    expect(userMessage).toBe(
      'A store cannot supply itself — the commissary and the branch must be two different stores.',
    );
  }, 30000);
});
