/**
 * T-436 case 21 - migration 0205 (`0205_t436_leave_tracking.sql`).
 *
 * RED today (a database migrated through 0203): none of the leave tables, the two payslip columns or the
 * rewritten gross identity exist, and `stored_files_purpose_check` still lists the 5 original purposes.
 * Every test below fails on THAT, not on a typo: the column/table names are the ones the spec names.
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const here = dirname(fileURLToPath(import.meta.url));

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t436m-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Store') returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${p!.id}, ${store!.id}, ${uid('sc')}, '2025-01-01', 'regular', ${p!.id}) returning id`;
  const [rate] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${emp!.id}, 'daily', '600.00', '2025-01-01', ${p!.id}) returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${store!.id} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, created_by)
    values (${orgId}, ${store!.id}, '2026-01-01', '2026-01-15', 'draft', ${office!.id}, ${p!.id}) returning id`;
  return { orgId, storeId: store!.id, personId: p!.id, employmentId: emp!.id, rateId: rate!.id, runId: run!.id };
}

type F = Awaited<ReturnType<typeof fixture>>;

async function slip(f: F, v: { basic: string; ot: string; nd: string; hol: string; leave: string; sil: string; gross: string }) {
  return sql`
    insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked,
                          basic_pay, ot_pay, night_diff_pay, holiday_pay, leave_pay, sil_conversion_pay,
                          gross_pay, advance_recovered, net_pay)
    values (${f.runId}, ${f.orgId}, ${f.employmentId}, ${f.personId}, ${f.rateId}, '1',
            ${v.basic}, ${v.ot}, ${v.nd}, ${v.hol}, ${v.leave}, ${v.sil}, ${v.gross}, '0', ${v.gross})`;
}

describe('T-436 case 21 - tables, journal, payslip identity, file purposes', () => {
  it('the five leave tables exist', async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('leave_types','leave_caps','leave_requests','leave_request_days','leave_commutations')`;
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      ['leave_caps', 'leave_commutations', 'leave_request_days', 'leave_requests', 'leave_types'],
    );
  });

  it('journal idx 205 is 0205_t436_leave_tracking with when = 0204 + 86400000', () => {
    const journal = JSON.parse(readFileSync(join(here, '..', '..', 'migrations', 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    const e = journal.entries.find((x) => x.idx === 205);
    expect(e?.tag).toBe('0205_t436_leave_tracking');
    expect(e?.when).toBe(1803785507084);
  });

  it('leave_types carries the eleven seeded kinds with their flags (platform seed, not per-test data)', async () => {
    const rows = await sql<{ code: string; paid: boolean; draws_sil: boolean; requestable: boolean }[]>`
      select distinct code, paid, draws_sil, requestable from leave_types
      where code in ('no_show','sick','personal','emergency','sil','maternity','paternity','solo_parent','vawc','special_women','unpaid_other')`;
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.size).toBe(11);
    expect(byCode.get('no_show')).toMatchObject({ paid: false, requestable: false });
    expect(byCode.get('sil')).toMatchObject({ paid: true, draws_sil: true });
  });

  it('a payslip that satisfies the NEW identity (basic+ot+nd+holiday+leave+sil) is accepted', async () => {
    const f = await fixture('ok');
    await slip(f, { basic: '600.00', ot: '10.00', nd: '5.00', hol: '20.00', leave: '1200.00', sil: '1800.00', gross: '3635.00' });
    const [r] = await sql<{ leave_pay: string; sil_conversion_pay: string }[]>`
      select leave_pay, sil_conversion_pay from payslips where run_id = ${f.runId}`;
    expect(r).toEqual({ leave_pay: '1200.00', sil_conversion_pay: '1800.00' });
  });

  it('a payslip breaking the identity is rejected: leave_pay omitted from gross', async () => {
    const f = await fixture('bad-leave');
    await expect(
      slip(f, { basic: '600.00', ot: '0', nd: '0', hol: '0', leave: '1200.00', sil: '0', gross: '600.00' }),
    ).rejects.toThrow(/payslips_gross_identity_check/);
  });

  it('a payslip breaking the identity is rejected: sil_conversion_pay omitted from gross', async () => {
    const f = await fixture('bad-sil');
    await expect(
      slip(f, { basic: '600.00', ot: '0', nd: '0', hol: '0', leave: '0', sil: '1800.00', gross: '600.00' }),
    ).rejects.toThrow(/payslips_gross_identity_check/);
  });

  it('leave_pay and sil_conversion_pay default to 0 (an old-shape insert still balances)', async () => {
    const f = await fixture('default');
    await sql`
      insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked,
                            basic_pay, gross_pay, advance_recovered, net_pay)
      values (${f.runId}, ${f.orgId}, ${f.employmentId}, ${f.personId}, ${f.rateId}, '1', '600.00', '600.00', '0', '600.00')`;
    const [r] = await sql<{ leave_pay: string; sil_conversion_pay: string }[]>`
      select leave_pay, sil_conversion_pay from payslips where run_id = ${f.runId}`;
    expect(r).toEqual({ leave_pay: '0.00', sil_conversion_pay: '0.00' });
  });

  it('all 8 file purposes insert, a 9th string is rejected (T-434 purposes are NOT dropped)', async () => {
    const f = await fixture('purposes');
    const purposes = [
      'receipt_photo', 'ar_collection_proof', 'memo_document', 'wastage_dispute', 'onboarding_document',
      'staff_photo', 'staff_signature', 'leave_document',
    ];
    for (const purpose of purposes) {
      await sql`
        insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
        values (${f.orgId}, ${f.storeId}, ${purpose}, ${`orgs/${f.orgId}/stores/${f.storeId}/${purpose}/${uid('f')}.jpg`}, 'image/jpeg', 10, 'abc', ${f.personId})`;
    }
    await expect(sql`
      insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
      values (${f.orgId}, ${f.storeId}, 'ninth_purpose', ${`orgs/${f.orgId}/stores/${f.storeId}/ninth/${uid('f')}.jpg`}, 'image/jpeg', 10, 'abc', ${f.personId})`,
    ).rejects.toThrow(/stored_files_purpose_check/);
  });

  it('leave_request_days has the freeze pair (frozen_by_pay_run_id + frozen_at) with a pair CHECK', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'leave_request_days' and column_name in ('frozen_by_pay_run_id','frozen_at')`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(['frozen_at', 'frozen_by_pay_run_id']);
    const checks = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'leave_request_days' and c.contype = 'c'`;
    expect(checks.some((c) => /frozen_at/.test(c.def) && /frozen_by_pay_run_id/.test(c.def))).toBe(true);
  });

  it('leave_commutations: at most one of pay run / separation, unique per person per year', async () => {
    const defs = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'leave_commutations' and c.contype = 'c'`;
    expect(defs.some((d) => /frozen_by_pay_run_id/.test(d.def) && /separation_id/.test(d.def))).toBe(true);
    const idx = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where tablename = 'leave_commutations' and indexdef ilike '%unique%'`;
    expect(idx.some((i) => /person_id/.test(i.def) && /year/.test(i.def))).toBe(true);
  });

  it('one live (pending/approved) leave day per PERSON per date is a partial unique index', async () => {
    const idx = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where tablename = 'leave_request_days' and indexdef ilike '%unique%'`;
    expect(idx.some((i) => /person_id/.test(i.def) && /pending|approved/.test(i.def))).toBe(true);
  });
});
