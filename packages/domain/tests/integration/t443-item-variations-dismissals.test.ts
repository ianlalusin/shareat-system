import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-443 - `docs/tasks/443-item-variations-dismiss-guards.md` R1-R5. Real Postgres, real `authorize()`, as APP_ROLE under an org
 * principal. Runs on any `*_test` database: nothing here names a lane database.
 *
 * Every allowed path has its refused twin: a non-super-admin is refused for set-variant, dismiss and undo (approve_item), and each
 * database rule is proven with a RAW UPDATE/INSERT that bypasses the domain (the trigger / index fires on its own).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, itemsRepo, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  approveItemRequest,
  createItem,
  dismissDuplicatePair,
  mergeItems,
  normaliseItemName,
  rejectItemRequest,
  renameItem,
  requestItem,
  setItemStatus,
  setItemVariantOf,
  undoDuplicateDismissal,
} from '@shareat/domain';

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t443-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const superId = await mk('Super', 'super_admin');
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  return {
    orgId,
    superAdmin: actor(orgId, superId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

type Kind = 'raw_material' | 'supply' | 'retail' | 'meat_slab' | 'meat_sliced';
async function mkItem(f: Fixture, name: string, kind: Kind = 'raw_material', baseUnit: 'kg' | 'pcs' = 'kg'): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { name, kind, baseUnit }));
  return id;
}
const setVariant = (f: Fixture, who: Actor, itemId: string, parentId: string | null) =>
  asOrg(f.orgId, (tx) => setItemVariantOf(tx, who, { itemId, parentId }));
const variantOf = async (id: string) =>
  (await sql<{ variant_of_item_id: string | null }[]>`select variant_of_item_id from items where id = ${id}`)[0]!.variant_of_item_id;

/** The Postgres error's constraint name, found anywhere on the cause chain. */
function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint;
    if (c) return c;
  }
  return undefined;
}
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}
/** The sentence a person would see for a domain refusal. */
async function sentence(p: Promise<unknown>): Promise<string> {
  const err = await failure(p);
  expect(err).toBeInstanceOf(RefusalError);
  return (err as RefusalError).userMessage;
}
/** A raw statement through the owner connection: the database rule fires with no domain in front of it. */
async function rawRefusal(statement: Promise<unknown>): Promise<string | undefined> {
  return constraintOf(await failure(statement));
}

const pairs = (f: Fixture) => asOrg(f.orgId, (tx) => itemsRepo.findDuplicateCandidates(tx, f.orgId));
const names = (c: { aName: string; bName: string }) => [c.aName, c.bName].sort().join(' | ');

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('R1 - variations', () => {
  it('sets and clears a variation; a request carries its parent to the item and the approver may change or clear it', async () => {
    const f = await fixture('r1a');
    const kimchi = await mkItem(f, 'Kimchi');
    const k250 = await mkItem(f, 'Kimchi 250g');
    expect(await setVariant(f, f.superAdmin, k250, kimchi)).toEqual({ changed: true });
    expect(await variantOf(k250)).toBe(kimchi);
    expect(await setVariant(f, f.superAdmin, k250, kimchi)).toEqual({ changed: false });
    expect(await setVariant(f, f.superAdmin, k250, null)).toEqual({ changed: true });
    expect(await variantOf(k250)).toBeNull();

    // Request with a parent: copied at approval.
    const r1 = await asOrg(f.orgId, (tx) => requestItem(tx, f.manager, { name: 'Kimchi 500g', kind: 'raw_material', baseUnit: 'kg', variantOfItemId: kimchi }));
    const a1 = await asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId: r1.requestId }));
    expect(await variantOf(a1.itemId)).toBe(kimchi);

    // The approver clears it (null) ...
    const r2 = await asOrg(f.orgId, (tx) => requestItem(tx, f.manager, { name: 'Kimchi 1kg', kind: 'raw_material', baseUnit: 'kg', variantOfItemId: kimchi }));
    const a2 = await asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId: r2.requestId, variantOfItemId: null }));
    expect(await variantOf(a2.itemId)).toBeNull();

    // ... or sets one the requester left blank.
    const r3 = await asOrg(f.orgId, (tx) => requestItem(tx, f.manager, { name: 'Kimchi 10kg', kind: 'raw_material', baseUnit: 'kg' }));
    const a3 = await asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId: r3.requestId, variantOfItemId: kimchi }));
    expect(await variantOf(a3.itemId)).toBe(kimchi);
  }, 30_000);

  it.each(['admin', 'manager'] as const)('%s is refused for set-variant (approve_item is super-admin alone); the row is unchanged', async (who) => {
    const f = await fixture(`r1b${who}`);
    const kimchi = await mkItem(f, 'Kimchi');
    const k250 = await mkItem(f, 'Kimchi 250g');
    expect(await failure(setVariant(f, f[who], k250, kimchi))).toBeInstanceOf(AuthorizationError);
    expect(await variantOf(k250)).toBeNull();
  }, 30_000);

  it('the domain refuses in plain words: itself, two levels, parent with variations, merged parent, kind mismatch', async () => {
    const f = await fixture('r1c');
    const kimchi = await mkItem(f, 'Kimchi');
    const k250 = await mkItem(f, 'Kimchi 250g');
    await setVariant(f, f.superAdmin, k250, kimchi);

    expect(await sentence(setVariant(f, f.superAdmin, kimchi, kimchi))).toMatch(/cannot be a variation of itself/);

    const sauce = await mkItem(f, 'Kimchi sauce');
    expect(await sentence(setVariant(f, f.superAdmin, sauce, k250))).toMatch(/one level only/);

    expect(await sentence(setVariant(f, f.superAdmin, kimchi, sauce))).toMatch(/already has variations of its own/);

    const retail = await mkItem(f, 'Kimchi gift jar', 'retail');
    expect(await sentence(setVariant(f, f.superAdmin, retail, kimchi))).toMatch(/same kind as "Kimchi"/);

    // merged parent: merge `old` into `sauce` (no variations), then try to hang an item under `old`.
    const old = await mkItem(f, 'Kimchi old');
    await asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: old, winnerId: sauce }));
    const other = await mkItem(f, 'Kimchi other');
    expect(await sentence(setVariant(f, f.superAdmin, other, old))).toMatch(/was merged into another item/);

    // a request naming a parent of another kind is refused at request time, with the same words
    expect(
      await sentence(asOrg(f.orgId, (tx) => requestItem(tx, f.manager, { name: 'Kimchi mug', kind: 'retail', baseUnit: 'pcs', variantOfItemId: kimchi }))),
    ).toMatch(/same kind as "Kimchi"/);
  }, 30_000);

  it('the DATABASE trigger refuses the same five shapes on a raw UPDATE, and an INSERT, with no domain in front', async () => {
    const f = await fixture('r1d');
    const kimchi = await mkItem(f, 'Kimchi');
    const k250 = await mkItem(f, 'Kimchi 250g');
    await setVariant(f, f.superAdmin, k250, kimchi);
    const sauce = await mkItem(f, 'Kimchi sauce');
    const retail = await mkItem(f, 'Kimchi gift jar', 'retail');

    // itself (the CHECK)
    expect(await rawRefusal(sql`update items set variant_of_item_id = id where id = ${sauce}`)).toBe('items_variant_not_self_check');
    // two levels: a child of a variation
    expect(await rawRefusal(sql`update items set variant_of_item_id = ${k250} where id = ${sauce}`)).toBe('items_variant_guard');
    // an item that has variations becomes a variation
    expect(await rawRefusal(sql`update items set variant_of_item_id = ${sauce} where id = ${kimchi}`)).toBe('items_variant_guard');
    // kind mismatch
    expect(await rawRefusal(sql`update items set variant_of_item_id = ${kimchi} where id = ${retail}`)).toBe('items_variant_guard');
    // a parent cannot change kind while it has variations
    expect(await rawRefusal(sql`update items set kind = 'supply' where id = ${kimchi}`)).toBe('items_variant_guard');
    // a parent cannot be merged while it has variations
    expect(await rawRefusal(sql`update items set status = 'merged', merged_into_id = ${sauce} where id = ${kimchi}`)).toBe('items_variant_guard');
    // merged parent: merge a childless item away, then hang something under it
    const gone = await mkItem(f, 'Kimchi gone');
    await sql`update items set status = 'merged', merged_into_id = ${sauce} where id = ${gone}`;
    expect(await rawRefusal(sql`update items set variant_of_item_id = ${gone} where id = ${sauce}`)).toBe('items_variant_guard');
    // INSERT with a variation as parent
    expect(
      await rawRefusal(sql`
        insert into items (org_id, code, name, kind, base_unit, created_by, variant_of_item_id)
        select org_id, 'ZZZZ-001', 'Raw insert child', 'raw_material', 'kg', created_by, ${k250} from items where id = ${kimchi}`),
    ).toBe('items_variant_guard');
    // control: the legal shape still works raw
    await sql`update items set variant_of_item_id = ${kimchi} where id = ${sauce}`;
    expect(await variantOf(sauce)).toBe(kimchi);
    // cross-org parent is refused by the same-org FK (an item of another org)
    const g = await fixture('r1d2');
    const foreign = await mkItem(g, 'Foreign parent');
    expect(await rawRefusal(sql`update items set variant_of_item_id = ${foreign} where id = ${sauce}`)).toBe('items_variant_of_same_org_fk');
  }, 30_000);

  it('merge: refuses a LOSER that has variations; a variation itself may be merged and the winner keeps its own parent', async () => {
    const f = await fixture('r1e');
    const kimchi = await mkItem(f, 'Kimchi');
    const k250 = await mkItem(f, 'Kimchi 250g');
    const winner = await mkItem(f, 'Kimchee');
    await setVariant(f, f.superAdmin, k250, kimchi);
    expect(await sentence(asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: kimchi, winnerId: winner })))).toMatch(/has variations/);
    expect((await sql`select status from items where id = ${kimchi}`)[0]!.status).toBe('active');

    await asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: k250, winnerId: winner }));
    expect((await sql`select status from items where id = ${k250}`)[0]!.status).toBe('merged');
    expect(await variantOf(winner)).toBeNull(); // the winner keeps ITS parent (none), it does not inherit the loser's
  }, 30_000);
});

describe('R2 - "not a duplicate" dismissals', () => {
  it('a dismissed pair leaves the panel; dismissing twice (either order) is one row; undo brings it back', async () => {
    const f = await fixture('r2a');
    const a = await mkItem(f, 'Samyang Cheese');
    const b = await mkItem(f, 'Samyang 4 Cheese');
    expect((await pairs(f)).map(names)).toContain('Samyang 4 Cheese | Samyang Cheese'); // control: it is listed first

    const first = await asOrg(f.orgId, (tx) => dismissDuplicatePair(tx, f.superAdmin, { itemAId: a, itemBId: b, note: 'different products' }));
    expect(first.created).toBe(true);
    expect((await pairs(f)).map(names)).not.toContain('Samyang 4 Cheese | Samyang Cheese');

    const again = await asOrg(f.orgId, (tx) => dismissDuplicatePair(tx, f.superAdmin, { itemAId: b, itemBId: a }));
    expect(again).toEqual({ dismissalId: first.dismissalId, created: false });
    const rows = await sql<{ item_a_id: string; item_b_id: string; note: string }[]>`
      select item_a_id, item_b_id, note from item_duplicate_dismissals where org_id = ${f.orgId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.item_a_id < rows[0]!.item_b_id).toBe(true);
    expect(rows[0]!.note).toBe('different products');

    const listed = await asOrg(f.orgId, (tx) => itemsRepo.listDismissals(tx, f.orgId));
    expect(listed.map((d) => [d.itemAName, d.itemBName].sort().join(' | '))).toEqual(['Samyang 4 Cheese | Samyang Cheese']);

    expect(await asOrg(f.orgId, (tx) => undoDuplicateDismissal(tx, f.superAdmin, { dismissalId: first.dismissalId }))).toEqual({ removed: true });
    expect((await pairs(f)).map(names)).toContain('Samyang 4 Cheese | Samyang Cheese');
    expect(await asOrg(f.orgId, (tx) => undoDuplicateDismissal(tx, f.superAdmin, { dismissalId: first.dismissalId }))).toEqual({ removed: false });
  }, 30_000);

  it.each(['admin', 'manager'] as const)('%s is refused for dismiss and for undo; nothing is written or removed', async (who) => {
    const f = await fixture(`r2b${who}`);
    const a = await mkItem(f, 'Samyang Cheese');
    const b = await mkItem(f, 'Samyang 4 Cheese');
    expect(await failure(asOrg(f.orgId, (tx) => dismissDuplicatePair(tx, f[who], { itemAId: a, itemBId: b })))).toBeInstanceOf(AuthorizationError);
    expect(await sql`select 1 from item_duplicate_dismissals where org_id = ${f.orgId}`).toHaveLength(0);

    const made = await asOrg(f.orgId, (tx) => dismissDuplicatePair(tx, f.superAdmin, { itemAId: a, itemBId: b }));
    expect(await failure(asOrg(f.orgId, (tx) => undoDuplicateDismissal(tx, f[who], { dismissalId: made.dismissalId })))).toBeInstanceOf(AuthorizationError);
    expect(await sql`select 1 from item_duplicate_dismissals where org_id = ${f.orgId}`).toHaveLength(1);
  }, 30_000);

  it('a pair of items of the same family is never listed (parent-variation, sibling-sibling); detaching brings the pair back', async () => {
    const f = await fixture('r2c');
    const kimchi = await mkItem(f, 'Kimchi');
    const k250 = await mkItem(f, 'Kimchi 250g');
    const k500 = await mkItem(f, 'Kimchi 500g');
    const all = (await pairs(f)).map(names);
    expect(all).toContain('Kimchi | Kimchi 250g'); // control: look-alikes while ungrouped
    expect(all).toContain('Kimchi 250g | Kimchi 500g');

    await setVariant(f, f.superAdmin, k250, kimchi);
    await setVariant(f, f.superAdmin, k500, kimchi);
    const grouped = (await pairs(f)).map(names);
    expect(grouped).not.toContain('Kimchi | Kimchi 250g');
    expect(grouped).not.toContain('Kimchi | Kimchi 500g');
    expect(grouped).not.toContain('Kimchi 250g | Kimchi 500g');

    await setVariant(f, f.superAdmin, k500, null);
    const after = (await pairs(f)).map(names);
    expect(after).toContain('Kimchi 250g | Kimchi 500g'); // no longer siblings
    expect(after).toContain('Kimchi | Kimchi 500g');
    expect(after).not.toContain('Kimchi | Kimchi 250g'); // still parent-child
  }, 30_000);

  it('the table is org-isolated: another org cannot see, or undo, a dismissal', async () => {
    const f = await fixture('r2d');
    const g = await fixture('r2d2');
    const a = await mkItem(f, 'Samyang Cheese');
    const b = await mkItem(f, 'Samyang 4 Cheese');
    const made = await asOrg(f.orgId, (tx) => dismissDuplicatePair(tx, f.superAdmin, { itemAId: a, itemBId: b }));
    expect(await asOrg(g.orgId, (tx) => itemsRepo.listDismissals(tx, g.orgId))).toEqual([]);
    expect(await asOrg(g.orgId, (tx) => undoDuplicateDismissal(tx, g.superAdmin, { dismissalId: made.dismissalId }))).toEqual({ removed: false });
    expect(await sql`select 1 from item_duplicate_dismissals where id = ${made.dismissalId}`).toHaveLength(1);
  }, 30_000);
});

describe('R3 - kind filter', () => {
  it('listItems with a kind returns only that kind (and counts match)', async () => {
    const f = await fixture('r3');
    await mkItem(f, 'Pork belly', 'meat_slab');
    await mkItem(f, 'Charcoal', 'supply');
    await mkItem(f, 'Gloves', 'supply');
    const supplies = await asOrg(f.orgId, (tx) => itemsRepo.listItems(tx, f.orgId, { includeInactive: true, kind: 'supply' }));
    expect(supplies.map((i) => i.name).sort()).toEqual(['Charcoal', 'Gloves']);
    expect((await asOrg(f.orgId, (tx) => itemsRepo.listItems(tx, f.orgId, { includeInactive: true }))).length).toBe(3);
    expect(await asOrg(f.orgId, (tx) => itemsRepo.countItemsByKind(tx, f.orgId, { includeInactive: true }))).toEqual({ meat_slab: 1, supply: 2 });
  }, 30_000);
});

describe('R4 - guard 1, at request time', () => {
  it('normalises names: trim + collapse inner whitespace, for create, request and rename', () => {
    expect(normaliseItemName('  Pork   belly \t')).toBe('Pork belly');
  });

  it('refuses a name an item already has, ignoring case and spacing, with a sentence per status (active / retired / merged)', async () => {
    const f = await fixture('r4a');
    const active = await mkItem(f, 'Pork belly');
    const req = (name: string) => asOrg(f.orgId, (tx) => requestItem(tx, f.manager, { name, kind: 'raw_material', baseUnit: 'kg' }));

    const s1 = await sentence(req('  pork   BELLY '));
    expect(s1).toMatch(/"Pork belly" \([A-Z0-9]{4}-\d{3}\) already exists\. Use that item/);

    await asOrg(f.orgId, (tx) => setItemStatus(tx, f.superAdmin, { itemId: active, status: 'inactive' }));
    expect(await sentence(req('Pork belly'))).toMatch(/already exists and is retired\. Ask a super-admin to reactivate it/);

    await asOrg(f.orgId, (tx) => setItemStatus(tx, f.superAdmin, { itemId: active, status: 'active' }));
    const winner = await mkItem(f, 'Pork belly slab');
    const loser = await mkItem(f, 'Porkbelly');
    await asOrg(f.orgId, (tx) => mergeItems(tx, f.superAdmin, { loserId: loser, winnerId: winner }));
    expect(await sentence(req('PORKBELLY'))).toMatch(/was merged into "Pork belly slab" \([A-Z0-9]{4}-\d{3}\)\. Use that item instead/);

    // a refused request wrote nothing
    expect(await sql`select 1 from item_requests where org_id = ${f.orgId}`).toHaveLength(0);
  }, 30_000);

  it('refuses a second OPEN request for the same name, naming who asked and when; a decided request never blocks a new ask', async () => {
    const f = await fixture('r4b');
    const req = (who: Actor, name: string) => asOrg(f.orgId, (tx) => requestItem(tx, who, { name, kind: 'raw_material', baseUnit: 'kg' }));
    const first = await req(f.manager, 'Dried anchovy');
    const s = await sentence(req(f.admin, 'dried  ANCHOVY'));
    expect(s).toMatch(/^Manager already asked for "Dried anchovy" on .+; it is waiting for a super-admin\.$/);

    await asOrg(f.orgId, (tx) => rejectItemRequest(tx, f.superAdmin, { requestId: first.requestId, note: 'not now' }));
    const second = await req(f.admin, 'Dried anchovy');
    expect(second.requestId).not.toBe(first.requestId);
  }, 30_000);

  it('the DATABASE backstop: a raw second open request hits item_requests_open_name_key; a decided one does not', async () => {
    const f = await fixture('r4c');
    const [p] = await sql<{ id: string }[]>`select id from persons where org_id = ${f.orgId} limit 1`;
    const insert = (name: string, status: string) => sql`
      insert into item_requests (org_id, name, code, kind, base_unit, requested_by, status, decided_by, decided_at, decision_note)
      values (${f.orgId}, ${name}, 'ZZZZ-001', 'raw_material', 'kg', ${p!.id}, ${status},
              ${status === 'requested' ? null : p!.id}, ${status === 'requested' ? null : new Date()}, ${status === 'requested' ? null : 'x'})`;
    await insert('Sesame oil', 'requested');
    expect(await rawRefusal(insert('SESAME OIL', 'requested'))).toBe('item_requests_open_name_key');
    await insert('sesame oil', 'rejected'); // a decided one never blocks
  }, 30_000);
});

describe('R5 - guard 2, at approval time', () => {
  it('approval refuses a name that was taken after the request; the request stays requested and no code number is burned', async () => {
    const f = await fixture('r5a');
    const asked = await asOrg(f.orgId, (tx) => requestItem(tx, f.manager, { name: 'Pork belly', kind: 'raw_material', baseUnit: 'kg' }));
    // Someone creates the same name directly while the request waits (a super-admin add, not blocked by an OPEN request).
    await mkItem(f, 'pork belly');
    const counter = async () =>
      (await sql<{ last_seq: number }[]>`select last_seq from item_code_counters where org_id = ${f.orgId} and stem = 'PORK'`)[0]?.last_seq;
    const before = await counter();
    const s = await sentence(asOrg(f.orgId, (tx) => approveItemRequest(tx, f.superAdmin, { requestId: asked.requestId })));
    expect(s).toMatch(/An item called "pork belly" \([A-Z0-9]{4}-\d{3}\) already exists/);
    expect(await counter()).toBe(before);
    const row = (await sql<{ status: string; created_item_id: string | null }[]>`select status, created_item_id from item_requests where id = ${asked.requestId}`)[0]!;
    expect(row).toEqual({ status: 'requested', created_item_id: null });
    expect(await sql`select 1 from items where org_id = ${f.orgId}`).toHaveLength(1);
    // the approver's way out: reject with a note
    await asOrg(f.orgId, (tx) => rejectItemRequest(tx, f.superAdmin, { requestId: asked.requestId, note: 'already exists' }));
  }, 30_000);

  it('createItem refuses a taken name in words (the unique index stays the backstop) and normalises spacing', async () => {
    const f = await fixture('r5b');
    await mkItem(f, 'Pork belly');
    expect(await sentence(asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { name: ' PORK   belly', kind: 'raw_material', baseUnit: 'kg' }))))
      .toMatch(/already exists/);
    const id = await mkItem(f, '  Beef   short  rib ');
    expect((await sql<{ name: string }[]>`select name from items where id = ${id}`)[0]!.name).toBe('Beef short rib');
    // backstop: a raw duplicate still hits the unique index
    expect(
      await rawRefusal(sql`
        insert into items (org_id, code, name, kind, base_unit, created_by)
        select org_id, 'ZZZZ-002', 'BEEF SHORT RIB', kind, base_unit, created_by from items where id = ${id}`),
    ).toBe('items_org_name_key');
    // rename normalises too
    const code = (await sql<{ code: string }[]>`select code from items where id = ${id}`)[0]!.code;
    await asOrg(f.orgId, (tx) => renameItem(tx, f.superAdmin, { itemId: id, name: '  Beef   rib  ', code }));
    expect((await sql<{ name: string }[]>`select name from items where id = ${id}`)[0]!.name).toBe('Beef rib');
  }, 30_000);
});


// Audit regression: the database must enforce family invariants across connections, not only serial calls.
describe('R1 concurrent database family changes', () => {
  it.each(['cycle', 'parent-kind', 'parent-merge', 'kind-before-child'] as const)(
    '%s: a conflicting second writer waits and cannot leave an invalid family', async (shape) => {
      const f = await fixture('race-' + shape);
      const parent = await mkItem(f, 'Race parent');
      const child = await mkItem(f, 'Race child');
      const survivor = await mkItem(f, 'Race survivor');
      const a = await sql.reserve();
      const b = await sql.reserve();
      let result: { ok: boolean; error?: unknown } = { ok: true };
      let waited = false;
      let aOpen = false;
      let bOpen = false;
      try {
        await a.unsafe('begin'); aOpen = true;
        await b.unsafe('begin'); bOpen = true;
        const pid = Number((await b.unsafe('select pg_backend_pid() as id'))[0]!.id);
        if (shape === 'kind-before-child') {
          await a.unsafe('update items set kind = $1 where id = $2', ['supply', parent]);
        } else {
          await a.unsafe('update items set variant_of_item_id = $1 where id = $2', [parent, child]);
        }
        let settled = false;
        const statement = shape === 'cycle'
          ? b.unsafe('update items set variant_of_item_id = $1 where id = $2', [child, parent])
          : shape === 'parent-kind'
            ? b.unsafe('update items set kind = $1 where id = $2', ['supply', parent])
            : shape === 'parent-merge'
              ? b.unsafe('update items set status = $1, merged_into_id = $2 where id = $3', ['merged', survivor, parent])
              : b.unsafe('update items set variant_of_item_id = $1 where id = $2', [parent, child]);
        const competing = statement.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        ).finally(() => { settled = true; });
        const deadline = Date.now() + 3000;
        while (!settled && Date.now() < deadline) {
          const state = await sql.unsafe('select wait_event from pg_stat_activity where pid = $1', [pid]);
          if (state[0]?.wait_event === 'advisory') { waited = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        await a.unsafe('commit'); aOpen = false;
        result = await competing;
        await b.unsafe(result.ok ? 'commit' : 'rollback'); bOpen = false;
      } finally {
        if (aOpen) await a.unsafe('rollback');
        if (bOpen) await b.unsafe('rollback');
        a.release();
        b.release();
      }
      expect(result.ok, 'a conflicting family change must not commit').toBe(false);
      expect(waited, 'the second family writer must wait on the shared database guard').toBe(true);
      expect(constraintOf(result.error)).toBe('items_variant_guard');
      const invalid = await sql.unsafe('select c.id from items c join items p on p.id = c.variant_of_item_id where c.org_id = $1 and (p.variant_of_item_id is not null or p.kind <> c.kind or p.status = $2)', [f.orgId, 'merged']);
      expect(invalid).toHaveLength(0);
    }, 30000,
  );
});
