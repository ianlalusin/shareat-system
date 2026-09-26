/**
 * T-343 S5.0 — F7. `docs/tasks/343-def-417-human-readable-refusals.md` §S5, Amendment R1 item 4,
 * Amendment R2 fold ("F7 (`apps/erp/tests/t343-s5-uuid-shape-parity.test.ts`, TESTER): `UUID_SHAPE.source`
 * equals the db copy").
 *
 * `refuse(...)`'s own UUID redaction (Design: "The UUID regex `refuse` uses also lives in
 * `refusal.ts`") must be the SAME shape as the choke point's `error-shape.ts` copy (S1) — two
 * regex literals drifting apart is exactly the kind of second-source-of-truth RULES.md §6 warns
 * against, just for a pattern instead of a business rule.
 *
 * ⛔ RED until the builder adds `packages/db/src/refusal.ts` and exports `UUID_SHAPE` from
 * `@shareat/db` — `does not provide an export named 'UUID_SHAPE'`.
 */
import { describe, expect, it } from 'vitest';
import { UUID_SHAPE as DB_UUID_SHAPE } from '@shareat/db';
import { UUID_SHAPE as APP_UUID_SHAPE } from '../src/lib/error-shape';

describe('F7 — the db-layer UUID regex and the app choke-point UUID regex are the same pattern', () => {
  it('UUID_SHAPE.source is byte-identical in both copies', () => {
    expect(DB_UUID_SHAPE.source).toBe(APP_UUID_SHAPE.source);
  });

  // /code-review: `.source` alone doesn't prove the two behave alike — a stray 'g' flag on either
  // copy makes `.test()` stateful (its `lastIndex` advances between calls), so the same source with
  // different flags is a silent behavioural drift `.source` equality would never catch.
  it('flags are identical too — a stray "g" would make .test() stateful on only one copy', () => {
    expect(DB_UUID_SHAPE.flags).toBe(APP_UUID_SHAPE.flags);
  });
});
