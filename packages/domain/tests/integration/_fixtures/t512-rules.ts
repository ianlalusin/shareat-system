/**
 * T-512 (T-511 S5c) - shared fixtures for the business-rule integration tests (NOT a test file). One org per call, so nothing here truncates.
 * Real Postgres through the caller's `postgres(TEST_DATABASE_URL)`; domain calls run as the restricted app role with an org principal (`asOrg`).
 */
import type postgres from 'postgres';
import { addDays, toBusinessDate } from '@shareat/core/datetime';
import type { Actor } from '@shareat/auth';
import { randomBytes } from 'node:crypto';

export { asOrg, attempt } from './t511-s5-world';

let seq = 0;
const uid = (p: string): string => `${p}-${Date.now()}-${++seq}`;

export interface RuleWorld {
  orgId: string;
  storeId: string;
  admin: Actor;
  manager: Actor;
  staff: Actor;
}

/** An org with an admin, a manager and a staff member (the manager and staff scoped to one store). No chart of accounts: the rule tables need none. */
export async function ruleWorld(sql: postgres.Sql, hint: string): Promise<RuleWorld> {
  const code = uid(`t512-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`;
  const person = async (name: string, role: string): Promise<Actor> => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    if (role !== 'admin') await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s!.id})`;
    return { personId: p!.id, orgId };
  };
  return { orgId, storeId: s!.id, admin: await person('Admin', 'admin'), manager: await person('Manager', 'manager'), staff: await person('Staff', 'staff') };
}

/** An actor (person and role) of a DIFFERENT org, as one that tries to act on `w`'s org: its personId belongs elsewhere. */
export async function foreignAdmin(sql: postgres.Sql, hint: string): Promise<Actor> {
  const other = await ruleWorld(sql, `${hint}-other`);
  return other.admin;
}

/**
 * A row id for a tie-break test: the leading hex digits `lead` fix where it sorts against another id, the rest is random, so a second run on the same database
 * never collides on a fixed uuid. Two ids built with different leads always order by their leads.
 */
export function tieId(lead: string): string {
  const hex = (lead + randomBytes(16).toString('hex')).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface RuleRowOpts {
  id?: string;
  /** an ISO instant; default is the database's now() */
  at?: string;
  setBy?: string | null;
  reason?: string;
}

/** A rule row written RAW (as the table owner, past RLS and past the writer's no-backdating rule): the only way a test can put a rule in force on a past business date. */
export async function putRule(sql: postgres.Sql, orgId: string, key: string, value: string, effectiveFrom: string, o: RuleRowOpts = {}): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into business_rule_values (id, org_id, key, value, effective_from, set_by, reason, created_at)
    values (coalesce(${o.id ?? null}::uuid, uuidv7()), ${orgId}, ${key}, ${value}, ${effectiveFrom}, ${o.setBy ?? null}, ${o.reason ?? 'test rule'}, coalesce(${o.at ?? null}::timestamptz, now()))
    returning id`;
  return r!.id;
}

export const ruleRows = (sql: postgres.Sql, orgId: string, key?: string) =>
  sql<{ id: string; key: string; value: string; effective_from: string; set_by: string | null; reason: string; created_at: Date }[]>`
    select id::text, key, value::text, effective_from::text, set_by::text, reason, created_at
      from business_rule_values where org_id = ${orgId} and (${key ?? null}::text is null or key = ${key ?? null}) order by created_at, id`;

export const auditCount = async (sql: postgres.Sql, orgId: string, action = 'business_rule.changed'): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action = ${action}`;
  return r!.n;
};

/** Manila's today (the business date), and days from it. Never UTC. */
export const today = (): string => toBusinessDate();
export const daysFromToday = (n: number): string => addDays(toBusinessDate(), n);

/** every scalar (string/number/boolean) in a JSON value, as strings: a payload can be asserted without knowing its exact shape */
export function scalars(v: unknown, out: string[] = []): string[] {
  if (v === null || v === undefined) return out;
  if (typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) scalars(x, out);
  } else out.push(String(v));
  return out;
}
export const hasNumber = (all: string[], n: number): boolean => all.some((s) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) === n);
