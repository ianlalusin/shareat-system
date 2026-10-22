/**
 * `npm run backfill-fiscal-periods` — seeds fiscal periods for every EXISTING org, per T-264 /
 * DEF-284 slice 1. Read `docs/tasks/264-def-284-fiscal-period-lock.md`'s "severity correction"
 * before running this against anything that matters: every organisation bootstrapped before this
 * task shipped has ZERO fiscal periods and `postEntry` refuses its very first entry — not a
 * scheduler bug, a cutover blocker.
 *
 * ⛔ **Not a migration.** This inserts DATA into an existing table with an unchanged schema; no
 * DDL runs anywhere in this file. RULES rule 9 / ADR-012 govern schema changes and do not apply
 * here.
 *
 * ## Same safety shape as `bootstrap-org.ts`, deliberately
 *
 *   - **`--confirm` is required.** Without it this prints the exact plan and writes nothing — and
 *     the "plan" is not a guess: it runs the real seeding logic inside a transaction and rolls
 *     back, so the preview is the real result, not a re-derived approximation that can drift from
 *     it.
 *   - **One transaction per org.** One org's failure (or, per DEF-044's shape below, a full skip
 *     that is not a failure at all) must never stop the next org from being backfilled or even
 *     being reported on.
 *
 * ## ⛔ Why this reports `inserted`, `skipped`, AND the resulting coverage date — not just a count
 *
 * `seedCalendarMonths`'s bare `ON CONFLICT DO NOTHING` swallows a PARTIAL overlap exactly like an
 * exact duplicate. Several dev/test fixtures carry one wide legacy period
 * (`2020-01-01 .. 2035-12-31`) — run this against one of those and all 12 candidate months
 * conflict, `periodsInserted` is 0, and NOTHING FAILED. That is indistinguishable from "already
 * fully seeded" unless the actual resulting coverage end date is printed alongside the counts —
 * the number that answers "is this org actually fine now?", which a bare count cannot.
 *
 *   npm run backfill-fiscal-periods -- --confirm
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { closeDb, transaction, type Tx } from '../packages/db/src/client';
import { systemTransaction } from '@shareat/db';
import * as schedulerRepo from '../packages/db/src/repo/scheduler';
import * as fiscalPeriodsRepo from '../packages/db/src/repo/fiscal-periods';
import { fiscalPeriodSeedWindow } from '../packages/domain/src/organizations';

interface OrgReport {
  orgId: string;
  orgName: string;
  periodsInserted: number;
  periodsSkipped: number;
  coverageEndsOn: string | null;
}

async function seedOneOrg(tx: Tx, org: { id: string; name: string }): Promise<OrgReport> {
  const window = fiscalPeriodSeedWindow();
  const { periodsInserted, periodsSkipped } = await fiscalPeriodsRepo.seedCalendarMonths(
    tx,
    org.id,
    window,
  );
  const coverageEndsOn = await fiscalPeriodsRepo.latestPeriodEnd(tx, org.id);
  return { orgId: org.id, orgName: org.name, periodsInserted, periodsSkipped, coverageEndsOn };
}

/** Rolled back on purpose — the sentinel below is how the caller tells a deliberate rollback
 *  apart from a real failure, the same technique `first-run-setup.test.ts` uses to prove one. */
const DRY_RUN_ROLLBACK = Symbol('backfill-fiscal-periods dry run');

async function previewOneOrg(org: { id: string; name: string }): Promise<OrgReport> {
  let report: OrgReport | undefined;
  try {
    await transaction(async (tx) => {
      report = await seedOneOrg(tx, org);
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  if (!report) throw new Error('backfill-fiscal-periods: preview transaction never ran its body.');
  return report;
}

function printReport(report: OrgReport): void {
  console.log(
    `  ${report.orgName.padEnd(28)} inserted ${String(report.periodsInserted).padStart(2)} · ` +
      `skipped ${String(report.periodsSkipped).padStart(2)} · coverage now ends ` +
      `${report.coverageEndsOn ?? 'NEVER — still zero periods'}`,
  );
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  // DEF-742: `organizations` has FORCE ROW LEVEL SECURITY. A bare `transaction()` (no principal) sees
  // zero rows, so the script would report "organizations found : 0" while orgs exist. Enumerating every
  // org is the system-connection case (see scripts/backfill-canonical-positions.ts header), so use
  // `systemTransaction`. The per-org seeding below keeps its own transaction.
  const orgs = await systemTransaction((tx) => schedulerRepo.listOrgsToRun(tx));

  console.log('');
  console.log('backfill-fiscal-periods — the plan');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  organizations found : ${orgs.length}`);
  const window = fiscalPeriodSeedWindow();
  console.log(
    `  seed window         : ${window.months} calendar months from ` +
      `${window.startYear}-${String(window.startMonth).padStart(2, '0')} ` +
      `(idempotent — a month already covered is skipped, never duplicated)`,
  );
  console.log('  one transaction PER ORG — one org failing does not stop the rest');
  console.log('─────────────────────────────────────────────────────────────');

  if (orgs.length === 0) {
    console.log('No organizations exist yet. Nothing to backfill.');
    return;
  }

  for (const org of orgs) {
    const report = confirm ? await transaction((tx) => seedOneOrg(tx, org)) : await previewOneOrg(org);
    printReport(report);
  }

  console.log('');
  if (!confirm) {
    console.log('DRY RUN — nothing was written. Re-run with --confirm to do it.');
  } else {
    console.log('DONE — committed, one org at a time.');
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
