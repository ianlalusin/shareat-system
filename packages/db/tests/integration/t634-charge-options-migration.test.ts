/**
 * T-634 - migration 0287: the org's charge master list and the backfill of every existing store charge. `docs/tasks/634-central-charges.md`.
 *
 * As t629: the backfill is the DO block INSIDE the migration file; this test cuts that block out of the file and runs it on realistic old-shape rows (store charges
 * with no option), inside a transaction that is always rolled back, so what is proven is the migration's own text, not a copy of it. Raw SQL on the migration role.
 * Not run on the builder's PC (no database): CI runs it.
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

const FILE = readFileSync(resolve(__dirname, '..', '..', 'migrations', '0287_t634_charge_options.sql'), 'utf8');
const BACKFILL = FILE.slice(FILE.indexOf('DO $do$'), FILE.indexOf('$do$;') + '$do$;'.length);

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
class Rollback extends Error {}
type Tx = postgres.TransactionSql;

/** Puts the database in its pre-0287 shape inside a transaction (no options, store charges without one, no mirror trigger), runs `fn`, and always rolls back. */
async function inOldWorld<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await sql.begin(async (tx) => {
      await tx`alter table pos_charge_presets alter column charge_option_id drop not null`;
      await tx`alter table pos_charge_presets disable trigger pos_charge_presets_mirror_option`;
      // Other test files leave their own charges in this shared database; the backfill runs over every row, so a real STOP case from another file would stop
      // this one. Inside this always-rolled-back transaction only, take them out (FK checks off) so the world is exactly what the case builds.
      await tx`set local session_replication_role = replica`;
      await tx`delete from pos_charge_presets`;
      await tx`delete from charge_options`;
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
  const [person] = await tx<{ id: string }[]>`insert into persons (org_id, display_name) values (${org!.id}, 'Admin') returning id`;
  const lipa = await mkStore('Lipa');
  const batangas = await mkStore('Batangas');
  let minute = 0;
  /** An old-shape store charge (no option), each a minute after the last so "earliest" is unambiguous. */
  const old = async (store: string, name: string, amount: string, perUnit: boolean, status: 'active' | 'retired' = 'active') =>
    (
      await tx<{ id: string }[]>`
        insert into pos_charge_presets (org_id, store_id, name, amount, per_unit, status, created_by, created_at)
        values (${org!.id}, ${store}, ${name}, ${amount}, ${perUnit}, ${status}, ${person!.id}, now() - make_interval(mins => ${100 - ++minute})) returning id`
    )[0]!.id;
  return { orgId: org!.id, lipa, batangas, old };
}

const backfill = (tx: Tx) => tx.unsafe(BACKFILL);
const optionsOf = (tx: Tx, orgId: string) =>
  tx<{ id: string; name: string; amount: string; per_unit: boolean; status: string }[]>`
    select id, name, amount::text, per_unit, status from charge_options where org_id = ${orgId} order by name`;
const rowsOf = (tx: Tx, orgId: string) =>
  tx<{ id: string; store_id: string; charge_option_id: string | null; name: string; amount: string; per_unit: boolean; status: string }[]>`
    select id, store_id, charge_option_id, name, amount::text, per_unit, status from pos_charge_presets where org_id = ${orgId} order by created_at`;
const errorOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { message?: string } | null)?.message ?? 'no error';

describe('0287 backfill', () => {
  it('groups the same charge across stores by its normalised name into ONE option; every store row points at it and takes its spelling', async () => {
    const out = await inOldWorld(async (tx) => {
      const w = await world(tx, 't634b1');
      await w.old(w.lipa, 'Leftover', '100.00', true);
      await w.old(w.batangas, 'left-over', '100.00', true);
      await w.old(w.batangas, 'Extra griller', '150.00', false);
      await backfill(tx);
      return { options: await optionsOf(tx, w.orgId), rows: await rowsOf(tx, w.orgId) };
    });
    expect(out.options.map((o) => [o.name, o.amount, o.per_unit, o.status])).toEqual([
      ['Extra griller', '150.00', false, 'active'],
      ['Leftover', '100.00', true, 'active'],
    ]);
    const leftover = out.options.find((o) => o.name === 'Leftover')!;
    expect(out.rows.filter((r) => r.charge_option_id === leftover.id).map((r) => r.name)).toEqual(['Leftover', 'Leftover']); // "left-over" renamed
    expect(out.rows.every((r) => r.charge_option_id !== null)).toBe(true);
  });

  it('the same name at a DIFFERENT amount at two stores stops the deploy (RAISE), and so does once-per-bill against per-unit', async () => {
    for (const [amountB, perUnitB] of [['120.00', true], ['100.00', false]] as const) {
      const msg = await inOldWorld(async (tx) => {
        const w = await world(tx, 't634b2');
        await w.old(w.lipa, 'Leftover', '100.00', true);
        await w.old(w.batangas, 'Leftover', amountB, perUnitB);
        return errorOf(backfill(tx));
      });
      expect(msg).toMatch(/^T-634 STOP: org .* has the charge "Leftover" at different amounts/);
    }
  });

  it('two charges switched on at ONE store that are the same by name stop the deploy: two presets of one store are never merged', async () => {
    const msg = await inOldWorld(async (tx) => {
      const w = await world(tx, 't634b3');
      await w.old(w.lipa, 'Extra griller', '150.00', false);
      await w.old(w.lipa, 'Extra-griller', '150.00', false);
      return errorOf(backfill(tx));
    });
    expect(msg).toMatch(/^T-634 STOP: store .* has two charges switched on/);
  });

  it('retired history is not compared: an old retired price does not stop it, and the retired row joins the option at the current price', async () => {
    const out = await inOldWorld(async (tx) => {
      const w = await world(tx, 't634b4');
      const oldRow = await w.old(w.lipa, 'Leftover', '90.00', true, 'retired');
      await w.old(w.lipa, 'Leftover', '100.00', true);
      await w.old(w.batangas, 'Leftover', '100.00', true);
      await backfill(tx);
      return { options: await optionsOf(tx, w.orgId), rows: await rowsOf(tx, w.orgId), oldRow };
    });
    expect(out.options).toHaveLength(1);
    expect(out.options[0]).toMatchObject({ name: 'Leftover', amount: '100.00', status: 'active' });
    expect(out.rows.find((r) => r.id === out.oldRow)).toMatchObject({ charge_option_id: out.options[0]!.id, amount: '100.00', status: 'retired' });
  });

  it('a charge that is retired everywhere becomes a retired option', async () => {
    const out = await inOldWorld(async (tx) => {
      const w = await world(tx, 't634b5');
      await w.old(w.lipa, 'Corkage', '200.00', false, 'retired');
      await backfill(tx);
      return optionsOf(tx, w.orgId);
    });
    expect(out).toMatchObject([{ name: 'Corkage', amount: '200.00', status: 'retired' }]);
  });

  it('two orgs with the same charge name get one option each (the key is per org)', async () => {
    const out = await inOldWorld(async (tx) => {
      const a = await world(tx, 't634b6a');
      const b = await world(tx, 't634b6b');
      await a.old(a.lipa, 'Leftover', '100.00', true);
      await b.old(b.lipa, 'Leftover', '80.00', true);
      await backfill(tx);
      return [(await optionsOf(tx, a.orgId)).length, (await optionsOf(tx, b.orgId)).map((o) => o.amount)];
    });
    expect(out).toEqual([1, ['80.00']]);
  });
});
