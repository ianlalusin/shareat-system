import { describe, expect, it } from 'vitest';
import { redactDbUrl } from '../helpers/redact-db-url';

/** DEF-814 — a password containing `@` must not leak its tail. Invented values; no database needed. */
describe('redactDbUrl (DEF-814)', () => {
  const password = 'p@ss:w/ord@x';
  const url = `postgres://admin:${password}@localhost:5435/prod_db`;

  it('masks the whole password in the URL, including the part after the first @', () => {
    const out = redactDbUrl(url);
    expect(out).not.toContain('ss:w/ord');
    expect(out).not.toContain('ord@x');
    expect(out).not.toContain('p@ss');
    expect(out).toContain('localhost:5435/prod_db');
  });

  it('masks the raw and encoded password wherever it appears in an error message', () => {
    const msg = `connect failed for ${url}; auth rejected "${password}" (${encodeURIComponent(password)})`;
    const out = redactDbUrl(msg, url);
    for (const leak of ['ss:w/ord', 'ord@x', 'p%40ss', 'w%2Ford']) expect(out).not.toContain(leak);
  });

  it('masks a password containing # ? and %', () => {
    const odd = 'a#b?c%d@e';
    const out = redactDbUrl(`postgres://u:${odd}@h/db`);
    for (const leak of ['a#b', 'c%d', 'e@h']) expect(out).not.toContain(leak);
  });
});
