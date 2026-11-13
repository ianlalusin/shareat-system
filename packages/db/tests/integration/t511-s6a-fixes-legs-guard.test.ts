/**
 * T-511 S6a FIXES (audit item 3) - migration 0242: a settlement loan leg is append-only history. A BEFORE UPDATE OR DELETE refuse trigger, ENABLE ALWAYS
 * (house pattern: 0183 sales_day_pos_corrections, 0221 pay_rates, 0239 business_rule_values). The owner and a superuser are refused by the trigger
 * (SQLSTATE 23001), even with session_replication_role = replica; the app role never gets the privilege (42501). Real Postgres via TEST_DATABASE_URL.
 * MUTANTS are named in each title `[kills: ...]`.
 */
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { APP_ROLE } from '../../src/rls/registry';
import { TRIGGER_REGISTRY } from '../../src/triggers/registry';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const LEGS = 'channel_settlement_loan_legs';
const TRIGGER = 'channel_settlement_loan_legs_append_only';
type PgErr = Error & { code?: string };
type Tx = postgres.TransactionSql;
class Rollback extends Error {}
let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

/** Runs `fn` in a transaction that is always rolled back; resolves with the error it raised, or null. */
async function attempt(fn: (tx: Tx) => Promise<unknown>): Promise<PgErr | null> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    return e instanceof Rollback ? null : (e as PgErr);
  }
  return null;
}

async function world() {
  const code = uid('t511s6a-guard');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${uid('Admin')}) returning id`;
  const [loan] = await sql<{ id: string }[]>`
    insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
    values (${orgId}, ${store!.id}, 'Grab', ${uid('L')}, 5000, 0, 'month', 'straight', 'monthly', 6, '2026-01-01', ${p!.id}) returning id`;
  const [ch] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code) values (${orgId}, ${store!.id}, ${uid('Grab')}, false, '1220') returning id`;
  const [bank] = await sql<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian, is_active) values (${orgId}, ${store!.id}, ${uid('Bank')}, 'bank', '1140', 'office', true) returning id`;
  const [day] = await sql<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${store!.id}, '2026-01-10', '0', '0', '0', ${p!.id}) returning id`;
  // a header and its one leg, committed together (the deferred legs-add-up trigger checks at commit)
  const settlementId = await sql.begin(async (tx) => {
    const [s] = await tx<{ id: string }[]>`
      insert into channel_settlements (org_id, store_id, channel_id, sales_day_id, business_date, gross_amount, outstanding_cleared, loan_deduction, net_deposited, destination_money_account_id, settled_on, created_by)
      values (${orgId}, ${store!.id}, ${ch!.id}, ${day!.id}, '2026-01-10', '10000.00', '10000.00', '2000.00', '8000.00', ${bank!.id}, '2026-01-15', ${p!.id}) returning id`;
    await tx`insert into channel_settlement_loan_legs (org_id, settlement_id, loan_id, owner_store_id, amount) values (${orgId}, ${s!.id}, ${loan!.id}, ${store!.id}, '2000.00')`;
    return s!.id;
  });
  const [leg] = await sql<{ id: string }[]>`select id from channel_settlement_loan_legs where settlement_id = ${settlementId}`;
  return { orgId, legId: leg!.id };
}

describe('T-511 S6a fixes - a settlement loan leg is never changed or removed', () => {
  it('the owner (and a superuser) cannot UPDATE or DELETE a leg: the trigger refuses with 23001 and the row is unchanged [kills: no guard; a guard on DELETE only]', async () => {
    const w = await world();
    const upd = await attempt((tx) => tx`update channel_settlement_loan_legs set amount = '1.00' where id = ${w.legId}`);
    expect(upd?.code, upd?.message).toBe('23001');
    expect(upd?.message).toMatch(/never changed or removed/i);
    const del = await attempt((tx) => tx`delete from channel_settlement_loan_legs where id = ${w.legId}`);
    expect(del?.code, del?.message).toBe('23001');
    const [row] = await sql<{ amount: string }[]>`select amount::text from channel_settlement_loan_legs where id = ${w.legId}`;
    expect(row!.amount).toBe('2000.00');
  });

  it('session_replication_role = replica does not switch it off: the trigger is ENABLE ALWAYS [kills: an origin trigger that a bulk load could bypass]', async () => {
    const w = await world();
    for (const stmt of ['update', 'delete'] as const) {
      const err = await attempt(async (tx) => {
        await tx.unsafe(`set local session_replication_role = replica`);
        if (stmt === 'update') await tx`update channel_settlement_loan_legs set amount = '1.00' where id = ${w.legId}`;
        else await tx`delete from channel_settlement_loan_legs where id = ${w.legId}`;
      });
      expect(err?.code, `${stmt} under replica: ${err?.message}`).toBe('23001');
    }
    const [t] = await sql<{ tgenabled: string }[]>`select tgenabled from pg_trigger where tgrelid = ${`public.${LEGS}`}::regclass and tgname = ${TRIGGER}`;
    expect(t?.tgenabled).toBe('A');
  });

  it('the app role has no UPDATE or DELETE privilege on legs at all (42501), so the trigger is the second wall, not the first [kills: UPDATE granted back to the app role]', async () => {
    const w = await world();
    for (const stmt of ['update', 'delete'] as const) {
      const err = await attempt(async (tx) => {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx`select set_config('app.principal_kind', 'staff', true)`;
        await tx`select set_config('app.org_id', ${w.orgId}, true)`;
        if (stmt === 'update') await tx`update channel_settlement_loan_legs set amount = '1.00' where id = ${w.legId}`;
        else await tx`delete from channel_settlement_loan_legs where id = ${w.legId}`;
      });
      expect(err?.code, `${stmt} as the app role: ${err?.message}`).toBe('42501');
    }
  });

  it('INSERT still works for a new leg on a new settlement, and the registry names the guard as a history_guard in ALWAYS mode [kills: a guard that blocks inserts; an unregistered or mis-kinded guard]', async () => {
    expect(TRIGGER_REGISTRY[TRIGGER]).toMatchObject({ table: LEGS, mode: 'always', kind: 'history_guard' });
    const w = await world();
    const [n] = await sql<{ n: string }[]>`select count(*)::text as n from channel_settlement_loan_legs where org_id = ${w.orgId}`;
    expect(n!.n).toBe('1');
  });
});
