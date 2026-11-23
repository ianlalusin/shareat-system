import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-629 - the org's master list of payment options and a store's switch for each (`pos/payment-options.ts`, `pos/tenders.ts`, migration 0277).
 * `docs/tasks/629-payment-options-master-list.md`, tests 2, 3 and 4 (and the seed). Real Postgres; raw SQL builds the world, so the DATABASE is the oracle.
 *
 * Mutants (each proven red by hand; the list is in the spec's "As built"):
 *   S1 seed: match by exact name instead of the normalised one            P1 red
 *   T1 switchOnPaymentOption: drop the "already on" refusal               P2a red
 *   T2 switchOnPaymentOption: drop the wallet-needs-an-account branch     P2b red
 *   T3 switchOnPaymentOption: drop the store-account check                P2c red
 *   O1 setPaymentOptionStatus: drop the "switched on at a store" refusal  P3a red
 *   O2 updatePaymentOption: drop the "used by a store" kind refusal       P3b red
 *   O3 assertFree: drop the second-cash refusal                           P3c red
 *   O4 createPaymentOption: authorize after the name check                P4a red
 *   O5 createPaymentOption: no audit row                                  P4b red
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { PAYMENT_OPTION_SEED, seedPaymentOptions } from '../../../db/seed/payment-options';
import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createPaymentOption, setPaymentOptionStatus, updatePaymentOption } from '../../src/pos/payment-options';
import { setTenderActive, switchOnPaymentOption, updateTender } from '../../src/pos/tenders';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

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
const sentenceOf = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return String((err as { userMessage?: string }).userMessage ?? (err as Error).message);
};

async function fixture(hint: string, opts: { seed?: boolean } = {}) {
  const code = uid(`t629-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  if (opts.seed !== false) await seedPaymentOptions(sql, orgId);
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas');
  const mkPerson = async (name: string, role: string | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of [storeId, store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return actorOf(orgId, p!.id);
  };
  const admin = await mkPerson('Admin', 'admin');
  const manager = await mkPerson('Manager', 'manager');
  const cashier = await mkPerson('Cashier', null);
  const mkAccount = async (sid: string, name: string, instrument: string, gl: string) =>
    (await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${sid}, ${name}, ${instrument}, ${gl}, 'cashier') returning id`)[0]!.id;
  const wallet = await mkAccount(storeId, 'GCash - Lipa', 'ewallet', '1140');
  const bank = await mkAccount(storeId, 'BDO - Lipa', 'bank', '1140');
  const otherWallet = await mkAccount(store2Id, 'GCash - Batangas', 'ewallet', '1140');
  return { orgId, storeId, store2Id, admin, manager, cashier, wallet, bank, otherWallet };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const optionId = async (orgId: string, name: string) => (await sql<{ id: string }[]>`select id from payment_options where org_id = ${orgId} and name = ${name}`)[0]!.id;
const tendersOf = (storeId: string) =>
  sql<{ id: string; name: string; kind: string; is_active: boolean; payment_option_id: string; money_account_id: string | null }[]>`
    select id, name, kind, is_active, payment_option_id, money_account_id from tenders where store_id = ${storeId} order by name`;
const auditOf = (orgId: string, action: string) =>
  sql<{ entity: string; entity_id: string; store_id: string | null; actor_person_id: string; before: unknown; after: unknown }[]>`
    select entity, entity_id, store_id, actor_person_id, before, after from audit_log where org_id = ${orgId} and action = ${action} order by recorded_at`;

describe('P1 - the seed: Ian\'s six, matched by normalised name', () => {
  it('a new org gets Cash, GCash, Maya, QRPH, Credit card, Debit card (one cash, the rest wallets); a second run adds nothing', async () => {
    const f = await fixture('p1');
    const rows = await sql<{ name: string; kind: string; status: string }[]>`select name, kind, status from payment_options where org_id = ${f.orgId} order by sort_order`;
    expect(rows).toEqual(PAYMENT_OPTION_SEED.map((s) => ({ name: s.name, kind: s.kind, status: 'active' })));
    expect(rows.map((r) => r.name)).toEqual(['Cash', 'GCash', 'Maya', 'QRPH', 'Credit card', 'Debit card']);
    expect((await seedPaymentOptions(sql, f.orgId)).inserted).toBe(0);
  });

  it('an org that already has "G-Cash" does not get a second GCash; a cash option under another name (Till) does not stop the seed adding Cash', async () => {
    const f = await fixture('p1b', { seed: false });
    await sql`insert into payment_options (org_id, name, kind, sort_order) values (${f.orgId}, 'G-Cash', 'wallet', 1), (${f.orgId}, 'Till', 'cash', 2)`;
    const r = await seedPaymentOptions(sql, f.orgId);
    const names = (await sql<{ name: string }[]>`select name from payment_options where org_id = ${f.orgId} order by name`).map((x) => x.name);
    expect(names).toEqual(['Cash', 'Credit card', 'Debit card', 'G-Cash', 'Maya', 'QRPH', 'Till']);
    expect(r.inserted).toBe(5);
  });
});

describe('P2 - a store switches an option on (test 2)', () => {
  it('P2a: the same option cannot be switched on twice at a store, but can at another store; switched off and on again it is the same row', async () => {
    const f = await fixture('p2a');
    const gcash = await optionId(f.orgId, 'GCash');
    const first = await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash, moneyAccountId: f.wallet, posV1Alias: 'GCash' }));
    expect(await sentenceOf(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash, moneyAccountId: f.wallet })))).toBe('GCash is already switched on at this store.');
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.store2Id, paymentOptionId: gcash, moneyAccountId: f.otherWallet }));
    // the database holds it too: a raw second row for (store, option) is a unique violation
    const raw = await sql`insert into tenders (org_id, store_id, payment_option_id, name, kind, money_account_id) values (${f.orgId}, ${f.storeId}, ${gcash}, 'GCash', 'wallet', ${f.wallet})`.then(() => null, (e) => e as { code?: string });
    expect(raw?.code).toBe('23505');
    // off, then on again: one row, switched back on, alias and account kept
    await asOrg(f.orgId, (tx) => setTenderActive(tx, f.admin, { tenderId: first.id, isActive: false }));
    const again = await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash }));
    expect(again.id).toBe(first.id);
    const rows = await tendersOf(f.storeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'GCash', kind: 'wallet', is_active: true, money_account_id: f.wallet });
  });

  it('P2e: a tender insert with no payment_option_id fails on NOT NULL; nothing makes an option silently', async () => {
    const f = await fixture('p2e');
    const before = (await sql<{ n: number }[]>`select count(*)::int n from payment_options where org_id = ${f.orgId}`)[0]!.n;
    const raw = await sql`insert into tenders (org_id, store_id, name, kind) values (${f.orgId}, ${f.storeId}, 'Brand New Method', 'cash')`.then(() => null, (e) => e as { code?: string; column_name?: string });
    expect(raw?.code).toBe('23502');
    expect(raw?.column_name).toBe('payment_option_id');
    expect((await sql<{ n: number }[]>`select count(*)::int n from payment_options where org_id = ${f.orgId}`)[0]!.n, 'no option was made').toBe(before);
    expect(await tendersOf(f.storeId)).toHaveLength(0);
  });

  it('P2b: a wallet option without a money account is refused in words and writes nothing', async () => {
    const f = await fixture('p2b');
    const maya = await optionId(f.orgId, 'Maya');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: maya })))).toBe('Maya needs the money account it pays into at this store.');
    expect(await tendersOf(f.storeId)).toHaveLength(0);
  });

  it('P2c: a wallet pointed at another store\'s account, at a cash drawer, or at an account on a cash option is refused; the right account works', async () => {
    const f = await fixture('p2c');
    const maya = await optionId(f.orgId, 'Maya');
    const cash = await optionId(f.orgId, 'Cash');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: maya, moneyAccountId: f.otherWallet })))).toBe("That money account isn't one of this store's.");
    expect(await sentenceOf(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: cash, moneyAccountId: f.wallet })))).toBe('A cash tender has no money account.');
    expect(await tendersOf(f.storeId)).toHaveLength(0);
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: maya, moneyAccountId: f.bank }));
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: cash }));
    expect((await tendersOf(f.storeId)).map((t) => [t.name, t.kind])).toEqual([['Cash', 'cash'], ['Maya', 'wallet']]);
  });

  it('P2d: an option of another org, and a retired option, cannot be switched on; a tender takes its name and kind from the option (and the store cannot edit them)', async () => {
    const f = await fixture('p2d');
    const g = await fixture('p2d2');
    const foreign = await optionId(g.orgId, 'GCash');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: foreign, moneyAccountId: f.wallet })))).toBe('That payment option could not be found. Someone may have changed it — reload the page and try again.');
    const qr = await optionId(f.orgId, 'QRPH');
    await asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, f.admin, { paymentOptionId: qr, status: 'retired' }));
    expect(await sentenceOf(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: qr, moneyAccountId: f.bank })))).toMatch(/QRPH is retired/);
    // a raw write cannot give a tender a name or kind of its own: the mirror trigger sets them from the option
    const gcash = await optionId(f.orgId, 'GCash');
    const t = await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash, moneyAccountId: f.wallet }));
    await sql`update tenders set name = 'Whatever' where id = ${t.id}`;
    expect((await tendersOf(f.storeId))[0]).toMatchObject({ name: 'GCash', kind: 'wallet' });
    const moved = await sql`update tenders set payment_option_id = ${await optionId(f.orgId, 'Maya')} where id = ${t.id}`.then(() => null, (e) => e as { message: string });
    expect(moved?.message).toMatch(/stays on its payment option/);
    // updateTender moves only the account and the POS name
    await asOrg(f.orgId, (tx) => updateTender(tx, f.admin, { tenderId: t.id, moneyAccountId: f.bank, posV1Alias: 'G-Cash' }));
    expect((await tendersOf(f.storeId))[0]).toMatchObject({ name: 'GCash', money_account_id: f.bank });
  });
});

describe('P3 - the master list\'s own rules (test 3)', () => {
  it('P3a: retiring an option that a store has on is refused (domain sentence AND the database); after it is switched off it can be retired and brought back', async () => {
    const f = await fixture('p3a');
    const gcash = await optionId(f.orgId, 'GCash');
    const t = await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash, moneyAccountId: f.wallet }));
    expect(await sentenceOf(asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, f.admin, { paymentOptionId: gcash, status: 'retired' })))).toBe('GCash is switched on at 1 store. Switch it off there first, then retire it.');
    const raw = await sql`update payment_options set status = 'retired' where id = ${gcash}`.then(() => null, (e) => e as { message: string });
    expect(raw?.message, 'the trigger is the backstop').toMatch(/switched on at a store, so it cannot be retired/);
    expect((await sql<{ status: string }[]>`select status from payment_options where id = ${gcash}`)[0]!.status).toBe('active');
    await asOrg(f.orgId, (tx) => setTenderActive(tx, f.admin, { tenderId: t.id, isActive: false }));
    await asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, f.admin, { paymentOptionId: gcash, status: 'retired' }));
    // a retired option cannot be switched back on at the store by a raw write either
    const back = await sql`update tenders set is_active = true where id = ${t.id}`.then(() => null, (e) => e as { message: string });
    expect(back?.message).toMatch(/is retired and cannot be switched on/);
    await asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, f.admin, { paymentOptionId: gcash, status: 'active' }));
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash }));
  });

  it('P3b: cash / wallet cannot change once a store holds a tender for the option (domain AND database); an unused option can change', async () => {
    const f = await fixture('p3b');
    const maya = await optionId(f.orgId, 'Maya');
    const qr = await optionId(f.orgId, 'QRPH');
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: maya, moneyAccountId: f.wallet }));
    expect(await sentenceOf(asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: maya, kind: 'cash' })))).toBe('Maya is used by a store, so it cannot change between cash and wallet.');
    const raw = await sql`update payment_options set kind = 'cash' where id = ${maya}`.then(() => null, (e) => e as { message: string });
    expect(raw?.message).toMatch(/cannot change between cash and wallet/);
    // switched off still counts as used (its history keeps the kind)
    expect(await sentenceOf(asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: maya, kind: 'cash' })))).toMatch(/used by a store/);
    // QRPH has no store: it can still be renamed
    await asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: qr, name: 'QR Ph' }));
    expect((await sql<{ name: string }[]>`select name from payment_options where id = ${qr}`)[0]!.name).toBe('QR Ph');
  });

  it('P3c: a second cash option is ALLOWED (Cash and Collected, bible row 292), a name that is already there in any case or punctuation is refused', async () => {
    const f = await fixture('p3c');
    const collected = await asOrg(f.orgId, (tx) => createPaymentOption(tx, f.admin, { name: 'Collected', kind: 'cash' }));
    expect((await sql<{ kind: string }[]>`select kind from payment_options where id = ${collected.id}`)[0]!.kind).toBe('cash');
    const qr = await optionId(f.orgId, 'QRPH');
    await asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: qr, kind: 'cash' })); // unused, so its kind may change
    expect((await sql<{ kind: string }[]>`select kind from payment_options where id = ${qr}`)[0]!.kind).toBe('cash');
    expect(await sql`select 1 from payment_options where org_id = ${f.orgId} and kind = 'cash'`).toHaveLength(3);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => createPaymentOption(tx, f.admin, { name: 'g-cash', kind: 'wallet' })))).toBe('There is already a payment option called "GCash".');
    expect(await sentenceOf(asOrg(f.orgId, (tx) => createPaymentOption(tx, f.admin, { name: 'x'.repeat(41), kind: 'wallet' })))).toMatch(/40 characters/);
    expect(await sentenceOf(asOrg(f.orgId, (tx) => createPaymentOption(tx, f.admin, { name: '###', kind: 'wallet' })))).toBe('The name needs at least one letter or digit.');
    // the database holds the name rule too (and a raw second cash option is fine)
    const raw = await sql`insert into payment_options (org_id, name, kind) values (${f.orgId}, 'COLLECTED', 'cash')`.then(() => null, (e) => e as { code?: string });
    expect(raw?.code).toBe('23505');
    await sql`insert into payment_options (org_id, name, kind) values (${f.orgId}, 'Petty cash', 'cash')`;
    const ok = await asOrg(f.orgId, (tx) => createPaymentOption(tx, f.admin, { name: '  Bank Transfer ', kind: 'wallet' }));
    expect((await sql<{ name: string; sort_order: number }[]>`select name, sort_order from payment_options where id = ${ok.id}`)[0]).toMatchObject({ name: 'Bank Transfer' });
  });

  it('P3d: renaming an option renames the store tenders that use it, at every store', async () => {
    const f = await fixture('p3d');
    const gcash = await optionId(f.orgId, 'GCash');
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash, moneyAccountId: f.wallet }));
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.store2Id, paymentOptionId: gcash, moneyAccountId: f.otherWallet }));
    await asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: gcash, name: 'GCash Wallet' }));
    expect((await tendersOf(f.storeId))[0]!.name).toBe('GCash Wallet');
    expect((await tendersOf(f.store2Id))[0]!.name).toBe('GCash Wallet');
  });
});

describe('P4 - who may edit the master list, and what is recorded (test 4)', () => {
  it('P4a: a manager and a cashier are refused for the master list and for a store switch (authorize first: even a blank name or an unknown option gets the refusal, not a validation sentence)', async () => {
    const f = await fixture('p4a');
    const gcash = await optionId(f.orgId, 'GCash');
    const before = (await sql<{ n: number }[]>`select count(*)::int n from payment_options where org_id = ${f.orgId}`)[0]!.n;
    for (const who of [f.manager, f.cashier]) {
      await expect(asOrg(f.orgId, (tx) => createPaymentOption(tx, who, { name: '   ', kind: 'wallet' }))).rejects.toBeInstanceOf(AuthorizationError);
      await expect(asOrg(f.orgId, (tx) => updatePaymentOption(tx, who, { paymentOptionId: crypto.randomUUID(), name: 'x' }))).rejects.toBeInstanceOf(AuthorizationError);
      await expect(asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, who, { paymentOptionId: crypto.randomUUID(), status: 'retired' }))).rejects.toBeInstanceOf(AuthorizationError);
      await expect(asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, who, { storeId: f.storeId, paymentOptionId: crypto.randomUUID() }))).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect((await sql<{ n: number }[]>`select count(*)::int n from payment_options where org_id = ${f.orgId}`)[0]!.n).toBe(before);
    expect(await tendersOf(f.storeId)).toHaveLength(0);
    // the admin does all of it
    await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: gcash, moneyAccountId: f.wallet }));
  });

  it('P4b: every write leaves one audit row (entity payment_options, org scope: no store; tender writes name the store)', async () => {
    const f = await fixture('p4b');
    const made = await asOrg(f.orgId, (tx) => createPaymentOption(tx, f.admin, { name: 'Bank Transfer', kind: 'wallet' }));
    await asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: made.id, name: 'Bank transfer (BDO)' }));
    await asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, f.admin, { paymentOptionId: made.id, status: 'retired' }));
    await asOrg(f.orgId, (tx) => setPaymentOptionStatus(tx, f.admin, { paymentOptionId: made.id, status: 'active' }));
    const created = await auditOf(f.orgId, 'payment_option.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entity: 'payment_options', entity_id: made.id, store_id: null, actor_person_id: f.admin.personId, before: null });
    expect(created[0]!.after).toMatchObject({ name: 'Bank Transfer', kind: 'wallet' });
    const updated = await auditOf(f.orgId, 'payment_option.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ before: { name: 'Bank Transfer', kind: 'wallet' }, after: { name: 'Bank transfer (BDO)', kind: 'wallet' } });
    expect(await auditOf(f.orgId, 'payment_option.retired')).toHaveLength(1);
    expect(await auditOf(f.orgId, 'payment_option.reactivated')).toHaveLength(1);
    const t = await asOrg(f.orgId, (tx) => switchOnPaymentOption(tx, f.admin, { storeId: f.storeId, paymentOptionId: made.id, moneyAccountId: f.wallet }));
    const tenderAudit = await auditOf(f.orgId, 'create_tender');
    expect(tenderAudit).toHaveLength(1);
    expect(tenderAudit[0]).toMatchObject({ entity: 'tenders', entity_id: t.id, store_id: f.storeId });
    expect(tenderAudit[0]!.after).toMatchObject({ paymentOptionId: made.id, name: 'Bank transfer (BDO)' });
    // a no-op writes no row
    await asOrg(f.orgId, (tx) => updatePaymentOption(tx, f.admin, { paymentOptionId: made.id, name: 'Bank transfer (BDO)' }));
    expect(await auditOf(f.orgId, 'payment_option.updated')).toHaveLength(1);
  });
});
