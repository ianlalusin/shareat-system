/**
 * T-394 S2 - `verify` / `verify --after-post`: read-only checks against the copy.
 * docs/tasks/394-purge-and-opening-rehearsal.md s6 I8-I10c, R11, R13.
 *
 * Every function only READS (sequences via last_value/is_called, never nextval). `sql` must be connected to the copy by a role that
 * bypasses RLS, and must be the ONLY session this tool opens (the app-role check excludes the tool's own pid). The tool computes no
 * balance, 3900 or stock figure of its own: tying is `openingTieOut`'s answer, per organisation.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import * as schema from '@shareat/db/schema';
import type { Tx } from '@shareat/db';
import { openingTieOut } from '../../../packages/domain/src/cutover/tie-out';

// ---------------------------------------------------------------------------------------------- I10b

/** R11: the role(s) of the OTHER client sessions on the copy, read from pg_stat_activity.usename; none, or one that bypasses RLS, fails. */
export async function checkAppRole(sql: Sql): Promise<{ ok: boolean; roles: string[]; message: string }> {
  const rows = await sql<{ usename: string; bypass: boolean | null }[]>`
    select distinct a.usename::text as usename, (r.rolbypassrls or r.rolsuper) as bypass
    from pg_stat_activity a left join pg_roles r on r.rolname = a.usename
    where a.datname = current_database() and a.pid <> pg_backend_pid() and a.backend_type = 'client backend' and a.usename is not null
    order by 1`;
  const roles = rows.map((r) => r.usename);
  if (rows.length === 0) {
    return { ok: false, roles, message: 'no app session is connected to the copy: start the app (R11 env) so its database role can be read' };
  }
  const bad = rows.filter((r) => r.bypass !== false).map((r) => r.usename);
  if (bad.length > 0) return { ok: false, roles, message: `the app connects as a role that bypasses RLS or is a superuser: ${bad.join(', ')}` };
  return { ok: true, roles, message: `the app role has no bypass (${roles.join(', ')})` };
}

// ---------------------------------------------------------------------------------------------- I10c

/** R11 terminal ban: no clock terminal created or updated, and no attendance punch inserted, after `sinceIso`. */
export async function checkTerminalActivity(sql: Sql, sinceIso: string): Promise<{ ok: boolean; failures: { table: string; detail: string }[] }> {
  const failures: { table: string; detail: string }[] = [];
  const [t] = await sql<{ n: number }[]>`
    select count(*)::int as n from clock_terminals where created_at > ${sinceIso}::timestamptz or updated_at > ${sinceIso}::timestamptz`;
  if ((t?.n ?? 0) > 0) failures.push({ table: 'clock_terminals', detail: `${t?.n} row(s) created or updated after the rehearsal started` });
  const [p] = await sql<{ n: number }[]>`
    select count(*)::int as n from attendance_punches where created_at > ${sinceIso}::timestamptz or received_at > ${sinceIso}::timestamptz`;
  if ((p?.n ?? 0) > 0) failures.push({ table: 'attendance_punches', detail: `${p?.n} row(s) inserted after the rehearsal started` });
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------------------------- I10

/** R13 freeze: any entry that is not an opening_balance, created after the purge commit, whatever its entry_date. */
export async function checkFreeze(
  sql: Sql,
  purgeCommittedAtIso: string,
): Promise<{ ok: boolean; failures: { entryId: string; sourceType: string; detail: string }[] }> {
  const rows = await sql<{ id: string; source_type: string; entry_date: string }[]>`
    select id::text as id, source_type, entry_date::text as entry_date from journal_entries
    where source_type <> 'opening_balance' and created_at > ${purgeCommittedAtIso}::timestamptz order by created_at, id`;
  const failures = rows.map((r) => ({
    entryId: r.id,
    sourceType: r.source_type,
    detail: `journal entry ${r.id} (source ${r.source_type}, dated ${r.entry_date}) was created after the purge`,
  }));
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------------------------- I10a

/**
 * The first document after the purge gets number 1: a sequence owned by a table column that has been used while its table is still EMPTY
 * (a number was consumed and nothing was written) fails. A table that holds rows has legitimately used its numbers. Reads, never nextval.
 */
export async function checkSequencesReset(sql: Sql): Promise<{ ok: boolean; failures: { sequence: string; detail: string }[] }> {
  const seqs = await sql<{ seq: string; owner: string }[]>`
    select s.relname::text as seq, t.relname::text as owner from pg_class s
    join pg_depend d on d.objid = s.oid and d.deptype = 'a'
    join pg_class t on t.oid = d.refobjid
    where s.relkind = 'S' and s.relnamespace = 'public'::regnamespace order by 1`;
  const failures: { sequence: string; detail: string }[] = [];
  for (const { seq, owner } of seqs) {
    const [r] = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
      `select last_value::text as last_value, is_called from "${seq.replace(/"/g, '""')}"`,
    );
    if (!r?.is_called) continue;
    const [n] = await sql.unsafe<{ n: number }[]>(`select count(*)::int as n from "${owner.replace(/"/g, '""')}"`);
    if ((n?.n ?? 0) === 0) failures.push({ sequence: seq, detail: `sequence ${seq} has been used (last value ${r.last_value}); the next document would not be number 1` });
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------------------------- I8 / I9

const orgsOf = async (sql: Sql): Promise<string[]> => (await sql<{ id: string }[]>`select id::text as id from organizations order by id`).map((o) => o.id);

/** openingTieOut for EVERY organisation; the sentences are the function's own. */
export async function checkTieOutAll(sql: Sql): Promise<{ ok: boolean; failures: { orgId: string; sentences: string[] }[] }> {
  const db = drizzle(sql, { schema });
  const failures: { orgId: string; sentences: string[] }[] = [];
  const orgs = await orgsOf(sql);
  if (orgs.length === 0) failures.push({ orgId: '', sentences: ['no organisation on the copy'] });
  for (const orgId of orgs) {
    const t = await db.transaction((tx) => openingTieOut(tx as unknown as Tx, orgId));
    if (!t.holds) failures.push({ orgId, sentences: t.lines.map((l) => l.sentence) });
  }
  return { ok: failures.length === 0, failures };
}

/** I9: per organisation, every `opening_balance` entry is posted and dated the conversion date, and there is at least one. */
export async function checkOpeningSet(
  sql: Sql,
  conversionDate: string,
): Promise<{ ok: boolean; failures: { orgId: string; entryId: string | null; detail: string }[] }> {
  const failures: { orgId: string; entryId: string | null; detail: string }[] = [];
  const orgs = await orgsOf(sql);
  if (orgs.length === 0) failures.push({ orgId: '', entryId: null, detail: 'no organisation on the copy' });
  for (const orgId of orgs) {
    const rows = await sql<{ id: string; status: string; d: string }[]>`
      select id::text as id, status, entry_date::text as d from journal_entries
      where org_id = ${orgId}::uuid and source_type = 'opening_balance' order by created_at, id`;
    if (rows.length === 0) failures.push({ orgId, entryId: null, detail: `organisation ${orgId} has no opening entry: nothing was posted` });
    for (const r of rows) {
      if (r.status !== 'posted') failures.push({ orgId, entryId: r.id, detail: `opening entry ${r.id} is ${r.status}, not posted` });
      if (r.d !== conversionDate) failures.push({ orgId, entryId: r.id, detail: `opening entry ${r.id} is dated ${r.d}, not ${conversionDate}` });
    }
  }
  return { ok: failures.length === 0, failures };
}

/** C2 and C5 recorded in `cutover_steps`, for every organisation. */
export async function checkC2C5(sql: Sql): Promise<{ ok: boolean; missing: { orgId: string; step: string }[] }> {
  const missing: { orgId: string; step: string }[] = [];
  for (const orgId of await orgsOf(sql)) {
    for (const step of ['C2', 'C5']) {
      const [r] = await sql<{ n: number }[]>`select count(*)::int as n from cutover_steps where org_id = ${orgId}::uuid and step_code = ${step}`;
      if ((r?.n ?? 0) === 0) missing.push({ orgId, step });
    }
  }
  return { ok: missing.length === 0, missing };
}
