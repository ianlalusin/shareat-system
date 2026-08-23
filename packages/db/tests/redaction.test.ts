import { describe, it, expect } from 'vitest';

/**
 * PROJECT_BIBLE.md §7 rule 8 — secrets never enter the repo, and never enter a log.
 *
 * The migration runner prints its target so an operator can see which database is
 * about to change. Redacting that URL with a LAZY match (`[^@]*`) stops at the first
 * '@' — so a password containing '@' leaks its tail. That is not hypothetical: it
 * happened on 2026-08-23 and printed part of the live local password to stdout.
 * DEF-030.
 */
const redact = (url: string) => url.replace(/:\/\/.*@/, '://***:***@');

describe('connection-string redaction', () => {
  it('redacts an ordinary password', () => {
    expect(redact('postgresql://postgres:hunter2@localhost:5435/db')).toBe(
      'postgresql://***:***@localhost:5435/db',
    );
  });

  it('redacts a password containing @ — the case that actually leaked', () => {
    const out = redact('postgresql://postgres:pa@ss@localhost:5435/db');
    expect(out).toBe('postgresql://***:***@localhost:5435/db');
    expect(out).not.toContain('ss');
  });

  it('redacts a password of nothing but @ signs', () => {
    expect(redact('postgresql://u:@@@@localhost:5435/db')).toBe(
      'postgresql://***:***@localhost:5435/db',
    );
  });

  it('leaves a URL with no credentials untouched', () => {
    expect(redact('postgresql://localhost:5435/db')).toBe('postgresql://localhost:5435/db');
  });

  it('never emits the password for any special character', () => {
    for (const pw of ['a@b', 'p#1', 'x:y', 'q/r', 'A@B@C']) {
      const out = redact(`postgresql://user:${pw}@localhost:5435/db`);
      expect(out).toBe('postgresql://***:***@localhost:5435/db');
    }
  });
});
