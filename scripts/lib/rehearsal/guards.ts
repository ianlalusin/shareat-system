/**
 * T-394 R3 - target guards for the opening rehearsal. PURE: URLs are parsed, never connected (invariant 2).
 * docs/tasks/394-purge-and-opening-rehearsal.md s4 R2, R3, s6 I1, I2.
 *
 * Covers guards (a) name pattern, (b) the URL comes from REHEARSAL_DATABASE_URL only, (c) pinned and added production hosts and
 * "not the same host+database as DATABASE_URL / SYSTEM_DATABASE_URL", (d) the typed name. Guards (e) liveness and (f) RLS bypass
 * need a connection and live in checks.ts. No refusal ever carries a connection string or a password.
 */

import { PINNED_PRODUCTION_HOSTS } from '@shareat/core/production-hosts';

/** The production cluster's host lives in @shareat/core (one source); re-exported for the rehearsal scripts and tests. */
export { PINNED_PRODUCTION_HOSTS };

export const REHEARSAL_DB_RE = /^shareat_rehearsal_[0-9]{8}$/;

export interface GuardResult {
  ok: boolean;
  refusals: string[];
  database?: string;
  host?: string;
}

type Env = Record<string, string | undefined>;

/** R3 b: the target comes from REHEARSAL_DATABASE_URL and from nothing else. */
export function resolveTargetUrl(env: Env): string | undefined {
  const v = env.REHEARSAL_DATABASE_URL;
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

/** Host (lower case) and database name of a URL, or null when it does not parse. Never throws, never echoes the URL. */
export function parseDbUrl(raw: string | undefined): { host: string; database: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // A comma means a multi-host URL (libpq tries each), and ?host= / ?hostaddr= override the authority: neither is a single known host.
    if (!u.hostname || u.hostname.includes(',') || u.searchParams.has('host') || u.searchParams.has('hostaddr')) return null;
    return { host: u.hostname.toLowerCase().replace(/\.+$/, ''), database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
  } catch {
    return null;
  }
}

/** The pinned hosts plus whatever PRODUCTION_DB_HOSTS adds. The env can only ADD (R3 c). */
export function productionHosts(env: Env): string[] {
  const added = (env.PRODUCTION_DB_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.+$/, ''))
    .filter(Boolean);
  return [...new Set([...PINNED_PRODUCTION_HOSTS.map((h) => h.toLowerCase().replace(/\.+$/, '')), ...added])];
}

/** The refusals common to the target and to a rollback-check `--against` database: name, production host, other databases. */
export function databaseRefusals(raw: string | undefined, env: Env, label: string, alsoDistinctFrom: readonly (string | undefined)[] = []): {
  refusals: string[];
  parsed: { host: string; database: string } | null;
} {
  const refusals: string[] = [];
  const parsed = parseDbUrl(raw);
  if (!parsed) {
    refusals.push(`${label}: no usable database URL`);
    return { refusals, parsed: null };
  }
  if (!REHEARSAL_DB_RE.test(parsed.database)) {
    refusals.push(`${label}: database name "${parsed.database}" does not match shareat_rehearsal_YYYYMMDD`);
  }
  if (productionHosts(env).includes(parsed.host)) {
    refusals.push(`${label}: host "${parsed.host}" is a production database host`);
  }
  const others: [string, string | undefined][] = [
    ['DATABASE_URL', env.DATABASE_URL],
    ['SYSTEM_DATABASE_URL', env.SYSTEM_DATABASE_URL],
    ...alsoDistinctFrom.map((u, i): [string, string | undefined] => [`the target (${i + 1})`, u]),
  ];
  for (const [name, other] of others) {
    const o = parseDbUrl(other);
    if (o && o.host === parsed.host && o.database === parsed.database) {
      refusals.push(`${label}: same host and database as ${name}`);
    }
  }
  return { refusals, parsed };
}

export function checkTargetGuards(input: { url: string | undefined; confirmDatabase: string | undefined; env: Env }): GuardResult {
  const { refusals, parsed } = databaseRefusals(input.url, input.env, 'target');
  if (parsed && input.confirmDatabase !== parsed.database) {
    refusals.push(`the typed database name does not match the target "${parsed.database}" (use --confirm-database)`);
  }
  if (!parsed && !input.confirmDatabase) refusals.push('--confirm-database is required');
  const result: GuardResult = { ok: refusals.length === 0, refusals };
  if (parsed) {
    result.database = parsed.database;
    result.host = parsed.host;
  }
  return result;
}
