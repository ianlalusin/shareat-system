import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-384 S1a (TESTER) - the tender stale-write guard (R1) and kind correction in place (R5), domain + repo.
 * `docs/tasks/384-pos-link-tenders-and-width.md` S1a, D1-D5.
 *
 * Every leg asserts the TARGET. Red on HEAD for a behavioural reason: `expectedVersion` is ignored (the stale update
 * succeeds), `kind` is ignored on update, `TenderRow` has no `version`. Each refusal has a positive control.
 *
 * ## How the version is read
 * Through the repo, `posV1Repo.getTenderById(...).version` (R1 puts `version` on `TenderRow`). The test does not
 * restate the SQL expression, so the builder owns it. SPEC DEFECT carried in D0: a freshly CREATED tender has
 * `updated_at = NULL` (insertTender never sets it), so R1's expression `extract(epoch from updated_at)...` is NULL for
 * it and `= $v` could never match. D0 and D4 require a usable version on a never-updated row.
 *
 * ## Mutants (named for the builder; the tester may not edit source)
 *  - D1: drop the version clause from updateTenderRow's WHERE -> D1/D2 red.
 *  - D3: the patch omits `kind` -> D3 red.
 *  - D1: refuse on a version mismatch but still write the audit row -> the D1 audit count goes red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, posV1Repo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';

const sql = postgres(url, { max: 6 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const STALE_SENTENCE =
  'This tender was changed after this page was opened. The page now shows what is saved. Check it and save again.';
const WALLET_NEEDS_ACCOUNT = 'A wallet tender needs the money account it pays into.';

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
const sentence = (e: unknown): string => String((e as { userMessage?: string }).userMessage ?? (e as Error).message);
async function sentenceOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e) => e);
  expect(err, 'the call must refuse').toBeInstanceOf(Error);
  return sentence(err);
}

async function create(f: Fixture, input: Record<string, unknown>): Promise<{ id: string }> {
  return asOrg(f.orgId, (tx) => mod.createTender(tx, f.admin, { storeId: f.storeId, ...input } as never));
}
async function update(f: Fixture, input: Record<string, unknown>) {
  return asOrg(f.orgId, (tx) => mod.updateTender(tx, f.admin, input as never));
}
async function setActive(f: Fixture, input: Record<string, unknown>) {
  return asOrg(f.orgId, (tx) => mod.setTenderActive(tx, f.admin, input as never));
}
/** The version the screen would carry: read through the repo, as the page does. */
async function versionOf(f: Fixture, tenderId: string): Promise<string> {
  const r = await asOrg(f.orgId, (tx) => posV1Repo.getTenderById(tx, f.orgId, tenderId));
  return (r as unknown as { version: string }).version;
}

async function row(tenderId: string) {
  const [r] = await sql<{ name: string; kind: string; money_account_id: string | null; pos_v1_alias: string | null; is_active: boolean }[]>`
    select name, kind, money_account_id, pos_v1_alias, is_active from tenders where id = ${tenderId}`;
  return r!;
}
async function audits(tenderId: string, action?: string) {
  const rs = await sql<{ action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]>`
    select action, before, after from audit_log where entity = 'tenders' and entity_id = ${tenderId} order by occurred_at, id`;
  return action ? rs.filter((r) => r.action === action) : rs;
}

async function fixture(hint: string) {
  const code = uid(`t384s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const storeId = s!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  const mkAccount = async (name: string, instrument: string, gl: string, custodian: string) => {
    const [a] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${orgId}, ${storeId}, ${name}, ${instrument}, ${gl}, ${custodian}) returning id`;
    return a!.id;
  };
  const drawerAcct = await mkAccount('Lipa cash drawer', 'cash', '1110', 'cashier');
  const bpiAcct = await mkAccount('BPI Lipa', 'bank', '1140', 'office');
  const gcashAcct = await mkAccount('GCash Lipa', 'ewallet', '1140', 'cashier');
  const admin: Actor = { personId: p!.id, orgId };
  return { orgId, storeId, drawerAcct, bpiAcct, gcashAcct, admin };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

describe('D0 - a version exists on every tender, including one never updated', () => {
  it('a freshly created tender (updated_at NULL) has a non-empty string version; an update changes it; a re-read is stable', async () => {
    const f = await fixture('d0');
    const t = await create(f, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const v0 = await versionOf(f, t.id);
    expect(typeof v0, 'TenderRow.version must be a string, even for a row with no updated_at').toBe('string');
    expect(v0.length, 'not an empty string').toBeGreaterThan(0);
    expect(v0, 'not the text null').not.toBe('null');
    expect(await versionOf(f, t.id), 'reading twice gives the same version').toBe(v0);
    await update(f, { tenderId: t.id, name: 'Drawer' });
    const v1 = await versionOf(f, t.id);
    expect(v1, 'a write moves the version').not.toBe(v0);
  });
});

describe('D1 - a stale update is refused in words, writes nothing, audits nothing', () => {
  it('fresh version succeeds; the same version again is refused with the R1 sentence; row stays A2; exactly one update_tender audit row', async () => {
    const f = await fixture('d1');
    const t = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    const v = await versionOf(f, t.id);
    await update(f, { tenderId: t.id, name: 'A2', expectedVersion: v });
    expect((await row(t.id)).name).toBe('A2');

    expect(await sentenceOf(update(f, { tenderId: t.id, name: 'A3', expectedVersion: v }))).toBe(STALE_SENTENCE);
    expect((await row(t.id)).name, 'the stale write must not land').toBe('A2');
    expect(await audits(t.id, 'update_tender'), 'a refused write is not audited').toHaveLength(1);

    // control: the version read AFTER the first write is the fresh one
    const v2 = await versionOf(f, t.id);
    await update(f, { tenderId: t.id, name: 'A3', expectedVersion: v2 });
    expect((await row(t.id)).name).toBe('A3');
  });

  it('the refusal names no id and no constraint text', async () => {
    const f = await fixture('d1s');
    const t = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    const v = await versionOf(f, t.id);
    await update(f, { tenderId: t.id, name: 'A2', expectedVersion: v });
    const s = await sentenceOf(update(f, { tenderId: t.id, name: 'A3', expectedVersion: v }));
    expect(s).not.toContain(t.id);
    expect(s).not.toMatch(/constraint|tenders_|violates/i);
  });
});

describe('D2 - retire and restore carry the guard too', () => {
  it('setTenderActive with a stale version is refused, still active, no audit; control: the fresh version retires', async () => {
    const f = await fixture('d2');
    const t = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    const v0 = await versionOf(f, t.id);
    await update(f, { tenderId: t.id, name: 'A2', expectedVersion: v0 });

    expect(await sentenceOf(setActive(f, { tenderId: t.id, isActive: false, expectedVersion: v0 }))).toBe(STALE_SENTENCE);
    expect((await row(t.id)).is_active, 'a stale retire must not land').toBe(true);
    expect(await audits(t.id, 'retire_tender')).toHaveLength(0);

    const v1 = await versionOf(f, t.id);
    await setActive(f, { tenderId: t.id, isActive: false, expectedVersion: v1 });
    expect((await row(t.id)).is_active).toBe(false);
    expect(await audits(t.id, 'retire_tender')).toHaveLength(1);

    // restore: stale then fresh
    const v2 = await versionOf(f, t.id);
    expect(await sentenceOf(setActive(f, { tenderId: t.id, isActive: true, expectedVersion: v1 }))).toBe(STALE_SENTENCE);
    expect((await row(t.id)).is_active).toBe(false);
    await setActive(f, { tenderId: t.id, isActive: true, expectedVersion: v2 });
    expect((await row(t.id)).is_active).toBe(true);
  });
});

describe('D3 - kind is corrected in place (R5), audited with kind', () => {
  it('cash -> wallet with BPI: row is a wallet on BPI; audit before.kind=cash, after.kind=wallet', async () => {
    const f = await fixture('d3a');
    const t = await create(f, { name: 'Gcash', kind: 'cash', posV1Alias: 'Gcash' });
    await update(f, { tenderId: t.id, kind: 'wallet', moneyAccountId: f.bpiAcct });
    const r = await row(t.id);
    expect(r.kind).toBe('wallet');
    expect(r.money_account_id).toBe(f.bpiAcct);
    const [a] = await audits(t.id, 'update_tender');
    expect(a, 'the kind change is audited').toBeDefined();
    expect((a!.before as { kind?: string }).kind).toBe('cash');
    expect((a!.after as { kind?: string }).kind).toBe('wallet');
    expect((a!.after as { moneyAccountId?: string }).moneyAccountId).toBe(f.bpiAcct);
  });

  it('cash -> wallet with no account: wallet sentence, row unchanged, no audit', async () => {
    const f = await fixture('d3b');
    const t = await create(f, { name: 'Gcash', kind: 'cash', posV1Alias: 'Gcash' });
    expect(await sentenceOf(update(f, { tenderId: t.id, kind: 'wallet' }))).toBe(WALLET_NEEDS_ACCOUNT);
    const r = await row(t.id);
    expect(r.kind).toBe('cash');
    expect(r.money_account_id).toBeNull();
    expect(await audits(t.id, 'update_tender')).toHaveLength(0);
  });

  it('cash -> wallet pointing at a cash drawer is still refused (assertStoreAccount); unchanged', async () => {
    const f = await fixture('d3c');
    const t = await create(f, { name: 'Gcash', kind: 'cash', posV1Alias: 'Gcash' });
    const s = await sentenceOf(update(f, { tenderId: t.id, kind: 'wallet', moneyAccountId: f.drawerAcct }));
    expect(s).toContain('cash drawer');
    expect((await row(t.id)).kind).toBe('cash');
  });

  it('wallet -> cash clears the account; audit before.kind=wallet, after.kind=cash, after account null', async () => {
    const f = await fixture('d3d');
    const t = await create(f, { name: 'Gcash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'Gcash' });
    await update(f, { tenderId: t.id, kind: 'cash' });
    const r = await row(t.id);
    expect(r.kind).toBe('cash');
    expect(r.money_account_id, 'the shape CHECK holds: a cash tender has no account').toBeNull();
    const [a] = await audits(t.id, 'update_tender');
    expect((a!.before as { kind?: string }).kind).toBe('wallet');
    expect((a!.after as { kind?: string }).kind).toBe('cash');
    expect((a!.after as { moneyAccountId?: string | null }).moneyAccountId).toBeNull();
  });

  it('a kind change with a fresh expectedVersion succeeds; with a stale one it is refused and the kind stays', async () => {
    const f = await fixture('d3e');
    const t = await create(f, { name: 'Gcash', kind: 'cash', posV1Alias: 'Gcash' });
    const v0 = await versionOf(f, t.id);
    await update(f, { tenderId: t.id, name: 'Gcash 2', expectedVersion: v0 });
    expect(await sentenceOf(update(f, { tenderId: t.id, kind: 'wallet', moneyAccountId: f.bpiAcct, expectedVersion: v0 }))).toBe(STALE_SENTENCE);
    expect((await row(t.id)).kind).toBe('cash');
    await update(f, { tenderId: t.id, kind: 'wallet', moneyAccountId: f.bpiAcct, expectedVersion: await versionOf(f, t.id) });
    expect((await row(t.id)).kind).toBe('wallet');
  });
});

describe("D4 - control: Lipa's four tenders each keep their own values through one guarded update", () => {
  it('Bank Transfer, Cash, Gcash, QRPH; each updated once with its own fresh version; BPI shared by two; 4 + 4 audit rows', async () => {
    const f = await fixture('d4');
    const bank = await create(f, { name: 'Bank Transfer', kind: 'wallet', moneyAccountId: f.bpiAcct, posV1Alias: 'Bank Transfer' });
    const cash = await create(f, { name: 'Cash', kind: 'cash', posV1Alias: 'Cash' });
    const gcash = await create(f, { name: 'Gcash', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'Gcash' });
    const qr = await create(f, { name: 'QRPH', kind: 'wallet', moneyAccountId: f.bpiAcct, posV1Alias: 'QRPH' });
    for (const [t, name] of [[bank, 'Bank Transfer 2'], [cash, 'Cash 2'], [gcash, 'Gcash 2'], [qr, 'QRPH 2']] as const) {
      // a never-updated row's version must be usable (updated_at is NULL until the first write)
      const v = await versionOf(f, t.id);
      expect(typeof v, 'each never-updated row carries a usable version').toBe('string');
      await update(f, { tenderId: t.id, name, expectedVersion: v });
    }
    const rows = await sql<{ name: string; kind: string; money_account_id: string | null; pos_v1_alias: string | null }[]>`
      select name, kind, money_account_id, pos_v1_alias from tenders where store_id = ${f.storeId} order by name`;
    expect(rows).toEqual([
      { name: 'Bank Transfer 2', kind: 'wallet', money_account_id: f.bpiAcct, pos_v1_alias: 'Bank Transfer' },
      { name: 'Cash 2', kind: 'cash', money_account_id: null, pos_v1_alias: 'Cash' },
      { name: 'Gcash 2', kind: 'wallet', money_account_id: f.gcashAcct, pos_v1_alias: 'Gcash' },
      { name: 'QRPH 2', kind: 'wallet', money_account_id: f.bpiAcct, pos_v1_alias: 'QRPH' },
    ]);
    const c = await sql<{ n: string }[]>`select count(*)::text n from audit_log where org_id = ${f.orgId} and entity = 'tenders' and action = 'create_tender'`;
    const u = await sql<{ n: string }[]>`select count(*)::text n from audit_log where org_id = ${f.orgId} and entity = 'tenders' and action = 'update_tender'`;
    expect([c[0]!.n, u[0]!.n]).toEqual(['4', '4']);
  });
});

describe('D5 - control: no expectedVersion behaves as before', () => {
  it('two updates without a version both land (no guard unless asked); nothing is refused', async () => {
    const f = await fixture('d5');
    const t = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    await update(f, { tenderId: t.id, name: 'A2' });
    await update(f, { tenderId: t.id, name: 'A3' });
    expect((await row(t.id)).name).toBe('A3');
    await setActive(f, { tenderId: t.id, isActive: false });
    expect((await row(t.id)).is_active).toBe(false);
    expect(await audits(t.id, 'update_tender')).toHaveLength(2);
  });
});

describe('D6 - the version moves on every write, even inside one transaction', () => {
  it('create, read v, update with v, update again with the same v, all in ONE transaction: the second is refused and its name does not land', async () => {
    const f = await fixture('d6');
    const out = await asOrg(f.orgId, async (tx) => {
      const t = await mod.createTender(tx, f.admin, { storeId: f.storeId, name: 'A', kind: 'cash', posV1Alias: 'A' } as never);
      const v = ((await posV1Repo.getTenderById(tx, f.orgId, t.id)) as unknown as { version: string }).version;
      await mod.updateTender(tx, f.admin, { tenderId: t.id, name: 'A2', expectedVersion: v } as never);
      const err = await mod.updateTender(tx, f.admin, { tenderId: t.id, name: 'A3', expectedVersion: v } as never).then(() => null, (e) => e);
      const name = ((await posV1Repo.getTenderById(tx, f.orgId, t.id)) as { name: string }).name;
      return { err, name };
    });
    expect(out.err, 'the second update carries a version the first update already moved').toBeInstanceOf(Error);
    expect(sentence(out.err)).toBe(STALE_SENTENCE);
    expect(out.name).toBe('A2');
  });

  it('same, for an existing row: update with v then retire with the same v in one transaction is refused', async () => {
    const f = await fixture('d6b');
    const t = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    await update(f, { tenderId: t.id, name: 'A1' });
    const out = await asOrg(f.orgId, async (tx) => {
      const v = ((await posV1Repo.getTenderById(tx, f.orgId, t.id)) as unknown as { version: string }).version;
      await mod.updateTender(tx, f.admin, { tenderId: t.id, name: 'A2', expectedVersion: v } as never);
      return mod.setTenderActive(tx, f.admin, { tenderId: t.id, isActive: false, expectedVersion: v } as never).then(() => null, (e) => e);
    });
    expect(out, 'the retire carries a version the update already moved').toBeInstanceOf(Error);
    expect(sentence(out)).toBe(STALE_SENTENCE);
  });
});

describe('D7 - the version is checked first: a stale form gets the stale sentence, not an alias or account one', () => {
  it('stale update whose alias is now held by another tender -> stale sentence; control: the same alias with a fresh version -> the alias sentence', async () => {
    const f = await fixture('d7a');
    const a = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    await create(f, { name: 'B', kind: 'cash', posV1Alias: 'B' });
    const v0 = await versionOf(f, a.id);
    await update(f, { tenderId: a.id, name: 'A2', expectedVersion: v0 });
    expect(await sentenceOf(update(f, { tenderId: a.id, posV1Alias: 'B', expectedVersion: v0 }))).toBe(STALE_SENTENCE);
    const alias = await sentenceOf(update(f, { tenderId: a.id, posV1Alias: 'B', expectedVersion: await versionOf(f, a.id) }));
    expect(alias).toContain('already answers to');
  });

  it('stale kind change cash -> wallet with no account -> stale sentence; control: fresh -> the wallet-needs-account sentence', async () => {
    const f = await fixture('d7b');
    const a = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    const v0 = await versionOf(f, a.id);
    await update(f, { tenderId: a.id, name: 'A2', expectedVersion: v0 });
    expect(await sentenceOf(update(f, { tenderId: a.id, kind: 'wallet', expectedVersion: v0 }))).toBe(STALE_SENTENCE);
    expect(await sentenceOf(update(f, { tenderId: a.id, kind: 'wallet', expectedVersion: await versionOf(f, a.id) }))).toBe(WALLET_NEEDS_ACCOUNT);
  });

  it('stale update pointing a wallet at a cash drawer -> stale sentence', async () => {
    const f = await fixture('d7c');
    const a = await create(f, { name: 'G', kind: 'wallet', moneyAccountId: f.gcashAcct, posV1Alias: 'G' });
    const v0 = await versionOf(f, a.id);
    await update(f, { tenderId: a.id, name: 'G2', expectedVersion: v0 });
    expect(await sentenceOf(update(f, { tenderId: a.id, moneyAccountId: f.drawerAcct, expectedVersion: v0 }))).toBe(STALE_SENTENCE);
  });

  it('stale restore whose alias was taken meanwhile -> stale sentence; control: fresh -> the alias sentence', async () => {
    const f = await fixture('d7d');
    const a = await create(f, { name: 'A', kind: 'cash', posV1Alias: 'A' });
    const v0 = await versionOf(f, a.id);
    await setActive(f, { tenderId: a.id, isActive: false, expectedVersion: v0 });
    await create(f, { name: 'A again', kind: 'cash', posV1Alias: 'A' });
    expect(await sentenceOf(setActive(f, { tenderId: a.id, isActive: true, expectedVersion: v0 }))).toBe(STALE_SENTENCE);
    expect(await sentenceOf(setActive(f, { tenderId: a.id, isActive: true, expectedVersion: await versionOf(f, a.id) }))).toContain('already answers to');
  });
});
