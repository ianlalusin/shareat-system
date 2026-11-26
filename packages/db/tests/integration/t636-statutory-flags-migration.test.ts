/**
 * T-636 - migration 0288: the three persons ticks and payslips.unticked_agencies with its CHECK. `docs/tasks/636-statutory-toggles.md`.
 *
 * Reads the catalogue of the migrated test database (information_schema / pg_constraint), so what is proven is the migration as applied. The CHECK is exercised on a
 * temporary two-column table that takes the REAL constraint's own definition (pg_get_constraintdef), so no payslip fixture is needed. Not run on the builder's PC
 * (no database): CI runs it.
 * Mutants: drop the CHECK -> the constraint lookup is empty, red. Default false on a persons flag -> the default case is red. Drop NOT NULL -> is_nullable case red.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const column = async (table: string, name: string) =>
  (
    await sql<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = ${table} and column_name = ${name}`
  )[0];

describe('0288 columns', () => {
  it.each(['deduct_sss', 'deduct_philhealth', 'deduct_pagibig'])('persons.%s is boolean NOT NULL DEFAULT true', async (name) => {
    expect(await column('persons', name)).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'true' });
  });

  it('payslips.unticked_agencies is text[] NOT NULL DEFAULT empty array', async () => {
    const c = await column('payslips', 'unticked_agencies');
    expect(c).toMatchObject({ data_type: 'ARRAY', is_nullable: 'NO' });
    expect(c!.column_default).toMatch(/^'\{\}'::text\[\]$/);
  });
});

describe('0288 CHECK payslips_unticked_agencies_check (unticked is a subset of skipped)', () => {
  const defOf = async () =>
    (await sql<{ def: string }[]>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'payslips_unticked_agencies_check' and conrelid = 'payslips'::regclass`)[0]?.def;

  it('exists on payslips', async () => {
    expect(await defOf()).toMatch(/^CHECK/);
  });

  it('refuses an unticked agency that is not in skipped_agencies, and accepts a subset', async () => {
    const def = await defOf();
    expect(def).toBeDefined();
    const attempt = async (skipped: string[], unticked: string[]) => {
      let msg = 'no error';
      try {
        await sql.begin(async (tx) => {
          await tx`create temp table chk (skipped_agencies text[] not null default '{}', unticked_agencies text[] not null default '{}') on commit drop`;
          await tx.unsafe(`alter table chk add constraint payslips_unticked_agencies_check ${def}`);
          await tx`insert into chk (skipped_agencies, unticked_agencies) values (${sql.array(skipped)}, ${sql.array(unticked)})`;
        });
      } catch (e) {
        msg = (e as { message?: string }).message ?? 'error';
      }
      return msg;
    };
    expect(await attempt(['sss', 'pagibig'], ['sss'])).toBe('no error');
    expect(await attempt(['sss'], [])).toBe('no error');
    expect(await attempt(['philhealth'], ['sss'])).toMatch(/payslips_unticked_agencies_check|violates check constraint/);
    expect(await attempt([], ['pagibig'])).toMatch(/payslips_unticked_agencies_check|violates check constraint/);
  });
});
