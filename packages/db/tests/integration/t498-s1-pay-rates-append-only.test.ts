/**
 * T-498 S1 / DEF-799 — `docs/tasks/498-pay-rates-append-only-csv-formula.md`, S1. A historical pay rate
 * is never rewritten or removed (T-189 §5.1): a wrong rate is superseded by a NEW row.
 * Three locks (migration 0221): privilege (REVOKE UPDATE, DELETE from the app role -> 42501), the
 * `pay_rates_append_only` trigger (23001), and ENABLE ALWAYS (fires under replica mode).
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard (same idiom as t356).
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';
import { transaction, type Tx } from '../../src/client';
import * as payrollRepo from '../../src/repo/payroll';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let MIGRATING_ROLE: string;

beforeAll(async () => {
  const [row] = await sql<{ tableowner: string }[]>`
    select tableowner from pg_tables where schemaname = 'public' and tablename = 'pay_rates'`;
  if (!row?.tableowner) throw new Error('T-498 S1: could not determine the owner of public.pay_rates.');
  MIGRATING_ROLE = row.tableowner;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function caught<T>(p: Promise<T>): Promise<(Error & { code?: string }) | undefined> {
  try {
    await p;
  } catch (err) {
    return err as Error & { code?: string };
  }
  return undefined;
}

/** Raw SQL as the app role with an org principal (the shape the ERP runs as). */
async function asApp<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.principal_kind', 'staff', true)`;
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

async function asAppDrizzle<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function fixture() {
  const code = uid('t498s1');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, 'Store') returning id`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Worker') returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${store!.id}, ${person!.id}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  const [rate] = await sql<{ id: string }[]>`
    insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
    values (${orgId}, ${emp!.id}, 'daily', '600.00', '2025-01-01', ${person!.id}) returning id`;
  return { orgId, personId: person!.id, employmentId: emp!.id, rateId: rate!.id };
}

describe('T-498 S1 — pay_rates is append-only', () => {
  it('(a) app role with an org principal: positive control, then UPDATE and DELETE are refused with 42501', async () => {
    const f = await fixture();
    const seen = await asApp(f.orgId, async (tx) => {
      const [who] = await tx<{ u: string }[]>`select current_user as u`;
      const rows = await tx<{ id: string }[]>`select id from pay_rates where id = ${f.rateId}`;
      return { who: who!.u, visible: rows.length };
    });
    expect(seen).toEqual({ who: APP_ROLE, visible: 1 });

    const upd = await caught(asApp(f.orgId, (tx) => tx`update pay_rates set amount = '1.00' where id = ${f.rateId}`));
    expect(upd?.code).toBe('42501');
    const del = await caught(asApp(f.orgId, (tx) => tx`delete from pay_rates where id = ${f.rateId}`));
    expect(del?.code).toBe('42501');

    const [row] = await sql<{ amount: string }[]>`select amount from pay_rates where id = ${f.rateId}`;
    expect(row!.amount).toBe('600.00');
  });

  it('(b) table owner (privilege bypassed): the trigger refuses UPDATE and DELETE with 23001, also in replica mode', async () => {
    const f = await fixture();
    const owner = async (stmt: (tx: postgres.TransactionSql) => Promise<unknown>, replica = false) =>
      caught(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${MIGRATING_ROLE}`);
          if (replica) await tx.unsafe(`set local session_replication_role = 'replica'`);
          await stmt(tx);
        }),
      );
    for (const replica of [false, true]) {
      const upd = await owner((tx) => tx`update pay_rates set amount = '1.00' where id = ${f.rateId}`, replica);
      expect(upd?.code, `update replica=${replica}`).toBe('23001');
      const del = await owner((tx) => tx`delete from pay_rates where id = ${f.rateId}`, replica);
      expect(del?.code, `delete replica=${replica}`).toBe('23001');
    }
    const [trg] = await sql<{ tgenabled: string }[]>`
      select tgenabled from pg_trigger where tgrelid = 'public.pay_rates'::regclass and tgname = 'pay_rates_append_only'`;
    expect(trg?.tgenabled).toBe('A');
    const [row] = await sql<{ amount: string }[]>`select amount from pay_rates where id = ${f.rateId}`;
    expect(row!.amount).toBe('600.00');
  });

  it('(c) INSERT of a superseding rate as the app role still works and rateInForceOn picks it from its date', async () => {
    const f = await fixture();
    await asAppDrizzle(f.orgId, (tx) =>
      payrollRepo.insertPayRate(tx, {
        orgId: f.orgId,
        employmentId: f.employmentId,
        basis: 'daily',
        amount: '700.00' as never,
        effectiveFrom: '2025-06-01',
        createdBy: f.personId,
      }),
    );
    const before = await asAppDrizzle(f.orgId, (tx) => payrollRepo.rateInForceOn(tx, f.orgId, f.employmentId, '2025-05-31'));
    const after = await asAppDrizzle(f.orgId, (tx) => payrollRepo.rateInForceOn(tx, f.orgId, f.employmentId, '2025-06-01'));
    expect(before?.amount).toBe('600.00');
    expect(after?.amount).toBe('700.00');
  });
});
