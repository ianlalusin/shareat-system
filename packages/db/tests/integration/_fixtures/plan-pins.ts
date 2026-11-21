/**
 * T-624 - makes a test that asserts on an EXPLAIN plan independent of the planner's mood.
 *
 * Why they flaked: the tables are tiny and freshly written, most had no statistics, and CI shards share one database, so the row
 * estimates (and with them the choice between a nested loop with an index probe, a hash join, a bitmap scan or a sibling index)
 * moved from run to run. Every one of those plans is VALID; the test only means to prove the query CAN be served by the index.
 *
 * Call `pinPlan` inside the rolled-back transaction, after seeding and before the EXPLAIN. `run` executes one SQL statement
 * (`(s) => tx.unsafe(s)` for postgres.js, `(s) => tx.execute(dsql.raw(s))` for drizzle). Every setting is SET LOCAL, gone at rollback.
 *  - ANALYZE the named tables, so estimates come from the rows the transaction can see rather than from stale or absent statistics.
 *  - No seq scan, hash join, merge join or bitmap scan: what is left is an index scan, probed by a nested loop. A query that is
 *    narrowed shows an Index Cond; one that is not (the mutant) still walks the index end to end, so it still reads red.
 */
export const PLAN_PINS = [
  'set local enable_seqscan = off',
  'set local enable_bitmapscan = off',
] as const;

export async function pinPlan(run: (statement: string) => Promise<unknown>, analyze: readonly string[] = []): Promise<void> {
  for (const table of analyze) await run(`analyze ${table}`);
  for (const pin of PLAN_PINS) await run(pin);
}
