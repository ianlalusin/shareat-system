/**
 * T-394 S1 - the rehearsal's read-only checks against the copy, and rollback-check's comparison.
 * docs/tasks/394-purge-and-opening-rehearsal.md s4 R3 e/f, R6, R12, s6 I3, I5, I6, I11.
 *
 * Every function here only READS. Money is compared as numeric text (normalizeDecimal), never as a float; the tool computes no balance
 * of its own beyond "the trial balance is zero", which the schema's own view answers.
 * `sql` must be connected to the copy by a role that bypasses RLS.
 */
import type { Sql } from 'postgres';
import { toBusinessDate } from '../../../packages/core/src/datetime';
import { tablesInClass, CUTOVER_CLASSIFICATION } from '../../../packages/db/src/cutover/classification';
import { compareFingerprints, normalizeDecimal, type Fingerprint } from '../backup/fingerprint';
import { checkTargetGuards, databaseRefusals } from './guards';

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------- guard (e), (f)

/** R3 e: no other client session on the target. Our own pid is excluded. */
export async function checkLiveness(sql: Sql): Promise<{ ok: boolean; sessions: { applicationName: string; pid: number }[]; message: string }> {
  const rows = await sql<{ pid: number; app: string }[]>`
    select pid, application_name as app from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
    order by pid`;
  const sessions = rows.map((r) => ({ applicationName: r.app, pid: r.pid }));
  const names = sessions.map((s) => `application_name=${s.applicationName === '' ? '(none)' : s.applicationName} pid=${s.pid}`);
  return {
    ok: sessions.length === 0,
    sessions,
    message: sessions.length === 0 ? 'no other session is connected to the target' : `another session is connected to the target: ${names.join('; ')}`,
  };
}

/** R3 f: the tool's role must bypass RLS (the purge engine refuses otherwise). */
export async function checkBypassRls(sql: Sql): Promise<{ ok: boolean; message: string }> {
  const [r] = await sql<{ bypass: boolean }[]>`select (rolbypassrls or rolsuper) as bypass from pg_roles where rolname = current_user`;
  return r?.bypass ? { ok: true, message: 'the tool role bypasses RLS' } : { ok: false, message: 'the tool role does not bypass RLS; use the owner role for the copy' };
}

// ---------------------------------------------------------------------------------------------- R6 / DEF-585

const addMonths = (ym: string, n: number): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};

/**
 * Per organisation: an `open` period covers every month from the conversion month through (Manila month of `runAt`) + 11.
 * Months before the conversion month are not required (the purge deletes those periods anyway).
 */
export async function checkFiscalCoverage(
  sql: Sql,
  o: { runAt: Date; conversionDate: string },
): Promise<{ ok: boolean; failures: { orgId: string; firstMissingMonth: string; reason: string }[] }> {
  const first = o.conversionDate.slice(0, 7);
  const horizonFromRun = addMonths(toBusinessDate(o.runAt).slice(0, 7), 11);
  const last = horizonFromRun > first ? horizonFromRun : first;
  const orgs = await sql<{ id: string }[]>`select id::text as id from organizations order by id`;
  const periods = await sql<{ org: string; s: string; e: string }[]>`
    select org_id::text as org, starts_on::text as s, ends_on::text as e from fiscal_periods where status = 'open'`;
  const failures: { orgId: string; firstMissingMonth: string; reason: string }[] = [];
  for (const org of orgs) {
    const mine = periods.filter((p) => p.org === org.id);
    for (let ym = first; ym <= last; ym = addMonths(ym, 1)) {
      const day = `${ym}-01`;
      if (!mine.some((p) => p.s <= day && p.e >= day)) {
        failures.push({
          orgId: org.id,
          firstMissingMonth: ym,
          reason: `organisation ${org.id} has no open fiscal period covering ${ym} (needed through ${last}); run the fiscal-period seed for it`,
        });
        break;
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------------------------- I5

export const KEEP_COUNT_TABLES = ['persons', 'accounts', 'stores', 'opening_counts'] as const;
export interface StartSnapshot {
  keepCounts: Record<(typeof KEEP_COUNT_TABLES)[number], number>;
  /** md5 of the content of every KEEP-class table, taken before the purge (the engine asserts the same inside its transaction). */
  keepHashes: Record<string, string>;
}

const count = async (sql: Sql, table: string): Promise<number> => {
  const [r] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
  return r?.n ?? 0;
};

const keepClassTables = (): string[] =>
  Object.entries(CUTOVER_CLASSIFICATION)
    .filter(([, e]) => e.class === 'keep')
    .map(([t]) => t);

const hashOf = async (sql: Sql, table: string): Promise<string> => {
  const [r] = await sql.unsafe<{ h: string }[]>(
    `select md5(coalesce(string_agg(x::text, '' order by x::text), '')) as h from "${table.replace(/"/g, '""')}" x`,
  );
  return r?.h ?? '';
};

/** Counted BEFORE the purge; checkPostPurge compares against it, never against a recount. */
export async function snapshotStart(sql: Sql): Promise<StartSnapshot> {
  const keepCounts = {} as StartSnapshot['keepCounts'];
  for (const t of KEEP_COUNT_TABLES) keepCounts[t] = await count(sql, t);
  const keepHashes: Record<string, string> = {};
  for (const t of keepClassTables()) keepHashes[t] = await hashOf(sql, t);
  return { keepCounts, keepHashes };
}

export async function checkPostPurge(
  sql: Sql,
  start: StartSnapshot,
  o: { conversionDate: string },
): Promise<{ ok: boolean; failures: { check: string; detail: string }[] }> {
  const failures: { check: string; detail: string }[] = [];

  // purge-class tables are empty (an entry with a notBefore later than the conversion date is deliberately deferred)
  const nonEmpty: string[] = [];
  for (const t of tablesInClass('purge')) {
    const nb = (CUTOVER_CLASSIFICATION[t] as { notBefore?: string } | undefined)?.notBefore;
    if (nb && o.conversionDate < nb) continue;
    // T-402 R15 (C6): the purge writes its own `cutover.purge` event AFTER truncating audit_log, so the go-live record is the first row
    // of the production log. "Empty" therefore means: no row that is not a cutover.* event (the dump holds everything older).
    const n =
      t === 'audit_log'
        ? ((await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action not like 'cutover.%'`)[0]?.n ?? 0)
        : await count(sql, t);
    if (n > 0) nonEmpty.push(`${t}=${n}`);
  }
  if (nonEmpty.length > 0) failures.push({ check: 'purge_tables_empty', detail: nonEmpty.join(', ') });

  const moved: string[] = [];
  for (const t of KEEP_COUNT_TABLES) {
    const now = await count(sql, t);
    if (now !== start.keepCounts[t]) moved.push(`${t}: ${start.keepCounts[t]} at start, ${now} now`);
  }
  if (moved.length > 0) failures.push({ check: 'keep_counts_unchanged', detail: moved.join('; ') });

  // Content, not only counts: a KEEP table whose rows changed with the same count must fail too.
  const changed: string[] = [];
  // cutover_steps is KEEP, but the purge itself writes the C2 rows into it AFTER its own byte-identical check, so it is legitimately different.
  for (const [t, before] of Object.entries(start.keepHashes)) {
    if (t === 'cutover_steps') continue;
    if ((await hashOf(sql, t)) !== before) changed.push(t);
  }
  if (changed.length > 0) failures.push({ check: 'keep_content_unchanged', detail: `content changed in: ${changed.join(', ')}` });

  const tb = await sql<{ org: string; d: string; c: string }[]>`
    select org_id::text as org, sum(debit_total)::text as d, sum(credit_total)::text as c from v_trial_balance group by org_id`;
  const off = tb.filter((r) => normalizeDecimal(r.d) !== '0' || normalizeDecimal(r.c) !== '0');
  if (off.length > 0) failures.push({ check: 'trial_balance_zero', detail: off.map((r) => `org ${r.org}: debit ${r.d}, credit ${r.c}`).join('; ') });

  const [old] = await sql<{ n: number }[]>`select count(*)::int as n from fiscal_periods where starts_on < ${o.conversionDate}::date`;
  if ((old?.n ?? 0) > 0) failures.push({ check: 'no_pre_conversion_periods', detail: `${old?.n} fiscal period(s) start before ${o.conversionDate}` });

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------------------------- I11

/**
 * R12: the fingerprint of the restored predump equals the fingerprint in that dump's OWN manifest. The --against database passes the
 * same guards as the target and must be a different database from it, from DATABASE_URL and from SYSTEM_DATABASE_URL.
 */
export function checkRollback(o: {
  manifest: Fingerprint;
  restored: Fingerprint;
  targetUrl: string;
  againstUrl: string | undefined;
  confirmDatabase: string | undefined;
  env: Env;
}): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  failures.push(...checkTargetGuards({ url: o.targetUrl, confirmDatabase: o.confirmDatabase, env: o.env }).refusals);
  failures.push(...databaseRefusals(o.againstUrl, o.env, '--against', [o.targetUrl]).refusals);
  if (failures.length === 0) failures.push(...compareFingerprints(o.manifest, o.restored).mismatches);
  return { ok: failures.length === 0, failures };
}
