import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@shareat/core/logger';
import { CONSTRAINT_MESSAGES, errorMessage } from '../src/lib/constraint-messages';

// ⛔ Without this, `vi.spyOn(logger, 'error')` persists across `it()` blocks within a file — every
// T5 "does NOT log" assertion inherits calls accumulated by earlier tests instead of starting
// clean. Convention already established in the sibling apps/erp/tests/pre-session-message.test.ts.
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * T-326 — DEF-378, docs/tasks/326-a-cashier-readable-error-from-both-ends.md §2/§2a.
 *
 * ⛔ **What this file must prove that `constraint-messages.test.ts` does not**: that file pins the
 * existing four-step resolution (mapped / DEF-279 verbatim / generic-unmapped / prefix-strip) with
 * every synthetic error built as `new Error(raw)` — none of them carries a `.code`. This file adds
 * the ONE step T-326 changes — step 4, the fall-through — gated on `typeof err.code === 'string'`,
 * and the two ways a naive version of that gate breaks the three steps above it:
 *   - nesting the mapped/unmapped lookups INSIDE a "has code" branch (kills all 26 mapped
 *     sentences the moment a real driver error carries one — T4 below);
 *   - a "never the raw text" fall-through that also catches the five DEF-279
 *     `RAISE … USING CONSTRAINT` sentences, which DO carry a `code` (SQLSTATE P0001, no ERRCODE
 *     set) and are unmapped — T2c below is that carve-out's regression guard.
 *
 * ⚠️ The discriminator is `typeof err.code === 'string'`, not a five-character SQLSTATE match —
 * verified directly against `node_modules/postgres/src/errors.js`'s `connection()`, which builds
 * `Object.assign(new Error('write '+code+' '+host+':'+port), {code, errno, address})` with no
 * SQLSTATE. T2b is the regression guard for that specific amendment.
 */

// ---- T1 — Invariant 1: a hand-authored application error reaches the screen intact. ----
// ⚠️ REGRESSION GUARD — already passes against the code as it stands today, because this path is
// unchanged by contract. Its job is to catch the new classification work breaking it, not to
// prove something that doesn't exist yet.
describe('T1 — application error reaches the screen intact (DEF-301/T-270 regression guard)', () => {
  it('strips only the label prefix, exact string, no code present', () => {
    const err = new Error('createCashRequest: the amount must be positive');
    expect(errorMessage(err)).toBe('the amount must be positive');
  });
});

// ---- T2 — Invariant 2, per SQLSTATE class: no SQL grammar reaches the screen. ----
describe('T2 — database errors are sanitised by class, no SQL grammar survives', () => {
  const SQLSTATE_CASES: Array<{ code: string; raw: string; label: string }> = [
    { code: '22P02', raw: 'invalid input syntax for type numeric: "1.234"', label: 'invalid text representation' },
    {
      code: '42703',
      raw: 'column "declared_overage" of relation "remittance_lines" does not exist',
      label: 'undefined column',
    },
    { code: '42P01', raw: 'relation "remittance_lnes" does not exist', label: 'undefined table' },
    { code: '22003', raw: 'numeric field overflow', label: 'numeric out of range' },
  ];

  for (const { code, raw, label } of SQLSTATE_CASES) {
    it(`${label} (${code}): the raw driver text is gone, not just reworded`, () => {
      const err = Object.assign(new Error(raw), { code });
      const message = errorMessage(err);
      expect(message).not.toBe(raw);
      expect(message).not.toContain(raw);
      expect(message).not.toContain('"');
      expect(message.includes('\n')).toBe(false);
    });
  }
});

// ---- T2b — Invariant 2's host/port half. The case that would have caught the original
// five-character-SQLSTATE draft. ----
describe('T2b — a connection error never puts the database host or port on screen', () => {
  it('exactly as the postgres driver builds it: ECONNREFUSED, no SQLSTATE', () => {
    const err = Object.assign(new Error('write ECONNREFUSED 10.0.0.1:5432'), {
      code: 'ECONNREFUSED',
      errno: 'ECONNREFUSED',
      address: '10.0.0.1',
    });
    const message = errorMessage(err);
    expect(message).not.toContain('10.0.0.1');
    expect(message).not.toContain('5432');
    expect(message).not.toContain('ECONNREFUSED');
  });

  it('the same shape for ENOTFOUND, a different host', () => {
    const err = Object.assign(new Error('write ENOTFOUND db.internal:5432'), {
      code: 'ENOTFOUND',
      errno: 'ENOTFOUND',
      address: 'db.internal',
    });
    const message = errorMessage(err);
    expect(message).not.toContain('db.internal');
    expect(message).not.toContain('5432');
  });
});

// ---- T2c — the DEF-279 carve-out (§2 step 2). Protects five live hand-authored sentences that
// DO carry a code (SQLSTATE P0001) but must never be sanitised. ----
describe('T2c — a DEF-279 hand-authored RAISE is preserved verbatim, even though it has a code', () => {
  // Shape verified live in docs/discovery/33-def-279-live-trigger-bodies.md: the driver's
  // structured `constraint_name` field is populated (RAISE … USING CONSTRAINT), the prose carries
  // NO `constraint "…"` clause, and no ERRCODE was set so Postgres defaults to P0001.
  const message =
    'stock would go negative: item 01a093c0-0000-0000-0000-000000000000 at location ' +
    '01a093c0-0000-0000-0000-000000000001 would be -1.000 after this movement';

  it('resolveConstraintName resolves via the structured field, parseConstraintName finds nothing in the prose — returned verbatim', () => {
    expect(message).not.toMatch(/constraint "/); // the premise: no constraint clause in the prose
    expect('stock_movements_no_negative_on_hand_trg' in CONSTRAINT_MESSAGES).toBe(false); // unmapped

    const err = Object.assign(new Error(message), {
      constraint_name: 'stock_movements_no_negative_on_hand_trg',
      code: 'P0001',
    });

    const rendered = errorMessage(err);
    expect(rendered).toBe(message);
    expect(rendered).not.toContain("isn't allowed for"); // never genericConstraintMessage's wording
    expect(rendered).not.toContain('please check the values you entered');
  });

  // ⛔ The five-with-`constraint_name` case above proves the carve-out for the population my
  // briefing named — it says nothing about the OTHER hand-authored `RAISE EXCEPTION` sites in
  // packages/db/migrations/*.sql that carry NEITHER `USING CONSTRAINT` NOR an explicit ERRCODE and
  // so also default to P0001, with no constraint_name at all. A raw occurrence count is not a
  // live-site count — `CREATE OR REPLACE` supersedes earlier migrations, and nobody has run a live
  // catalog query — so the only claims that survive re-derivation are: exactly one migration file
  // (0142) uses `USING CONSTRAINT`, and exactly one explicit `ERRCODE` exists anywhere (0009,
  // itself `raise_exception` = P0001). What follows is one verified-live example: 0143 supersedes
  // 0003's `journal_entries_check_period_open`, and no later migration adds `USING CONSTRAINT` to
  // it, so its raise is a hand-authored sentence with a code and no constraint name at all. If the
  // carve-out keys on a resolved constraint name rather than on `code === 'P0001'`, this site still
  // gets replaced by the generic fallback while T2c stays green throughout.
  it('a P0001 raise with NO constraint_name at all is also preserved verbatim', () => {
    const message = 'cannot post journal entry into period 42 (status = locked)';
    expect(message).not.toMatch(/constraint "/); // same premise, no structured field this time

    const err = Object.assign(new Error(message), { code: 'P0001' });
    // no constraint_name property at all — resolveConstraintName has nothing to resolve

    const rendered = errorMessage(err);
    expect(rendered).toBe(message);
    expect(rendered).not.toContain("isn't allowed for");
    expect(rendered).not.toContain('please check the values you entered');
    expect(rendered).not.toContain('detail is in the server log');
  });
});

// ---- T2d — the codeless dump (§2a). Settled contract, reuses looksLikeADump, folds into §2b's
// extracted predicate module. ----
describe('T2d — a code-less multi-line dump does not render its banner verbatim (env() shape)', () => {
  const raw =
    '\n' +
    '='.repeat(72) +
    '\nShareat System REFUSED TO START — environment is incomplete or invalid.\n' +
    '='.repeat(72) +
    '\n  - DATABASE_URL: Required\n  - SESSION_SECRET: Required\n' +
    '\n\nFix .env.local (see .env.example for the full contract).\n' +
    '='.repeat(72) +
    '\n';

  it('no code, multi-line → the generic sentence, not the banner', () => {
    const message = errorMessage(new Error(raw));
    expect(message).not.toContain('DATABASE_URL');
    expect(message).not.toContain('SESSION_SECRET');
    expect(message).not.toContain('='.repeat(72));
    expect(message.includes('\n')).toBe(false);
  });

  it('the raw banner still reaches the log', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    errorMessage(new Error(raw));
    expect(spy).toHaveBeenCalled();
    const loggedRaw = spy.mock.calls.some((call) =>
      call.some((arg) => {
        try {
          return JSON.stringify(arg).includes('SESSION_SECRET');
        } catch {
          return String(arg).includes('SESSION_SECRET');
        }
      }),
    );
    expect(loggedRaw).toBe(true);
  });
});

// ---- T3 — an unrecognised, NON-SQLSTATE code still degrades to the generic sentence. The space
// of `code` values is far larger than SQLSTATE, which is the entire point of Amendment 1. ----
describe('T3 — an unrecognised non-SQLSTATE code is not treated as "known safe"', () => {
  it('a brand new failure-mode code nobody has mapped yet still gets sanitised', () => {
    const raw = 'a brand new failure mode nobody mapped yet';
    const err = Object.assign(new Error(raw), { code: 'TOTALLY_UNKNOWN_CODE' });
    expect(errorMessage(err)).not.toBe(raw);
  });

  it('a made-up SQLSTATE-shaped code that maps to no known class is sanitised the same way', () => {
    const raw = 'something the driver has never said before';
    const err = Object.assign(new Error(raw), { code: '99999' });
    expect(errorMessage(err)).not.toBe(raw);
  });
});

// ---- T4 — mapped and unmapped constraints unchanged, WITH AND WITHOUT a code. The shape that
// would break if resolution got nested inside a "has code" branch — none of
// constraint-messages.test.ts's existing fixtures carries a `.code`, so none of them would notice. ----
describe('T4 — constraint resolution is unaffected by the new code check, with and without a code', () => {
  it('mapped, no code (today\'s shape) — unchanged', () => {
    const raw =
      'new row for relation "pay_rates" violates check constraint "pay_rates_amount_positive_check"';
    expect(errorMessage(new Error(raw))).toBe(CONSTRAINT_MESSAGES.pay_rates_amount_positive_check);
  });

  it('mapped, WITH a real SQLSTATE (23514, check_violation) — still the mapped sentence, not the fall-through', () => {
    const raw =
      'new row for relation "pay_rates" violates check constraint "pay_rates_amount_positive_check"';
    const err = Object.assign(new Error(raw), { code: '23514' });
    expect(errorMessage(err)).toBe(CONSTRAINT_MESSAGES.pay_rates_amount_positive_check);
  });

  const unmappedRaw = 'duplicate key value violates unique constraint "some_other_unique"';

  it('unmapped, no code (today\'s shape) — the generic sentence, not raw', () => {
    const message = errorMessage(new Error(unmappedRaw));
    expect(message).not.toContain('some_other_unique');
    expect(message).not.toContain('duplicate key');
  });

  it('unmapped, WITH a real SQLSTATE (23505, unique_violation) — still the generic sentence, not the class-based fall-through sentence', () => {
    const err = Object.assign(new Error(unmappedRaw), { code: '23505' });
    const message = errorMessage(err);
    expect(message).not.toContain('some_other_unique');
    expect(message).not.toContain('duplicate key');
  });
});

// ---- T5 — Invariant 3: the raw text is never discarded; it reaches the server log for every
// sanitised (fall-through, has-code) error. ----
describe('T5 — the raw text survives in the server log for every sanitised error', () => {
  it('logs the raw message at error level when a database error is sanitised', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const raw = 'column "declared_overage" of relation "remittance_lines" does not exist';
    const err = Object.assign(new Error(raw), { code: '42703' });

    errorMessage(err);

    expect(spy).toHaveBeenCalled();
    const loggedRawText = spy.mock.calls.some((call) =>
      call.some((arg) => {
        try {
          return JSON.stringify(arg).includes('declared_overage');
        } catch {
          return String(arg).includes('declared_overage');
        }
      }),
    );
    expect(loggedRawText).toBe(true);
  });

  // Falsified by hand (fed a database error instead) and confirmed to fail for the right reason —
  // not a vacuous assertion. Guards against logging every error rather than only sanitised ones.
  it('does NOT log an application error — invariant 3 is about sanitised errors only', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    errorMessage(new Error('createCashRequest: the amount must be positive'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does NOT log a DEF-279 verbatim sentence — it was never sanitised, nothing was discarded', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const message = 'order_wastage 01a093c0-0000-0000-0000-000000000003 allocations sum to 80, not 100';
    const err = Object.assign(new Error(message), {
      constraint_name: 'order_wastage_allocations_sum_100_trg',
      code: 'P0001',
    });
    errorMessage(err);
    expect(spy).not.toHaveBeenCalled();
  });
});
