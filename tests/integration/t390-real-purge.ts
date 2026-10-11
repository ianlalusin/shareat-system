import type postgres from 'postgres';

/**
 * T-390 S2 - run the REAL `applyPurge` (never a hand-inserted `cutover_steps` row) so C2 is reached the way production reaches it.
 * `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R8, s8 fixtures. TESTER-owned, shared by the S2 files and the two
 * existing callers R8 now refuses (cutover.test.ts, t343-s5-5v-followups.test.ts).
 *
 * ⚠️ A real purge TRUNCATEs every purge-class table of the WHOLE database, so it may only be used against a database no other test
 * run is using (`run-with-db.mjs <your own db>`), and a test must create its org BEFORE calling it (the C2 row is written for every
 * organization that exists at purge time) and its operational data AFTER. Each test therefore builds a fresh fixture and never
 * relies on rows from an earlier test.
 */
export const PURGE_AS_OF = '2027-01-01';

export async function realPurge(
  sql: postgres.Sql,
  performedBy: string,
  opts: { rollback?: boolean } = {},
): Promise<void> {
  const { planPurge, applyPurge } = await import('../../packages/db/src/cutover/purge');
  const ROLLBACK = Symbol('rehearsal rollback');
  try {
    await sql.begin(async (tx) => {
      const plan = await planPurge(tx, PURGE_AS_OF);
      // `performedBy` is the S2 option (R8); the cast keeps this file compiling before the builder adds it to ApplyPurgeOptions.
      await applyPurge(tx, plan, { performedBy } as unknown as Parameters<typeof applyPurge>[2]);
      if (opts.rollback) throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}
