/**
 * T-629 - migration 0277: the payment-option master list and the backfill of every existing tender. `docs/tasks/629-payment-options-master-list.md`.
 *
 * The backfill is the DO block INSIDE the migration file; this test cuts that block out of the file and runs it on realistic old-shape rows (tenders with no
 * option), inside a transaction that is always rolled back, so what is proven is the migration's own text, not a copy of it. Raw SQL on the migration role.
 *
 * Mutants (each proven red by hand, see docs/tasks/629 "As built"): key the option per STORE instead of per org (B1 red); drop the "two tenders of one store" STOP (B3 red);
 * drop the kind-disagreement STOPs (B4 red); fold every cash tender into one option (B5 red); skip the rename of tenders to the option's name (B2 red); drop the seed insert (B6 red).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const FILE = readFileSync(resolve(__dirname, '..', '..', 'migrations', '0277_t629_payment_options.sql'), 'utf8');
const BACKFILL = FILE.slice(FILE.indexOf('DO $do$'), FILE.indexOf('$do$;') + '$do$;'.length);

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
class Rollback extends Error {}

type Tx = postgres.TransactionSql;
type Old = { org: string; store: string; name: string; kind: 'cash' | 'wallet'; account?: string };

/** Puts the database in its pre-0277 shape inside a transaction (no options, tenders without one, no mirror trigger), runs `fn`, and always rolls back. */
async function inOldWorld<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      await tx`alter table tenders alter column payment_option_id drop not null`;
      await tx`alter table tenders disable trigger tenders_mirror_option`;
      await tx`update tenders set payment_option_id = null`;
      // Other test files leave their own tenders in this shared test database; the backfill runs over every tender, so a real STOP case from some other
      // file would stop this one. Inside this always-rolled-back transaction only, take them out (FK checks off) so the world is exactly what the case builds.
      await tx`set local session_replication_role = replica`;
      await tx`delete from tenders`;
      await tx`delete from payment_options`;
      await tx`set local session_replication_role = origin`;
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out as T;
}

async function world(tx: Tx, hint: string) {
  const code = uid(hint);
  const [org] = await tx<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const mkStore = async (name: string) => (await tx<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const a = await mkStore('Lipa');
  const b = await mkStore('Batangas');
  const acct = async (store: string, name: string) =>
    (await tx<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${org!.id}, ${store}, ${name}, 'ewallet', '1140', 'cashier') returning id`)[0]!.id;
  return { orgId: org!.id, a, b, acctA: await acct(a, 'Wallet Lipa'), acctB: await acct(b, 'Wallet Batangas') };
}

async function addTender(tx: Tx, t: Old): Promise<string> {
  const [r] = await tx<{ id: string }[]>`
    insert into tenders (org_id, store_id, name, kind, money_account_id) values (${t.org}, ${t.store}, ${t.name}, ${t.kind}, ${t.account ?? null}) returning id`;
  return r!.id;
}

const optionsOf = (tx: Tx, orgId: string) =>
  tx<{ id: string; name: string; kind: string; status: string }[]>`select id, name, kind, status from payment_options where org_id = ${orgId} order by sort_order, name`;

describe('0277 backfill', () => {
  it('B1/B2: "Gcash" at one store and "GCash" at another become ONE option; Cash at both stores is ONE; a lone "Bank Transfer" is its own; tenders take the option name', async () => {
    const r = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b1');
      const gA = await addTender(tx, { org: w.orgId, store: w.a, name: 'Gcash', kind: 'wallet', account: w.acctA });
      const gB = await addTender(tx, { org: w.orgId, store: w.b, name: 'GCash', kind: 'wallet', account: w.acctB });
      const cA = await addTender(tx, { org: w.orgId, store: w.a, name: 'Cash', kind: 'cash' });
      const cB = await addTender(tx, { org: w.orgId, store: w.b, name: 'cash', kind: 'cash' });
      const bt = await addTender(tx, { org: w.orgId, store: w.a, name: 'Bank Transfer', kind: 'wallet', account: w.acctA });
      await tx.unsafe(BACKFILL);
      const t = await tx<{ id: string; name: string; kind: string; payment_option_id: string }[]>`select id, name, kind, payment_option_id from tenders where org_id = ${w.orgId}`;
      return { opts: await optionsOf(tx, w.orgId), t: new Map(t.map((x) => [x.id, x])), gA, gB, cA, cB, bt };
    });
    const by = (id: string) => r.t.get(id)!;
    expect(by(r.gA).payment_option_id, 'Gcash and GCash are one option').toBe(by(r.gB).payment_option_id);
    expect(by(r.cA).payment_option_id, 'Cash at both stores is one option').toBe(by(r.cB).payment_option_id);
    expect(by(r.bt).payment_option_id).not.toBe(by(r.gA).payment_option_id);
    expect(by(r.gA).name).toBe('GCash'); // the Ian-list spelling, not the typed one
    expect(by(r.cB).name).toBe('Cash');
    expect(by(r.bt).name).toBe('Bank Transfer');
    // the option list: Ian's six plus Bank Transfer, each name once
    expect(r.opts.map((o) => o.name).sort()).toEqual(['Bank Transfer', 'Cash', 'Credit card', 'Debit card', 'GCash', 'Maya', 'QRPH']);
    expect(r.opts.find((o) => o.name === 'Bank Transfer')).toMatchObject({ kind: 'wallet', status: 'active' });
    expect(r.opts.filter((o) => o.kind === 'cash')).toHaveLength(1);
  });

  it('B6: an org with no tenders at all gets the six, in the order of the list', async () => {
    const r = await inOldWorld(async (tx) => {
      const empty = await world(tx, 't629b6e');
      await tx.unsafe(BACKFILL);
      return { empty: await optionsOf(tx, empty.orgId) };
    });
    expect(r.empty.map((o) => o.name)).toEqual(['Cash', 'GCash', 'Maya', 'QRPH', 'Credit card', 'Debit card']);
    expect(r.empty.map((o) => o.kind)).toEqual(['cash', 'wallet', 'wallet', 'wallet', 'wallet', 'wallet']);
  });

  it('B3: two tenders of ONE store that map to one option STOP the migration, naming nothing silently merged', async () => {
    const err = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b3');
      await addTender(tx, { org: w.orgId, store: w.a, name: 'Gcash', kind: 'wallet', account: w.acctA });
      await addTender(tx, { org: w.orgId, store: w.a, name: 'G-Cash', kind: 'wallet', account: w.acctA });
      return tx.savepoint((sp) => sp.unsafe(BACKFILL)).then(() => null, (e: Error) => e);
    });
    expect(err, 'the backfill must refuse').not.toBeNull();
    expect(err!.message).toMatch(/T-629 STOP: store .* holds two tenders/);
  });

  it('B4: cash at one store and a wallet at another under one name STOP; so does a wallet named like one of Ian\'s cash options and the other way round', async () => {
    const e1 = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b4a');
      await addTender(tx, { org: w.orgId, store: w.a, name: 'Voucher', kind: 'cash' });
      await addTender(tx, { org: w.orgId, store: w.b, name: 'voucher', kind: 'wallet', account: w.acctB });
      return tx.savepoint((sp) => sp.unsafe(BACKFILL)).then(() => null, (e: Error) => e);
    });
    expect(e1?.message).toMatch(/T-629 STOP: org .* cash at one store and a wallet at another/);
    const e2 = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b4b');
      await addTender(tx, { org: w.orgId, store: w.a, name: 'Maya', kind: 'cash' });
      return tx.savepoint((sp) => sp.unsafe(BACKFILL)).then(() => null, (e: Error) => e);
    });
    expect(e2?.message).toMatch(/T-629 STOP: org .* wrong kind for the payment option of that name/);
  });

  it('B5: a store that holds Cash AND "Collected" (two cash tenders, by design: bible row 292) gets TWO cash options; nothing stops', async () => {
    const r = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b5');
      const cash = await addTender(tx, { org: w.orgId, store: w.a, name: 'Cash', kind: 'cash' });
      const collected = await addTender(tx, { org: w.orgId, store: w.a, name: 'Collected', kind: 'cash' });
      const cashB = await addTender(tx, { org: w.orgId, store: w.b, name: 'cash', kind: 'cash' });
      await tx.unsafe(BACKFILL);
      const t = await tx<{ id: string; name: string; payment_option_id: string }[]>`select id, name, payment_option_id from tenders where org_id = ${w.orgId}`;
      return { opts: await optionsOf(tx, w.orgId), t: new Map(t.map((x) => [x.id, x])), cash, collected, cashB };
    });
    const cashOptions = r.opts.filter((o) => o.kind === 'cash').map((o) => o.name).sort();
    expect(cashOptions).toEqual(['Cash', 'Collected']);
    expect(r.t.get(r.cash)!.payment_option_id, 'Cash at both stores is one option').toBe(r.t.get(r.cashB)!.payment_option_id);
    expect(r.t.get(r.collected)!.payment_option_id, 'Collected is its own option').not.toBe(r.t.get(r.cash)!.payment_option_id);
    expect(r.t.get(r.collected)!.name).toBe('Collected');
  });

  it('B8: a 45-character tender name becomes a 40-character option, the tender joins it and takes its name; SET NOT NULL then holds (the deploy does not fail)', async () => {
    const long = 'Lipa Branch Special Bank Transfer Account'.padEnd(45, 'X'); // 45 characters
    expect(long).toHaveLength(45);
    const r = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b8');
      const t = await addTender(tx, { org: w.orgId, store: w.a, name: long, kind: 'wallet', account: w.acctA });
      await tx.unsafe(BACKFILL);
      await tx`alter table tenders alter column payment_option_id set not null`; // what the migration does next: it must not fail
      const [row] = await tx<{ name: string; payment_option_id: string }[]>`select name, payment_option_id from tenders where id = ${t}`;
      const [opt] = await tx<{ name: string }[]>`select name from payment_options where id = ${row!.payment_option_id}`;
      return { row: row!, opt: opt! };
    });
    expect(r.opt.name).toBe(long.slice(0, 40));
    expect(r.row.name, 'the tender takes the option name').toBe(long.slice(0, 40));
  });

  it('B9: two different tenders whose names share their first 40 characters STOP with a clear message, not a raw unique error', async () => {
    const stem = 'Lipa Branch Special Bank Transfer Accoun'; // 40 characters
    expect(stem).toHaveLength(40);
    const err = await inOldWorld(async (tx) => {
      const w = await world(tx, 't629b9');
      await addTender(tx, { org: w.orgId, store: w.a, name: `${stem}t one`, kind: 'wallet', account: w.acctA });
      await addTender(tx, { org: w.orgId, store: w.b, name: `${stem}t two`, kind: 'wallet', account: w.acctB });
      return tx.savepoint((sp) => sp.unsafe(BACKFILL)).then(() => null, (e: Error) => e);
    });
    expect(err, 'the backfill must refuse').not.toBeNull();
    expect(err!.message).toMatch(/T-629 STOP: org .* two different tenders whose names are the same in their first 40 characters/);
    expect(err!.message).not.toMatch(/duplicate key|violates/);
  });

  it('B7: the migration prints nothing (no NOTICE or WARNING while the backfill runs)', async () => {
    const seen: string[] = [];
    const quiet = postgres(url!, { max: 1, onnotice: (n) => seen.push(String(n.message)) });
    try {
      await quiet.begin(async (tx) => {
        await tx`alter table tenders alter column payment_option_id drop not null`;
        await tx`alter table tenders disable trigger tenders_mirror_option`;
        await tx`update tenders set payment_option_id = null`;
        await tx`set local session_replication_role = replica`;
        await tx`delete from tenders`;
        await tx`delete from payment_options`;
        await tx`set local session_replication_role = origin`;
        await tx.unsafe(BACKFILL);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    } finally {
      await quiet.end({ timeout: 5 });
    }
    expect(seen).toEqual([]);
  });
});
