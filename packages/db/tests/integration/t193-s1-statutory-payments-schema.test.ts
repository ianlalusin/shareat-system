/**
 * T-193 S1 (TESTER) - migration 0222 against a real Postgres: the catalog, the refusals (SQLSTATE + "nothing written"), RLS
 * isolation, grants as shareat_app, the two triggers, and account 6810 for old and new orgs.
 * docs/tasks/193-statutory-remittance/REFRESH.md s3 + s5 (S1). Real Postgres via TEST_DATABASE_URL (a *_test database).
 *
 * RED TODAY: the three tables and account 6810 do not exist, so every leg that touches them fails on "relation does not exist".
 *
 * MUTANTS (each leg names its own): GRANT UPDATE on all columns; missing btrim CHECK; guard left ENABLE ORIGIN; no line
 *   freeze; non-partial unique; FK on store_id / money_account_id / journal_entry_id alone (no same-org twin); missing month /
 *   paid_on CHECK; RLS without FORCE or without WITH CHECK; 6810 seed-only (old orgs lack it).
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { APP_ROLE } from '../../src/rls/registry';
import { seedChartOfAccounts } from '../../seed/chart-of-accounts';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
type PgErr = Error & { code?: string; constraint_name?: string };
async function refusal(fn: () => PromiseLike<unknown>): Promise<PgErr | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as PgErr;
  }
}
const CHECK = '23514';
const UNIQUE = '23505';
const FK = '23503';
const NOPRIV = '42501';

interface Fx {
  orgId: string;
  personId: string;
  storeA: string;
  storeB: string;
  accountId: string;
  entry1: string;
  entry2: string;
}

/** One org: two stores, a person, a money account, a 2027-01 period and two DRAFT, balanced journal entries (the entry link needs a real one). */
async function fx(hint: string): Promise<Fx> {
  const code = uid(`t193-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [a] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Lipa') returning id`;
  const [b] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Malvar') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const [m] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active)
    values (${orgId}, ${a!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [per] = await sql<{ id: string }[]>`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open') returning id`;
  const [dr] = await sql<{ id: string }[]>`
    insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
    values (${orgId}, '9001', 'Probe debit', 'expense', 'debit', true, true, 'active') returning id`;
  const [cr] = await sql<{ id: string }[]>`
    insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
    values (${orgId}, '9002', 'Probe credit', 'asset', 'debit', true, true, 'active') returning id`;
  // a journal entry must carry two balanced lines by commit time, so each header gets them in the same transaction
  const mk = () =>
    sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, period_id, entry_date, source_type, source_id, idempotency_key, memo, status)
        values (${orgId}, ${per!.id}, '2027-01-10', 'statutory_payment', ${uid('src')}, ${uid('idem')}, 't193 probe', 'draft') returning id`;
      await tx`insert into journal_lines (entry_id, account_id, line_no, debit, credit) values (${e!.id}, ${dr!.id}, 1, 100, 0), (${e!.id}, ${cr!.id}, 2, 0, 100)`;
      return e!.id;
    });
  return { orgId, personId: p!.id, storeA: a!.id, storeB: b!.id, accountId: m!.id, entry1: (await mk()) as string, entry2: (await mk()) as string };
}

type Over = Partial<{
  id: string;
  agency: string;
  month: string;
  paidOn: string;
  reference: string;
  penalty: string | number;
  accountId: string;
  entryId: string | null;
  createdBy: string;
}>;
/** A posted statutory payment. Every column the checks look at is passed explicitly. */
async function pay(f: Fx, o: Over = {}, q: postgres.Sql | postgres.TransactionSql = sql): Promise<string> {
  const id = o.id ?? crypto.randomUUID();
  await q`
    insert into statutory_payments (id, org_id, agency, month, paid_on, money_account_id, reference_no, penalty, journal_entry_id, created_by)
    values (${id}, ${f.orgId}, ${o.agency ?? 'sss'}, ${o.month ?? '2027-01-01'}, ${o.paidOn ?? '2027-02-10'}, ${o.accountId ?? f.accountId},
            ${o.reference ?? uid('REF')}, ${o.penalty ?? 0}, ${o.entryId === undefined ? null : o.entryId}, ${o.createdBy ?? f.personId})`;
  return id;
}
const line = (f: Fx, paymentId: string, storeId: string, amount: string | number = '100.00', q: postgres.Sql | postgres.TransactionSql = sql) =>
  q`insert into statutory_payment_lines (org_id, payment_id, store_id, amount) values (${f.orgId}, ${paymentId}, ${storeId}, ${amount})`;
const count = async (table: string, where: string) => Number((await sql.unsafe(`select count(*)::int c from ${table} where ${where}`))[0]!.c);
const voidIt = (id: string, by: string) =>
  sql`update statutory_payments set status = 'voided', void_reason = 'wrong month', voided_by = ${by}, voided_at = now() where id = ${id}`;

class Rollback extends Error {}
/** Run fn as shareat_app with app.org_id = org, in a transaction that is ALWAYS rolled back; fn's error is returned. */
async function asApp<T>(org: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<{ err?: PgErr; value?: T }> {
  const out: { err?: PgErr; value?: T } = {};
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${APP_ROLE}`);
      await tx`select set_config('app.principal_kind', 'staff', true)`;
      await tx`select set_config('app.org_id', ${org}, true)`;
      try {
        await tx.savepoint(async (sp) => {
          out.value = await fn(sp as unknown as postgres.TransactionSql);
        });
      } catch (e) {
        out.err = e as PgErr;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return out;
}

// =================================================================================================
describe('C - catalog: the shape the migration must leave behind', () => {
  it('the three tables exist - RED today: relation does not exist', async () => {
    const rows = await sql<{ relname: string }[]>`select relname from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and relname like 'statutory\_%'`;
    const names = rows.map((r) => r.relname);
    for (const t of ['statutory_employers', 'statutory_payments', 'statutory_payment_lines']) expect(names, t).toContain(t);
  });

  it.each(['statutory_employers', 'statutory_payments', 'statutory_payment_lines'])('%s: RLS enabled AND forced, exactly one org_isolation policy with USING and WITH CHECK (kills: FORCE missing, WITH CHECK missing)', async (t) => {
    const [c] = await sql<{ rls: boolean; forced: boolean }[]>`select relrowsecurity rls, relforcerowsecurity forced from pg_class where oid = ${`public.${t}`}::regclass`;
    expect(c).toEqual({ rls: true, forced: true });
    const pol = await sql<{ polname: string; qual: string | null; wc: string | null }[]>`
      select polname, pg_get_expr(polqual, polrelid) qual, pg_get_expr(polwithcheck, polrelid) wc from pg_policy where polrelid = ${`public.${t}`}::regclass`;
    expect(pol.map((p) => p.polname)).toEqual([`${t}_org_isolation`]);
    expect(pol[0]!.qual).toMatch(/org_id/);
    expect(pol[0]!.wc, 'WITH CHECK missing').toMatch(/org_id/);
  });

  it('same-org composite FKs exist by name and point at (org_id, id): money_account, journal_entry, created_by, voided_by, payment, store (kills: single-column FK, missing journal twin)', async () => {
    const want: [string, string, string][] = [
      ['statutory_payments', 'statutory_payments_money_account_id_same_org_fk', 'money_accounts'],
      ['statutory_payments', 'statutory_payments_journal_entry_id_same_org_fk', 'journal_entries'],
      ['statutory_payments', 'statutory_payments_created_by_same_org_fk', 'persons'],
      ['statutory_payments', 'statutory_payments_voided_by_same_org_fk', 'persons'],
      ['statutory_payment_lines', 'statutory_payment_lines_payment_id_same_org_fk', 'statutory_payments'],
      ['statutory_payment_lines', 'statutory_payment_lines_store_id_same_org_fk', 'stores'],
      ['statutory_employers', 'statutory_employers_created_by_same_org_fk', 'persons'],
      ['statutory_employers', 'statutory_employers_updated_by_same_org_fk', 'persons'],
    ];
    for (const [tbl, name, parent] of want) {
      const [r] = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) def from pg_constraint where conname = ${name} and conrelid = ${`public.${tbl}`}::regclass`;
      expect(r, `${name} missing`).toBeDefined();
      expect(r!.def).toMatch(new RegExp(`FOREIGN KEY \\(org_id, \\w+\\) REFERENCES ${parent}\\(org_id, id\\)`));
      expect(r!.def).toMatch(/ON DELETE RESTRICT/);
    }
  });

  it('grants: shareat_app has SELECT + INSERT, no DELETE/TRUNCATE anywhere, UPDATE only on the named columns (kills: GRANT UPDATE on all columns)', async () => {
    const col = async (t: string, c: string, priv: string) => (await sql<{ ok: boolean }[]>`select has_column_privilege(${APP_ROLE}, ${`public.${t}`}, ${c}, ${priv}) ok`)[0]!.ok;
    const tab = async (t: string, priv: string) => (await sql<{ ok: boolean }[]>`select has_table_privilege(${APP_ROLE}, ${`public.${t}`}, ${priv}) ok`)[0]!.ok;
    for (const t of ['statutory_employers', 'statutory_payments', 'statutory_payment_lines']) {
      expect(await tab(t, 'SELECT'), `${t} SELECT`).toBe(true);
      expect(await tab(t, 'INSERT'), `${t} INSERT`).toBe(true);
      expect(await tab(t, 'DELETE'), `${t} DELETE`).toBe(false);
      expect(await tab(t, 'TRUNCATE'), `${t} TRUNCATE`).toBe(false);
    }
    for (const c of ['journal_entry_id', 'status', 'void_reason', 'voided_by', 'voided_at']) expect(await col('statutory_payments', c, 'UPDATE'), `payments.${c}`).toBe(true);
    for (const c of ['id', 'org_id', 'agency', 'month', 'paid_on', 'money_account_id', 'reference_no', 'penalty', 'notes', 'created_by', 'created_at']) {
      expect(await col('statutory_payments', c, 'UPDATE'), `payments.${c} must NOT be updatable`).toBe(false);
    }
    for (const c of ['employer_no', 'due_day', 'updated_by', 'updated_at']) expect(await col('statutory_employers', c, 'UPDATE'), `employers.${c}`).toBe(true);
    for (const c of ['id', 'org_id', 'agency', 'created_by', 'created_at']) expect(await col('statutory_employers', c, 'UPDATE'), `employers.${c} must NOT be updatable`).toBe(false);
    for (const c of ['payment_id', 'store_id', 'amount', 'org_id']) expect(await col('statutory_payment_lines', c, 'UPDATE'), `lines.${c} must NOT be updatable`).toBe(false);
  });

  it('trigger modes: the history guard is ENABLE ALWAYS (A), the line freeze is ENABLE ORIGIN (O) (kills: guard left origin)', async () => {
    const rows = await sql<{ tgname: string; e: string; t: string }[]>`
      select tg.tgname, tg.tgenabled::text e, c.relname t from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
       where not tg.tgisinternal and tg.tgname in ('statutory_payments_history_guard', 'statutory_payment_lines_parent_open_trg')`;
    const by = Object.fromEntries(rows.map((r) => [r.tgname, r]));
    expect(by.statutory_payments_history_guard, 'RED today: no guard').toMatchObject({ e: 'A', t: 'statutory_payments' });
    expect(by.statutory_payment_lines_parent_open_trg, 'RED today: no line freeze').toMatchObject({ e: 'O', t: 'statutory_payment_lines' });
  });
});

// =================================================================================================
describe('K1 - account 6810 exists for an org created BEFORE 0222 and for a freshly seeded org (kills: seed-only)', () => {
  it('a freshly seeded org has 6810 Penalties and surcharges: postable, expense, debit, under 6000, no party', async () => {
    const code = uid('t193-seed');
    const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    await seedChartOfAccounts(sql, o!.id);
    const rows = await sql<{ name: string; type: string; normal_balance: string; is_postable: boolean; requires_party: boolean; parent: string }[]>`
      select a.name, a.type, a.normal_balance, a.is_postable, a.requires_party, p.code parent
        from accounts a join accounts p on p.id = a.parent_id where a.org_id = ${o!.id} and a.code = '6810'`;
    expect(rows, 'RED today: 6810 is not seeded').toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Penalties and surcharges', type: 'expense', normal_balance: 'debit', is_postable: true, requires_party: false, parent: '6000' });
    expect(await count('accounts', `org_id = '${o!.id}'`)).toBe(103); // 102 + 6810; the seed and the migration must agree
  });

  it('the migration statement that seeds 6810 adds it to an old org (a 6000 header, no 6810), once, and leaves an org without a 6000 header alone', async () => {
    const mig = readFileSync(join(import.meta.dirname, '..', '..', 'migrations', '0222_t193_statutory_payments.sql'), 'utf8'); // RED today: ENOENT
    const stmt = mig
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .find((s) => /INSERT INTO "accounts"/i.test(s) && s.includes('6810'));
    expect(stmt, 'the migration has no INSERT that seeds 6810').toBeDefined();

    const code = uid('t193-old');
    const [old] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const [hdr] = await sql<{ id: string }[]>`
      insert into accounts (org_id, code, name, type, normal_balance, is_postable, is_system, status)
      values (${old!.id}, '6000', 'Operating expenses', 'expense', 'debit', false, true, 'active') returning id`;
    const code2 = uid('t193-bare');
    const [bare] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code2}`}, ${code2}) returning id`;

    await sql.unsafe(stmt!);
    await sql.unsafe(stmt!); // a re-run adds nothing
    const rows = await sql<{ name: string; type: string; normal_balance: string; is_postable: boolean; is_system: boolean; requires_party: boolean; status: string; parent_id: string }[]>`
      select name, type, normal_balance, is_postable, is_system, requires_party, status, parent_id from accounts where org_id = ${old!.id} and code = '6810'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Penalties and surcharges', type: 'expense', normal_balance: 'debit', is_postable: true, is_system: true, requires_party: false, status: 'active', parent_id: hdr!.id });
    expect(await count('accounts', `org_id = '${bare!.id}'`), 'an org with no chart must not get a stray 6810').toBe(0);
  });
});

// =================================================================================================
describe('P17 - case 17: payments are immutable except the void and the one journal link; references and employer numbers are well formed', () => {
  it.each([
    ['reference_no', `reference_no = 'CHANGED'`],
    ['penalty', `penalty = 5`],
    ['paid_on', `paid_on = '2027-03-01'`],
    ['agency', `agency = 'pagibig'`],
    ['month', `month = '2027-02-01'`],
    ['notes', `notes = 'edited'`],
    ['money_account_id', `money_account_id = money_account_id`], // same value is a no-op: must be ACCEPTED (control below)
  ])('UPDATE %s on a posted payment: refused by the history guard (23514, constraint statutory_payments_history_guard), row unchanged', async (col, set) => {
    const f = await fx('p17u');
    const id = await pay(f);
    const before = JSON.stringify((await sql`select * from statutory_payments where id = ${id}`)[0]);
    const err = await refusal(() => sql.unsafe(`update statutory_payments set ${set} where id = '${id}'`));
    if (col === 'money_account_id') {
      expect(err, 'a no-op update must not be refused').toBeUndefined();
      return;
    }
    expect(err, `RED today: ${col} update was accepted or the table is missing`).toBeDefined();
    expect(err!.code).toBe(CHECK);
    expect(err!.constraint_name).toBe('statutory_payments_history_guard');
    expect(JSON.stringify((await sql`select * from statutory_payments where id = ${id}`)[0])).toBe(before);
  });

  it('DELETE of a payment is refused by the guard (23514) even for the table owner, and the row stays (kills: no delete branch)', async () => {
    const f = await fx('p17d');
    const id = await pay(f);
    const err = await refusal(() => sql`delete from statutory_payments where id = ${id}`);
    expect(err?.code).toBe(CHECK);
    expect(err?.constraint_name).toBe('statutory_payments_history_guard');
    expect(await count('statutory_payments', `id = '${id}'`)).toBe(1);
  });

  it('un-void is refused (voided is final): back to posted with the void columns cleared, or only the reason edited - 23514 by the guard, still voided', async () => {
    const f = await fx('p17v');
    const id = await pay(f);
    await voidIt(id, f.personId);
    const back = await refusal(() => sql`update statutory_payments set status = 'posted', void_reason = null, voided_by = null, voided_at = null where id = ${id}`);
    expect(back?.code).toBe(CHECK);
    expect(back?.constraint_name, 'must be the guard, not just the status CHECK').toBe('statutory_payments_history_guard');
    const edit = await refusal(() => sql`update statutory_payments set void_reason = 'rewritten' where id = ${id}`);
    expect(edit?.constraint_name).toBe('statutory_payments_history_guard');
    const [r] = await sql<{ status: string; void_reason: string }[]>`select status, void_reason from statutory_payments where id = ${id}`;
    expect(r).toEqual({ status: 'voided', void_reason: 'wrong month' });
  });

  it('the void itself is allowed (control): posted -> voided with reason, voided_by, voided_at', async () => {
    const f = await fx('p17c');
    const id = await pay(f);
    expect(await refusal(() => voidIt(id, f.personId))).toBeUndefined();
    expect(await count('statutory_payments', `id = '${id}' and status = 'voided'`)).toBe(1);
  });

  it.each([
    ['padded reference', ' SSS-1', 'statutory_payments_reference_no_check'],
    ['trailing space', 'SSS-1 ', 'statutory_payments_reference_no_check'],
    ['empty reference', '', 'statutory_payments_reference_no_check'],
  ])('INSERT with a %s is refused (23514 %s) and nothing is written (kills: missing btrim CHECK)', async (_n, ref, constraint) => {
    const f = await fx('p17r');
    const err = await refusal(() => pay(f, { reference: ref }));
    expect(err?.code, 'RED today: the table is missing').toBe(CHECK);
    expect(err?.constraint_name).toBe(constraint);
    expect(await count('statutory_payments', `org_id = '${f.orgId}'`)).toBe(0);
  });

  it('INSERT with a negative penalty, an unknown agency, a voided row without a reason, or a posted row carrying a reason: each refused 23514, nothing written', async () => {
    const f = await fx('p17x');
    const id = () => crypto.randomUUID();
    const base = (extra: string, vals: string) =>
      sql.unsafe(
        `insert into statutory_payments (id, org_id, agency, month, paid_on, money_account_id, reference_no, penalty, created_by${extra})
         values ('${id()}', '${f.orgId}', ${vals.includes('AGENCY') ? `'tin'` : `'sss'`}, '2027-01-01', '2027-02-10', '${f.accountId}', '${uid('R')}', ${vals.includes('NEG') ? '-1' : '0'}, '${f.personId}'${vals.replace('AGENCY', '').replace('NEG', '')})`,
      );
    expect((await refusal(() => base('', 'NEG')))?.constraint_name).toBe('statutory_payments_penalty_check');
    expect((await refusal(() => base('', 'AGENCY')))?.constraint_name).toBe('statutory_payments_agency_check');
    expect((await refusal(() => base(', status', `, 'voided'`)))?.constraint_name).toBe('statutory_payments_status_check');
    expect((await refusal(() => base(', void_reason', `, 'because'`)))?.constraint_name).toBe('statutory_payments_status_check');
    expect(await count('statutory_payments', `org_id = '${f.orgId}'`)).toBe(0);
  });

  it('employer numbers: bir with a number is refused; sss with none, a non-digit number, due_day 0 or 32, and a second row for the same agency are each refused; a good row is accepted', async () => {
    const f = await fx('p17e');
    const ins = (agency: string, no: string | null, due: number) =>
      sql`insert into statutory_employers (org_id, agency, employer_no, due_day, created_by) values (${f.orgId}, ${agency}, ${no}, ${due}, ${f.personId})`;
    const bir = await refusal(() => ins('bir', '123', 10));
    expect(bir?.code, 'RED today: the table is missing').toBe(CHECK);
    expect(bir?.constraint_name).toBe('statutory_employers_employer_no_check');
    expect((await refusal(() => ins('sss', null, 10)))?.constraint_name).toBe('statutory_employers_employer_no_check');
    expect((await refusal(() => ins('sss', '12-34', 10)))?.constraint_name).toBe('statutory_employers_employer_no_check');
    expect((await refusal(() => ins('sss', '1234', 0)))?.constraint_name).toBe('statutory_employers_due_day_check');
    expect((await refusal(() => ins('sss', '1234', 32)))?.constraint_name).toBe('statutory_employers_due_day_check');
    expect(await count('statutory_employers', `org_id = '${f.orgId}'`)).toBe(0);
    expect(await refusal(() => ins('sss', '0012345', 10))).toBeUndefined();
    expect(await refusal(() => ins('bir', null, 10))).toBeUndefined();
    const dup = await refusal(() => ins('sss', '999', 15));
    expect(dup?.code).toBe(UNIQUE);
    expect(dup?.constraint_name).toBe('statutory_employers_org_agency_unique');
  });

  it('as shareat_app: UPDATE of penalty / reference_no / amount, and DELETE of a payment or a line, are refused with 42501 and nothing changes; employer_no and the void columns ARE updatable (kills: GRANT UPDATE on all columns)', async () => {
    const f = await fx('p17g');
    const id = await pay(f);
    await line(f, id, f.storeA, '50.00');
    await sql`insert into statutory_employers (org_id, agency, employer_no, due_day, created_by) values (${f.orgId}, 'sss', '111', 10, ${f.personId})`;

    for (const stmt of [
      `update statutory_payments set penalty = 9 where id = '${id}'`,
      `update statutory_payments set reference_no = 'X' where id = '${id}'`,
      `update statutory_payment_lines set amount = 1 where payment_id = '${id}'`,
      `delete from statutory_payment_lines where payment_id = '${id}'`,
      `delete from statutory_payments where id = '${id}'`,
      `update statutory_employers set agency = 'pagibig' where org_id = '${f.orgId}'`,
      `delete from statutory_employers where org_id = '${f.orgId}'`,
    ]) {
      const r = await asApp(f.orgId, (tx) => tx.unsafe(stmt));
      expect(r.err, `RED today / ACCEPTED: ${stmt}`).toBeDefined();
      expect(r.err!.code, stmt).toBe(NOPRIV);
    }
    const [row] = await sql<{ penalty: string; reference_no: string }[]>`select penalty::text, reference_no from statutory_payments where id = ${id}`;
    expect(row!.penalty).toBe('0.00');
    expect(await count('statutory_payment_lines', `payment_id = '${id}' and amount = 50`)).toBe(1);

    const emp = await asApp(f.orgId, (tx) => tx.unsafe(`update statutory_employers set employer_no = '222', updated_by = '${f.personId}', updated_at = now() where org_id = '${f.orgId}' and agency = 'sss'`));
    expect(emp.err, 'employer_no edit must be allowed').toBeUndefined();
    const v = await asApp(f.orgId, (tx) =>
      tx.unsafe(`update statutory_payments set status = 'voided', void_reason = 'dup', voided_by = '${f.personId}', voided_at = now() where id = '${id}'`),
    );
    expect(v.err, 'void columns must be allowed').toBeUndefined();
  });
});

// =================================================================================================
describe('P21 - case 21 DB legs: the line freeze, the one journal link, replica mode, the posted-reference unique', () => {
  it('a line INSERT is refused (23514, statutory_payment_lines_parent_open) once the parent has its journal entry; before that it is accepted (kills: no line freeze)', async () => {
    const f = await fx('p21a');
    const id = await pay(f);
    expect(await refusal(() => line(f, id, f.storeA)), 'RED today: the table is missing').toBeUndefined();
    await sql`update statutory_payments set journal_entry_id = ${f.entry1} where id = ${id}`;
    const err = await refusal(() => line(f, id, f.storeB));
    expect(err?.code).toBe(CHECK);
    expect(err?.constraint_name).toBe('statutory_payment_lines_parent_open');
    expect(await count('statutory_payment_lines', `payment_id = '${id}'`)).toBe(1);
  });

  it('a line INSERT is refused for a VOIDED parent even with no journal entry (kills: freeze reads only journal_entry_id)', async () => {
    const f = await fx('p21b');
    const id = await pay(f);
    await voidIt(id, f.personId);
    const err = await refusal(() => line(f, id, f.storeA));
    expect(err?.constraint_name).toBe('statutory_payment_lines_parent_open');
    expect(await count('statutory_payment_lines', `payment_id = '${id}'`)).toBe(0);
  });

  it('journal_entry_id is set once: NULL -> entry1 accepted; entry1 -> entry2 and entry1 -> NULL refused by the guard (23514); still entry1', async () => {
    const f = await fx('p21c');
    const id = await pay(f);
    expect(await refusal(() => sql`update statutory_payments set journal_entry_id = ${f.entry1} where id = ${id}`), 'RED today').toBeUndefined();
    for (const to of [f.entry2, null]) {
      const err = await refusal(() => sql`update statutory_payments set journal_entry_id = ${to} where id = ${id}`);
      expect(err?.code, `to ${to}`).toBe(CHECK);
      expect(err?.constraint_name).toBe('statutory_payments_history_guard');
    }
    expect((await sql<{ j: string }[]>`select journal_entry_id j from statutory_payments where id = ${id}`)[0]!.j).toBe(f.entry1);
  });

  it('un-void and DELETE are refused under session_replication_role = replica (the guard is ENABLE ALWAYS); the line freeze is NOT (it is origin, by design) (kills: guard left origin)', async () => {
    const f = await fx('p21d');
    const id = await pay(f);
    await voidIt(id, f.personId);
    const inReplica = (fn: (tx: postgres.TransactionSql) => PromiseLike<unknown>) =>
      refusal(() =>
        sql.begin(async (tx) => {
          await tx.unsafe(`set local session_replication_role = 'replica'`);
          await fn(tx);
        }),
      );
    const un = await inReplica((tx) => tx`update statutory_payments set status = 'posted', void_reason = null, voided_by = null, voided_at = null where id = ${id}`);
    expect(un?.code, 'RED today / guard is ORIGIN: un-void accepted in replica mode').toBe(CHECK);
    expect(un?.constraint_name).toBe('statutory_payments_history_guard');
    const del = await inReplica((tx) => tx`delete from statutory_payments where id = ${id}`);
    expect(del?.constraint_name).toBe('statutory_payments_history_guard');
    expect((await sql<{ s: string }[]>`select status s from statutory_payments where id = ${id}`)[0]!.s).toBe('voided');
  });

  it('two POSTED payments cannot share (org, agency, reference_no): 23505 posted_reference_unique, one row; the same reference under another agency or another org is fine; after a void the reference is reusable (kills: non-partial unique)', async () => {
    const f = await fx('p21e');
    const g = await fx('p21e2');
    const first = await pay(f, { reference: 'OR-100', agency: 'sss' });
    const dup = await refusal(() => pay(f, { reference: 'OR-100', agency: 'sss' }));
    expect(dup?.code, 'RED today: the table is missing').toBe(UNIQUE);
    expect(dup?.constraint_name).toBe('statutory_payments_posted_reference_unique');
    expect(await count('statutory_payments', `org_id = '${f.orgId}' and reference_no = 'OR-100'`)).toBe(1);
    expect(await refusal(() => pay(f, { reference: 'OR-100', agency: 'philhealth' })), 'other agency').toBeUndefined();
    expect(await refusal(() => pay(g, { reference: 'OR-100', agency: 'sss' })), 'other org').toBeUndefined();
    await voidIt(first, f.personId);
    expect(await refusal(() => pay(f, { reference: 'OR-100', agency: 'sss' })), 'reuse after void').toBeUndefined();
    expect(await count('statutory_payments', `org_id = '${f.orgId}' and reference_no = 'OR-100' and agency = 'sss'`)).toBe(2);
  });

  it('a store appears once per payment (23505 payment_store_unique) and an amount of 0 or less is refused (23514 amount_check); nothing extra is written', async () => {
    const f = await fx('p21f');
    const id = await pay(f);
    await line(f, id, f.storeA, '10.00');
    const dup = await refusal(() => line(f, id, f.storeA, '20.00'));
    expect(dup?.code).toBe(UNIQUE);
    expect(dup?.constraint_name).toBe('statutory_payment_lines_payment_store_unique');
    for (const a of ['0', '-5']) {
      const bad = await refusal(() => line(f, id, f.storeB, a));
      expect(bad?.code).toBe(CHECK);
      expect(bad?.constraint_name).toBe('statutory_payment_lines_amount_check');
    }
    expect(await count('statutory_payment_lines', `payment_id = '${id}'`)).toBe(1);
  });
});

// =================================================================================================
describe('P18 - case 18 FK leg: another org\'s store / money account / journal entry / person is refused (23503) by the SAME-ORG twin, and nothing is written', () => {
  it('a line naming another org\'s store: 23503 statutory_payment_lines_store_id_same_org_fk (kills: FK on store_id alone)', async () => {
    const f = await fx('p18a');
    const g = await fx('p18a2');
    const id = await pay(f);
    const err = await refusal(() => line(f, id, g.storeA));
    expect(err?.code, 'RED today: the table is missing').toBe(FK);
    expect(err?.constraint_name).toBe('statutory_payment_lines_store_id_same_org_fk');
    expect(await count('statutory_payment_lines', `payment_id = '${id}'`)).toBe(0);
  });

  it('a payment naming another org\'s money account: 23503 statutory_payments_money_account_id_same_org_fk', async () => {
    const f = await fx('p18b');
    const g = await fx('p18b2');
    const err = await refusal(() => pay(f, { accountId: g.accountId }));
    expect(err?.code).toBe(FK);
    expect(err?.constraint_name).toBe('statutory_payments_money_account_id_same_org_fk');
    expect(await count('statutory_payments', `org_id = '${f.orgId}'`)).toBe(0);
  });

  it('a payment naming another org\'s journal entry: 23503 statutory_payments_journal_entry_id_same_org_fk (kills: journal_entry_id without its 0213 twin)', async () => {
    const f = await fx('p18c');
    const g = await fx('p18c2');
    const err = await refusal(() => pay(f, { entryId: g.entry1 }));
    expect(err?.code).toBe(FK);
    expect(err?.constraint_name).toBe('statutory_payments_journal_entry_id_same_org_fk');
    expect(await count('statutory_payments', `org_id = '${f.orgId}'`)).toBe(0);
    // and the later link (an UPDATE) is held to the same twin
    const id = await pay(f);
    const upd = await refusal(() => sql`update statutory_payments set journal_entry_id = ${g.entry1} where id = ${id}`);
    expect(upd?.constraint_name).toBe('statutory_payments_journal_entry_id_same_org_fk');
  });

  it('created_by and voided_by from another org are refused by their twins', async () => {
    const f = await fx('p18d');
    const g = await fx('p18d2');
    const e1 = await refusal(() => pay(f, { createdBy: g.personId }));
    expect(e1?.constraint_name).toBe('statutory_payments_created_by_same_org_fk');
    const id = await pay(f);
    const e2 = await refusal(() => voidIt(id, g.personId));
    expect(e2?.constraint_name).toBe('statutory_payments_voided_by_same_org_fk');
    expect((await sql<{ s: string }[]>`select status s from statutory_payments where id = ${id}`)[0]!.s).toBe('posted');
  });

  it('a line whose org_id differs from its payment\'s org_id is refused (23503 payment_id_same_org_fk)', async () => {
    const f = await fx('p18e');
    const g = await fx('p18e2');
    const id = await pay(f);
    const err = await refusal(() => sql`insert into statutory_payment_lines (org_id, payment_id, store_id, amount) values (${g.orgId}, ${id}, ${g.storeA}, 10)`);
    expect(err?.code).toBe(FK);
    expect(err?.constraint_name).toBe('statutory_payment_lines_payment_id_same_org_fk');
  });
});

// =================================================================================================
describe('P15 - case 15 DB leg: the month is the 1st and the payment is on or after it', () => {
  it('month 2027-01-02 is refused (month_first_check); paid_on before the month is refused (paid_on_check); paid_on = month is accepted (kills: either CHECK missing)', async () => {
    const f = await fx('p15');
    const a = await refusal(() => pay(f, { month: '2027-01-02' }));
    expect(a?.code, 'RED today: the table is missing').toBe(CHECK);
    expect(a?.constraint_name).toBe('statutory_payments_month_first_check');
    const b = await refusal(() => pay(f, { month: '2027-02-01', paidOn: '2027-01-31' }));
    expect(b?.code).toBe(CHECK);
    expect(b?.constraint_name).toBe('statutory_payments_paid_on_check');
    expect(await count('statutory_payments', `org_id = '${f.orgId}'`)).toBe(0);
    expect(await refusal(() => pay(f, { month: '2027-02-01', paidOn: '2027-02-01' }))).toBeUndefined();
  });
});

// =================================================================================================
describe('RLS - org isolation as shareat_app (kills: policy missing, FORCE missing, WITH CHECK missing)', () => {
  it('org B cannot see org A\'s employers, payments or lines; org A sees its own', async () => {
    const a = await fx('rls-a');
    const b = await fx('rls-b');
    const id = await pay(a);
    await line(a, id, a.storeA, '10.00');
    await sql`insert into statutory_employers (org_id, agency, employer_no, due_day, created_by) values (${a.orgId}, 'sss', '1', 10, ${a.personId})`;
    for (const t of ['statutory_employers', 'statutory_payments', 'statutory_payment_lines']) {
      const mine = await asApp(a.orgId, (tx) => tx.unsafe(`select count(*)::int c from ${t}`));
      expect(mine.err, `RED today: ${t}`).toBeUndefined();
      expect(Number((mine.value as unknown as { c: number }[])[0]!.c), `${t} as owner org`).toBeGreaterThanOrEqual(1);
      const theirs = await asApp(b.orgId, (tx) => tx.unsafe(`select count(*)::int c from ${t} where org_id = '${a.orgId}'`));
      expect(Number((theirs.value as unknown as { c: number }[])[0]!.c), `${t} leaked to another org`).toBe(0);
    }
  });

  it('as org B, inserting a payment, a line or an employer stamped with org A is refused by WITH CHECK (42501); nothing is written', async () => {
    const a = await fx('rls-c');
    const b = await fx('rls-d');
    const id = await pay(a);
    const p = await asApp(b.orgId, (tx) =>
      tx`insert into statutory_payments (id, org_id, agency, month, paid_on, money_account_id, reference_no, created_by)
         values (${crypto.randomUUID()}, ${a.orgId}, 'sss', '2027-01-01', '2027-02-10', ${a.accountId}, ${uid('R')}, ${a.personId})`,
    );
    expect(p.err?.code, 'payment: WITH CHECK').toBe(NOPRIV);
    const l = await asApp(b.orgId, (tx) => tx`insert into statutory_payment_lines (org_id, payment_id, store_id, amount) values (${a.orgId}, ${id}, ${a.storeA}, 1)`);
    expect(l.err?.code, 'line: WITH CHECK').toBe(NOPRIV);
    const e = await asApp(b.orgId, (tx) => tx`insert into statutory_employers (org_id, agency, employer_no, due_day, created_by) values (${a.orgId}, 'sss', '1', 10, ${a.personId})`);
    expect(e.err?.code, 'employer: WITH CHECK').toBe(NOPRIV);
    expect(await count('statutory_payment_lines', `payment_id = '${id}'`)).toBe(0);
    expect(await count('statutory_employers', `org_id = '${a.orgId}'`)).toBe(0);
  });

  it('control: as org A, the app role can INSERT a payment and a line for org A (the grants and the policy let the happy path through)', async () => {
    const a = await fx('rls-e');
    const r = await asApp(a.orgId, async (tx) => {
      const id = crypto.randomUUID();
      await tx`insert into statutory_payments (id, org_id, agency, month, paid_on, money_account_id, reference_no, created_by)
               values (${id}, ${a.orgId}, 'sss', '2027-01-01', '2027-02-10', ${a.accountId}, ${uid('R')}, ${a.personId})`;
      await tx`insert into statutory_payment_lines (org_id, payment_id, store_id, amount) values (${a.orgId}, ${id}, ${a.storeA}, 12.34)`;
      return id;
    });
    expect(r.err, 'RED today: the table is missing').toBeUndefined();
  });
});
