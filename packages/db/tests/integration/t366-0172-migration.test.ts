import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-366 S2 — migration 0172's own constraints (`docs/tasks/366-remittance-floats.md` §S2,
 * "Migration test"). `remittance_allocations.source` and `remittance_variances.journal_entry_id`
 * do not exist yet — every leg below is expected to fail on "column does not exist" until the
 * migration lands (the orchestrator's own carve-out: this file inherently needs the new schema,
 * unlike `t366-s2-variance-charge.test.ts`'s posting legs).
 *
 * ⛔ TESTER, not BUILDER. Not covered here: "a pre-existing legacy `charged` row with no entry
 * survives the migration" (the NOT VALID clause) — that is a migration-APPLICATION-time check
 * (insert the violating row, apply 0172, confirm it is untouched), which is ADR-012 §5.8's own
 * "prove it on a scratch DB" step the builder runs once, not a standing assertion this file can
 * express against an already-migrated test database. Flagged rather than faked.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t366mig-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [remittance] = await sql<{ id: string }[]>`
    insert into remittances (org_id, store_id, remitted_on, created_by, accepted_by, status)
    values (${orgId}, ${storeId}, '2026-01-06', ${admin!.id}, ${admin!.id}, 'posted') returning id`;
  return { orgId, storeId, adminId: admin!.id, remittanceId: remittance!.id };
}

/** A balanced two-line draft journal entry — something a variance's journal_entry_id can point at. */
async function entryFor(orgId: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [period] = await tx<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open') returning id`;
    const [dr] = await tx<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${orgId}, '9001', 'Probe debit', 'expense', 'debit', true, true, 'active') returning id`;
    const [cr] = await tx<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${orgId}, '9002', 'Probe credit', 'asset', 'debit', true, true, 'active') returning id`;
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, status)
      values (${orgId}, ${period!.id}, '2026-01-06', 'manual_journal', ${uid('src')}, ${uid('idem')}, 'draft') returning id`;
    await tx`
      insert into journal_lines (entry_id, account_id, line_no, debit, credit)
      values (${entry!.id}, ${dr!.id}, 1, 150, 0), (${entry!.id}, ${cr!.id}, 2, 0, 150)`;
    return entry!.id;
  }) as Promise<string>;
}

describe('remittance_variances_sign_check — status vs amount sign', () => {
  it('a `charged` row with a POSITIVE amount is refused', async () => {
    const f = await fixture('sign-charged');
    await expect(
      sql`insert into remittance_variances (org_id, remittance_id, business_date, amount, status, charged_to_person_id, resolved_by, resolved_on)
        values (${f.orgId}, ${f.remittanceId}, '2026-01-06', '150.00', 'charged', ${f.adminId}, ${f.adminId}, '2026-01-07')`,
    ).rejects.toThrow();
  });

  it('a positive control: a `charged` row with a NEGATIVE amount AND a journal_entry_id is accepted', async () => {
    const f = await fixture('sign-charged-ok');
    const entryId = await entryFor(f.orgId);
    await expect(
      sql`insert into remittance_variances (org_id, remittance_id, business_date, amount, status, charged_to_person_id, resolved_by, resolved_on, journal_entry_id)
        values (${f.orgId}, ${f.remittanceId}, '2026-01-06', '-150.00', 'charged', ${f.adminId}, ${f.adminId}, '2026-01-07', ${entryId})`,
    ).resolves.toBeDefined();
  });
});

describe('remittance_variances_posting_check — status vs journal_entry_id', () => {
  // STRICT (orchestrator ruling): a `charged` variance must carry a journal_entry_id, like `income`.
  // Legacy `charged` rows with no entry are covered by the constraint being NOT VALID, not by this test.
  it('a `charged` row with NO journal_entry_id is refused', async () => {
    const f = await fixture('posting-charged');
    await expect(
      sql`insert into remittance_variances (org_id, remittance_id, business_date, amount, status, charged_to_person_id, resolved_by, resolved_on)
        values (${f.orgId}, ${f.remittanceId}, '2026-01-06', '-150.00', 'charged', ${f.adminId}, ${f.adminId}, '2026-01-07')`,
    ).rejects.toThrow(/posting_check/);
  });

  it('an `income` row with NO journal_entry_id is refused', async () => {
    const f = await fixture('posting-income');
    await expect(
      sql`insert into remittance_variances (org_id, remittance_id, business_date, amount, status, resolved_by, resolved_on)
        values (${f.orgId}, ${f.remittanceId}, '2026-01-06', '80.00', 'income', ${f.adminId}, '2026-01-07')`,
    ).rejects.toThrow();
  });

  it('an `open` row with NO journal_entry_id is accepted (the pre-resolution shape)', async () => {
    const f = await fixture('posting-open');
    await expect(
      sql`insert into remittance_variances (org_id, remittance_id, business_date, amount, status)
        values (${f.orgId}, ${f.remittanceId}, '2026-01-06', '-150.00', 'open')`,
    ).resolves.toBeDefined();
  });
});

describe('remittance_allocations_unique — widened to include source', () => {
  it('two CASH allocations for one (remittance, date) are refused', async () => {
    const f = await fixture('alloc-dup-cash');
    await sql`insert into remittance_allocations (remittance_id, business_date, amount, source) values (${f.remittanceId}, '2026-01-06', '9850.00', 'cash')`;
    await expect(
      sql`insert into remittance_allocations (remittance_id, business_date, amount, source) values (${f.remittanceId}, '2026-01-06', '50.00', 'cash')`,
    ).rejects.toThrow();
  });

  it('a CASH and a CHARGE allocation for the same (remittance, date) are BOTH accepted', async () => {
    const f = await fixture('alloc-cash-charge');
    await sql`insert into remittance_allocations (remittance_id, business_date, amount, source) values (${f.remittanceId}, '2026-01-06', '9850.00', 'cash')`;
    await expect(
      sql`insert into remittance_allocations (remittance_id, business_date, amount, source) values (${f.remittanceId}, '2026-01-06', '150.00', 'charge')`,
    ).resolves.toBeDefined();
  });
});
