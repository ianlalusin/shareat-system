import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * T-391 S3 audit legs (TESTER, round 3). docs/tasks/391-production-master-data-load.md R2, R8, R16 + rulings of 2026-10-11:
 *  1. `master-data run --actor <uuid>` WITHOUT --apply calls applyItems({apply:false}): the real, rolled-back dry run. A write-time
 *     failure (here: the actor lacks approve_item) therefore shows in the dry run; counts are printed; nothing is committed.
 *  2. With --apply the output never says "DRY RUN" / "nothing written", and the sheets are not rewritten from the PRE-apply plan.
 *  3. setItemPurchaseUnit takes an optional audit source; the apply passes 'etl' (a load's rows say etl; a screen call stays 'web').
 *  4. A buying-unit factor with more than 6 decimals on a sheet is HELD by the planner (a named row), never a late throw.
 *  5. --actor that is not a UUID is refused with a plain message (no raw Postgres error).
 *  6. A held race INSIDE the apply (the plan changed while it waited for the org lock) exits 2, like the pre-check.
 * Each runs the real CLI (npx tsx scripts/master-data.ts) against the gate database.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { parseStoreMap } from '../../../etl/src/master-data/store-map';
import { ITEM_SHEET_COLUMNS, planItems } from '../../../etl/src/master-data/items-plan';
import { toCsv } from '../../../etl/src/master-data/sheets';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
const sql = postgres(url, { max: 5 });
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();
const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';

async function mkEnv(hint: string) {
  const orgCode = uid(`C${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${orgCode}`}, ${orgCode}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'S') returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const superId = await mk('Super', 'super_admin');
  const adminId = await mk('Admin', 'admin');
  const mapText = [
    'v1_store_id,name,role,org_code,store_code',
    `${L},SharEat Lipa,own,${orgCode},LIPA`,
    `${M},SharEat Malvar,own,${orgCode},MLVR`,
  ].join('\r\n');
  return { orgId, orgCode, superId, adminId, mapText, map: parseStoreMap(mapText), superA: { orgId, personId: superId } as Actor };
}
type Env = Awaited<ReturnType<typeof mkEnv>>;

let rid = 0;
const rec = (store: string, name: string, baseUnit = 'kg', kind = 'raw_material', extra: Record<string, unknown> = {}) => ({
  id: `c${++rid}`, store, name, kind, baseUnit, ...extra,
});
const snap = (items: Any[]): Any => ({ version: 1, stores: [], items, suppliers: [], arCustomers: [], staff: [], staffIdentities: [] });

/** Everything the CLI reads, in a fresh directory OUTSIDE the work tree. */
function inputs(e: Env, snapshot: Any) {
  const dir = mkdtempSync(join(tmpdir(), 't391-s3-cli-'));
  const snapPath = join(dir, 'v1-snapshot.json');
  const text = JSON.stringify(snapshot);
  writeFileSync(snapPath, text);
  writeFileSync(join(dir, 'v1-snapshot.sha256'), createHash('sha256').update(text).digest('hex'));
  const mapPath = join(dir, 'stores.csv');
  writeFileSync(mapPath, e.mapText);
  const sheets = join(dir, 'sheets');
  return { dir, snapPath, mapPath, sheets };
}
const argv = (e: Env, i: ReturnType<typeof inputs>, extra: string[]) =>
  ['tsx', 'scripts/master-data.ts', 'run', '--snapshot', i.snapPath, '--map', i.mapPath, '--org', e.orgId, '--org-code', e.orgCode, '--sheets', i.sheets, ...extra];
const childEnv = () => ({ ...process.env, DATABASE_URL: url });

function cli(e: Env, i: ReturnType<typeof inputs>, extra: string[]) {
  const r = spawnSync('npx', argv(e, i, extra), { cwd: REPO_ROOT, env: childEnv(), encoding: 'utf8', shell: true, timeout: 150_000 });
  return { status: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}`, all: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const counts = async (orgId: string) => ({
  items: Number((await sql<Any[]>`select count(*)::int n from items where org_id = ${orgId}`)[0]!.n),
  links: Number((await sql<Any[]>`select count(*)::int n from v1_master_links where org_id = ${orgId}`)[0]!.n),
  audit: Number((await sql<Any[]>`select count(*)::int n from audit_log where org_id = ${orgId}`)[0]!.n),
  counters: (await sql<Any[]>`select stem, last_seq from item_code_counters where org_id = ${orgId} order by stem`).map((r) => `${r.stem}:${r.last_seq}`),
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const boxSnap = () =>
  snap([
    rec(L, 'Paper Cups', 'box', 'supply', { purchaseUnit: 'pcs', conversionFactor: 24 }),
    rec(M, 'Paper Cups', 'box', 'supply', { purchaseUnit: 'pcs', conversionFactor: 24 }),
  ]);

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('1 - the CLI dry run with --actor is the real rolled-back dry run', () => {
  it(
    'an actor without approve_item FAILS the dry run (the domain gate ran), nothing committed. Killing mutant: the CLI dry run only plans and never calls applyItems({apply:false})',
    () => {
      return (async () => {
        const e = await mkEnv('D1');
        const i = inputs(e, snap([rec(L, 'Flour')]));
        const before = await counts(e.orgId);
        const r = cli(e, i, ['--actor', e.adminId]);
        expect(r.status).not.toBe(0);
        expect(r.all).toMatch(/approve|not allowed|permission|authori[sz]/i);
        expect(await counts(e.orgId)).toEqual(before);
      })();
    },
    180_000,
  );

  it(
    'a permitted actor: exit 0, the printed counts are the dry run\'s (2 items, 3 links), nothing committed, no audit row. Killing mutant: the dry run commits; the counts come from the planner not the transaction',
    async () => {
      const e = await mkEnv('D2');
      const i = inputs(e, snap([rec(L, 'Flour'), rec(L, 'Salt'), rec(M, 'Salt')]));
      const before = await counts(e.orgId);
      const r = cli(e, i, ['--actor', e.superId]);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/dry run/i);
      expect(r.out).toMatch(/\b2\b[^\n]*item/i);
      expect(r.out).toMatch(/\b3\b[^\n]*link/i);
      expect(r.out).not.toMatch(/APPLIED/);
      expect(await counts(e.orgId)).toEqual(before);
    },
    180_000,
  );
});

describe('2 - --apply speaks as an apply and does not rewrite the sheets from the pre-apply plan', () => {
  it(
    'output has neither "DRY RUN" nor "nothing written"; Ian\'s answered sheet keeps his note or the resolved row is gone, never the pre-apply planner row. Killing mutant: the pre-apply sheet rewrite and DRY RUN line left in before the apply',
    async () => {
      const e = await mkEnv('A2');
      const s = boxSnap();
      const i = inputs(e, s);
      const first: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing: [], links: [], answers: {} } as Any);
      const row = { ...first.sheets['items-box'][0], inside_unit: 'pcs', how_many: '24', note: 'IAN-NOTE' };
      expect(row.item).toBe('Paper Cups');
      const sheetPath = join(i.sheets, 'items-box.csv');
      mkdirSync(i.sheets, { recursive: true });
      writeFileSync(sheetPath, toCsv(ITEM_SHEET_COLUMNS['items-box'], [row]));

      const r = cli(e, i, ['--actor', e.superId, '--apply']);
      expect(r.status).toBe(0);
      expect(r.out).not.toMatch(/DRY RUN/i);
      expect(r.out).not.toMatch(/nothing (was )?written/i);
      expect(r.out).toMatch(/APPLIED|applied/);
      expect((await counts(e.orgId)).items).toBe(1);
      expect(existsSync(sheetPath)).toBe(true);
      const after = readFileSync(sheetPath, 'utf8');
      expect(after.includes('IAN-NOTE') || !after.includes('Paper Cups')).toBe(true);
    },
    180_000,
  );
});

describe('3 - the buying-unit audit source', () => {
  it(
    'a load\'s set_item_purchase_unit row carries source etl; a direct (screen) call stays web. Killing mutant: the apply passes no source (rows say web)',
    async () => {
      const e = await mkEnv('S3');
      const s = boxSnap();
      const first: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing: [], links: [], answers: {} } as Any);
      const answers = { 'items-box': [{ ...first.sheets['items-box'][0], inside_unit: 'pcs', how_many: '24' }] };
      const { applyItems } = (await import('../../../../scripts/lib/master-data-apply')) as Any;
      await applyItems({ snapshot: s, snapshotSha: 'a'.repeat(64), map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers, actor: e.superA, apply: true });
      const rows = await sql<Any[]>`select source from audit_log where org_id = ${e.orgId} and action = 'set_item_purchase_unit'`;
      expect(rows.map((r) => r.source)).toEqual(['etl']);

      // a screen call, no source given: still web
      const { id } = await asOrg(e.orgId, (tx) => domain.createItem(tx, e.superA, { name: 'Screen Item', kind: 'supply', baseUnit: 'pcs' } as never));
      await asOrg(e.orgId, (tx) => (domain as Any).setItemPurchaseUnit(tx, e.superA, { itemId: id, purchaseUnit: 'box', purchaseFactor: '12' }));
      const web = await sql<Any[]>`select source from audit_log where org_id = ${e.orgId} and action = 'set_item_purchase_unit' and entity_id = ${id}`;
      expect(web.map((r) => r.source)).toEqual(['web']);
    },
    120_000,
  );
});

describe('4 - a factor with more than 6 decimals is held by the planner', () => {
  it.each([
    ['items-box', 'how_many', '0.1234567'],
    ['items-box', 'how_many', '24.0000001'],
  ])(
    '%s.%s = %s: the planner holds it, names the row, creates nothing; 6 decimals are fine. Killing mutant: parsePositive accepts any decimal and the write rounds late',
    async (sheet, col, value) => {
      const e = await mkEnv('F4');
      const s = boxSnap();
      const first: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing: [], links: [], answers: {} } as Any);
      const base = { ...first.sheets[sheet][0], inside_unit: 'pcs', how_many: '24' };
      const bad: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing: [], links: [], answers: { [sheet]: [{ ...base, [col]: value }] } } as Any);
      expect(bad.writes.filter((w: Any) => w.op === 'create')).toHaveLength(0);
      expect(bad.held).toBeGreaterThan(0);
      const named = (bad.sheets[sheet] as Any[]).find((r) => r.item === 'Paper Cups');
      expect(named).toBeTruthy();
      expect(String(named.note ?? '')).toMatch(/decimal|places|6|six/i);

      const ok: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing: [], links: [], answers: { [sheet]: [{ ...base, [col]: '0.123456' }] } } as Any);
      expect(ok.held).toBe(0);
    },
    60_000,
  );

  it(
    'a 7-decimal factor on items-units for an existing item is held too. Killing mutant: the units factor is not checked',
    async () => {
      const e = await mkEnv('F5');
      const existing = [{ id: 'v2-sugar', name: 'Sugar', status: 'active', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: null }];
      const s = snap([rec(L, 'Sugar', 'pcs')]);
      const first: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing, links: [], answers: {} } as Any);
      const row = first.sheets['items-units'][0];
      const bad: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing, links: [], answers: { 'items-units': [{ ...row, factor: '0.5000001' }] } } as Any);
      expect(bad.held).toBeGreaterThan(0);
      expect(bad.writes).toHaveLength(0);
      const ok: Any = planItems({ snapshot: s, map: e.map, orgCode: e.orgCode, existing, links: [], answers: { 'items-units': [{ ...row, factor: '0.500001' }] } } as Any);
      expect(ok.held).toBe(0);
    },
    60_000,
  );
});

describe('5 - --actor must be a UUID', () => {
  it.each([[true], [false]])(
    '--actor not-a-uuid (apply=%s): refused with a plain message, no raw Postgres error, nothing written. Killing mutant: the string reaches a uuid column',
    async (withApply) => {
      const e = await mkEnv('U5');
      const i = inputs(e, snap([rec(L, 'Flour')]));
      const before = await counts(e.orgId);
      const r = cli(e, i, ['--actor', 'ian', ...(withApply ? ['--apply'] : [])]);
      expect(r.status).not.toBe(0);
      expect(r.all).toMatch(/--actor/);
      expect(r.all).toMatch(/uuid/i);
      expect(r.all).not.toMatch(/invalid input syntax|22P02|PostgresError|at async /i);
      expect(await counts(e.orgId)).toEqual(before);
    },
    180_000,
  );
});

describe('6 - a held race inside the apply exits 2', () => {
  it(
    'the CLI pre-check passes, the apply waits on the org lock, the plan turns held meanwhile (a retired v2 item appears): exit 2, a plain "held" message, nothing written. Killing mutant: the in-apply held throw is a generic failure (exit 1)',
    async () => {
      const e = await mkEnv('R6');
      const i = inputs(e, snap([rec(L, 'Race Item'), rec(M, 'Race Item')]));
      const holder = postgres(url!, { max: 1 });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const gotLock = new Promise<void>((r) => (locked = r));
      const held = holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('master-data:' || ${e.orgId}::text))`;
        locked();
        await gate;
      });
      await gotLock;

      const child = spawn('npx', argv(e, i, ['--actor', e.superId, '--apply']), { cwd: REPO_ROOT, env: childEnv(), shell: true });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const exit = new Promise<number | null>((r) => child.on('close', (c) => r(c)));

      // wait until the child is queued on the lock (its pre-check is over)
      const deadline = Date.now() + 120_000;
      for (;;) {
        const w = await sql<Any[]>`select count(*)::int n from pg_locks where locktype = 'advisory' and not granted`;
        if (Number(w[0]!.n) > 0) break;
        if (Date.now() > deadline) throw new Error(`the CLI never queued on the org lock:\n${out}`);
        await new Promise((r) => setTimeout(r, 300));
      }
      // the plan changes while it waits: a retired v2 item now holds the name
      await sql`insert into items (org_id, code, name, kind, base_unit, status, created_by)
                values (${e.orgId}, 'RACE-901', 'Race Item', 'raw_material', 'kg', 'inactive', ${e.superId})`;
      release();
      await held;
      await holder.end({ timeout: 5 });
      const code = await exit;
      expect(code).toBe(2);
      expect(out).toMatch(/held/i);
      expect(out).not.toMatch(/at async |master-data FAILED/);
      const c = await counts(e.orgId);
      expect(c.links).toBe(0);
      expect(c.items).toBe(1); // only the inactive row we inserted
    },
    240_000,
  );
});
