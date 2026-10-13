/**
 * T-402 S1a - the MIGRATION itself, against pre-existing rows. `docs/tasks/402-activity-log.md`, Contract section 3
 * steps 2-4, Invariants 13 and 13a (and the copy half of 14).
 *
 * TESTER, not BUILDER. Mechanism (same as `attendance-credentials-scan-collision-migration.test.ts`): a temp copy of
 * `migrations/` holding every migration BEFORE the one tagged `*_t402_*` (filtered by journal `when`, not file
 * name), applied to a scratch database; old-shape `audit_log` rows are seeded with raw SQL; then the real folder is
 * applied (the t402 migration and anything after it). The seeded scratch database is cloned with `TEMPLATE` so the
 * three scenarios (happy copy, unlisted action, forced count mismatch) share one slow migration run.
 *
 * ## State at HEAD
 * No journal entry is tagged `_t402_` (the migration does not exist): `beforeAll` throws
 * "T-402 S1a: ... does not exist", so EVERY leg here is red for that one reason, which is the honest failure for a
 * migration test. Once it exists each leg asserts its own thing (mutant named beside it).
 *
 * ## What the BUILDER must match
 *  - the migration file/journal tag contains `_t402_` (Contract 3: `0NNN_t402_activity_log.sql`);
 *  - a seeded `set_supplier_bank_account` row keeps no 8+ digit run in before/after; the masked value shows the last
 *    4 digits; `<key>Changed` (`bankAccountNumberChanged`) true|false sits in `after` or `before` (R5);
 *  - an action outside the migration's VALUES list RAISEs (the whole migration rolls back; audit_log stays a plain
 *    table with every row); a copied count that differs from the source count RAISEs the same way;
 *  - the migration runs as the OWNER connection and must read the old table with row security effectively off for
 *    itself (FORCE RLS applies to a non-BYPASSRLS owner: without it `select count(*)` and the copy both read 0 and
 *    the count check would agree with itself). The test role is a superuser, so this leg cannot prove it - it is
 *    named here so the builder does not rely on it (0166's `set local row_security = off` pattern fails loudly).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

config({ path: '.env.local' });

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(baseUrl)) {
  throw new Error(`Refusing to run against ${baseUrl.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const REAL_MIGRATIONS_FOLDER = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
const TARGET_TAG = /_t402_/;

type Sql = ReturnType<typeof postgres>;
class Rollback extends Error {}

function adminUrl(): string {
  const u = new URL(baseUrl!);
  u.pathname = '/postgres';
  return u.toString();
}
function dbUrl(name: string): string {
  const u = new URL(baseUrl!);
  u.pathname = `/${name}`;
  return u.toString();
}
async function admin(fn: (a: Sql) => Promise<unknown>) {
  const a = postgres(adminUrl(), { max: 1 });
  try {
    await fn(a);
  } finally {
    await a.end();
  }
}

/** Every migration strictly before the t402 one (by journal `when`), in a temp folder. Throws if it does not exist yet. */
function buildFolderBeforeTarget(): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'));
  const target = journal.entries.find((e: { tag: string }) => TARGET_TAG.test(e.tag));
  if (!target) {
    throw new Error('T-402 S1a: no journal entry is tagged "*_t402_*" - the activity-log storage migration (0NNN_t402_activity_log.sql) does not exist yet.');
  }
  const kept = journal.entries.filter((e: { when: number }) => e.when < target.when);
  const keptTags = new Set(kept.map((e: { tag: string }) => e.tag));
  const dir = mkdtempSync(join(tmpdir(), 'shareat-migrations-pre-t402-'));
  mkdirSync(join(dir, 'meta'));
  for (const f of readdirSync(REAL_MIGRATIONS_FOLDER)) {
    if (f.endsWith('.sql') && keptTags.has(f.slice(0, -4))) writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_FOLDER, f)));
  }
  journal.entries = kept;
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

const RUN = Date.now();
const DB = {
  base: `shareat_scratch_t402_base_${RUN}`,
  happy: `shareat_scratch_t402_happy_${RUN}`,
  unlisted: `shareat_scratch_t402_unlisted_${RUN}`,
  mismatch: `shareat_scratch_t402_mismatch_${RUN}`,
};

// The 22 action strings of the 20 existing call sites (spec Source), byte-identical.
const ACTIONS = [
  'reopen_pin_sign_in',
  'set_supplier_credit_terms', 'set_supplier_status', 'set_supplier_bank_account', 'set_supplier_counterparty_store',
  'set_channel_payout', 'set_customer_status',
  'change_item_base_unit', 'set_item_purchase_unit', 'rename_item', 'retire_item', 'restore_item',
  'set_staff_code', 'link_store_to_pos', 'unlink_store_from_pos',
  'create_tender', 'update_tender', 'reactivate_tender', 'retire_tender',
  'edit_sales_day', 'reimport_sales_day', 'set_platform_sales',
] as const;

const BANK_BEFORE = { bankName: 'BDO', bankAccountName: 'Acme', bankAccountNumber: '001234567890' };
const BANK_AFTER_CHANGED = { bankName: 'BDO', bankAccountName: 'Acme', bankAccountNumber: '009876543210' };
const BANK_BEFORE_SAME = { bankName: 'BDO', bankAccountName: 'Acme', bankAccountNumber: '001234567890' };
const BANK_AFTER_SAME = { bankName: 'BDO', bankAccountName: 'Acme Inc', bankAccountNumber: '001234567890' };

interface Seed {
  orgA: string;
  orgB: string;
  storeA1: string;
  storeA2: string;
  storeB: string;
  ids: Record<string, string>; // label -> audit_log id
  all: string[];
  perAction: Record<string, number>;
  total: number;
}
let seed: Seed;
let preFolder: string;

async function seedOldRows(s: Sql): Promise<Seed> {
  const code = (p: string) => `${p}-${RUN}`;
  const [oa] = await s<{ id: string }[]>`insert into organizations (name, code) values ('Org A', ${code('a')}) returning id`;
  const [ob] = await s<{ id: string }[]>`insert into organizations (name, code) values ('Org B', ${code('b')}) returning id`;
  const orgA = oa!.id;
  const orgB = ob!.id;
  const [a1] = await s<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgA}, 'A1', 'A One') returning id`;
  const [a2] = await s<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgA}, 'A2', 'A Two') returning id`;
  const [b1] = await s<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgB}, 'B1', 'B One') returning id`;
  const [pa] = await s<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA}, 'Alice') returning id`;
  const ids: Record<string, string> = {};
  const all: string[] = [];
  const perAction: Record<string, number> = {};
  const add = async (label: string, action: string, before: unknown, after: unknown, occurredAt = '2026-03-10T05:00:00Z', org = orgA) => {
    const id = randomUUID();
    await s`
      insert into audit_log (id, org_id, actor_person_id, action, entity, entity_id, before, after, source, occurred_at)
      values (${id}, ${org}, ${org === orgA ? pa!.id : null}, ${action}, 'things', ${randomUUID()}, ${before === null ? null : JSON.stringify(before)}::jsonb,
              ${after === null ? null : JSON.stringify(after)}::jsonb, 'web', ${occurredAt}::timestamptz)`;
    ids[label] = id;
    all.push(id);
    perAction[action] = (perAction[action] ?? 0) + 1;
  };
  for (const action of ACTIONS) {
    if (action === 'set_supplier_bank_account') await add(action, action, BANK_BEFORE, BANK_AFTER_CHANGED);
    else await add(action, action, { v: 1 }, { v: 2 });
  }
  // store_id backfill (Contract 3 step 3): only from a store of the row's OWN org.
  await add('store_after_same_org', 'rename_item', null, { storeId: a1!.id });
  await add('store_before_same_org', 'retire_item', { storeId: a2!.id }, { v: 2 });
  await add('store_other_org', 'restore_item', null, { storeId: b1!.id });
  // masked copy (R5, 13a)
  await add('bank_changed', 'set_supplier_bank_account', BANK_BEFORE, BANK_AFTER_CHANGED);
  await add('bank_same_number', 'set_supplier_bank_account', BANK_BEFORE_SAME, BANK_AFTER_SAME);
  // time: the minimum Manila year present, and the Manila-vs-UTC edge
  await add('year_2025', 'set_staff_code', { v: 1 }, { v: 2 }, '2025-06-15T04:00:00Z');
  await add('manila_new_year', 'set_staff_code', { v: 1 }, { v: 2 }, '2025-12-31T20:00:00Z'); // 2026-01-01 04:00 Manila
  await add('year_2026', 'set_staff_code', { v: 1 }, { v: 2 }, '2026-06-15T04:00:00Z');
  return { orgA, orgB, storeA1: a1!.id, storeA2: a2!.id, storeB: b1!.id, ids, all, perAction, total: all.length };
}

async function applyRest(s: Sql) {
  await migrate(drizzle(s), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
}
const kindOfAuditLog = async (s: Sql) =>
  (await s<{ relkind: string }[]>`select relkind from pg_class where oid = 'public.audit_log'::regclass`)[0]!.relkind;
const countAuditLog = async (s: Sql) => (await s<{ c: number }[]>`select count(*)::int as c from audit_log`)[0]!.c;

beforeAll(async () => {
  preFolder = buildFolderBeforeTarget(); // throws while the migration does not exist: every leg red for that reason
  await admin(async (a) => {
    await a.unsafe(`DROP DATABASE IF EXISTS "${DB.base}"`);
    await a.unsafe(`CREATE DATABASE "${DB.base}"`);
  });
  const s = postgres(dbUrl(DB.base), { max: 1 });
  try {
    await migrate(drizzle(s), { migrationsFolder: preFolder });
    seed = await seedOldRows(s);
  } finally {
    await s.end();
  }
  await admin(async (a) => {
    for (const name of [DB.happy, DB.unlisted, DB.mismatch]) {
      await a.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await a.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${DB.base}"`);
    }
  });
}, 600_000);

afterAll(async () => {
  if (preFolder) rmSync(preFolder, { recursive: true, force: true });
  await admin(async (a) => {
    for (const name of Object.values(DB)) await a.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
  });
}, 180_000);

// =================================================================================================
describe('S1a invariant 13 / 13a - the copy: every row, labelled, masked, store-backfilled, partitioned', () => {
  let s: Sql;
  beforeAll(async () => {
    s = postgres(dbUrl(DB.happy), { max: 2 });
    await applyRest(s);
  }, 300_000);
  afterAll(async () => {
    await s?.end();
  });

  it('audit_log is partitioned now, and every seeded row survived with its id (count check, 22 actions + extras)', async () => {
    expect(await kindOfAuditLog(s)).toBe('p');
    expect(await countAuditLog(s)).toBe(seed.total);
    const rows = await s<{ id: string }[]>`select id from audit_log`;
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(seed.all));
  });

  it('per-action row counts old == new for every one of the 22 actions (the rehearsal comparison of Contract 3 step 7)', async () => {
    const rows = await s<{ action: string; c: number }[]>`select action, count(*)::int as c from audit_log group by action`;
    expect(Object.fromEntries(rows.map((r) => [r.action, r.c]))).toEqual(seed.perAction);
    expect(Object.keys(seed.perAction).sort()).toEqual([...ACTIONS].sort());
  });

  it('every copied row has a category, a sensitivity bound to its severity, and a retention class obeying R7 (no row defaulted blindly)', async () => {
    const rows = await s<{ id: string; category: string; sensitivity: string; severity: number; retention_class: string }[]>`
      select id, category, sensitivity, severity, retention_class from audit_log`;
    const sev: Record<string, number> = { critical: 2, high: 4, normal: 5, low: 6 };
    for (const r of rows) {
      expect(['security', 'order', 'money', 'menu_price', 'stock', 'staff', 'settings', 'data', 'customer'], r.id).toContain(r.category);
      expect(sev[r.sensitivity], `${r.id}: ${r.sensitivity}`).toBe(r.severity);
      const mustBeLong = ['money', 'order', 'menu_price', 'customer'].includes(r.category) || r.sensitivity !== 'low';
      if (mustBeLong) expect(r.retention_class, `${r.category}/${r.sensitivity}`).toBe('r10y');
    }
    const reopen = rows.find((r) => r.id === seed.ids['reopen_pin_sign_in']);
    expect(reopen?.category, 'reopen_pin_sign_in is a security event (R3)').toBe('security');
  });

  it('recorded_at = occurred_at for every copied row (R1 + Contract 3 step 3)', async () => {
    const [r] = await s<{ bad: number }[]>`select count(*)::int as bad from audit_log where recorded_at <> occurred_at`;
    expect(r!.bad).toBe(0);
  });

  it('partitions start at the minimum Manila year present (2025) for BOTH classes: a 2025 row routes, and the Manila edge row is in 2026 (mutant: UTC years)', async () => {
    const leaf = async (label: string) =>
      (await s<{ leaf: string }[]>`select tableoid::regclass::text as leaf from audit_log where id = ${seed.ids[label]!}`)[0]!.leaf;
    const l2025 = await leaf('year_2025');
    const lEdge = await leaf('manila_new_year');
    const l2026 = await leaf('year_2026');
    expect(l2025).not.toBe(l2026);
    expect(lEdge, '2025-12-31T20:00Z is 2026-01-01 04:00 in Manila').toBe(l2026);
    for (const retention of ['r10y', 'r2y']) {
      let err: Error | undefined;
      try {
        await s.begin(async (t) => {
          await t`
            insert into audit_log (org_id, action, entity, entity_id, source, category, sensitivity, severity, retention_class, recorded_at, occurred_at)
            values (${seed.orgA}, 'x', 'y', ${randomUUID()}, 'web', 'security', 'low', 6, ${retention}, '2025-07-01T00:00:00+08', '2025-07-01T00:00:00+08')`;
          throw new Rollback();
        });
      } catch (e) {
        if (!(e instanceof Rollback)) err = e as Error;
      }
      expect(err?.message, `a ${retention} partition for 2025 must exist`).toBeUndefined();
    }
  });

  it('store_id is backfilled from after.storeId / before.storeId ONLY when the store belongs to the row\'s org (mutant: cross-org store accepted)', async () => {
    const storeOf = async (label: string) =>
      (await s<{ store_id: string | null }[]>`select store_id from audit_log where id = ${seed.ids[label]!}`)[0]!.store_id;
    expect(await storeOf('store_after_same_org')).toBe(seed.storeA1);
    expect(await storeOf('store_before_same_org')).toBe(seed.storeA2);
    expect(await storeOf('store_other_org'), 'org A row naming org B\'s store -> null').toBeNull();
    expect(await storeOf('reopen_pin_sign_in'), 'no storeId in the payload -> null').toBeNull();
  });

  it('set_supplier_bank_account rows are MASKED on copy: no 8+ digit run, last 4 digits kept, the Changed flag computed from the unmasked pair (13a)', async () => {
    const bankRows = await s<{ id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]>`
      select id, before, after from audit_log where action = 'set_supplier_bank_account'`;
    expect(bankRows.length).toBe(seed.perAction['set_supplier_bank_account']);
    for (const r of bankRows) {
      const text = JSON.stringify({ b: r.before, a: r.after });
      expect(text, `row ${r.id} still carries a full account number`).not.toMatch(/\d{8,}/);
    }
    const flag = (r: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) =>
      (r.after?.bankAccountNumberChanged ?? r.before?.bankAccountNumberChanged) as boolean | undefined;
    const changed = bankRows.find((r) => r.id === seed.ids['bank_changed'])!;
    expect(JSON.stringify(changed.before)).toContain('7890');
    expect(JSON.stringify(changed.after)).toContain('3210');
    expect(flag(changed), 'number changed 001234567890 -> 009876543210').toBe(true);
    const same = bankRows.find((r) => r.id === seed.ids['bank_same_number'])!;
    expect(JSON.stringify(same.after)).toContain('7890');
    expect(flag(same), 'only the account NAME changed; the number is the same').toBe(false);
    expect(same.after?.bankAccountName, 'non-secret keys are untouched').toBe('Acme Inc');
  });

  it('set_staff_code is labelled security/high (a credential change) and reopen_pin_sign_in stays security/high, both r10y', async () => {
    const rows = await s<{ id: string; category: string; sensitivity: string; retention_class: string }[]>`
      select id, category, sensitivity, retention_class from audit_log where id in (${seed.ids['set_staff_code']!}, ${seed.ids['reopen_pin_sign_in']!})`;
    const by = (label: string) => rows.find((r) => r.id === seed.ids[label]);
    expect(by('set_staff_code')).toMatchObject({ category: 'security', sensitivity: 'high', retention_class: 'r10y' });
    expect(by('reopen_pin_sign_in')).toMatchObject({ category: 'security', sensitivity: 'high', retention_class: 'r10y' });
  });

  it('the old table is gone and the new parent carries what 0167/0168 gave the old one: two policies, trigger ENABLE ALWAYS everywhere, app SELECT+INSERT only', async () => {
    const pols = await s<{ polname: string }[]>`select polname from pg_policy where polrelid = 'public.audit_log'::regclass order by polname`;
    expect(pols.map((p) => p.polname)).toEqual(['audit_log_org_append', 'audit_log_org_read']);
    const trig = await s<{ relname: string; tgenabled: string }[]>`
      select c.relname, g.tgenabled from pg_trigger g join pg_class c on c.oid = g.tgrelid
      where g.tgname = 'audit_log_append_only' and c.relnamespace = 'public'::regnamespace`;
    expect(trig.length, 'the trigger exists on the parent and on every partition').toBeGreaterThanOrEqual(1 + 2 + 6);
    expect(trig.filter((t) => t.tgenabled !== 'A').map((t) => t.relname)).toEqual([]);
    const roleName = (await s<{ r: string }[]>`select rolname as r from pg_roles where rolname = 'shareat_app'`)[0]?.r;
    const held = [];
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
      if ((await s<{ ok: boolean }[]>`select has_table_privilege(${roleName!}, 'public.audit_log', ${p}) as ok`)[0]!.ok) held.push(p);
    expect(held).toEqual(['SELECT', 'INSERT']);
  });
});

// =================================================================================================
describe('S1a invariant 13 - the migration REFUSES an action it has no label for (mutant: unlisted action defaulted to normal)', () => {
  it('a row with an unknown action aborts the whole migration; audit_log stays the plain table with every row', async () => {
    const s = postgres(dbUrl(DB.unlisted), { max: 1 });
    try {
      await s`
        insert into audit_log (org_id, action, entity, entity_id, source)
        values (${seed.orgA}, 'bogus_unlisted_action', 'things', ${randomUUID()}, 'web')`;
      await expect(applyRest(s)).rejects.toThrow();
      expect(await kindOfAuditLog(s), 'rolled back: still a plain table').toBe('r');
      expect(await countAuditLog(s)).toBe(seed.total + 1);
      const cols = await s<{ c: string }[]>`select column_name as c from information_schema.columns where table_name = 'audit_log' and column_name = 'category'`;
      expect(cols, 'no category column leaked out of the rolled-back migration').toEqual([]);
    } finally {
      await s.end();
    }
  }, 300_000);
});

describe('S1a invariant 13a - a forced copy-count mismatch RAISEs (mutant: plain copy, no count check)', () => {
  it('rows silently dropped on the way in (a BEFORE INSERT trigger the test plants on every new partition) abort the migration', async () => {
    const s = postgres(dbUrl(DB.mismatch), { max: 1 });
    try {
      // The only way to make a correct INSERT ... SELECT lose rows from OUTSIDE the migration: an event trigger that
      // gives every NEW audit_log partition a BEFORE INSERT row trigger swallowing 'rename_item' rows.
      await s.unsafe(`
        create function t402_swallow_fn() returns trigger language plpgsql as $$
        begin if new.action = 'rename_item' then return null; end if; return new; end $$`);
      await s.unsafe(`
        create function t402_evt() returns event_trigger language plpgsql as $$
        declare r record;
        begin
          for r in select objid, object_identity from pg_event_trigger_ddl_commands() where command_tag = 'CREATE TABLE' loop
            if exists (select 1 from pg_class c where c.oid = r.objid and c.relispartition and c.relkind = 'r') then
              execute format('create trigger t402_swallow before insert on %s for each row execute function t402_swallow_fn()', r.object_identity);
            end if;
          end loop;
        end $$`);
      await s.unsafe(`create event trigger t402_evt on ddl_command_end when tag in ('CREATE TABLE') execute function t402_evt()`);

      let message = '';
      try {
        await applyRest(s);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, 'the migration must RAISE when the copied count differs from the source count').not.toBe('');
      expect(message).toMatch(/count|mismatch|copied|rows/i);
      expect(await kindOfAuditLog(s), 'rolled back: still a plain table').toBe('r');
      expect(await countAuditLog(s)).toBe(seed.total);
    } finally {
      await s.end();
    }
  }, 300_000);
});
