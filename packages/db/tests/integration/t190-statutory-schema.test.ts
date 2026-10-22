/**
 * T-190 S1 / case 15 - the schema: migration 0206, `docs/tasks/190-payroll-statutory.md` "Schema" and "Rates, lookups, refusals, immutability".
 *
 * RED until 0206 lands (the test DB is migrated through 0203): the first failure is a missing table or column, which is the right reason.
 * Every refusal here is asserted by the ROW surviving unchanged, not only by an error being thrown - an error from a typo would otherwise pass.
 *
 * Assumed spellings (the spec's own): tables statutory_rates / withholding_brackets / minimum_wages; columns per the spec's Schema section;
 * `payslips.sss_rate_id` / `philhealth_rate_id` / `pagibig_rate_id` are the "rate row ids used" (FK restrict).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { CUTOVER_CLASSIFICATION } from '../../src/cutover/classification';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t190s-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const workerId = await mk('Worker', 'staff');
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, '2026-01-01', 'regular', ${adminId}) returning id`;
  const [rate] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${emp!.id}, 'daily', '800.00', '2026-01-01', ${adminId}) returning id`;
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, created_by)
    values (${orgId}, ${storeId}, '2026-01-01', '2026-01-15', 'draft', ${office!.id}, ${adminId}) returning id`;
  return { orgId, storeId, adminId, workerId, employmentId: emp!.id, payRateId: rate!.id, runId: run!.id };
}
type F = Awaited<ReturnType<typeof fixture>>;

/** One transaction as the application role, in `orgId`. */
async function asApp<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.principal_kind', 'staff', true)`;
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

let slipSeq = 0;
/** A payslip; `over` supplies column overrides (SQL fragments are not used - values only). Each call needs its own run (one slip per job per run). */
async function insertSlip(f: F, over: Record<string, string | string[] | null> = {}) {
  const [run] = await sql<{ id: string }[]>`
    insert into pay_runs (org_id, store_id, period_start, period_end, status, money_account_id, created_by)
    select ${f.orgId}, ${f.storeId}, (date '2026-01-01' + ${++slipSeq} * interval '1 day')::date, (date '2026-01-02' + ${slipSeq} * interval '1 day')::date,
           'draft', money_account_id, ${f.adminId} from pay_runs where id = ${f.runId} returning id`;
  const base: Record<string, string | string[] | null> = {
    basic_pay: '1000.00', gross_pay: '1000.00', advance_recovered: '0', net_pay: '1000.00', ...over,
  };
  const cols = Object.keys(base);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const params = cols.map((c, i) => (Array.isArray(base[c]) ? `$${i + 5}::text[]` : `$${i + 5}`)).join(', ');
  const vals = cols.map((c) => (Array.isArray(base[c]) ? `{${(base[c] as string[]).join(',')}}` : base[c]));
  const rows = await sql.unsafe(
    `insert into payslips (run_id, org_id, employment_id, person_id, pay_rate_id, days_worked, ${colList})
     values ($1, $2, $3, $4, '${f.payRateId}', '1', ${params}) returning id`,
    [run!.id, f.orgId, f.employmentId, f.workerId, ...vals] as never,
  );
  return (rows[0] as unknown as { id: string }).id;
}

const rateRow = async (orgId: string, agency: string, from: string, over: { ee?: string; confirmed?: boolean; by?: string } = {}): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
  insert into statutory_rates (org_id, agency, effective_from, ee_rate, er_rate, base_kind, floor, ceiling, source_ref, confirmed_at, confirmed_by)
  values (${orgId}, ${agency}, ${from}, ${over.ee ?? '0.05'}, '0.10', 'gross', '5000', '35000', 'T-190 schema test',
          ${over.confirmed ? new Date() : null}, ${over.confirmed ? over.by! : null}) returning id`;
  return row!.id;
};

// =====================================================================================================================

describe('T-190 case 15 - payslips: the restated net identity and the new money columns', () => {
  it('a payslip whose net ignores withholding is REJECTED by payslips_net_identity_check; the honest one is accepted  [mutant: the CHECK not restated]', async () => {
    const f = await fixture('net');
    await expect(insertSlip(f, { withholding: '100.00', net_pay: '1000.00' })).rejects.toThrow(/payslips_net_identity_check/);
    await expect(insertSlip(f, { withholding: '100.00', net_pay: '900.00' })).resolves.toBeDefined();
  });

  it('net = gross - SSS - PhilHealth - Pag-IBIG - withholding - advance: ignoring any ONE employee share is rejected', async () => {
    const f = await fixture('net2');
    for (const col of ['sss_ee', 'philhealth_ee', 'pagibig_ee']) {
      await expect(insertSlip(f, { [col]: '50.00', net_pay: '1000.00' }), col).rejects.toThrow(/payslips_net_identity_check/);
    }
    await expect(
      insertSlip(f, { sss_ee: '50.00', philhealth_ee: '25.00', pagibig_ee: '20.00', withholding: '5.00', advance_recovered: '10.00', net_pay: '890.00' }),
    ).resolves.toBeDefined();
  });

  it('the new money columns default to 0, are NOT NULL, and a payslip that names none still satisfies the identity (existing rows stay valid)', async () => {
    const f = await fixture('defaults');
    const id = await insertSlip(f);
    const [r] = await sql<Record<string, string>[]>`
      select sss_ee::text, philhealth_ee::text, pagibig_ee::text, withholding::text, sss_er::text, sss_ec::text, philhealth_er::text,
             pagibig_er::text, taxable_pay::text from payslips where id = ${id}`;
    expect(Object.values(r!)).toEqual(['0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
    const [m] = await sql<{ is_mwe: boolean; skipped_agencies: string[] }[]>`select is_mwe, skipped_agencies from payslips where id = ${id}`;
    expect(m).toEqual({ is_mwe: false, skipped_agencies: [] });
    await expect(sql`update payslips set sss_ee = null where id = ${id}`).rejects.toThrow(/null/i);
  });

  it('every new money column is >= 0 and finite: -1 and NaN are rejected', async () => {
    const f = await fixture('finite');
    await expect(insertSlip(f, { taxable_pay: '5.00' }), 'control: a valid taxable_pay').resolves.toBeDefined();
    for (const col of ['sss_ee', 'philhealth_ee', 'pagibig_ee', 'withholding', 'sss_er', 'sss_ec', 'philhealth_er', 'pagibig_er', 'taxable_pay']) {
      // Employee-side columns sit inside the net identity, so -1 needs net 1001 to reach the >= 0 check; the others do not.
      const inIdentity = ['sss_ee', 'philhealth_ee', 'pagibig_ee', 'withholding'].includes(col);
      await expect(insertSlip(f, { [col]: '-1.00', net_pay: inIdentity ? '1001.00' : '1000.00' }), `${col} = -1`).rejects.toThrow();
      await expect(insertSlip(f, { [col]: 'NaN' }), `${col} = NaN`).rejects.toThrow();
    }
  });

  it('skipped_agencies may only hold sss / philhealth / pagibig', async () => {
    const f = await fixture('skipped');
    await expect(insertSlip(f, { skipped_agencies: ['tin'] })).rejects.toThrow();
    await expect(insertSlip(f, { skipped_agencies: ['sss', 'pagibig'] })).resolves.toBeDefined();
  });
});

describe('T-190 case 15 - persons: government number formats', () => {
  const setCol = async (id: string, col: string, v: string | null) => {
    await sql.unsafe(`update persons set ${col} = $1 where id = '${id}'`, [v] as never);
  };
  it.each([
    ['sss_no', '123456789', '1234567890', '12345678901'],
    ['philhealth_no', '12345678901', '123456789012', '1234567890123'],
    ['pagibig_no', '12345678901', '123456789012', '1234567890123'],
  ])('%s: wrong lengths are rejected, the right length and NULL are accepted  [mutant: 9-digit sss_no accepted]', async (col, short, ok, long) => {
    const f = await fixture(`fmt-${col}`);
    await expect(setCol(f.workerId, col, short)).rejects.toThrow();
    await expect(setCol(f.workerId, col, long)).rejects.toThrow();
    await expect(setCol(f.workerId, col, 'ABCDEFGHIJKL'.slice(0, ok.length))).rejects.toThrow();
    await expect(setCol(f.workerId, col, ok)).resolves.toBeUndefined();
    await expect(setCol(f.workerId, col, null)).resolves.toBeUndefined();
  });
  it('tin: 9 to 12 digits', async () => {
    const f = await fixture('tin');
    for (const bad of ['12345678', '1234567890123', '12345678A']) await expect(setCol(f.workerId, 'tin', bad), bad).rejects.toThrow();
    for (const ok of ['123456789', '123456789012']) await expect(setCol(f.workerId, 'tin', ok), ok).resolves.toBeUndefined();
  });
});

describe('T-190 case 15 - statutory_rates: dating, uniqueness, immutability', () => {
  it('a contribution row takes effect only on the 1st: 2026-07-15 is rejected, 2026-07-01 accepted', async () => {
    const f = await fixture('dating');
    await expect(rateRow(f.orgId, 'sss', '2026-07-15')).rejects.toThrow(/statutory_rates/);
    await expect(rateRow(f.orgId, 'sss', '2026-07-01')).resolves.toBeDefined();
  });

  it('one row per (org, agency, effective_from); agency and base_kind are closed lists', async () => {
    const f = await fixture('unique');
    await rateRow(f.orgId, 'sss', '2026-01-01');
    await expect(rateRow(f.orgId, 'sss', '2026-01-01')).rejects.toThrow(/duplicate|unique/i);
    await expect(rateRow(f.orgId, 'tax', '2026-01-01')).rejects.toThrow();
    await expect(sql`update statutory_rates set base_kind = 'net' where org_id = ${f.orgId}`).rejects.toThrow();
  });

  it('UPDATE of a CONFIRMED row\'s ee_rate is refused as the app role - and the rate is unchanged  [mutant: UPDATE granted]', async () => {
    const f = await fixture('imm-confirmed');
    const id = await rateRow(f.orgId, 'sss', '2026-01-01', { confirmed: true, by: f.adminId });
    await expect(asApp(f.orgId, (tx) => tx`update statutory_rates set ee_rate = '0.06' where id = ${id!}`)).rejects.toThrow();
    const [r] = await sql<{ ee_rate: string }[]>`select ee_rate::text from statutory_rates where id = ${id!}`;
    expect(Number(r!.ee_rate)).toBe(0.05);
  });

  it('UPDATE of an UNCONFIRMED row\'s rate is refused too - the app role may set confirmed_at / confirmed_by and nothing else', async () => {
    const f = await fixture('imm-unconfirmed');
    const id = await rateRow(f.orgId, 'sss', '2026-01-01');
    await expect(asApp(f.orgId, (tx) => tx`update statutory_rates set ee_rate = '0.06' where id = ${id!}`)).rejects.toThrow();
    const [r] = await sql<{ ee_rate: string }[]>`select ee_rate::text from statutory_rates where id = ${id!}`;
    expect(Number(r!.ee_rate)).toBe(0.05);
  });

  it('confirming works ONCE: the first confirm is accepted, re-confirming (a new time, another person, or clearing it) is refused  [mutant: re-confirm allowed]', async () => {
    const f = await fixture('reconfirm');
    const id = await rateRow(f.orgId, 'sss', '2026-01-01');
    await asApp(f.orgId, (tx) => tx`update statutory_rates set confirmed_at = now(), confirmed_by = ${f.adminId} where id = ${id!}`);
    const [first] = await sql<{ confirmed_at: Date; confirmed_by: string }[]>`select confirmed_at, confirmed_by from statutory_rates where id = ${id!}`;
    expect(first!.confirmed_by).toBe(f.adminId);
    await expect(asApp(f.orgId, (tx) => tx`update statutory_rates set confirmed_at = now() + interval '1 day' where id = ${id!}`)).rejects.toThrow();
    await expect(asApp(f.orgId, (tx) => tx`update statutory_rates set confirmed_by = ${f.workerId} where id = ${id!}`)).rejects.toThrow();
    await expect(asApp(f.orgId, (tx) => tx`update statutory_rates set confirmed_at = null, confirmed_by = null where id = ${id!}`)).rejects.toThrow();
    const [after] = await sql<{ confirmed_at: Date; confirmed_by: string }[]>`select confirmed_at, confirmed_by from statutory_rates where id = ${id!}`;
    expect(after).toEqual(first);
  });

  it('DELETE: an unconfirmed never-used row can be deleted; a confirmed row cannot; a USED row cannot (the payslip FK restricts)', async () => {
    const f = await fixture('delete');
    const free = await rateRow(f.orgId, 'sss', '2026-02-01');
    await asApp(f.orgId, (tx) => tx`delete from statutory_rates where id = ${free!}`);
    expect(await sql`select 1 from statutory_rates where id = ${free!}`).toHaveLength(0);

    const confirmed = await rateRow(f.orgId, 'sss', '2026-03-01', { confirmed: true, by: f.adminId });
    await expect(asApp(f.orgId, (tx) => tx`delete from statutory_rates where id = ${confirmed!}`)).rejects.toThrow();
    expect(await sql`select 1 from statutory_rates where id = ${confirmed!}`).toHaveLength(1);

    const used = await rateRow(f.orgId, 'sss', '2026-04-01');
    await insertSlip(f, { sss_rate_id: used! });
    await expect(asApp(f.orgId, (tx) => tx`delete from statutory_rates where id = ${used!}`)).rejects.toThrow();
    expect(await sql`select 1 from statutory_rates where id = ${used!}`).toHaveLength(1);
  });
});

describe('T-190 case 15 - withholding_brackets and minimum_wages: the same immutability', () => {
  it('a bracket row: rate cannot be updated, confirming works once', async () => {
    const f = await fixture('bracket');
    const [row0] = await sql<{ id: string }[]>`
      insert into withholding_brackets (org_id, frequency, effective_from, "over", base_tax, rate, source_ref)
      values (${f.orgId}, 'semi_monthly', '2026-01-01', '10417', '0', '0.15', 'T-190 schema test') returning id`;
    const id = row0!.id;
    await expect(asApp(f.orgId, (tx) => tx`update withholding_brackets set rate = '0.20' where id = ${id!}`)).rejects.toThrow();
    await asApp(f.orgId, (tx) => tx`update withholding_brackets set confirmed_at = now(), confirmed_by = ${f.adminId} where id = ${id!}`);
    await expect(asApp(f.orgId, (tx) => tx`update withholding_brackets set confirmed_at = now() where id = ${id!}`)).rejects.toThrow();
    const [r] = await sql<{ rate: string }[]>`select rate::text from withholding_brackets where id = ${id!}`;
    expect(Number(r!.rate)).toBe(0.15);
  });

  it('a minimum-wage row: daily_rate cannot be updated, confirming works once, frequency of brackets is a closed list', async () => {
    const f = await fixture('minwage');
    const [row0] = await sql<{ id: string }[]>`
      insert into minimum_wages (org_id, store_id, effective_from, daily_rate, wage_order_ref)
      values (${f.orgId}, ${f.storeId}, '2026-01-01', '695.00', 'T-190 schema test') returning id`;
    const id = row0!.id;
    await expect(asApp(f.orgId, (tx) => tx`update minimum_wages set daily_rate = '1.00' where id = ${id!}`)).rejects.toThrow();
    await asApp(f.orgId, (tx) => tx`update minimum_wages set confirmed_at = now(), confirmed_by = ${f.adminId} where id = ${id!}`);
    await expect(asApp(f.orgId, (tx) => tx`update minimum_wages set confirmed_at = now() where id = ${id!}`)).rejects.toThrow();
    const [r] = await sql<{ daily_rate: string }[]>`select daily_rate::text from minimum_wages where id = ${id!}`;
    expect(r!.daily_rate).toBe('695.00');
    await expect(
      sql`insert into withholding_brackets (org_id, frequency, effective_from, "over", base_tax, rate, source_ref)
          values (${f.orgId}, 'daily', '2026-01-01', '0', '0', '0', 'x')`,
    ).rejects.toThrow();
  });
});

describe('T-190 - org scope and classification', () => {
  it('all three reference tables are org-scoped: another org sees none of these rows (RLS)', async () => {
    const a = await fixture('rls-a');
    const b = await fixture('rls-b');
    await rateRow(a.orgId, 'sss', '2026-01-01');
    await sql`insert into withholding_brackets (org_id, frequency, effective_from, "over", base_tax, rate, source_ref)
              values (${a.orgId}, 'weekly', '2026-01-01', '0', '0', '0', 'x')`;
    await sql`insert into minimum_wages (org_id, store_id, effective_from, daily_rate, wage_order_ref)
              values (${a.orgId}, ${a.storeId}, '2026-01-01', '695.00', 'x')`;
    for (const t of ['statutory_rates', 'withholding_brackets', 'minimum_wages']) {
      const seenByB = await asApp(b.orgId, (tx) => tx.unsafe(`select 1 from ${t} where org_id = '${a.orgId}'`));
      expect(seenByB, `${t} leaked across orgs`).toHaveLength(0);
      const seenByA = await asApp(a.orgId, (tx) => tx.unsafe(`select 1 from ${t} where org_id = '${a.orgId}'`));
      expect(seenByA.length, `${t} invisible to its own org`).toBeGreaterThan(0);
    }
  });

  it('all three tables are classified for cutover and registered for RLS', () => {
    for (const t of ['statutory_rates', 'withholding_brackets', 'minimum_wages']) {
      expect(CUTOVER_CLASSIFICATION[t], `${t} is not in cutover/classification.ts`).toBeDefined();
      expect((RLS_REGISTRY as Record<string, unknown>)[t], `${t} is not in rls/registry.ts`).toBeDefined();
    }
  });
});


describe('T-190 audit gap 1 (DB level) - a confirmed bracket set is closed to INSERT', () => {
  it('a raw INSERT of another row into a confirmed (frequency, effective_from) set fails; an unconfirmed set still takes rows', async () => {
    const f = await fixture('closed-set');
    const ins = (frequency: string, over: string, confirmed: boolean) => sql`
      insert into withholding_brackets (org_id, frequency, effective_from, "over", base_tax, rate, source_ref, confirmed_at, confirmed_by)
      values (${f.orgId}, ${frequency}, '2026-01-01', ${over}, '0', '0.1', 'x', ${confirmed ? new Date() : null}, ${confirmed ? f.adminId : null})`;
    await ins('monthly', '0', true);
    await expect(ins('monthly', '20833', false)).rejects.toThrow();
    await expect(ins('monthly', '20833', true)).rejects.toThrow();
    const rows = await sql<{ n: string }[]>`select count(*)::text as n from withholding_brackets where org_id = ${f.orgId} and frequency = 'monthly'`;
    expect(rows[0]!.n).toBe('1');
    await ins('weekly', '0', false);
    await expect(ins('weekly', '4808', false), 'an unconfirmed set must still accept rows').resolves.toBeDefined();
  });
});

describe('T-190 audit gap 4 - the 0206 seed goes to the main org by its key, not the oldest org', () => {
  it('re-running the seed with an OLDER non-main org present seeds only the org coded "shareat"  [mutant: ORDER BY created_at LIMIT 1]', async () => {
    const file = readFileSync(fileURLToPath(new URL('../../migrations/0206_t190_statutory.sql', import.meta.url)), 'utf8');
    const seedSql = file.slice(file.indexOf('-- Seed:'));
    const statements = seedSql.split('--> statement-breakpoint').map((x) => x.trim()).filter((x) => /^(--[^\n]*\n)*\s*INSERT/i.test(x));
    expect(statements.length, 'the seed statements were not found').toBeGreaterThanOrEqual(2);
    const ROLLBACK = new Error('rollback');
    let seen: { old: number; main: number } | null = null;
    await sql
      .begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        // The three history guards are ENABLE ALWAYS (replica mode no longer bypasses them), so lift them inside this
        // rolled-back transaction only; ALTER TABLE is transactional and the ROLLBACK below restores them.
        await tx`alter table statutory_rates disable trigger statutory_rates_immutable`;
        await tx`alter table withholding_brackets disable trigger withholding_brackets_immutable`;
        await tx`alter table minimum_wages disable trigger minimum_wages_immutable`;
        await tx`delete from statutory_rates`;
        await tx`delete from withholding_brackets`;
        await tx`delete from minimum_wages`;
        let [main] = await tx<{ id: string }[]>`select id from organizations where code = 'shareat'`;
        if (!main) [main] = await tx<{ id: string }[]>`insert into organizations (name, code) values ('Shareat', 'shareat') returning id`;
        const [old] = await tx<{ id: string }[]>`insert into organizations (name, code, created_at) values ('Older org', ${uid('older')}, '1999-01-01') returning id`;
        for (const st of statements) await tx.unsafe(st);
        const count = async (org: string) =>
          Number((await tx<{ n: string }[]>`select ((select count(*) from statutory_rates where org_id = ${org}) + (select count(*) from withholding_brackets where org_id = ${org}))::text as n`)[0]!.n);
        seen = { old: await count(old!.id), main: await count(main!.id) };
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(seen).not.toBeNull();
    expect(seen!.old, 'the older non-main org was seeded').toBe(0);
    expect(seen!.main, 'the org coded shareat got no seed').toBeGreaterThan(0);
  });
});
