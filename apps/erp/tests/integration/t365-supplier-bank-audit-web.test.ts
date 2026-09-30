import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-365 (DEF-498 S1, DEF-506 S2) — web legs. `docs/tasks/365-def-498-supplier-bank-audit.md`
 * §Legs, "Web" (S1: W1-W4) and §Slice S2 (W5, C1; S1's W3 already covers the "re-run" note — it
 * is unchanged by S2 since its bank fields are PRESENT, just blank). Harness copied from
 * `t362-supplier-terms-web.test.ts:14-90` (`RedirectSignal`, `ACTOR_HOLDER`, `fixture`,
 * `expectRedirectTo`, `editFormData` — reused here for W5/C1's "supplierId + name only" shape).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSupplier, editSupplier } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`t365w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;
  const admin_ = actor(orgId, admin!.id);

  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Floor Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${staff!.id}, ${storeId}, 'manual')`;
  const staff_ = actor(orgId, staff!.id);

  return { orgId, storeId, admin: admin_, staff: staff_ };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface BankValue {
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
}

async function supplierWithBank(f: Fixture, hint: string, bank: { bankName: string; bankAccountName: string; bankAccountNumber: string }) {
  const name = `Bank ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name }));
  await asOrg(f.orgId, (tx) => editSupplier(tx, f.admin, { supplierId: id, ...bank }));
  return { id, name };
}

async function supplierWithBankEmailTin(f: Fixture, hint: string) {
  const name = `Bank ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name }));
  await asOrg(f.orgId, (tx) =>
    editSupplier(tx, f.admin, {
      supplierId: id,
      bankName: 'BDO',
      bankAccountName: 'Acme Inc',
      bankAccountNumber: '1111',
      email: 'acme@example.com',
      tin: '123-456-789',
    }),
  );
  return { id, name };
}

async function expectRedirectTo(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const errorOf = (to: string) => new URL(to, 'http://localhost').searchParams.get('error');
const okOf = (to: string) => new URL(to, 'http://localhost').searchParams.get('ok');

/** T-365's own full form — real edit forms always post all three bank fields (task doc §TESTER
 * S1's ⚠️ note). `overrides` replaces `supplierId`/`name` when a leg needs to. */
function bankEditFormData(supplier: { id: string; name: string }, bank: { bankName?: string; bankAccountName?: string; bankAccountNumber?: string }): FormData {
  const fd = new FormData();
  fd.set('supplierId', supplier.id);
  fd.set('name', supplier.name);
  fd.set('bankName', bank.bankName ?? '');
  fd.set('bankAccountName', bank.bankAccountName ?? '');
  fd.set('bankAccountNumber', bank.bankAccountNumber ?? '');
  return fd;
}

/** t362's shape — `supplierId` + `name` ONLY (t362-supplier-terms-web.test.ts:181-187). Used here
 * for S2's W5/C1, which test a form that omits the bank/email/TIN keys entirely. */
function editFormData(supplier: { id: string; name: string }, overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('supplierId', supplier.id);
  fd.set('name', supplier.name);
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

interface AuditRow {
  before: unknown;
  after: unknown;
}
async function bankAuditRows(id: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select before, after from audit_log
    where entity = 'suppliers' and entity_id = ${id} and action = 'set_supplier_bank_account' order by occurred_at`;
}
async function bankColumnsOf(id: string): Promise<{ bank_name: string | null; bank_account_name: string | null; bank_account_number: string | null }> {
  const [row] = await sql<{ bank_name: string | null; bank_account_name: string | null; bank_account_number: string | null }[]>`
    select bank_name, bank_account_name, bank_account_number from suppliers where id = ${id}`;
  return row!;
}

const BANK = { bankName: 'BDO', bankAccountName: 'Acme Inc', bankAccountNumber: '1111' };

describe('W1 — full form, account number changed', () => {
  it('redirect ok=Supplier updated.; +1 BANK row, after.bankAccountNumber = 2222', async () => {
    const f = await fixture('w1');
    const s = await supplierWithBank(f, 'w1', BANK);
    const before = await bankAuditRows(s.id);
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(bankEditFormData(s, { ...BANK, bankAccountNumber: '2222' })));
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    const rows = await bankAuditRows(s.id);
    expect(rows.length).toBe(before.length + 1);
    expect((rows.at(-1)!.after as BankValue).bankAccountNumber).toBe('2222');
  });
});

describe('W2 (green, guard) — full form re-posted with its current values', () => {
  it('ok; BANK unchanged (the always-posted fields do not log a no-op)', async () => {
    const f = await fixture('w2');
    const s = await supplierWithBank(f, 'w2', BANK);
    const before = await bankAuditRows(s.id);
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(bankEditFormData(s, BANK)));
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    expect((await bankAuditRows(s.id)).length).toBe(before.length);
  });
});

describe('W3 — full form, account number blank (also S2\'s "sent-blank still clears" control)', () => {
  it('+1, after.bankAccountNumber null', async () => {
    const f = await fixture('w3');
    const s = await supplierWithBank(f, 'w3', BANK);
    const before = await bankAuditRows(s.id);
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(bankEditFormData(s, { ...BANK, bankAccountNumber: '' })));
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    const rows = await bankAuditRows(s.id);
    expect(rows.length).toBe(before.length + 1);
    expect((rows.at(-1)!.after as BankValue).bankAccountNumber).toBeNull();
  });
});

describe('W4 (green, guard) — staff session', () => {
  it('refused; nothing written', async () => {
    const f = await fixture('w4');
    const s = await supplierWithBank(f, 'w4', BANK);
    const beforeCols = await bankColumnsOf(s.id);
    const before = await bankAuditRows(s.id);
    ACTOR_HOLDER.actor = f.staff;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(bankEditFormData(s, { ...BANK, bankAccountNumber: '9999' })));
    expect(errorOf(to), `redirect URL was: ${to}`).not.toBeNull();
    expect(await bankColumnsOf(s.id)).toEqual(beforeCols);
    expect((await bankAuditRows(s.id)).length).toBe(before.length);
  });
});

describe('W5 (DEF-506, S2) — supplierId + name only, on a supplier with bank/email/TIN set', () => {
  it('redirect ok; bank columns, email and TIN all unchanged; BANK unchanged', async () => {
    const f = await fixture('w5');
    const s = await supplierWithBankEmailTin(f, 'w5');
    const beforeCols = await bankColumnsOf(s.id);
    const [beforeRow] = await sql<{ email: string | null; tin: string | null }[]>`select email, tin from suppliers where id = ${s.id}`;
    const before = await bankAuditRows(s.id);
    ACTOR_HOLDER.actor = f.admin;
    const { editSupplierAction } = await import('../../src/app/ap/actions');
    const to = await expectRedirectTo(() => editSupplierAction(editFormData(s)));
    expect(okOf(to), `redirect URL was: ${to}`).toBe('Supplier updated.');
    expect(await bankColumnsOf(s.id)).toEqual(beforeCols);
    const [afterRow] = await sql<{ email: string | null; tin: string | null }[]>`select email, tin from suppliers where id = ${s.id}`;
    expect(afterRow).toEqual(beforeRow);
    expect((await bankAuditRows(s.id)).length).toBe(before.length);
  });
});

describe('C1 (green, guard) — createSupplierAction, name only', () => {
  it('new row: all seven fields null, issues_official_receipt true, redirect ok', async () => {
    const f = await fixture('c1');
    ACTOR_HOLDER.actor = f.admin;
    const { createSupplierAction } = await import('../../src/app/ap/actions');
    const name = `C1 ${uid('s')}`;
    const fd = new FormData();
    fd.set('name', name);
    const to = await expectRedirectTo(() => createSupplierAction(fd));
    expect(new URL(to, 'http://localhost').searchParams.get('ok'), `redirect URL was: ${to}`).not.toBeNull();
    const [row] = await sql<
      {
        email: string | null;
        representative_name: string | null;
        tin: string | null;
        classification: string | null;
        bank_name: string | null;
        bank_account_name: string | null;
        bank_account_number: string | null;
        issues_official_receipt: boolean;
      }[]
    >`
      select email, representative_name, tin, classification, bank_name, bank_account_name, bank_account_number, issues_official_receipt
      from suppliers where name = ${name}`;
    expect(row, 'expected the new supplier row to exist').toBeDefined();
    expect(row!.email).toBeNull();
    expect(row!.representative_name).toBeNull();
    expect(row!.tin).toBeNull();
    expect(row!.classification).toBeNull();
    expect(row!.bank_name).toBeNull();
    expect(row!.bank_account_name).toBeNull();
    expect(row!.bank_account_number).toBeNull();
    expect(row!.issues_official_receipt).toBe(true);
  });
});
