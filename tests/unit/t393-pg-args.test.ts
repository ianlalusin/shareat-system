import { describe, expect, it } from 'vitest';
import { assertDirectPort, buildPgArgs } from '../../scripts/lib/backup/pg-tools';

/**
 * T-393 S1 - tests 8a and 8b (`docs/tasks/393-nightly-backup-and-restore.md` R1, R13, I12).
 * Written TESTER-FIRST: red with "Cannot find module scripts/lib/backup/pg-tools" until the builder lands it.
 */

describe('T-393 S1 - buildPgArgs (I12: no password in argv)', () => {
  const url = 'postgresql://u:s3cr3t@h:25060/db?sslmode=require';

  it('8a. no argv element contains the password, the connection in argv carries none, PGPASSWORD holds it', () => {
    const { argv, env } = buildPgArgs(url, ['-Fc', '--snapshot=00000003-0000001B-1']);
    for (const a of argv) expect(a, `argv element leaks the password: ${a}`).not.toContain('s3cr3t');
    expect(env.PGPASSWORD).toBe('s3cr3t');
    // The caller's extra flags are passed through untouched.
    expect(argv).toContain('-Fc');
    expect(argv).toContain('--snapshot=00000003-0000001B-1');
    // The connection target is still present somewhere in argv (host, port, db), just without the secret.
    const joined = argv.join(' ');
    expect(joined).toContain('h');
    expect(joined).toContain('25060');
    expect(joined).toContain('db');
    expect(joined).toContain('sslmode=require');
  });

  it('8a2. a password with reserved characters is decoded into PGPASSWORD and appears in no argv form', () => {
    const { argv, env } = buildPgArgs('postgresql://u:p%40ss%3Aw%2Frd@h:5435/db', []);
    expect(env.PGPASSWORD).toBe('p@ss:w/rd');
    for (const a of argv) {
      expect(a).not.toContain('p@ss:w/rd');
      expect(a).not.toContain('p%40ss%3Aw%2Frd');
    }
  });

  it('8a3. a URL with no password sets no PGPASSWORD (never an empty string that overrides ~/.pgpass)', () => {
    const { env } = buildPgArgs('postgresql://u@h:5435/db', []);
    expect(env.PGPASSWORD === undefined || env.PGPASSWORD === null).toBe(true);
  });
});

describe('T-393 S1 - assertDirectPort (R1)', () => {
  it('8b. refuses the pooler port 25061, accepts the direct port 25060 and local 5435', () => {
    expect(() => assertDirectPort('postgresql://u:p@h:25061/db?sslmode=require')).toThrow(/25061|pool/i);
    expect(() => assertDirectPort('postgresql://u:p@h:25060/db?sslmode=require')).not.toThrow();
    expect(() => assertDirectPort('postgresql://u:p@localhost:5435/shareat_test')).not.toThrow();
  });
});
