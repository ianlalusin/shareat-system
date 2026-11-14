/**
 * T-562 (DEF-818 / GT-001) - a database is a test database only by its NAME. The user, password, host and query of the
 * connection URL never count. Pure string checks: this file never connects to a database.
 */
import { describe, expect, it } from 'vitest';
import { isTestDatabaseUrl } from '../../scripts/lib/test-db-name.mjs';

const at = (name: string, tail = '') => `postgres://u:p@localhost:5435/${name}${tail}`;

describe('isTestDatabaseUrl', () => {
  it.each(['shareat_test', 'shareat_test_audit512', 'shareat_t503_test', 'shareat_t528_test_w1', 'test', 'a_test_b'])(
    'accepts the database name %s',
    (name) => {
      expect(isTestDatabaseUrl(at(name))).toBe(true);
      expect(isTestDatabaseUrl(at(name, '?sslmode=disable'))).toBe(true);
    },
  );

  it.each(['production', 'shareat', 'shareat_dev', 'contest', 'shareat_testing', 'latest', 'shareat_tests', ''])(
    'refuses the database name "%s"',
    (name) => {
      expect(isTestDatabaseUrl(at(name))).toBe(false);
    },
  );

  it('refuses a URL whose only "test" is in the user, password, host or query', () => {
    expect(isTestDatabaseUrl('postgres://shareat_test_user:x@localhost/production')).toBe(false);
    expect(isTestDatabaseUrl('postgres://u:shareat_test@localhost/production')).toBe(false);
    expect(isTestDatabaseUrl('postgres://u:p@shareat_test.example.com/production')).toBe(false);
    expect(isTestDatabaseUrl('postgres://u:p@localhost/production?application_name=shareat_test')).toBe(false);
    expect(isTestDatabaseUrl('postgres://u:p@localhost/production?options=_test')).toBe(false);
    expect(isTestDatabaseUrl('postgres://u:p@localhost/production#shareat_test')).toBe(false);
  });

  it('decodes the name before checking it', () => {
    expect(isTestDatabaseUrl(at('shareat%5Ftest'))).toBe(true);
    expect(isTestDatabaseUrl(at('shareat_%74est'))).toBe(true);
    expect(isTestDatabaseUrl(at('shareat%5Ftesting'))).toBe(false);
  });

  it('refuses an unparseable, empty or non-string URL', () => {
    expect(isTestDatabaseUrl('not a url')).toBe(false);
    expect(isTestDatabaseUrl('')).toBe(false);
    expect(isTestDatabaseUrl('postgres://u:p@localhost')).toBe(false);
    expect(isTestDatabaseUrl('shareat_test')).toBe(false);
    expect(isTestDatabaseUrl(undefined as unknown as string)).toBe(false);
  });
});
