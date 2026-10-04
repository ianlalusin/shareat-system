import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-375 S2 - the tender master (`packages/domain/src/pos/tenders.ts`). `docs/tasks/375-pos-v1-day-feed.md` S2, T1, T2.
 *
 * TESTER, not BUILDER. Every red leg asserts the TARGET (the spec's sentences, R3, R7), every refusal has a positive
 * control in the same file.
 *
 * ## Why these are red on HEAD
 * `tenders.ts` does not exist. It is imported DYNAMICALLY (preloaded in `beforeAll`, long timeout), so each leg fails
 * on "Failed to resolve import ../../src/pos/tenders". Once it exists, legs pass or fail on the assertion named.
 *
 * ## How the target is read where the spec is silent
 *  - `createTender(tx, actor, { storeId, name, kind, moneyAccountId?, posV1Alias? })` -> `{ id }`;
 *    `updateTender(tx, actor, { tenderId, name?, posV1Alias?, moneyAccountId? })`;
 *    `setTenderActive(tx, actor, { tenderId, isActive })`. Every refusal THROWS (RefusalError, `userMessage`);
 *  - rows are read back by raw SQL, so return values beyond `id` are not asserted;
 *  - audit: a row in `audit_log` with `entity = 'tenders'` and `entity_id` = the tender id (the spec says "audited";
 *    S1's link audit uses the table name as the entity, followed here);
 *  - the sentence for a retired money account is not given by the spec: asserted as a refusal that names no id, with
 *    the active account as the positive control.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

type Mod = typeof import('../../src/pos/tenders');
let mod: Mod;
beforeAll(async () => {
  mod = await import('../../src/pos/tenders');
}, 120_000);

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
const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return sentence(err);
}

type Created = { id: string };
async function create(f: Fixture, who: Actor, input: Record<string, unknown>) {
  return asOrg(f.orgId, (tx) => mod.createTender(tx, who, { storeId: f.storeId, ...input } as never)) as Promise<Created>;
}
async function update(f: Fixture, who: Actor, input: Record<string, unknown>) {
  return asOrg(f.orgId, (tx) => mod.updateTender(tx, who, input as never));
}
async function setActive(f: Fixture, who: Actor, tenderId: string, isActive: boolean) {
  return asOrg(f.orgId, (tx) => mod.setTenderActive(tx, who, { tenderId, isActive } as never));
}

async function tenderRows(storeId: string) {
  return sql<{ id: string; name: string; kind: string; money_account_id: string | null; pos_v1_alias: string | null; is_active: boolean }[]>`
    select id, name, kind, money_account_id, pos_v1_alias, is_active from tenders where store_id = ${storeId} order by name`;
}

async function fixture(hint: string) {
  const code = uid(`t375s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas');
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [storeId, store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');
  const mkAccount = async (sid: string, name: string, active: boolean) => {
    const [a] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
      values (${orgId}, ${sid}, ${name}, 'ewallet', '1140', 'cashier', ${active}) returning id`;
    return a!.id;
  };
  const gcashAcct = await mkAccount(storeId, 'GCash - Lipa', true);
  const mayaAcct = await mkAccount(storeId, 'Maya - Lipa', true);
  const retiredAcct = await mkAccount(storeId, 'Old wallet - Lipa', false);
  const otherStoreAcct = await mkAccount(store2Id, 'GCash - Batangas', true);
  const mkTyped = async (name: string, instrument: string, gl: string, custodian: string) => {
    const [a] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${storeId}, ${name}, ${instrument}, ${gl}, ${custodian}) returning id`;
    return a!.id;
  };
  const drawerAcct = await mkTyped('Cashier drawer - Lipa', 'cash', '1110', 'cashier');
  const bankAcct = await mkTyped('BDO - Lipa', 'bank', '1140', 'office');
  const [p2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin Batangas') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p2!.id}, ${orgId}, 'admin')`;
  const [p3] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager Batangas') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p3!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p3!.id}, ${store2Id})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p2!.id}, ${store2Id})`;
  return {
    orgId, storeId, store2Id, gcashAcct, mayaAcct, retiredAcct, otherStoreAcct, drawerAcct, bankAcct,
    scopedAdmin: actorOf(orgId, p2!.id),
    scopedManager: actorOf(orgId, p3!.id),
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe('T1 - who may map tenders (manage_chart_of_accounts, admin only) and what a wallet may point at', () => {
  it('admin creates Cash (cash, alias Cash) and GCash (wallet -> the store GCash account, alias GCash); both active; audited', async () => {
    const f = await fixture('t1a');
    const cash = await create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const gcash = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    expect(await tenderRows(f.storeId)).toEqual([
      { id: cash.id, name: 'Cash', kind: 'cash', money_account_id: null, pos_v1_alias: 'Cash', is_active: true },
      { id: gcash.id, name: 'GCash', kind: 'wallet', money_account_id: f.gcashAcct, pos_v1_alias: 'GCash', is_active: true },
    ]);
    const audited = await sql<{ entity_id: string }[]>`select entity_id from audit_log where org_id = ${f.orgId} and entity = 'tenders'`;
    expect(audited.map((r) => r.entity_id).sort(), 'each create is audited against the tender').toEqual([cash.id, gcash.id].sort());
  });

  it('a manager is refused with AuthorizationError on create, update and retire, and nothing changes', async () => {
    const f = await fixture('t1m');
    await expect(create(f, f.manager, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' })).rejects.toBeInstanceOf(AuthorizationError);
    expect(await tenderRows(f.storeId)).toHaveLength(0);
    // control: the admin creates it, and the manager is then refused on update and retire too
    const cash = await create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    await expect(update(f, f.manager, { tenderId: cash.id, name: 'Drawer' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(setActive(f, f.manager, cash.id, false)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await tenderRows(f.storeId)).toEqual([
      { id: cash.id, name: 'Cash', kind: 'cash', money_account_id: null, pos_v1_alias: 'Cash', is_active: true },
    ]);
  });

  it("a wallet account of another store -> \"That money account isn't one of this store's.\"; control: this store's account accepted", async () => {
    const f = await fixture('t1x');
    expect(await sentenceOf(create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.otherStoreAcct, posV1Alias: 'GCash' }))).toBe(
      "That money account isn't one of this store's.",
    );
    expect(await tenderRows(f.storeId)).toHaveLength(0);
    await expect(create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' })).resolves.toHaveProperty('id');
    expect(await tenderRows(f.storeId)).toHaveLength(1);
  });

  it('a RETIRED money account is refused (the account must be ACTIVE) and names no id; control: the active one is accepted', async () => {
    const f = await fixture('t1r');
    const text = await sentenceOf(create(f, f.admin, { name: 'Old', kind: 'wallet', moneyAccountId: f.retiredAcct, posV1Alias: 'Old' }));
    expect(text).not.toContain(f.retiredAcct);
    expect(await tenderRows(f.storeId)).toHaveLength(0);
    await expect(create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' })).resolves.toHaveProperty('id');
  });

  it("updateTender enforces the same account rule: re-pointing a wallet at another store's account is refused and the row is unchanged; control: this store's other account", async () => {
    const f = await fixture('t1u');
    const gcash = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    expect(await sentenceOf(update(f, f.admin, { tenderId: gcash.id, moneyAccountId: f.otherStoreAcct }))).toBe(
      "That money account isn't one of this store's.",
    );
    expect((await tenderRows(f.storeId))[0]!.money_account_id).toBe(f.gcashAcct);
    await update(f, f.admin, { tenderId: gcash.id, moneyAccountId: f.mayaAcct });
    expect((await tenderRows(f.storeId))[0]!.money_account_id).toBe(f.mayaAcct);
  });

  it('updateTender changes name and alias, and the change is audited', async () => {
    const f = await fixture('t1n');
    const cash = await create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    await update(f, f.admin, { tenderId: cash.id, name: 'Drawer cash', posV1Alias: 'Cash on hand' });
    const [row] = await tenderRows(f.storeId);
    expect(row).toMatchObject({ name: 'Drawer cash', pos_v1_alias: 'Cash on hand' });
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${f.orgId} and entity = 'tenders' and entity_id = ${cash.id}`;
    expect(n!.n, 'create + update both audited').toBeGreaterThanOrEqual(2);
  });
});

describe('T2 - an alias is unique among a store\'s active tenders, by its normalized form', () => {
  it('a second active tender aliased "g cash" -> the T2 sentence naming "GCash"; nothing written; control: after retiring the first, accepted', async () => {
    const f = await fixture('t2a');
    const first = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    expect(await sentenceOf(create(f, f.admin, { name: 'GCash 2', kind: 'wallet', moneyAccountId: f.mayaAcct, posV1Alias: 'g cash' }))).toBe(
      'Another tender of this store already answers to "GCash" from POS.',
    );
    expect(await tenderRows(f.storeId)).toHaveLength(1);
    await setActive(f, f.admin, first.id, false);
    await expect(create(f, f.admin, { name: 'GCash 2', kind: 'wallet', moneyAccountId: f.mayaAcct, posV1Alias: 'g cash' })).resolves.toHaveProperty('id');
    expect(await tenderRows(f.storeId)).toHaveLength(2);
  });

  it('control: the same alias in ANOTHER store is accepted (the rule is per store)', async () => {
    const f = await fixture('t2s');
    await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    await expect(
      asOrg(f.orgId, (tx) => mod.createTender(tx, f.admin, { storeId: f.store2Id, name: 'GCash', kind: 'wallet', moneyAccountId: f.otherStoreAcct, posV1Alias: 'GCash' } as never)),
    ).resolves.toHaveProperty('id');
  });

  it('updateTender onto a taken alias gets the same sentence; control: an alias nobody holds is accepted', async () => {
    const f = await fixture('t2u');
    await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    const maya = await create(f, f.admin, { name: 'Maya', kind: 'wallet', moneyAccountId: f.mayaAcct, posV1Alias: 'Maya' });
    expect(await sentenceOf(update(f, f.admin, { tenderId: maya.id, posV1Alias: 'G-Cash' }))).toBe(
      'Another tender of this store already answers to "GCash" from POS.',
    );
    expect((await tenderRows(f.storeId)).find((r) => r.id === maya.id)!.pos_v1_alias).toBe('Maya');
    await update(f, f.admin, { tenderId: maya.id, posV1Alias: 'PayMaya' });
    expect((await tenderRows(f.storeId)).find((r) => r.id === maya.id)!.pos_v1_alias).toBe('PayMaya');
  });

  it('reactivating a retired tender whose alias is now held by an active one is refused with the same sentence; control: reactivating with the alias free works', async () => {
    const f = await fixture('t2r');
    const first = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    await setActive(f, f.admin, first.id, false);
    const second = await create(f, f.admin, { name: 'GCash 2', kind: 'wallet', moneyAccountId: f.mayaAcct, posV1Alias: 'GCash' });
    expect(await sentenceOf(setActive(f, f.admin, first.id, true))).toBe('Another tender of this store already answers to "GCash" from POS.');
    expect((await tenderRows(f.storeId)).find((r) => r.id === first.id)!.is_active).toBe(false);
    await setActive(f, f.admin, second.id, false);
    await setActive(f, f.admin, first.id, true);
    expect((await tenderRows(f.storeId)).find((r) => r.id === first.id)!.is_active).toBe(true);
  });

  it('an alias that normalizes to nothing ("--") is refused as a sentence (no database error text); control: "G-Cash" is accepted', async () => {
    const f = await fixture('t2n');
    const text = await sentenceOf(create(f, f.admin, { name: 'Odd', kind: 'cash', posV1Alias: '--' }));
    expect(text).not.toMatch(/tenders_|violates|constraint/i);
    expect(await tenderRows(f.storeId)).toHaveLength(0);
    await expect(create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'G-Cash' })).resolves.toHaveProperty('id');
  });
});

describe('RED-1 - a retired money account', () => {
  it('renaming and re-aliasing a wallet tender whose account was retired afterwards succeeds (the account is not in the input)', async () => {
    const f = await fixture('r1a');
    const t = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    await sql`update money_accounts set is_active = false where id = ${f.gcashAcct}`;
    await update(f, f.admin, { tenderId: t.id, name: 'GCash main', posV1Alias: 'G-Cash Main' });
    expect(await tenderRows(f.storeId)).toEqual([
      { id: t.id, name: 'GCash main', kind: 'wallet', money_account_id: f.gcashAcct, pos_v1_alias: 'G-Cash Main', is_active: true },
    ]);
  });

  it("re-pointing a tender TO a retired account is refused with a sentence saying it is retired (not the wrong-store one); control: an active account", async () => {
    const f = await fixture('r1b');
    const t = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    const text = await sentenceOf(update(f, f.admin, { tenderId: t.id, moneyAccountId: f.retiredAcct }));
    expect(text).toMatch(/retired/i);
    expect(text).not.toBe("That money account isn't one of this store's.");
    expect(text).not.toContain(f.retiredAcct);
    expect((await tenderRows(f.storeId))[0]!.money_account_id).toBe(f.gcashAcct);
    await update(f, f.admin, { tenderId: t.id, moneyAccountId: f.mayaAcct });
    expect((await tenderRows(f.storeId))[0]!.money_account_id).toBe(f.mayaAcct);
  });

  it('create onto a retired account says it is retired too', async () => {
    const f = await fixture('r1c');
    const text = await sentenceOf(create(f, f.admin, { name: 'Old', kind: 'wallet', moneyAccountId: f.retiredAcct, posV1Alias: 'Old' }));
    expect(text).toMatch(/retired/i);
  });
});

describe('RED-2 - a wallet tender may not point at a cash drawer', () => {
  it('create and update onto the cashier cash drawer (instrument cash, 1110) are refused with a sentence that is not the wrong-store one; control: e-wallet and bank accepted', async () => {
    const f = await fixture('r2');
    const text = await sentenceOf(create(f, f.admin, { name: 'Drawer', kind: 'wallet', moneyAccountId: f.drawerAcct, posV1Alias: 'Drawer' }));
    expect(text).not.toBe("That money account isn't one of this store's.");
    expect(text).not.toContain(f.drawerAcct);
    expect(await tenderRows(f.storeId)).toHaveLength(0);

    const g = await create(f, f.admin, { name: 'GCash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'GCash' });
    const text2 = await sentenceOf(update(f, f.admin, { tenderId: g.id, moneyAccountId: f.drawerAcct }));
    expect(text2).not.toBe("That money account isn't one of this store's.");
    expect((await tenderRows(f.storeId))[0]!.money_account_id).toBe(f.gcashAcct);

    await update(f, f.admin, { tenderId: g.id, moneyAccountId: f.bankAcct });
    expect((await tenderRows(f.storeId))[0]!.money_account_id).toBe(f.bankAcct);
    await expect(create(f, f.admin, { name: 'Maya', kind: 'wallet', moneyAccountId: f.mayaAcct, posV1Alias: 'Maya' })).resolves.toHaveProperty('id');
  });
});

describe('Gaps - domain shape rules, audit, scope, org', () => {
  it('a cash tender WITH an account is refused and nothing written - Mutant: drop the cash-with-account branch in createTender', async () => {
    const f = await fixture('g1');
    expect(await sentenceOf(create(f, f.admin, { name: 'Cash', kind: 'cash', moneyAccountId: f.gcashAcct, posV1Alias: 'Cash' }))).toBe(
      'A cash tender has no money account.',
    );
    expect(await tenderRows(f.storeId)).toHaveLength(0);
    await expect(create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' })).resolves.toHaveProperty('id');
  });

  it('a wallet with NO account is refused - Mutant: allow a null account for a wallet', async () => {
    const f = await fixture('g2');
    expect(await sentenceOf(create(f, f.admin, { name: 'GCash', kind: 'wallet', posV1Alias: 'GCash' }))).toBe(
      'A wallet tender needs the money account it pays into.',
    );
    expect(await tenderRows(f.storeId)).toHaveLength(0);
  });

  it('a blank name is refused; control: a named tender is created - Mutant: drop cleanName', async () => {
    const f = await fixture('g3');
    expect(await sentenceOf(create(f, f.admin, { name: '   ', kind: 'cash', posV1Alias: 'Cash' }))).toBe('Give the tender a name.');
    expect(await tenderRows(f.storeId)).toHaveLength(0);
    await expect(create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' })).resolves.toHaveProperty('id');
  });

  it('a duplicate NAME (case-insensitive) gets the name sentence, not constraint text - Mutant: drop the name branch of translate()', async () => {
    const f = await fixture('g4');
    await create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const text = await sentenceOf(create(f, f.admin, { name: 'cash', kind: 'cash', posV1Alias: 'Drawer' }));
    expect(text).toBe('This store already has a tender called "cash".');
    expect(await tenderRows(f.storeId)).toHaveLength(1);
  });

  it('retire and reactivate each write their own audit row with before/after - Mutant: skip the audit append or swap the action names', async () => {
    const f = await fixture('g5');
    const t = await create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    await setActive(f, f.admin, t.id, false);
    await setActive(f, f.admin, t.id, true);
    const rows = await sql<{ action: string; before: unknown; after: unknown }[]>`
      select action, "before" as before, "after" as after from audit_log
      where org_id = ${f.orgId} and entity = 'tenders' and entity_id = ${t.id} and action in ('retire_tender', 'reactivate_tender')`;
    const by = Object.fromEntries(rows.map((r) => [r.action, r]));
    expect(Object.keys(by).sort()).toEqual(['reactivate_tender', 'retire_tender']);
    expect(by.retire_tender).toMatchObject({ before: { isActive: true }, after: { isActive: false } });
    expect(by.reactivate_tender).toMatchObject({ before: { isActive: false }, after: { isActive: true } });
  });

  it('a manager scoped only to ANOTHER store is refused on create, update and retire for this store (manage_chart_of_accounts is ORG-scoped: the role is the gate, store scope is not, so an admin scoped to another store is NOT refused - control) - Mutant: grant the capability to managers', async () => {
    const f = await fixture('g6');
    await expect(create(f, f.scopedManager, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' })).rejects.toBeInstanceOf(AuthorizationError);
    const t = await create(f, f.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    await expect(update(f, f.scopedManager, { tenderId: t.id, name: 'X' })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(setActive(f, f.scopedManager, t.id, false)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await tenderRows(f.storeId)).toEqual([{ id: t.id, name: 'Cash', kind: 'cash', money_account_id: null, pos_v1_alias: 'Cash', is_active: true }]);
    // controls: even on her OWN store the manager is refused (role), and an admin scoped only to the other store is let in (org-scoped capability)
    await expect(
      asOrg(f.orgId, (tx) => mod.createTender(tx, f.scopedManager, { storeId: f.store2Id, name: 'Cash', kind: 'cash', posV1Alias: 'Cash' } as never)),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(create(f, f.scopedAdmin, { name: 'Till', kind: 'cash', posV1Alias: 'Till' })).resolves.toHaveProperty('id');
  });

  it('a tender id from ANOTHER org is "gone" for update and retire, and the owner org sees it unchanged - Mutant: read the tender without the org filter', async () => {
    const a = await fixture('g7a');
    const b = await fixture('g7b');
    const t = await create(a, a.admin, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const goneText = 'That tender could not be found';
    expect(await sentenceOf(update(b, b.admin, { tenderId: t.id, name: 'Hijack' }))).toContain(goneText);
    expect(await sentenceOf(setActive(b, b.admin, t.id, false))).toContain(goneText);
    expect(await tenderRows(a.storeId)).toEqual([{ id: t.id, name: 'Cash', kind: 'cash', money_account_id: null, pos_v1_alias: 'Cash', is_active: true }]);
    await update(a, a.admin, { tenderId: t.id, name: 'Drawer cash' });
    expect((await tenderRows(a.storeId))[0]!.name).toBe('Drawer cash');
  });
});
