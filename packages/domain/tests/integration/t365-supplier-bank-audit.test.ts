import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-365 S1 (DEF-498) — a real change to a supplier's bank fields is audited: one `audit_log` row,
 * `action='set_supplier_bank_account'`, full before/after triple, only on a written change.
 * `docs/tasks/365-def-498-supplier-bank-audit.md` §Legs, "Domain-direct", D1-D13. Harness/fixture
 * copied from `t362-supplier-credit-terms.test.ts:20-100` (`asOrg`, `fixture` with manager/staff/
 * admin, the `_test` guard).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { createSupplier, editSupplier } from '@shareat/domain';

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
  const code = uid(`t365-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Staff', 'staff');
  const adminId = await mk('Admin', 'admin');
  return { orgId, storeId: store!.id, manager: actor(orgId, managerId), staff: actor(orgId, staffId), admin: actor(orgId, adminId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterAll(async () => {
  await sql.end({ timeout: 5 });
  await closeDb();
});

interface BankValue {
  bankName: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
}
/** T-402 S1b / Q6: the audit row keeps only the last 4 digits ('••••1111') and a '<key>Changed' flag (unmasked before vs after). */
const M = (bankName: string | null, bankAccountName: string | null, masked: string | null, changed: boolean) => ({
  bankName,
  bankAccountName,
  bankAccountNumber: masked,
  bankAccountNumberChanged: changed,
});
const T = (bankName: string | null, bankAccountName: string | null, bankAccountNumber: string | null): BankValue => ({
  bankName,
  bankAccountName,
  bankAccountNumber,
});

interface AuditRow {
  before: unknown;
  after: unknown;
  actor_person_id: string;
  source: string;
}
async function auditRowsFor(id: string, action: string): Promise<AuditRow[]> {
  return sql<AuditRow[]>`
    select before, after, actor_person_id, source from audit_log
    where entity = 'suppliers' and entity_id = ${id} and action = ${action} order by occurred_at`;
}
const bankAuditRows = (id: string) => auditRowsFor(id, 'set_supplier_bank_account');
const termsAuditRows = (id: string) => auditRowsFor(id, 'set_supplier_credit_terms');

async function bankColumnsOf(id: string): Promise<{ bank_name: string | null; bank_account_name: string | null; bank_account_number: string | null }> {
  const [row] = await sql<{ bank_name: string | null; bank_account_name: string | null; bank_account_number: string | null }[]>`
    select bank_name, bank_account_name, bank_account_number from suppliers where id = ${id}`;
  return row!;
}

/** A supplier "with bank" — set up by `editSupplier` as admin (task doc note: this write is
 * itself audited once S1 is built; every leg reads its `BANK(id)` baseline AFTER this call, never
 * an absolute zero). */
async function supplierWithBank(f: Fixture, hint: string, bank: BankValue): Promise<{ id: string; name: string }> {
  const name = `Bank ${uid(hint)}`;
  const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name }));
  await asOrg(f.orgId, (tx) => editSupplier(tx, f.admin, { supplierId: id, ...bank }));
  return { id, name };
}

describe('D1 — a real change to one bank field', () => {
  it('column updated; +1 BANK row with the full before/after triple and the real actor', async () => {
    const f = await fixture('d1');
    const s = await supplierWithBank(f, 'd1', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, bankAccountNumber: '2222' }));
    expect((await bankColumnsOf(s.id)).bank_account_number).toBe('2222');
    const rows = await bankAuditRows(s.id);
    expect(rows.length, 'BANK +1').toBe(before.length + 1);
    const row = rows.at(-1)!;
    expect(row.before).toEqual(M('BDO', 'Acme Inc', '••••1111', true));
    expect(row.after).toEqual(M('BDO', 'Acme Inc', '••••2222', true));
    expect(row.actor_person_id).toBe(f.manager.personId);
    expect(row.source).toBe('web');
  });
});

describe('D2 — supplier with no bank; all three set', () => {
  it('+1: before is the null triple, after is the three new values', async () => {
    const f = await fixture('d2');
    const { id } = await asOrg(f.orgId, (tx) => createSupplier(tx, f.admin, { name: `Bank ${uid('d2')}` }));
    const before = await bankAuditRows(id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: id, bankName: 'BPI', bankAccountName: 'New Co', bankAccountNumber: '5555' }));
    const rows = await bankAuditRows(id);
    expect(rows.length).toBe(before.length + 1);
    expect(rows.at(-1)!.before).toEqual(M(null, null, null, true));
    expect(rows.at(-1)!.after).toEqual(M('BPI', 'New Co', '••••5555', true));
  });
});

describe('D3 — clearing one field', () => {
  it('column null; +1, after.bankAccountNumber null, the other two carried', async () => {
    const f = await fixture('d3');
    const s = await supplierWithBank(f, 'd3', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, bankAccountNumber: '' }));
    expect((await bankColumnsOf(s.id)).bank_account_number).toBeNull();
    const rows = await bankAuditRows(s.id);
    expect(rows.length).toBe(before.length + 1);
    expect(rows.at(-1)!.after).toEqual(M('BDO', 'Acme Inc', null, true));
  });
});

describe('D4 (green, guard) — the same three values posted back', () => {
  it('BANK unchanged — only a real change is audited', async () => {
    const f = await fixture('d4');
    const s = await supplierWithBank(f, 'd4', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, bankName: 'BDO', bankAccountName: 'Acme Inc', bankAccountNumber: '1111' }));
    expect((await bankAuditRows(s.id)).length).toBe(before.length);
  });
});

describe('D5 (green, guard) — normalisation, padded whitespace is not a change', () => {
  it('column stays trimmed; BANK unchanged', async () => {
    const f = await fixture('d5');
    const s = await supplierWithBank(f, 'd5', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, bankAccountNumber: ' 1111 ' }));
    expect((await bankColumnsOf(s.id)).bank_account_number).toBe('1111');
    expect((await bankAuditRows(s.id)).length).toBe(before.length);
  });
});

describe('D6 (green, guard) — absent keys never count as a change', () => {
  it('name-only edit changes the name; bank untouched; BANK unchanged', async () => {
    const f = await fixture('d6');
    const s = await supplierWithBank(f, 'd6', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, name: 'Renamed Co' }));
    const [row] = await sql<{ name: string }[]>`select name from suppliers where id = ${s.id}`;
    expect(row!.name).toBe('Renamed Co');
    expect((await bankColumnsOf(s.id)).bank_name).toBe('BDO');
    expect((await bankAuditRows(s.id)).length).toBe(before.length);
  });
});

describe('D7 — both controls in one edit', () => {
  it('exactly one new terms row and one new BANK row', async () => {
    const f = await fixture('d7');
    const s = await supplierWithBank(f, 'd7', T('BDO', 'Acme Inc', '1111'));
    const beforeBank = await bankAuditRows(s.id);
    const beforeTerms = await termsAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, creditTermsDays: 30, bankAccountNumber: '2222' }));
    expect((await bankAuditRows(s.id)).length).toBe(beforeBank.length + 1);
    expect((await termsAuditRows(s.id)).length).toBe(beforeTerms.length + 1);
  });
});

describe('D8 (green, guard) — T-362 unaffected by S1', () => {
  it('one terms row; BANK unchanged', async () => {
    const f = await fixture('d8');
    const s = await supplierWithBank(f, 'd8', T('BDO', 'Acme Inc', '1111'));
    const beforeBank = await bankAuditRows(s.id);
    const beforeTerms = await termsAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, creditTermsDays: 30 }));
    expect((await termsAuditRows(s.id)).length).toBe(beforeTerms.length + 1);
    expect((await bankAuditRows(s.id)).length).toBe(beforeBank.length);
  });
});

describe('D9 (green, guard) — the gate still fires for a non-holder', () => {
  it('staff refused; nothing written', async () => {
    const f = await fixture('d9');
    const s = await supplierWithBank(f, 'd9', T('BDO', 'Acme Inc', '1111'));
    const beforeCols = await bankColumnsOf(s.id);
    const beforeBank = await bankAuditRows(s.id);
    await expect(asOrg(f.orgId, (tx) => editSupplier(tx, f.staff, { supplierId: s.id, bankAccountNumber: '9999' }))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(await bankColumnsOf(s.id)).toEqual(beforeCols);
    expect((await bankAuditRows(s.id)).length).toBe(beforeBank.length);
  });
});

describe('D10 — an admin edit is audited the same way', () => {
  it('+1 with actor_person_id = admin', async () => {
    const f = await fixture('d10');
    const s = await supplierWithBank(f, 'd10', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.admin, { supplierId: s.id, bankAccountNumber: '3333' }));
    const rows = await bankAuditRows(s.id);
    expect(rows.length).toBe(before.length + 1);
    expect(rows.at(-1)!.actor_person_id).toBe(f.admin.personId);
  });
});

describe('D11 (green, guard) — atomic: an earlier field refusal writes nothing', () => {
  it('the name sentence; bank columns and BANK unchanged', async () => {
    const f = await fixture('d11');
    const s = await supplierWithBank(f, 'd11', T('BDO', 'Acme Inc', '1111'));
    const beforeCols = await bankColumnsOf(s.id);
    const beforeBank = await bankAuditRows(s.id);
    await expect(asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, name: '   ', bankAccountNumber: '4444' }))).rejects.toThrow(
      /name/i,
    );
    expect(await bankColumnsOf(s.id)).toEqual(beforeCols);
    expect((await bankAuditRows(s.id)).length).toBe(beforeBank.length);
  });
});

describe('D12 (green, guard) — create is not audited (R4)', () => {
  it('BANK = 0 for the new id, even with all three bank fields set', async () => {
    const f = await fixture('d12');
    const { id } = await asOrg(f.orgId, (tx) =>
      createSupplier(tx, f.admin, { name: `Bank ${uid('d12')}`, bankName: 'BDO', bankAccountName: 'Acme', bankAccountNumber: '1111' }),
    );
    expect((await bankAuditRows(id)).length).toBe(0);
  });
});

describe('D13 — the chain: two edits in a row', () => {
  it('2 new rows; the second row\'s before equals the first row\'s after', async () => {
    const f = await fixture('d13');
    const s = await supplierWithBank(f, 'd13', T('BDO', 'Acme Inc', '1111'));
    const before = await bankAuditRows(s.id);
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, bankAccountNumber: '2222' }));
    await asOrg(f.orgId, (tx) => editSupplier(tx, f.manager, { supplierId: s.id, bankAccountNumber: '3333' }));
    const rows = await bankAuditRows(s.id);
    expect(rows.length).toBe(before.length + 2);
    const [r1, r2] = rows.slice(-2) as [AuditRow, AuditRow];
    expect((r1.after as BankValue).bankAccountNumber).toBe('••••2222');
    expect((r2.before as BankValue).bankAccountNumber).toBe('••••2222');
    expect((r2.after as BankValue).bankAccountNumber).toBe('••••3333');
  });
});
