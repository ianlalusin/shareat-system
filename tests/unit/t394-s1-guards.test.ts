import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PINNED_PRODUCTION_HOSTS,
  checkTargetGuards,
  resolveTargetUrl,
} from '../../scripts/lib/rehearsal/guards';
import { checkAppEnvText } from '../../scripts/lib/rehearsal/app-env';
import { checkRollback } from '../../scripts/lib/rehearsal/checks';
import type { Fingerprint } from '../../scripts/lib/backup/fingerprint';

/**
 * T-394 S1 - invariants 1, 2, 10c (app-env-check half), 11 (docs/tasks/394-purge-and-opening-rehearsal.md s6, R2, R3, R11, R12).
 * Written TESTER-FIRST: red with "Cannot find module scripts/lib/rehearsal/guards" until the builder lands S1.
 * Pure: no database, no network. Every URL below is a fake; the only real-looking host is the pinned production host,
 * which is only ever PARSED (invariant 2).
 *
 * ## Contract choices the spec leaves open (flagged in the hand-back)
 *  - guards.ts: `PINNED_PRODUCTION_HOSTS: readonly string[]` (the constant of R3 c);
 *    `resolveTargetUrl(env): string | undefined` returns `env.REHEARSAL_DATABASE_URL` and NOTHING else (R3 b);
 *    `checkTargetGuards({ url, confirmDatabase, env }): { ok, refusals: string[], database?, host? }` is SYNCHRONOUS and
 *    pure (parses, never connects): guards (a), (c), (d) and the DATABASE_URL / SYSTEM_DATABASE_URL equality of R3 c.
 *    Guard (e) liveness and (f) RLS bypass need a connection and live in checks.ts.
 *  - app-env.ts: `checkAppEnvText(text): { ok, offending: string[] }`, offending = variable NAMES only, never values.
 *  - checks.ts: `checkRollback({ manifest, restored, targetUrl, againstUrl, confirmDatabase, env }): { ok, failures: string[] }`;
 *    the --against database passes guards (a), (c) and the not-equal-to-DATABASE_URL/SYSTEM_DATABASE_URL/target rules; no
 *    separate typed-name for it is required by this test.
 */

const PINNED = 'shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com';
const PW = 'sup3rS3cretPw';
const url = (host: string, db: string, port = 5435): string => `postgresql://tester:${PW}@${host}:${port}/${db}`;

const TARGET_DB = 'shareat_rehearsal_20261113';
const TARGET = url('localhost', TARGET_DB);
const baseEnv = {
  DATABASE_URL: url('localhost', 'shareat_test_t394'),
  SYSTEM_DATABASE_URL: url('localhost', 'shareat_test_t394'),
};
const check = (over: { url?: string | undefined; confirmDatabase?: string | undefined; env?: Record<string, string | undefined> } = {}) =>
  checkTargetGuards({
    url: 'url' in over ? over.url : TARGET,
    confirmDatabase: 'confirmDatabase' in over ? over.confirmDatabase : TARGET_DB,
    env: over.env ?? baseEnv,
  });

describe('T-394 S1 I1 - target guards refuse before any write', () => {
  it('1.0 control: a well-formed local target with its name typed back passes', () => {
    const r = check();
    expect(r.refusals).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.database).toBe(TARGET_DB);
  });

  it('1.a the name must match ^shareat_rehearsal_[0-9]{8}$ whole (unanchored regex passes a suffix or prefix)', () => {
    for (const bad of [
      'shareat_rehearsal_20261113_prod',
      'xshareat_rehearsal_20261113',
      'shareat_rehearsal_2026111',
      'shareat_rehearsal_202611133',
      'shareat_rehearsal_2026111a',
      'shareat_system',
      'shareat_test_t394',
    ]) {
      const r = check({ url: url('localhost', bad), confirmDatabase: bad });
      expect(r.ok, `${bad} must be refused`).toBe(false);
      expect(r.refusals.length).toBeGreaterThan(0);
    }
  });

  it('1.b a pinned production host is refused on both ports, any case, even when DATABASE_URL names another host', () => {
    expect(PINNED_PRODUCTION_HOSTS.map((h) => h.toLowerCase())).toContain(PINNED);
    for (const [host, port] of [[PINNED, 25060], [PINNED, 25061], [PINNED.toUpperCase(), 25060]] as const) {
      const r = check({ url: url(host, TARGET_DB, port) });
      expect(r.ok, `${host}:${port} must be refused`).toBe(false);
    }
  });

  it('1.c PRODUCTION_DB_HOSTS only ADDS hosts: an added host is refused, the pinned host stays refused', () => {
    const env = { ...baseEnv, PRODUCTION_DB_HOSTS: ' prod2.example.com , prod3.example.com ' };
    expect(check({ url: url('prod3.example.com', TARGET_DB), env }).ok).toBe(false);
    expect(check({ url: url('prod2.example.com', TARGET_DB), env }).ok).toBe(false);
    // replaced-not-extended mutant: the list names some other host, or is empty - the constant still holds
    expect(check({ url: url(PINNED, TARGET_DB, 25060), env: { ...baseEnv, PRODUCTION_DB_HOSTS: 'other.example.com' } }).ok).toBe(false);
    expect(check({ url: url(PINNED, TARGET_DB, 25060), env: { ...baseEnv, PRODUCTION_DB_HOSTS: '' } }).ok).toBe(false);
    // a host in neither list is fine
    expect(check({ url: url('copy.example.com', TARGET_DB), env }).ok).toBe(true);
  });

  it('1.d a target whose host+database equal DATABASE_URL or SYSTEM_DATABASE_URL is refused; host alone or database alone is not', () => {
    // same host and database, even on another port (pooler vs direct reaches the same database)
    expect(check({ env: { ...baseEnv, DATABASE_URL: TARGET } }).ok).toBe(false);
    expect(check({ env: { ...baseEnv, DATABASE_URL: url('localhost', TARGET_DB, 25061) } }).ok).toBe(false);
    expect(check({ env: { ...baseEnv, SYSTEM_DATABASE_URL: TARGET } }).ok).toBe(false);
    // "host compared, database not" mutant: same host, different database must stay accepted (the control already is)
    // "database compared, host not" mutant: same database name on another host is not the same database
    expect(check({ env: { ...baseEnv, DATABASE_URL: url('elsewhere.example.com', TARGET_DB) } }).ok).toBe(true);
  });

  it('1.e the target comes from REHEARSAL_DATABASE_URL only, never DATABASE_URL', () => {
    const decoy = url('localhost', 'shareat_rehearsal_20261114');
    expect(resolveTargetUrl({ DATABASE_URL: decoy })).toBeUndefined();
    expect(resolveTargetUrl({ SYSTEM_DATABASE_URL: decoy, DATABASE_URL: decoy })).toBeUndefined();
    expect(resolveTargetUrl({ REHEARSAL_DATABASE_URL: TARGET, DATABASE_URL: decoy })).toBe(TARGET);
    expect(check({ url: undefined, confirmDatabase: 'shareat_rehearsal_20261114', env: { DATABASE_URL: decoy } }).ok).toBe(false);
  });

  it('1.f the typed name must equal the database name', () => {
    expect(check({ confirmDatabase: 'shareat_rehearsal_20261114' }).ok).toBe(false);
    expect(check({ confirmDatabase: undefined }).ok).toBe(false);
    expect(check({ confirmDatabase: '' }).ok).toBe(false);
    expect(check({ confirmDatabase: TARGET_DB.toUpperCase() }).ok).toBe(false);
  });

  it('1.h host tricks that reach a pinned host are refused: trailing dot, comma list, ?host= override, ?hostaddr=', () => {
    const tricks: [string, string][] = [
      ['trailing dot', `postgresql://tester:${PW}@${PINNED}.:25060/${TARGET_DB}`],
      ['trailing dot, upper case', `postgresql://tester:${PW}@${PINNED.toUpperCase()}.:25060/${TARGET_DB}`],
      ['comma host list (pinned second)', `postgresql://tester:${PW}@localhost,${PINNED}:25060/${TARGET_DB}`],
      ['comma host list (pinned first)', `postgresql://tester:${PW}@${PINNED},localhost:25060/${TARGET_DB}`],
      ['?host= override', `postgresql://tester:${PW}@localhost:5435/${TARGET_DB}?host=${PINNED}`],
      ['?host= override, upper case', `postgresql://tester:${PW}@localhost:5435/${TARGET_DB}?sslmode=require&host=${PINNED.toUpperCase()}`],
      ['?hostaddr= override', `postgresql://tester:${PW}@localhost:5435/${TARGET_DB}?hostaddr=10.0.0.5`],
    ];
    for (const [label, u] of tricks) {
      const r = check({ url: u });
      expect(r.ok, `${label} must be refused`).toBe(false);
      expect(JSON.stringify(r)).not.toContain(PW);
    }
  });

  it('1.g a refusal never carries the connection string or its password', () => {
    const r = check({ url: url(PINNED, 'shareat_system', 25060), confirmDatabase: 'nope' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(PW);
  });
});

describe('T-394 S1 I2 - source URLs are parsed, never connected', () => {
  it('2.a the guard is synchronous and returns at once for URLs that point nowhere reachable', () => {
    const dead = 'postgresql://u:p@10.255.255.1:1/shareat_test_t394';
    const t0 = Date.now();
    const r = checkTargetGuards({
      url: url('localhost', TARGET_DB),
      confirmDatabase: TARGET_DB,
      env: { DATABASE_URL: dead, SYSTEM_DATABASE_URL: dead },
    });
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('2.b guards.ts imports no database driver', () => {
    const src = readFileSync(new URL('../../scripts/lib/rehearsal/guards.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"]postgres['"]|from ['"]pg['"]|require\(['"]pg(ostgres)?['"]\)/);
  });
});

describe('T-394 S1 I10c - app-env-check (R11: Firebase for sign-in only)', () => {
  const signInOnly = [
    'FIREBASE_PROJECT_ID=shareat-xyz',
    'NEXT_PUBLIC_FIREBASE_API_KEY=abc',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=x.firebaseapp.com',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID=shareat-xyz',
    'FIREBASE_SERVICE_ACCOUNT_KEY=',
    'FIREBASE_SERVICE_ACCOUNT_KEY_FILE=',
    'FIREBASE_STORAGE_BUCKET=',
    'POS_API_URL=',
    'SESSION_SECRET=different',
  ].join('\n');

  it('10c.0 control: only FIREBASE_PROJECT_ID + NEXT_PUBLIC_FIREBASE_* set (the rest blank) is accepted', () => {
    expect(checkAppEnvText(signInOnly)).toEqual({ ok: true, offending: [] });
  });

  it('10c.1 each forbidden variable, set, is refused by name (including _KEY_FILE and any POS_API_*)', () => {
    for (const name of ['FIREBASE_SERVICE_ACCOUNT_KEY', 'FIREBASE_SERVICE_ACCOUNT_KEY_FILE', 'FIREBASE_STORAGE_BUCKET', 'POS_API_URL', 'POS_API_TOKEN']) {
      const r = checkAppEnvText(`${signInOnly}\n${name}=some-secret-value-123`);
      expect(r.ok, `${name} set must be refused`).toBe(false);
      expect(r.offending).toContain(name);
      expect(JSON.stringify(r)).not.toContain('some-secret-value-123');
    }
  });

  it('10c.2 a whitespace-only or empty-quoted value is blank, not set; a comment line is not a setting', () => {
    const text = ['FIREBASE_PROJECT_ID=p', 'FIREBASE_STORAGE_BUCKET=   ', 'FIREBASE_SERVICE_ACCOUNT_KEY=""', "POS_API_KEY=''", '# FIREBASE_SERVICE_ACCOUNT_KEY_FILE=/x.json'].join('\n');
    expect(checkAppEnvText(text)).toEqual({ ok: true, offending: [] });
  });

  it('10c.4 an inline comment after an empty value leaves it UNSET; after a real value it is still SET', () => {
    expect(checkAppEnvText('FIREBASE_STORAGE_BUCKET= #comment')).toEqual({ ok: true, offending: [] });
    expect(checkAppEnvText('POS_API_URL=   # nothing here')).toEqual({ ok: true, offending: [] });
    expect(checkAppEnvText('FIREBASE_SERVICE_ACCOUNT_KEY="" # none')).toEqual({ ok: true, offending: [] });
    const r = checkAppEnvText('FIREBASE_STORAGE_BUCKET=real-bucket #comment');
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(['FIREBASE_STORAGE_BUCKET']);
  });

  it('10c.3 a quoted real value is set', () => {
    const r = checkAppEnvText('FIREBASE_STORAGE_BUCKET="shareat-bucket"');
    expect(r.ok).toBe(false);
    expect(r.offending).toEqual(['FIREBASE_STORAGE_BUCKET']);
  });
});

describe("T-394 S1 I11 - rollback-check compares the restored predump with the dump's own manifest", () => {
  const fp = (over: Partial<Fingerprint> = {}): Fingerprint => ({
    trialBalance: [{ orgId: 'o1', accountId: 'a1', debit: '100.00', credit: '40.00', net: '60.00' }],
    orgTotals: [{ orgId: 'o1', debit: '100.00', credit: '100.00' }],
    rowCounts: { 'public.organizations': 1, 'public.journal_lines': 8, 'public.items': 10, 'drizzle.__drizzle_migrations': 190 },
    ...over,
  });
  const AGAINST_DB = 'shareat_rehearsal_20261114';
  const ctx = {
    targetUrl: TARGET,
    againstUrl: url('localhost', AGAINST_DB),
    confirmDatabase: TARGET_DB,
    env: baseEnv,
  };

  it('11.0 control: equal fingerprints, a guarded --against database that differs from the target, pass', () => {
    const r = checkRollback({ manifest: fp(), restored: fp(), ...ctx });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('11.a a single changed row count fails, naming the table (row counts are compared, not just the trial balance)', () => {
    const r = checkRollback({ manifest: fp(), restored: fp({ rowCounts: { ...fp().rowCounts, 'public.items': 11 } }), ...ctx });
    expect(r.ok).toBe(false);
    expect(r.failures.join('\n')).toContain('public.items');
  });

  it('11.b a 0.01 difference in a trial-balance line fails (money compared as text, not a float)', () => {
    const tb = [{ orgId: 'o1', accountId: 'a1', debit: '100.01', credit: '40.00', net: '60.01' }];
    const r = checkRollback({ manifest: fp(), restored: fp({ trialBalance: tb }), ...ctx });
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it('11.c the --against database is guarded like the target: bad name, pinned host, or the target itself are refused', () => {
    const same = checkRollback({ manifest: fp(), restored: fp(), ...ctx, againstUrl: TARGET });
    expect(same.ok, '--against equal to the target').toBe(false);
    const badName = checkRollback({ manifest: fp(), restored: fp(), ...ctx, againstUrl: url('localhost', 'shareat_rehearsal_20261114_prod') });
    expect(badName.ok, '--against with an unanchored name').toBe(false);
    const prod = checkRollback({ manifest: fp(), restored: fp(), ...ctx, againstUrl: url(PINNED, AGAINST_DB, 25060) });
    expect(prod.ok, '--against on the production host').toBe(false);
    const sys = checkRollback({ manifest: fp(), restored: fp(), ...ctx, againstUrl: baseEnv.SYSTEM_DATABASE_URL });
    expect(sys.ok, '--against equal to SYSTEM_DATABASE_URL').toBe(false);
    expect(JSON.stringify([same, badName, prod, sys])).not.toContain(PW);
  });
});
