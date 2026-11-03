/**
 * F43 - the practice starters never inherit a database address from the shell. `scripts/lib/practice-env.mjs` is the one rule both
 * `apps/pos/scripts/practice-start.mjs` and `scripts/practice-erp-start.mjs` use.
 */
import { describe, expect, it } from 'vitest';

type Lib = {
  buildPracticeEnv: (inherited: Record<string, string | undefined>, url: string | undefined | null, extra?: Record<string, string>) => Record<string, string>;
  assertPracticeDatabaseUrl: (url: string) => void;
  resolvePracticeDatabaseUrl: (inherited: Record<string, string | undefined>) => string;
};
const load = async (): Promise<Lib> => (await import('../../scripts/lib/practice-env.mjs' as string)) as Lib;

const GOOD = 'postgresql://u:p%40ss@127.0.0.1:5435/shareat_test_pospractice';

describe('practice env guard (F43)', () => {
  it('drops an inherited real-looking URL and every other *DATABASE_URL; empty when no practice URL', async () => {
    const { buildPracticeEnv } = await load();
    const shell = {
      DATABASE_URL: 'postgresql://prod:x@db.example.com:25060/shareat_prod',
      SYSTEM_DATABASE_URL: 'postgresql://prod:x@db.example.com:25060/shareat_prod',
      TEST_DATABASE_URL: 'postgresql://prod:x@db.example.com:25060/shareat_prod',
      PATH: '/bin',
    };
    const none = buildPracticeEnv(shell, undefined);
    expect(none.DATABASE_URL).toBe('');
    expect(none.SYSTEM_DATABASE_URL).toBeUndefined();
    expect(none.TEST_DATABASE_URL).toBeUndefined();
    expect(none.PATH).toBe('/bin');
    const withUrl = buildPracticeEnv(shell, GOOD, { POS_ORG_ID: 'x' });
    expect(withUrl.DATABASE_URL).toBe(GOOD);
    expect(withUrl.SYSTEM_DATABASE_URL).toBeUndefined();
    expect(withUrl.POS_ORG_ID).toBe('x');
  });

  it('refuses a database whose name does not contain _test', async () => {
    const { buildPracticeEnv } = await load();
    expect(() => buildPracticeEnv({}, 'postgresql://u:p@127.0.0.1:5435/shareat_dev')).toThrow(/_test/);
  });

  it('refuses a remote host, even with a _test name', async () => {
    const { buildPracticeEnv } = await load();
    expect(() => buildPracticeEnv({}, 'postgresql://u:p@db.example.com:5432/shareat_test_x')).toThrow(/host/);
    expect(() => buildPracticeEnv({}, 'postgresql://u:p@127.0.0.1.evil.com:5432/shareat_test_x')).toThrow(/host/);
  });

  it('accepts localhost and a password containing @', async () => {
    const { assertPracticeDatabaseUrl } = await load();
    expect(() => assertPracticeDatabaseUrl('postgresql://u:p@ss@localhost:5435/shareat_test_a')).not.toThrow();
    expect(() => assertPracticeDatabaseUrl('')).not.toThrow();
  });
});
