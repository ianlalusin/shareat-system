/**
 * `npm run backfill-store-attendance-config` — seeds a `store_attendance_config` row for every
 * EXISTING store that does not already have a live one. T-332 §4 item 2,
 * `docs/tasks/332-store-payday-settings-and-the-sixteen-day-check.md`, closing DEF-249's other
 * half: `createStore` (this task's other slice) fixes every store from here on, but a store created
 * before that fix shipped has none, and column defaults do not save it — a default needs a ROW.
 *
 * ⛔ **Not a migration — decided and recorded as Amendment A1.11.** `seedAttendanceConfig`
 * (`packages/domain/src/attendance/config.ts`) is the one place that knows what a correct default
 * config row is, and it is already idempotent. A SQL migration cannot call it; it would have to
 * hand-encode the same INSERT in raw SQL, a second source of truth for defaults that drifts the
 * next time one changes. This script calls the identical function `createStore` calls, so the two
 * doors can never disagree about what a fresh config looks like. No DDL runs anywhere in this file.
 *
 * ⭐ **`effective_from` is the date this script actually runs (Manila's business date), never the
 * store's creation date.** Backdating would assert a historical fact nobody has — that the store
 * actually ran this cadence since day one — and it is the DANGEROUS direction, not merely
 * unnecessary: `seedAttendanceConfig` has no `hasAdjudicatedDaysFrom` guard, so a backdated row
 * could make an old unfrozen day SILENTLY adjudicate under a policy invented after the fact,
 * turning `getConfigForShiftDay`'s loud, deliberate refusal (`config.ts`, "never substitute the
 * live config for a missing historical one") into a quiet wrong answer. "Live as of today, silent
 * before it" is the honest shape, and it costs nothing here: the attendance sweep's population
 * check and `sweepStore` itself never read `effective_from` at all (`scheduler/index.ts`,
 * `attendance/sweep.ts`), so DEF-251 closes the moment a live row exists, whatever date it carries.
 *
 * ⚠️ **Stores given a config by this run will enter the attendance sweep population.** A store
 * with old unclosed days may acquire a needs-review queue that cannot settle until someone decides
 * which policy governed those days — see the warning this script prints before it does anything.
 *
 * ⚠️ **Every insert also fires `store_attendance_config_mirror_enqueue`** (`0088_t181_mirror_outbox.sql`),
 * `after insert or update`, and that migration marks this entity PRIORITY — drained first. A
 * `--confirm` run against many stores produces a burst of PRIORITY outbox rows the moment it runs.
 * Almost certainly wanted — a terminal with no config is a known landmine — but an operator should
 * not meet it by surprise.
 *
 * `created_by` is `null` for every row this script writes. `store_attendance_config.created_by` is
 * deliberately nullable — unlike most `created_by` columns in this codebase, which are `NOT NULL`
 * specifically because "only a human ever writes here" (`0048_t147_supplier_item_catalogue.sql`).
 * `createStore` and `supersedeConfig` both always pass a real `actor.personId`, so `null` appears
 * here if and only if this script wrote the row — the audit trail keeps its distinction.
 *
 * ## Same safety shape as `backfill-fiscal-periods.ts`, deliberately, at the STORE grain
 *
 *   - **`--confirm` is required.** Without it this prints the plan and writes nothing — and the
 *     "plan" is not a guess: it runs the real seeding logic inside a transaction and rolls back, so
 *     the preview is the real result, not a re-derived approximation that can drift from it.
 *   - **One transaction PER STORE**, not per org — matching `sweep.ts`'s own reasoning that one bad
 *     store must never roll back the ones that already succeeded. ⭐ **And the run itself does not
 *     stop at EITHER grain**: a per-store failure is caught, recorded, and the store loop continues;
 *     a per-org failure (the listing query or its coverage baseline, a principal that cannot be set
 *     for one org) is caught, recorded, and the ORG loop continues too. ⚠️ The precedent for this is
 *     `runJobForOrg` (`packages/domain/src/scheduler/index.ts`) — **not** an org-level `try` around
 *     `runSweepForOrg`'s caller, which has none. `runJobForOrg` "never throws. Every path returns a
 *     [outcome]" — its own comment — so nothing reaches its caller's org loop to be caught in the
 *     first place. This script reaches the same property by a different, more direct mechanism: an
 *     ordinary `try`/`catch` around each org's body, because there is no equivalent "always return,
 *     never throw" wrapper here to delegate to.
 *   - **Reports `inserted` / `skipped` / `failed` per store, AND per org**, and computes coverage
 *     rather than trusting a counter: `seedAttendanceConfig`'s idempotence means a store already
 *     configured between this script's listing pass and its write pass is a correctly-reported
 *     `skipped`, not a swallowed conflict. In `--confirm` mode coverage is re-queried, because it
 *     actually moved; in a dry run every store's write rolled back, so coverage is PROJECTED from
 *     what would have been inserted, not re-queried — a re-query would print an unmoved number
 *     next to `inserted` lines and read as if the run had silently failed.
 *
 * ⚠️ **Deliberately UNFILTERED by `is_active`, unlike `payoutIntervalTooLong`/
 * `attendanceConfigMissing` (`packages/db/src/repo/findings.ts`), and that asymmetry is not an
 * oversight — it CLOSES A HOLE, not merely avoids one.** A detector alarming forever on a
 * deactivated store is a permanent, unclearable false alarm, so those two filter it out. But
 * `reactivateStore` (`stores/service.ts`) does exactly two things — `setActive(true)` and fan out
 * store scope — and does NOT seed a config. ⛔ **If this script also skipped inactive stores, a
 * store closed today would come back ACTIVE WITH NO CONFIG the moment someone reactivated it** —
 * DEF-249 reopening on a store that has just started trading again, through a path nobody watches.
 * Backfilling every store regardless of `is_active` is what prevents that: once this script has
 * run, `supersedeConfig` always inserts a successor, so "live" never empties again, and a
 * reactivated store already has a policy in force with no gap. The hazard this closes is real only
 * in the window before the backfill runs (or, after, for any store this run individually FAILED
 * on — see the failure list below, which is where slice A's per-store isolation earns its keep).
 * Do not "fix" this into matching the detectors' filter; the two are supposed to differ.
 *
 *   npm run backfill-store-attendance-config -- --confirm
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { sql } from 'drizzle-orm';
import {
  closeDb,
  manilaToday,
  schedulerRepo,
  transaction,
  withSystemOrgPrincipal,
  type Tx,
} from '@shareat/db';
import { seedAttendanceConfig } from '@shareat/domain';

interface StoreCandidate {
  id: string;
  name: string;
}

/** Stores in this org with no live (`superseded_at is null`) config row. */
async function findStoresWithoutLiveConfig(tx: Tx, orgId: string): Promise<StoreCandidate[]> {
  const rows = await tx.execute(sql`
    select s.id::text as "id", s.name as "name"
      from stores s
      left join store_attendance_config c on c.store_id = s.id and c.superseded_at is null
     where s.org_id = ${orgId} and c.id is null
     order by s.name`);
  return rows as unknown as StoreCandidate[];
}

/** How many of this org's stores are live-configured, out of how many total. */
async function storeCoverage(tx: Tx, orgId: string): Promise<{ configured: number; total: number }> {
  const [row] = (await tx.execute(sql`
    select count(*)::int as total,
           count(*) filter (where c.id is not null)::int as configured
      from stores s
      left join store_attendance_config c on c.store_id = s.id and c.superseded_at is null
     where s.org_id = ${orgId}`)) as unknown as { total: number; configured: number }[];
  return { configured: row!.configured, total: row!.total };
}

type Outcome = 'inserted' | 'skipped';

/** The write, and the idempotence check that lets it report the truth rather than a guess. */
async function backfillOneStore(
  tx: Tx,
  input: { orgId: string; storeId: string; effectiveFrom: string },
): Promise<Outcome> {
  const [existing] = (await tx.execute(sql`
    select exists (
      select 1 from store_attendance_config
       where store_id = ${input.storeId} and superseded_at is null
    ) as present`)) as unknown as { present: boolean }[];
  if (existing!.present) return 'skipped';

  await seedAttendanceConfig(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    effectiveFrom: input.effectiveFrom,
    createdBy: null,
  });
  return 'inserted';
}

/** Rolled back on purpose — same sentinel technique `backfill-fiscal-periods.ts` uses to tell a
 *  deliberate rollback apart from a real failure. */
const DRY_RUN_ROLLBACK = Symbol('backfill-store-attendance-config dry run');

async function runOneStore(
  org: { id: string; name: string },
  store: StoreCandidate,
  effectiveFrom: string,
  confirm: boolean,
): Promise<Outcome> {
  if (confirm) {
    return withSystemOrgPrincipal(org.id, (tx) =>
      backfillOneStore(tx, { orgId: org.id, storeId: store.id, effectiveFrom }),
    );
  }
  let outcome: Outcome | undefined;
  try {
    await withSystemOrgPrincipal(org.id, async (tx) => {
      outcome = await backfillOneStore(tx, { orgId: org.id, storeId: store.id, effectiveFrom });
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  if (!outcome) {
    throw new Error('backfill-store-attendance-config: preview transaction never ran its body.');
  }
  return outcome;
}

/** `storeName` absent means the failure was at the ORG grain — the listing/coverage query itself,
 *  not any one store's write. */
interface Failure {
  orgName: string;
  storeName?: string;
  reason: string;
}

/** Only `--confirm` is accepted. Same shape as `bootstrap-org.ts`'s `parseArgs`: an unrecognised
 *  argument is refused rather than silently ignored (a `--confrim` typo must not quietly run the
 *  opposite of what the operator typed — it already can't WRITE the opposite, since the direction
 *  is safe, but it should not pretend the flag was understood either). */
function parseArgs(argv: readonly string[]): { confirm: boolean } {
  let confirm = false;
  for (const arg of argv) {
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    throw new Error(
      `backfill-store-attendance-config: unrecognised argument "${arg}". Only --confirm is accepted.`,
    );
  }
  return { confirm };
}

async function main(): Promise<void> {
  const { confirm } = parseArgs(process.argv.slice(2));
  // ⛔ A bare `transaction`, not `withSystemOrgPrincipal` and not `systemTransaction` — `organizations`
  // carries no `org_id` column to scope against, so it is visible with no principal set at all, the
  // same read `backfill-fiscal-periods.ts` already relies on.
  const orgs = await transaction((tx) => schedulerRepo.listOrgsToRun(tx));
  const effectiveFrom = await transaction((tx) => manilaToday(tx));

  console.log('');
  console.log('backfill-store-attendance-config — the plan');
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`  organizations found : ${orgs.length}`);
  console.log(`  effective_from      : ${effectiveFrom}  (Manila business date, today — not backdated)`);
  console.log('  created_by          : null on every row this script writes');
  console.log('  one transaction PER STORE — one store failing does not stop the run or the rest');
  console.log('');
  console.log('  ⚠️  Stores given a config by this run will enter the attendance sweep population.');
  console.log('      A store with old unclosed days may acquire a needs-review queue that cannot');
  console.log('      settle until someone decides which policy governed those days.');
  console.log('  ⚠️  Every insert fires the PRIORITY mirror-outbox trigger — a --confirm run against');
  console.log('      many stores produces a burst of PRIORITY outbox rows the moment it runs.');
  console.log('─────────────────────────────────────────────────────────────');

  if (orgs.length === 0) {
    console.log('No organizations exist yet. Nothing to backfill.');
    return;
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  const failures: Failure[] = [];

  // ⛔ Caught per ORG, not allowed to propagate: a bad org (the listing query, its coverage
  // baseline, a principal that cannot be set for it) must not stop the orgs after it, and the
  // summary below must still print even when something failed at this grain. The per-store `try`
  // inside is the same idea one level down. See the header for why the precedent this mirrors is
  // `runJobForOrg`'s catch-and-return, not an org-level `try` that does not exist in the scheduler.
  //
  // ⚠️ The `after` coverage re-query (below, `confirm` branch) is deliberately NOT inside this
  // `try` — it runs once this org's stores have already committed, so a failure reading it back is
  // never a reason to report the org itself as failed. See its own comment.
  for (const org of orgs) {
    try {
      const candidates = await withSystemOrgPrincipal(org.id, (tx) => findStoresWithoutLiveConfig(tx, org.id));
      const before = await withSystemOrgPrincipal(org.id, (tx) => storeCoverage(tx, org.id));
      let orgInserted = 0;

      for (const store of candidates) {
        try {
          const outcome = await runOneStore(org, store, effectiveFrom, confirm);
          if (outcome === 'inserted') {
            totalInserted++;
            orgInserted++;
          } else {
            totalSkipped++;
          }
          console.log(`  ${org.name.padEnd(24)} ${store.name.padEnd(24)} ${outcome}`);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          failures.push({ orgName: org.name, storeName: store.name, reason });
          console.log(`  ${org.name.padEnd(24)} ${store.name.padEnd(24)} FAILED — ${reason}`);
        }
      }

      if (confirm) {
        // ⚠️ Its own `try`, separate from the org-level one above: this read happens AFTER this
        // org's inserts already committed, so its failure describes the REPORT, not the WRITE. An
        // org whose every write succeeded must never be printed as a failed org for a re-query that
        // came after the fact — that reads as "this org did not get done" when it did.
        try {
          const after = await withSystemOrgPrincipal(org.id, (tx) => storeCoverage(tx, org.id));
          console.log(
            `  ${org.name.padEnd(24)} coverage now: ${after.configured}/${after.total} stores configured`,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          console.log(
            `  ${org.name.padEnd(24)} coverage now: UNKNOWN — re-query failed: ${reason} ` +
              '(the inserts above already committed; this is a reporting failure, not a write failure)',
          );
        }
      } else {
        // ⚠️ Every store's write rolled back, so a re-query would print `before.configured` unchanged
        // right next to `inserted` lines above it — confusing, and read the wrong way, alarming. This
        // is the PROJECTED result if `--confirm` is passed next, computed from this run's own outcomes.
        const projected = before.configured + orgInserted;
        console.log(
          `  ${org.name.padEnd(24)} coverage would be: ${projected}/${before.total} stores configured ` +
            `(dry run — current coverage is still ${before.configured}/${before.total})`,
        );
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ orgName: org.name, reason });
      console.log(`  ${org.name.padEnd(24)} ORG-LEVEL FAILURE — ${reason}`);
    }
  }

  // ⛔ Two grains, reported separately: an org-level failure means its stores were never even
  // listed — an UNKNOWN number of them never attempted — which a combined count would understate.
  const storeFailures = failures.filter((f) => f.storeName !== undefined);
  const orgFailures = failures.filter((f) => f.storeName === undefined);

  console.log('─────────────────────────────────────────────────────────────');
  console.log(
    `  inserted ${totalInserted} · skipped ${totalSkipped} · ` +
      `failed ${storeFailures.length} store(s) · ${orgFailures.length} org(s) (their stores not attempted)`,
  );
  if (failures.length > 0) {
    console.log('  FAILURES (the run continued past each of these):');
    for (const f of failures) {
      console.log(`    ${f.orgName}${f.storeName ? ` / ${f.storeName}` : ' (org-level)'} — ${f.reason}`);
    }
  }
  console.log('');
  if (!confirm) {
    console.log('DRY RUN — nothing was written. Re-run with --confirm to do it.');
  } else if (failures.length === 0) {
    console.log('DONE — committed, one store at a time.');
  } else {
    console.log(
      `DONE WITH FAILURES — ${storeFailures.length} store(s) and ${orgFailures.length} org(s) not ` +
        'seeded, see above. Safe to re-run: an already-configured store is reported skipped, never re-inserted.',
    );
  }
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => closeDb());
