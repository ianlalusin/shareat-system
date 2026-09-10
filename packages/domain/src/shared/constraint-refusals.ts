/**
 * Records that a CHECK/unique constraint was hit with no mapped message — T-252, DEF-246, bible
 * §13 row 189. docs/tasks/252-def-246-constraint-message-fallback.md §5.
 *
 * ⛔ **Why this mirrors `attendance/credentials.ts`'s `recordPrerequisiteRefusal` and not a naive
 * same-`tx` write**: T-245 proved empirically that writing on the caller's own `tx` immediately
 * before a throw is silently lost — Drizzle rolls the whole transaction back, taking a same-tx
 * INSERT with it. **That specific mistake is not reachable from this function's signature**: it
 * takes no `tx` at all, so there is nothing for a caller to hand it that could later roll back out
 * before it commits — the class of bug T-245 hit is excluded by construction here, not merely
 * avoided by convention. (Confirmed while specifying this: this repo's own integration test role
 * bypasses RLS entirely — bible §13 row 181 — so a version that forgot to set `role`/`app.org_id`
 * would not fail in THIS test environment either; it would only be caught by the manual RLS
 * probe, §8 of the spec, which is why that probe is required rather than optional here.)
 *
 * What IS proved, by the durability test in `constraint-refusals.test.ts`: a row recorded inside
 * a transaction that the CALLER then rolls back for an unrelated reason still survives, because
 * this function opens its own INDEPENDENT transaction via `withOrgPrincipal`
 * (`packages/db/src/rls/principal.ts:111`) — a fresh pooled connection, already the codebase's
 * blessed pattern for this exact need.
 */
import { sql } from 'drizzle-orm';
import { prerequisiteRefusalsRepo, withOrgPrincipal } from '@shareat/db';
import { logger } from '@shareat/core/logger';

export async function recordConstraintRefusal(input: {
  orgId: string;
  storeId: string | null;
  actorPersonId: string | null;
  constraintName: string;
}): Promise<void> {
  try {
    await withOrgPrincipal(input.orgId, async (freshTx) => {
      // Same defence-in-depth as T-245's recordPrerequisiteRefusal: bound a genuine lock
      // conflict to a fast, logged failure rather than a hang.
      await freshTx.execute(sql`set local lock_timeout = '2s'`);
      return prerequisiteRefusalsRepo.record(freshTx, {
        orgId: input.orgId,
        storeId: input.storeId,
        reasonCode: input.constraintName,
        domain: 'constraint',
        actorPersonId: input.actorPersonId,
      });
    });
  } catch (err) {
    // Recording must never become a new way for the real refusal to fail or change shape.
    logger.error({ err, constraintName: input.constraintName }, 'failed to record constraint refusal');
  }
}
