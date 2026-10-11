import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redact } from '../../scripts/lib/backup/pg-tools';
import { BACKUP_PREFIX, resolveSpacesConfig } from '../../scripts/lib/backup/object-store';

/**
 * T-393 S1 - tests 7 and 8 (`docs/tasks/393-nightly-backup-and-restore.md` R12, R13, I9, I10).
 * Written TESTER-FIRST: red with "Cannot find module scripts/lib/backup/pg-tools" until the builder lands it.
 *
 * Two contract choices the spec leaves open, fixed here (hand-back flags them):
 *  - `redact(s)` takes only a string, so it can learn the Spaces secret and the heartbeat URLs only from the
 *    environment (`SPACES_SECRET`, `SPACES_KEY`, `BACKUP_HEARTBEAT_URL`, `DRILL_HEARTBEAT_URL`). The tests set those.
 *  - The R12 config check is reached as `resolveSpacesConfig(env)` exported from `scripts/lib/backup/object-store.ts`
 *    (it uses `scripts/lib/config-contract.ts` underneath). It throws on any violation, before any connection opens.
 */

const SECRET = 'sp4ces/Secret+Key=abc123XYZ';
const KEY = 'DO00ABCDEF1234567890';
const HEARTBEAT = 'https://hc-ping.com/1b2c3d4e-0000-4000-8000-aabbccddeeff';
const DRILL_HEARTBEAT = 'https://hc-ping.com/9f8e7d6c-1111-4111-8111-001122334455';
const PG_PASSWORD = 'AVNS_s3cretPass9';

const ENV_KEYS = ['SPACES_SECRET', 'SPACES_KEY', 'BACKUP_HEARTBEAT_URL', 'DRILL_HEARTBEAT_URL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SPACES_SECRET = SECRET;
  process.env.SPACES_KEY = KEY;
  process.env.BACKUP_HEARTBEAT_URL = HEARTBEAT;
  process.env.DRILL_HEARTBEAT_URL = DRILL_HEARTBEAT;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('T-393 S1 - redact (R13, I9)', () => {
  it('7a. removes the password from a postgres connection string, both schemes, wherever it appears', () => {
    const url = `postgresql://doadmin:${PG_PASSWORD}@db-host:25060/defaultdb?sslmode=require`;
    const out = redact(`connection to ${url} failed; retried ${url.replace('postgresql', 'postgres')}`);
    expect(out).not.toContain(PG_PASSWORD);
    expect(out).toContain('db-host'); // not over-redacted: the host is useful and not secret
  });

  it('7b. removes a percent-encoded password and a bare PGPASSWORD=... assignment', () => {
    const out = redact('postgresql://u:p%40ss%3Aw0rd-t393@h:5432/db and PGPASSWORD=hunter2hunter2 in env');
    expect(out).not.toContain('p%40ss%3Aw0rd-t393');
    expect(out).not.toContain('p@ss:w0rd-t393');
    expect(out).not.toContain('hunter2hunter2');
  });

  it('7c. removes the Spaces secret and key when they appear in an error message (not only the URL form)', () => {
    const out = redact(`S3 PutObject failed: signature mismatch, key ${KEY} secret ${SECRET}`);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(KEY);
  });

  it('7d. removes the heartbeat URL (the URL is the credential) embedded in an error message, every occurrence', () => {
    const out = redact(`fetch failed: ${HEARTBEAT}/fail ... retry ${DRILL_HEARTBEAT} ... again ${HEARTBEAT}`);
    expect(out).not.toContain('1b2c3d4e-0000-4000-8000-aabbccddeeff');
    expect(out).not.toContain('9f8e7d6c-1111-4111-8111-001122334455');
  });

  it('7e. leaves an ordinary message alone', () => {
    expect(redact('pg_dump exited with code 1 after 42 seconds')).toBe('pg_dump exited with code 1 after 42 seconds');
  });
});

describe('T-393 S1 - config contract (R12, I10)', () => {
  const good = {
    SPACES_ENDPOINT: 'https://sgp1.digitaloceanspaces.com',
    SPACES_REGION: 'sgp1',
    SPACES_BUCKET: 'shareat-pg-backups',
    SPACES_KEY: KEY,
    SPACES_SECRET: SECRET,
  };

  it('8a. accepts the documented values', () => {
    const cfg = resolveSpacesConfig({ ...good });
    expect(cfg.bucket).toBe('shareat-pg-backups');
  });

  it('8b. refuses the v1 bucket shareat-hub-v2 (DEF-311 shape: reachable, private, and wrong)', () => {
    expect(() => resolveSpacesConfig({ ...good, SPACES_BUCKET: 'shareat-hub-v2' })).toThrow(/shareat-hub-v2|SPACES_BUCKET/);
  });

  it('8c. refuses the Frappe archive bucket BY NAME, so the droplet key can never write to or delete from it (row 64)', () => {
    expect(() => resolveSpacesConfig({ ...good, SPACES_BUCKET: 'shareat-erp-backups' })).toThrow(/shareat-erp-backups|Frappe/i);
  });

  it('8d. an empty or blank SPACES_SECRET (or key) aborts', () => {
    expect(() => resolveSpacesConfig({ ...good, SPACES_SECRET: '' })).toThrow(/SPACES_SECRET/);
    expect(() => resolveSpacesConfig({ ...good, SPACES_SECRET: '   ' })).toThrow(/SPACES_SECRET/);
    expect(() => resolveSpacesConfig({ ...good, SPACES_KEY: '' })).toThrow(/SPACES_KEY/);
    const { SPACES_SECRET: _omit, ...missing } = good;
    expect(() => resolveSpacesConfig(missing)).toThrow(/SPACES_SECRET/);
  });

  it('8e. refuses an endpoint other than the documented one', () => {
    expect(() => resolveSpacesConfig({ ...good, SPACES_ENDPOINT: 'https://example.com' })).toThrow(/SPACES_ENDPOINT/);
  });

  it('8f. the prefix is a constant, not an environment variable', () => {
    expect(BACKUP_PREFIX).toBe('postgres/');
    const prior = process.env.BACKUP_PREFIX;
    process.env.BACKUP_PREFIX = 'elsewhere/';
    try {
      resolveSpacesConfig({ ...good });
      expect(BACKUP_PREFIX).toBe('postgres/');
    } finally {
      if (prior === undefined) delete process.env.BACKUP_PREFIX;
      else process.env.BACKUP_PREFIX = prior;
    }
  });
});
