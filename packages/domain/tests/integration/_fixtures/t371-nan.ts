import type postgres from 'postgres';
import { expect } from 'vitest';
import { sql as dsql } from 'drizzle-orm';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { seedChartOfAccounts } from '../../../../db/seed/chart-of-accounts';
import { testItemCode } from './item-code';

/**
 * T-371 S0 — shared fixture for the per-module NaN tests (`t371-<module>-nan.test.ts`). `docs/tasks/371-nan-sweep.md` §S0 "Per-module NaN tests".
 *
 * Each module test feeds a typed `'abc'` and `'NaN'` into a domain entry and asserts: a plain refusal sentence (a `userMessage` that quotes the
 * typed value, names the field in human words, carries no id and no database vocabulary), ZERO rows changed, and that a later valid call
 * succeeds (no partial state left behind). `plainRefusal` is the one place those four assertions live.
 */
export const NAN_INPUTS = ['abc', 'NaN'] as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DB_VOCAB = /23514|violates|constraint|finite_check|numeric field overflow|invalid input syntax|\bsql\b/i;

let seq = 0;
export const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
export const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

export async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** One org, one store, an admin and a manager (both scoped to the store), a raw-material item, January 2026 open. */
export async function bootstrap(sql: postgres.Sql, hint: string) {
  const code = uid(`t371-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid('s')}, 'Lipa', '2020-01-01') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Pork', 'raw_material', 'kg', ${adminId}) returning id`;
  return { orgId, storeId, adminId, managerId, admin: actor(orgId, adminId), manager: actor(orgId, managerId), itemId: item!.id };
}
export type Kit = Awaited<ReturnType<typeof bootstrap>>;

/** Runs `p`; returns the thrown error's text, or an Outcome-shaped `{ ok: false, reason }`'s reason; null if it succeeded. */
export async function refusalOf(p: Promise<unknown>): Promise<{ text: string | null; raw: boolean }> {
  try {
    const out = await p;
    const o = out as { ok?: boolean; reason?: string } | null;
    if (o && typeof o === 'object' && o.ok === false && typeof o.reason === 'string') return { text: o.reason, raw: false };
    return { text: null, raw: false };
  } catch (err) {
    const e = err as { userMessage?: string; message?: string };
    if (e.userMessage) return { text: e.userMessage, raw: false };
    return { text: String(e.message ?? err), raw: true };
  }
}

/** The four plain-refusal assertions. `field` is a regex for the human word(s) the sentence must use for the field. */
export function expectPlainRefusal(got: { text: string | null; raw: boolean }, typed: string, field: RegExp, what: string): void {
  expect(got.text, `${what}: ${JSON.stringify(typed)} was ACCEPTED`).not.toBeNull();
  expect(got.raw, `${what}: a raw error (not a written sentence) reached the person: ${got.text}`).toBe(false);
  expect(got.text, `${what}: the sentence does not quote the typed value`).toContain(`"${typed}"`);
  expect(got.text, `${what}: the sentence does not name the field`).toMatch(field);
  expect(got.text).not.toMatch(UUID);
  expect(got.text).not.toMatch(DB_VOCAB);
}

export const count = async (sql: postgres.Sql, table: string, orgId: string): Promise<number> =>
  Number((await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${table} where org_id = '${orgId}'`))[0]!.n);
