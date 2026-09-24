/**
 * `npm run backfill-canonical-positions` — seeds the six canonical positions for every EXISTING
 * org, per T-335 / DEF-150 (`docs/tasks/335-positions-seeded-at-org-creation.md`). Every
 * organisation created before this task shipped has ZERO positions and cannot hire: `/staff/hire`
 * and `/admin/access-defaults` both render empty, and a blank hire throws "The default position
 * 'Server' is missing."
 *
 * ⛔ **Not a migration.** This inserts DATA into an existing table with an unchanged schema; no
 * DDL runs anywhere in this file. RULES rule 9 / ADR-012 govern schema changes and do not apply
 * here (§6).
 *
 * ## Same safety shape as `backfill-fiscal-periods.ts`, deliberately
 *
 *   - **`--confirm` is required.** Without it this prints the exact plan and writes nothing — and
 *     the "plan" is not a guess: it runs the real seeding logic inside a transaction and rolls
 *     back, so the preview is the real result, not a re-derived approximation that can drift from
 *     it.
 *   - **One transaction per org, and one org's failure is caught and reported, never fatal to the
 *     rest.** `main` keeps going after a failed org (dry run or `--confirm`) and exits non-zero
 *     only at the end, if anything failed.
 *
 * ## ⛔ `organizations` and `positions` carry FORCE ROW LEVEL SECURITY — this runs on the SYSTEM
 * connection, not the bare one
 *
 * There is no signed-in actor here to establish an org principal (`withOrgPrincipal`), and
 * enumerating EVERY org is the `systemTransaction()` shape `client.ts:129`'s closed list already
 * names for `listOrgsToRun`. The bare `transaction()` (no principal) would satisfy no RLS policy on
 * either table — a silent, empty read, not a loud failure. ⚠️ `tests/unit/
 * system-transaction-callers.test.ts` keeps a closed, named list of files allowed to call
 * `systemTransaction`; this file must be on it or that guard fails the build (it is a test file —
 * the builder cannot add itself to it).
 *
 * ## ⛔ Collisions are reported, never resolved (§5/§8 — OPEN, needs Ian's ruling)
 *
 * A store may already have made its own 'Server' before this fix, if it went unseeded long enough
 * for `upsertStorePosition`'s old canonical-name refusal (keyed on the canonical row EXISTING) to
 * never fire. After this backfill that store has two 'Server' rows with different `position_id`s
 * and, potentially, different `position_capability_defaults`. This script only NAMES that by store
 * code and position id; it does not merge, adopt or delete either row.
 *
 * ## ⛔ Production needs a genuinely read-only step FIRST — this script's dry run is not it
 *
 * The dry run below is a write-then-rollback probe: the inserts really execute, take row locks and
 * run triggers, before rolling back. Before running this against production, run the plain,
 * genuinely read-only query named in §5 step 1 by hand:
 *   select count(*) from positions where org_id = <prod org> and store_id is null and is_canonical;
 * If it is already 6, stop — production needs no write-probe and no backfill. Only if it is below
 * 6 does the dry run, then `--confirm`, apply — both need the orchestrator's go (§8).
 *
 *   npm run backfill-canonical-positions -- --confirm
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { sql } from 'drizzle-orm';
import { closeSystemDb, systemTransaction, type Tx } from '../packages/db/src/client';
import * as schedulerRepo from '../packages/db/src/repo/scheduler';
import * as employmentRepo from '../packages/db/src/repo/employment';
import { type CanonicalNameCollision } from '../packages/db/src/repo/employment';
import { CANONICAL_POSITIONS } from '../packages/db/schema/employment';

interface OrgPositionsReport {
  orgId: string;
  orgName: string;
  inserted: number;
  canonicalNow: number;
  collisions: readonly CanonicalNameCollision[];
}

/** The one function a caller (a test, or this file's own `main`) needs: seed the six for one org
 *  and report any store-scoped name collisions. Never resolves a collision — §5/§8. */
export async function backfillOrgPositions(
  tx: Tx,
  org: { id: string; name: string },
): Promise<{ inserted: number; collisions: readonly CanonicalNameCollision[] }> {
  const { inserted } = await employmentRepo.seedCanonical(tx, org.id);
  const collisions = await employmentRepo.canonicalNameCollisions(tx, org.id);
  return { inserted, collisions };
}

async function reportOneOrg(tx: Tx, org: { id: string; name: string }): Promise<OrgPositionsReport> {
  const { inserted, collisions } = await backfillOrgPositions(tx, org);
  const canonicalNow = await employmentRepo.countCanonical(tx, org.id);
  return { orgId: org.id, orgName: org.name, inserted, canonicalNow, collisions };
}

/** Rolled back on purpose — the sentinel below is how the caller tells a deliberate rollback
 *  apart from a real failure, the same technique `backfill-fiscal-periods.ts` uses. */
const DRY_RUN_ROLLBACK = Symbol('backfill-canonical-positions dry run');

async function previewOneOrg(org: { id: string; name: string }): Promise<OrgPositionsReport> {
  let report: OrgPositionsReport | undefined;
  try {
    await systemTransaction(async (tx) => {
      report = await reportOneOrg(tx, org);
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  if (!report) throw new Error('backfill-canonical-positions: preview transaction never ran its body.');
  return report;
}

/** What role actually read/wrote — printed so a `0` org count can be told apart from an
 *  RLS-empty read using the wrong connection, rather than assumed innocent. */
async function currentRole(): Promise<string> {
  const result = await systemTransaction((tx) => tx.execute(sql`select current_user as role`));
  return String((result as unknown as { role: string }[])[0]?.role ?? 'unknown');
}

function printReport(report: OrgPositionsReport): void {
  const collisionText =
    report.collisions.length === 0
      ? 'none'
      : report.collisions.map((c) => `${c.storeCode} · ${c.positionId} · ${c.name}`).join('; ');
  console.log(
    `  ${report.orgName.padEnd(28)} inserted ${String(report.inserted)} · ` +
      `canonical now ${report.canonicalNow}/${CANONICAL_POSITIONS.length} · collisions: ${collisionText}`,
  );
}

async function main(): Promise<void> {
  const confirm = process.argv.includes('--confirm');
  const role = await currentRole();
  const orgs = await systemTransaction((tx) => schedulerRepo.listOrgsToRun(tx));

  console.log('');
  console.log('backfill-canonical-positions — the plan');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  reading/writing as  : ${role} (systemTransaction — RLS-forced tables, no principal)`);
  console.log(`  organizations found : ${orgs.length}`);
  console.log(`  canonical positions : ${CANONICAL_POSITIONS.join(', ')}`);
  console.log('  one transaction PER ORG — one org failing is caught and reported, never fatal to the rest');
  console.log('  collisions are REPORTED, never resolved — Ian rules those (§5/§8)');
  console.log('─────────────────────────────────────────────────────────────');

  if (orgs.length === 0) {
    console.log(`No organizations found, reading as role "${role}". Nothing to backfill.`);
    console.log('⚠️ If organizations are known to exist, this zero is suspect — confirm the role above is the SYSTEM role, not an RLS-empty read.');
    return;
  }

  const failures: { orgName: string; message: string }[] = [];
  for (const org of orgs) {
    try {
      const report = confirm ? await systemTransaction((tx) => reportOneOrg(tx, org)) : await previewOneOrg(org);
      printReport(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${org.name.padEnd(28)} FAILED — ${message}`);
      failures.push({ orgName: org.name, message });
    }
  }

  console.log('');
  if (!confirm) {
    console.log('DRY RUN — nothing was written. Re-run with --confirm to do it.');
  } else if (failures.length === 0) {
    console.log('DONE — committed, one org at a time.');
  } else {
    console.log('DONE, WITH FAILURES — every org that succeeded is committed; failed ones are not, and are listed above.');
  }

  if (failures.length > 0) {
    console.error(`${failures.length} of ${orgs.length} organisation(s) failed.`);
    process.exitCode = 1;
  }
}

// Importable without running `main` — `packages/domain/tests/integration/t335-…test.ts` dynamically
// imports this module for `backfillOrgPositions` alone. Same guard shape as `scripts/gen-toc.ts`.
if (process.argv[1] && process.argv[1].endsWith('backfill-canonical-positions.ts')) {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => closeSystemDb());
}
