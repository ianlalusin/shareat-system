import { describe, expect, it, vi } from 'vitest';
import {
  CONSTRAINT_MESSAGES,
  LOCALLY_MAPPED_CONSTRAINT_NAMES,
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

  // T-261 — DEF-274, §B3/§B7.2. Without this check, switching the counter on would have recorded
  // the 8 till/remittance constraints below as "unmapped" — they already render a friendly
  // sentence from a screen-local map this module cannot see.
  it('does not record a locally-mapped constraint (till/remittance own their own map)', async () => {
    const { recordConstraintRefusal } = await import('@shareat/domain');
    vi.mocked(recordConstraintRefusal).mockClear();
    const [firstLocalName] = LOCALLY_MAPPED_CONSTRAINT_NAMES;
    const raw = `new row for relation "x" violates check constraint "${firstLocalName}"`;
    await recordIfUnmappedConstraint(new Error(raw), {
      orgId: 'org-1',
      storeId: null,
      actorPersonId: null,
    });
    expect(recordConstraintRefusal).not.toHaveBeenCalled();
  });

  it('LOCALLY_MAPPED_CONSTRAINT_NAMES has zero overlap with the shared CONSTRAINT_MESSAGES map', () => {
    const overlap = [...LOCALLY_MAPPED_CONSTRAINT_NAMES].filter((name) => name in CONSTRAINT_MESSAGES);
    expect(overlap).toEqual([]);
  });
});

// T-261 — DEF-274, §B3/§B10 falsifier 4. `pre-session-message.ts`'s `WRITTEN_FOR_A_PERSON` set —
// which gates what text may appear in the URL of the unauthenticated `/setup` page — is built as
// `new Set(Object.values(CONSTRAINT_MESSAGES))` and is not itself exported, so this asserts the
// thing it is derived from instead: `CONSTRAINT_MESSAGES`'s own key count. §B3 adds a SEPARATE
// export (`LOCALLY_MAPPED_CONSTRAINT_NAMES`) and never touches this object literal, so if this
// count ever changes, someone widened the security allowlist as a side effect of a counting change.
describe('§B3 did not widen the /setup security allowlist', () => {
  it('CONSTRAINT_MESSAGES still has exactly 26 keys — the count WRITTEN_FOR_A_PERSON is built from', () => {
    expect(Object.keys(CONSTRAINT_MESSAGES).length).toBe(26);
  });

  it('none of the 8 locally-mapped names were promoted into CONSTRAINT_MESSAGES', () => {
    for (const name of LOCALLY_MAPPED_CONSTRAINT_NAMES) {
      expect(CONSTRAINT_MESSAGES).not.toHaveProperty(name);
    }
  });
});

/**
 * T-271 part 2 — DEF-301/DEF-279. A CI-enforced pin, not a review-dependent one.
 *
 * ⛔ **WHAT THIS PROTECTS, and it has already been broken twice on 2026-09-12 alone:**
 * `errorMessage` must render a DEF-279 invariant's OWN hand-authored sentence when no
 * `CONSTRAINT_MESSAGES` key exists for it yet — never `genericConstraintMessage`'s content-free
 * fallback. It is the property that makes DEF-301's fix (matching on the RESOLVED constraint name)
 * behaviour-preserving for these five specifically, and it is easy to break by a change that looks
 * like an improvement: gating the generic fallback on "a name resolved at all"
 * (`resolveConstraintName`) instead of "the name is in the raw PROSE" (`parseConstraintName`) reads
 * as a harmless simplification and sanitises all five into the same generic sentence.
 *   1. `docs/HANDOFF-TODAY.md:99-100` — system32-85, during T-270/DEF-279 itself: *"I widened
 *      `errorMessage` when only the counter needed it, replacing a precise accounting sentence with
 *      a content-free one. Reverted."*
 *   2. `apps/erp/tests/integration/constraint-message-lookup-mechanism.test.ts`'s "NO key added"
 *      case — lane B (T-271), caught in the orchestrator's review of the very fix for DEF-301,
 *      before it was committed.
 * Two different sessions, two different routes into the same trap, the same week. That is a
 * property of this function's shape, not bad luck — hence a unit-level pin instead of relying on
 * review a third time.
 *
 * ⚠️ **Synthetic error objects are CORRECT here, unlike the before/after pass** — worth being
 * explicit about, since that pass deliberately refused them. There the question was "what does the
 * REAL driver produce for these five?", which only a real provocation against Postgres can answer —
 * answered once, for real, in `constraint-message-lookup-mechanism.test.ts` (both the WITH-key and
 * NO-key cases, against `stock_movements_no_negative_on_hand_trg`). THAT integration test is the
 * anchor measurement; this unit test's question is different — "given an error of a shape already
 * measured for real, does this PURE function branch correctly?" — which a synthetic object of that
 * same measured shape (`constraint_name` set, name absent from the message text — confirmed live in
 * `docs/discovery/33-def-279-live-trigger-bodies.md`) answers just as well, without a database, in a
 * suite CI runs before migrations are applied.
 *
 * ⛔ Does NOT add any of the five sentences to `CONSTRAINT_MESSAGES` (T-272's call, invariant 1) and
 * does NOT provoke all five for real (the one real provocation already committed is the anchor).
 */
describe('T-271 part 2 — DEF-279 invariants with no key render their own text, never the generic sentence', () => {
  // Names and representative hand-authored message shapes verified live, byte-for-byte, in
  // docs/discovery/33-def-279-live-trigger-bodies.md. None contains `constraint "<name>"` — that
  // absence from the prose is DEF-279's entire premise, asserted explicitly below per case.
  const DEF_279_CASES: Array<{ constraintName: string; message: string }> = [
    {
      constraintName: 'journal_entries_balance_check',
      message: 'journal entry 9f3a2b1c-0000-0000-0000-000000000000 is unbalanced: debits 100.00 <> credits 90.00',
    },
    {
      constraintName: 'journal_lines_balance_check',
      message: 'journal entry 9f3a2b1c-0000-0000-0000-000000000000 must have at least two lines (has 1)',
    },
    {
      constraintName: 'stock_movements_no_negative_on_hand_trg',
      message:
        'stock would go negative: item 01a093c0-0000-0000-0000-000000000000 at location 01a093c0-0000-0000-0000-000000000001 would be -1.000 after this movement',
    },
    {
      constraintName: 'stock_layer_consumptions_ties_trg',
      message:
        'layer 01a093c0-0000-0000-0000-000000000002 does not tie: quantity 10.000 minus remaining 5.000 is 5.000, but its subledger sums to 3.000',
    },
    {
      constraintName: 'order_wastage_allocations_sum_100_trg',
      message: 'order_wastage 01a093c0-0000-0000-0000-000000000003 allocations sum to 80, not 100',
    },
  ];

  for (const { constraintName, message } of DEF_279_CASES) {
    it(`${constraintName}: renders its own hand-authored sentence verbatim, with no key mapped`, () => {
      expect(constraintName in CONSTRAINT_MESSAGES).toBe(false); // still true today for all five
      expect(message).not.toMatch(/constraint "/); // the name is not in the prose — DEF-279's premise

      // The measured shape: a driver error is an Error instance carrying `constraint_name` as an
      // own property, never embedding the name in `.message` for these five (migration 0142's
      // `USING CONSTRAINT` populates only the structured field).
      const err = Object.assign(new Error(message), { constraint_name: constraintName });

      const rendered = errorMessage(err);
      expect(rendered).toBe(message);
      expect(rendered).not.toContain("isn't allowed for"); // never genericConstraintMessage's wording
      expect(rendered).not.toContain('please check the values you entered');
    });
  }
});
