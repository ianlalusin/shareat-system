/**
 * T-598 S10 - migration 0271: DEF-415 (clock_terminals revoke reason must be non-blank) and DEF-548 (shareat_app loses DELETE on trade_orders).
 * docs/tasks/598-open-defect-sweep.md S10. Real Postgres via TEST_DATABASE_URL.
 *
 *  M1  file `0271_*t598*.sql`, journal idx 271 on the grid after 0269, breakpoints true, first statement SET LOCAL lock_timeout = '5s'.
 *  M2  the CHECK refuses '' and '   ' and a NULL reason (the NULL-blind trap), accepts a real reason and an un-revoked row.
 *  M3  shareat_app has no DELETE on trade_orders (42501) but keeps SELECT, INSERT and UPDATE.
 *  M4  the pre-check raises naming the store code and terminal label when a blank row exists, FAILS CLOSED for a role RLS would filter, and the whole file replays on clean data.
 *
 * Every probe runs in a transaction that is ALWAYS rolled back.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const CHECK_NAME = 'clock_terminals_revoked_triple_check';
type PgErr = Error & { code?: string; constraint_name?: string };
type Tx = postgres.TransactionSql;
class Rollback extends Error {}
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

async function run<T>(fn: (tx: Tx) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: PgErr }> {
  let value: T | undefined;
  try {
    await sql.begin(async (tx) => {
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: true, value: value as T };
    return { ok: false, err: e as PgErr };
  }
  return { ok: true, value: value as T };
}
async function refused(fn: (tx: Tx) => Promise<unknown>, code: string, what: string): Promise<PgErr> {
  const o = await run(fn);
  if (o.ok) throw new Error(`${what}: expected SQLSTATE ${code} but the statement succeeded`);
  expect(o.err.code, `${what}: ${o.err.message}`).toBe(code);
  return o.err;
}
async function accepted(fn: (tx: Tx) => Promise<unknown>, what: string): Promise<void> {
  const o = await run(fn);
  if (!o.ok) throw new Error(`${what}: expected success but got ${o.err.code}: ${o.err.message}`);
}

const file = readdirSync(MIGRATIONS).find((f) => /^0271_.*t598.*\.sql$/.test(f));
const statements = (): string[] => readFileSync(join(MIGRATIONS, file!), 'utf8').split('--> statement-breakpoint');
const preCheckIndex = (): number => statements().findIndex((s) => /DO \$\$/.test(s));

async function world() {
  const code = uid('t598s10');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string; code: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Store') returning id, code`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  return { orgId, store: store!, personId: person!.id };
}
type World = Awaited<ReturnType<typeof world>>;
/** A clock terminal row; no `reason` key leaves it un-revoked, any value (including null and '') revokes it with that reason. */
const terminal = (tx: Tx, w: World, o: { reason?: string | null } = {}) => {
  const revoked = 'reason' in o;
  return tx<{ id: string; label: string }[]>`
    insert into clock_terminals (org_id, store_id, label, firebase_uid, revoked_at, revoked_by, revoke_reason)
    values (${w.orgId}, ${w.store.id}, ${uid('Tablet')}, ${uid('uid')}, ${revoked ? new Date() : null}, ${revoked ? w.personId : null}, ${o.reason ?? null})
    returning id, label`;
};

describe('T-598 S10 migration 0271 - files and journal', () => {
  it('M1: the file exists, the journal entry is on the grid after 0269, lock_timeout comes first', () => {
    expect(file, 'a file 0271_*t598*.sql').toBeDefined();
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string; breakpoints: boolean }[];
    };
    const prev = journal.entries.find((x) => x.idx === 269)!;
    const e = journal.entries.find((x) => x.idx === 271)!;
    expect(e.tag).toBe(file!.replace(/\.sql$/, ''));
    expect(e.when).toBe(prev.when + 2 * 86_400_000);
    expect(e.breakpoints).toBe(true);
    expect(statements()[0]).toMatch(/SET LOCAL lock_timeout = '5s'/);
  });
});

describe('T-598 S10 migration 0271 - DEF-415 the revoke-reason CHECK', () => {
  it('M2: the CHECK is validated and carries a non-blank clause tied to revoke_reason', async () => {
    const [r] = await sql<{ convalidated: boolean; def: string }[]>`
      select convalidated, pg_get_constraintdef(oid) as def from pg_constraint where conname = ${CHECK_NAME} and conrelid = 'clock_terminals'::regclass`;
    expect(r, `constraint ${CHECK_NAME}`).toBeDefined();
    expect(r!.convalidated).toBe(true);
    expect(r!.def).toMatch(/revoke_reason IS NOT NULL\)\s*AND\s*\(btrim\(revoke_reason\)\s*<>\s*''/i);
  });

  it("M2: a revoke with '   ', '' or NULL as its reason is refused (23514; the NULL case is the blind trap); a real reason and an un-revoked row pass", async () => {
    const w = await world();
    for (const reason of ['   ', '', null]) {
      const e = await refused((tx) => terminal(tx, w, { reason }), '23514', `insert revoked with ${JSON.stringify(reason)}`);
      expect(e.constraint_name).toBe(CHECK_NAME);
    }
    const e2 = await refused(
      async (tx) => {
        const [t] = await terminal(tx, w);
        await tx`update clock_terminals set revoked_at = now(), revoked_by = ${w.personId}, revoke_reason = '  ' where id = ${t!.id}`;
      },
      '23514',
      'update to a blank revoke',
    );
    expect(e2.constraint_name).toBe(CHECK_NAME);
    await accepted((tx) => terminal(tx, w, { reason: 'Tablet lost at the Lipa store' }), 'valid revoke');
    await accepted((tx) => terminal(tx, w), 'un-revoked');
  });
});

describe('T-598 S10 migration 0271 - DEF-548 trade_orders DELETE', () => {
  it('M3: shareat_app cannot DELETE from trade_orders (42501) but keeps SELECT, INSERT and UPDATE', async () => {
    const [p] = await sql<{ d: boolean; s: boolean; u: boolean; i: boolean }[]>`
      select has_table_privilege('shareat_app', 'trade_orders', 'DELETE') as d, has_table_privilege('shareat_app', 'trade_orders', 'SELECT') as s,
             has_table_privilege('shareat_app', 'trade_orders', 'UPDATE') as u, has_table_privilege('shareat_app', 'trade_orders', 'INSERT') as i`;
    expect(p).toEqual({ d: false, s: true, u: true, i: true });
    // `where false` matches no row: the refusal is the privilege check at the statement, not a row-level outcome.
    await refused(
      async (tx) => {
        await tx.unsafe('set local role shareat_app');
        await tx`delete from trade_orders where false`;
      },
      '42501',
      'shareat_app delete on trade_orders',
    );
  });
});

describe('T-598 S10 migration 0271 - the pre-check', () => {
  /** Inside a rolled-back transaction: take the CHECK off so a blank row can exist, as it could on a database that predates it. */
  const unguard = (tx: Tx) => tx.unsafe(`alter table clock_terminals drop constraint ${CHECK_NAME}`);
  /** Statements up to and including the DO block: lock_timeout, row_security off, the count. */
  const preflight = () => statements().slice(0, preCheckIndex() + 1);

  it('M4: a blank-reason revoked terminal makes the pre-check raise, naming the store code and the terminal label', async () => {
    const w = await world();
    let label = '';
    const e = await refused(
      async (tx) => {
        await unguard(tx);
        const [t] = await terminal(tx, w, { reason: '   ' });
        label = t!.label;
        for (const s of preflight()) if (s.trim()) await tx.unsafe(s);
      },
      '23514',
      'pre-check on a blank reason',
    );
    expect(e.message).toContain('0271 refused');
    expect(e.message).toContain(`${w.store.code} / "${label}"`);
    expect(e.message).toMatch(/Nothing was changed\.$/);
  });

  it('M4: the pre-check FAILS CLOSED for a role RLS would filter: an error, never a quiet zero', async () => {
    const w = await world();
    const e = await refused(
      async (tx) => {
        await unguard(tx);
        await terminal(tx, w, { reason: '   ' });
        await tx.unsafe('set local role shareat_app');
        for (const s of preflight()) if (s.trim()) await tx.unsafe(s);
      },
      '42501',
      'pre-check as shareat_app',
    );
    expect(e.message).toMatch(/row-level security/i);
  });

  it('M4: on clean data the whole file replays: the CHECK comes back and DELETE on trade_orders is gone', async () => {
    const w = await world();
    const o = await run(async (tx) => {
      await terminal(tx, w, { reason: 'Lost' });
      await tx.unsafe('grant delete on trade_orders to shareat_app');
      for (const s of statements()) if (s.trim()) await tx.unsafe(s);
      const [r] = await tx<{ c: string; d: boolean }[]>`
        select (select count(*) from pg_constraint where conname = ${CHECK_NAME} and convalidated) as c,
               has_table_privilege('shareat_app', 'trade_orders', 'DELETE') as d`;
      return { c: Number(r!.c), d: r!.d };
    });
    if (!o.ok) throw new Error(`replay failed: ${o.err.code}: ${o.err.message}`);
    expect(o.value).toEqual({ c: 1, d: false });
  });
});
