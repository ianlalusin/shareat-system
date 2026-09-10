import { describe, expect, it, vi } from 'vitest';
import {
  CONSTRAINT_MESSAGES,
  errorMessage,
  parseConstraintName,
  recordIfUnmappedConstraint,
} from '../src/lib/constraint-messages';

/**
 * T-252 — DEF-246, bible §13 row 189. docs/tasks/252-def-246-constraint-message-fallback.md §4.
 *
 * ⛔ **What this file must prove above everything else**: `errorMessage()` can never again return
 * raw Postgres driver text for a constraint violation — mapped or not — while every one of the 9
 * already-mapped sentences keeps returning byte-for-byte what it did before this task (the
 * regression set below). Anything that isn't a constraint violation at all is untouched.
 */

// A real check-violation message, shaped exactly like postgres.js's `.message` for one —
// DEF-246's own named example.
const CHECK_VIOLATION =
  'new row for relation "cash_requests" violates check constraint "cash_requests_amount_positive_check"';
const UNIQUE_VIOLATION = 'duplicate key value violates unique constraint "some_other_unique"';

describe('parseConstraintName', () => {
  it('extracts the name from a check-violation message', () => {
    expect(parseConstraintName(CHECK_VIOLATION)).toBe('cash_requests_amount_positive_check');
  });

  it('extracts the name from a unique-violation message', () => {
    expect(parseConstraintName(UNIQUE_VIOLATION)).toBe('some_other_unique');
  });

  it('returns null for a plain domain Error with no constraint text', () => {
    expect(parseConstraintName('A card needs an id — that is the whole credential.')).toBeNull();
  });

  it('returns null for a connection error', () => {
    expect(parseConstraintName('write ECONNREFUSED 127.0.0.1:5432')).toBeNull();
  });
});

describe('errorMessage — regression: every mapped sentence is unchanged', () => {
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    it(`still returns the mapped sentence for ${constraint}`, () => {
      const raw = `new row for relation "x" violates check constraint "${constraint}"`;
      expect(errorMessage(new Error(raw))).toBe(message);
    });
  }
});

describe('errorMessage — the sanitised fallback', () => {
  it('never returns raw driver text for an unmapped constraint violation', () => {
    const message = errorMessage(new Error(CHECK_VIOLATION));
    expect(message).not.toContain('relation');
    expect(message).not.toContain('cash_requests_amount_positive_check');
    expect(message).not.toContain('violates');
  });

  it('the generic sentence is a single line', () => {
    const message = errorMessage(new Error(CHECK_VIOLATION));
    expect(message.includes('\n')).toBe(false);
  });

  it('an unmapped unique violation is also sanitised', () => {
    const message = errorMessage(new Error(UNIQUE_VIOLATION));
    expect(message).not.toContain('some_other_unique');
    expect(message).not.toContain('duplicate key');
  });
});

describe('errorMessage — non-constraint errors are untouched', () => {
  it('strips a leading `Ctor: ` prefix and shows the rest verbatim, as before', () => {
    class SomeError extends Error {}
    expect(errorMessage(new SomeError('SomeError: a plain domain refusal'))).toBe(
      'a plain domain refusal',
    );
  });

  it('a plain Error with no prefix is shown verbatim', () => {
    expect(errorMessage(new Error('A card needs an id — that is the whole credential.'))).toBe(
      'A card needs an id — that is the whole credential.',
    );
  });

  it('a non-Error value is stringified, same as before', () => {
    expect(errorMessage('just a string')).toBe('just a string');
  });
});

// ⛔ `recordIfUnmappedConstraint` is the one call a future caller-sweep threads in — see §3 of the
// spec. It must fire ONLY for an unmapped constraint violation, never for a mapped one or a
// non-constraint error, and it must never throw (the real refusal's own message must never be
// replaced or blocked by a recording failure).
vi.mock('@shareat/domain', () => ({
  recordConstraintRefusal: vi.fn().mockResolvedValue(undefined),
}));

describe('recordIfUnmappedConstraint', () => {
  it('records an unmapped constraint violation', async () => {
    const { recordConstraintRefusal } = await import('@shareat/domain');
    await recordIfUnmappedConstraint(new Error(CHECK_VIOLATION), {
      orgId: 'org-1',
      storeId: 'store-1',
      actorPersonId: 'person-1',
    });
    expect(recordConstraintRefusal).toHaveBeenCalledWith({
      orgId: 'org-1',
      storeId: 'store-1',
      actorPersonId: 'person-1',
      constraintName: 'cash_requests_amount_positive_check',
    });
  });

  it('does not record an already-mapped constraint', async () => {
    const { recordConstraintRefusal } = await import('@shareat/domain');
    vi.mocked(recordConstraintRefusal).mockClear();
    const [firstConstraint] = Object.keys(CONSTRAINT_MESSAGES);
    const raw = `new row for relation "x" violates check constraint "${firstConstraint}"`;
    await recordIfUnmappedConstraint(new Error(raw), {
      orgId: 'org-1',
      storeId: null,
      actorPersonId: null,
    });
    expect(recordConstraintRefusal).not.toHaveBeenCalled();
  });

  it('does not record a non-constraint error', async () => {
    const { recordConstraintRefusal } = await import('@shareat/domain');
    vi.mocked(recordConstraintRefusal).mockClear();
    await recordIfUnmappedConstraint(new Error('A card needs an id.'), {
      orgId: 'org-1',
      storeId: null,
      actorPersonId: null,
    });
    expect(recordConstraintRefusal).not.toHaveBeenCalled();
  });
});
