#!/usr/bin/env node
/**
 * position-access-census.mjs — T-318 slice A: what is actually out there, per store, before
 * slice B's backfill migration may be written or run.
 *
 *     node scripts/position-access-census.mjs
 *
 * ⛔ READ-ONLY. Prints. Writes nothing, anywhere — no INSERT, UPDATE, DELETE or DDL of any kind.
 * This script issues SELECT statements only; there is no write path in it to disable.
 *
 * ## Why this is a GATE, not a report
 *
 * Ian's ruling (`docs/tasks/318-position-decides-access.md`, "Needs from Ian" #1, 2026-09-14): an
 * open employment with no position is a DATA ERROR. Slice B's migration refuses to run while any
 * exist, and prints exactly who. So this census's "no position" count and list are what decide
 * whether slice B may proceed at all — not a number to eyeball, the gate itself.
 *
 * ## Whose database this queried
 *
 * Runs against whatever `DATABASE_URL` points at — printed below, every run. The orchestrator
 * cannot see production (SSH is blocked for agents) and neither can this script. **A census that
 * does not name its source is the exact shape of a number that gets quoted later as if it were
 * production.** Ian runs this against production himself, if and when he chooses.
 *
 * ## The 21
 *
 * The staff-true capabilities `docs/tasks/318-position-decides-access.md` moves from the role
 * matrix to position grants (`packages/auth/src/capabilities.ts`'s `CAPABILITY_MATRIX`). Counted
 * here as a constant rather than imported, deliberately: this script runs standalone against a
 * database, the same posture `provision-test-role.mjs` documents ("does not import from an app
 * package on purpose — it must also work before the workspace is built"). If this number and the
 * matrix's real count of staff-true cells ever disagree, `tests/unit/capability-matrix.test.ts`
 * is what catches it — not this script, which only sizes a migration.
 */
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const CAPABILITY_COUNT = 21;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. See .env.example.');
  process.exit(1);
}

// Never echo the full URL — the password may legitimately contain '@' (provision-test-role.mjs's
// own reasoning). Only the database name is what "which one did this query" needs.
const dbName = new URL(url).pathname.replace(/^\//, '');

const sql = postgres(url, { max: 1 });

function printHeader() {
  console.log('='.repeat(88));
  console.log(`POSITION-ACCESS CENSUS — T-318 slice A`);
  console.log(`SOURCE DATABASE: ${dbName}  (read from DATABASE_URL — this is NOT necessarily production)`);
  console.log(`READ-ONLY. No writes were made. Run at: ${new Date().toISOString()}`);
  console.log('='.repeat(88));
}

async function main() {
  printHeader();

  // ⛔ `is_active = true` only — this database carries two deactivated smoketest stores
  // (`ZZ-DEACTIVATED …`) and counting them would inflate both the backfill sizing and imply
  // the migration owes them default rows it does not.
  const stores = await sql`SELECT id, org_id, code, name FROM stores WHERE is_active = true ORDER BY name`;
  const inactiveStores = await sql`SELECT id, code, name FROM stores WHERE is_active = false ORDER BY name`;
  const inactiveStoreIds = new Set(inactiveStores.map((s) => s.id));
  if (stores.length === 0) {
    console.log('\nNo active stores in this database. Nothing to census.');
    return;
  }
  if (inactiveStores.length > 0) {
    console.log(
      `\n(${inactiveStores.length} inactive store(s) excluded from this census: ` +
        `${inactiveStores.map((s) => s.code).join(', ')})`,
    );
  }

  // ---------------------------------------------------------------------------------------
  // 1. Active positions per store, and how many people hold an open employment in each.
  //    Canonical positions (store_id IS NULL) apply to every store; store-invented positions
  //    apply only to their own. Both are "active positions at this store" for backfill sizing.
  // ---------------------------------------------------------------------------------------
  const storePositions = await sql`
    WITH store_positions AS (
      SELECT s.id AS store_id, p.id AS position_id, p.name AS position_name, true AS is_canonical
      FROM stores s
      CROSS JOIN positions p
      WHERE s.is_active = true AND p.store_id IS NULL AND p.is_active = true
      UNION ALL
      SELECT p.store_id, p.id, p.name, false
      FROM positions p
      JOIN stores s ON s.id = p.store_id
      WHERE s.is_active = true AND p.is_active = true
    ),
    holder_counts AS (
      SELECT ep.position_id, e.store_id, COUNT(DISTINCT e.person_id) AS holders
      FROM employment_positions ep
      JOIN employments e ON e.id = ep.employment_id
      WHERE e.ended_on IS NULL
      GROUP BY ep.position_id, e.store_id
    )
    SELECT
      sp.store_id, sp.position_id, sp.position_name, sp.is_canonical,
      COALESCE(hc.holders, 0)::int AS holders
    FROM store_positions sp
    LEFT JOIN holder_counts hc ON hc.position_id = sp.position_id AND hc.store_id = sp.store_id
    ORDER BY sp.store_id, sp.is_canonical DESC, sp.position_name
  `;

  // ---------------------------------------------------------------------------------------
  // 2. Open employments with NO position at all — the gate. Staff code + name, not just a count.
  // ---------------------------------------------------------------------------------------
  const orphans = await sql`
    SELECT e.id AS employment_id, e.store_id, e.staff_code, per.display_name
    FROM employments e
    JOIN persons per ON per.id = e.person_id
    LEFT JOIN employment_positions ep ON ep.employment_id = e.id
    WHERE e.ended_on IS NULL AND ep.id IS NULL
    ORDER BY e.store_id, e.staff_code
  `;

  // ---------------------------------------------------------------------------------------
  // 3. Open employments holding MORE than one position, and which one (if any) is flagged
  //    primary today — `employment_positions.is_primary`, not a separate `primaryPositionId`
  //    column (the briefing's phrasing was imprecise; the boolean flag lives ON the join row).
  //    Nothing in code currently reads this flag for an access decision — that is the open
  //    question slice B cannot answer alone.
  // ---------------------------------------------------------------------------------------
  const multiPosition = await sql`
    SELECT
      e.id AS employment_id, e.store_id, e.staff_code, per.display_name,
      COUNT(*)::int AS position_count,
      array_agg(p.name ORDER BY p.name) AS position_names,
      bool_or(ep.is_primary) AS has_a_flagged_primary,
      MAX(CASE WHEN ep.is_primary THEN p.name END) AS primary_position_name
    FROM employments e
    JOIN employment_positions ep ON ep.employment_id = e.id
    JOIN positions p ON p.id = ep.position_id
    JOIN persons per ON per.id = e.person_id
    WHERE e.ended_on IS NULL
    GROUP BY e.id, e.store_id, e.staff_code, per.display_name
    HAVING COUNT(*) > 1
    ORDER BY e.store_id, e.staff_code
  `;

  // ---------------------------------------------------------------------------------------
  // 5a. Total (position x store) pairs the backfill would write a default row for, x 21.
  // ⛔ CORRECTED 2026-09-14: the migration (0152) covers EVERY store, active or not — a
  // deactivated store can still carry an open employment (deactivating a store ends nobody's
  // employment), and Contract 4's byte-identical promise must hold for that person too. Scoping
  // this sizing to active stores only would understate the exact migration it exists to size —
  // found and fixed after building 0152, per the same "never silently fold in or drop" rule
  // already applied to the orphan gate below. `allPairs` matches the migration exactly;
  // `activePairs` is kept and reported alongside it so the two numbers are never silently
  // conflated.
  // 5b. Total distinct people who would receive materialised person_grants, x 21 — one grant
  //     row per (person, capability), never per (person, position, capability): grantCapability
  //     is keyed on (personId, grantName) alone (packages/db/src/repo/access.ts), so a person
  //     holding two positions at the same store, or open employments at two stores, still needs
  //     only 21 grant rows, not more. Verified at source, not assumed.
  // ---------------------------------------------------------------------------------------
  const [{ pair_count: defaultRowPairsAll }] = await sql`
    SELECT COUNT(*)::int AS pair_count
    FROM (
      SELECT s.id AS store_id, p.id AS position_id
      FROM stores s CROSS JOIN positions p
      WHERE p.store_id IS NULL AND p.is_active = true AND p.org_id = s.org_id
      UNION ALL
      SELECT p.store_id, p.id
      FROM positions p
      WHERE p.store_id IS NOT NULL AND p.is_active = true
    ) pairs
  `;
  const [{ pair_count: defaultRowPairsActiveOnly }] = await sql`
    SELECT COUNT(*)::int AS pair_count
    FROM (
      SELECT s.id AS store_id, p.id AS position_id
      FROM stores s CROSS JOIN positions p
      WHERE s.is_active = true AND p.store_id IS NULL AND p.is_active = true AND p.org_id = s.org_id
      UNION ALL
      SELECT p.store_id, p.id
      FROM positions p JOIN stores s ON s.id = p.store_id
      WHERE s.is_active = true AND p.is_active = true
    ) pairs
  `;
  const defaultRowPairs = defaultRowPairsAll;
  // ⚠️ Deliberately NOT scoped to active stores — an open employment is a data-integrity
  // question independent of whether its store is currently active. If a deactivated store still
  // carries an open employment, that person would still receive materialised grants — the store's
  // active flag does not make an open employment stop being open.
  const [{ person_count: grantedPersonCount }] = await sql`
    SELECT COUNT(DISTINCT e.person_id)::int AS person_count
    FROM employments e
    JOIN employment_positions ep ON ep.employment_id = e.id
    JOIN positions p ON p.id = ep.position_id AND p.is_active = true
    WHERE e.ended_on IS NULL
  `;

  // ================= Report, per store =================
  for (const store of stores) {
    const spRows = storePositions.filter((r) => r.store_id === store.id);
    const orphanRows = orphans.filter((r) => r.store_id === store.id);
    const multiRows = multiPosition.filter((r) => r.store_id === store.id);
    const zeroHolder = spRows.filter((r) => r.holders === 0);

    console.log(`\n--- STORE: ${store.name} (${store.code}), id=${store.id} ---`);

    console.log('  [1] Active positions and open-employment holders:');
    for (const r of spRows) {
      console.log(`      ${r.is_canonical ? 'canonical' : 'store-own'}  ${r.position_name}: ${r.holders}`);
    }

    console.log(`  [2] Open employments with NO position (GATE): ${orphanRows.length}`);
    for (const r of orphanRows) {
      console.log(`      ${r.staff_code}  ${r.display_name}  (employment ${r.employment_id})`);
    }

    console.log(`  [3] Open employments holding MORE THAN ONE position: ${multiRows.length}`);
    for (const r of multiRows) {
      console.log(
        `      ${r.staff_code}  ${r.display_name}  positions=[${r.position_names.join(', ')}]  ` +
          `flagged primary=${r.has_a_flagged_primary ? r.primary_position_name : 'NONE'}`,
      );
    }

    console.log(`  [4] Active positions with ZERO holders at this store: ${zeroHolder.length}`);
    for (const r of zeroHolder) {
      console.log(`      ${r.is_canonical ? 'canonical' : 'store-own'}  ${r.position_name}`);
    }
  }

  // ================= Org-wide summary =================
  // ⚠️ [2] and [3] are counted across ALL stores, active or not (see the comment above
  // `grantedPersonCount`) — an open employment does not stop being open because its store was
  // deactivated. Split out below so an inactive-store orphan is never silently folded into "the
  // active-store total" or silently dropped because the per-store loop above only prints active
  // stores.
  const orphansAtInactive = orphans.filter((r) => inactiveStoreIds.has(r.store_id));
  const multiAtInactive = multiPosition.filter((r) => inactiveStoreIds.has(r.store_id));
  const totalOrphans = orphans.length;
  const totalMultiPosition = multiPosition.length;
  const defaultRowCount = defaultRowPairs * CAPABILITY_COUNT;
  const personGrantCount = grantedPersonCount * CAPABILITY_COUNT;

  console.log(`\n${'='.repeat(88)}`);
  console.log('ORG-WIDE SUMMARY');
  console.log('='.repeat(88));
  console.log(`Stores censused (active): ${stores.length}; inactive stores excluded from [1]/[4] (display only): ${inactiveStores.length}; [5]'s sizing covers every store, see below.`);
  console.log(`[2] TOTAL open employments with no position at all (GATE COUNT): ${totalOrphans}`);
  if (orphansAtInactive.length > 0) {
    console.log(
      `    -> ${orphansAtInactive.length} of those are at an INACTIVE store (not shown in the per-store ` +
        `list above, which only prints active stores). Still counted here — an open employment does ` +
        'not stop being open because its store was deactivated.',
    );
  }
  console.log(
    totalOrphans > 0
      ? '    -> Per Ian\'s ruling, slice B MUST refuse to run until this is 0.'
      : '    -> Zero. Slice B\'s refuse-to-run gate would not trip today.',
  );
  console.log(`[3] TOTAL open employments holding more than one position: ${totalMultiPosition}`);
  if (multiAtInactive.length > 0) {
    console.log(`    -> ${multiAtInactive.length} of those are at an INACTIVE store.`);
  }
  console.log(
    totalMultiPosition > 0
      ? '    -> Non-zero: the "which position decides access" question is real. See per-store detail above.'
      : '    -> Zero. The question dies — no employment today holds more than one position.',
  );
  console.log(`[5] Backfill sizing — matches migration 0152 exactly (every store, active or not):`);
  console.log(`    (position x store) pairs, EVERY store: ${defaultRowPairsAll} (of which ${defaultRowPairsAll - defaultRowPairsActiveOnly} are at an inactive store)`);
  console.log(`    (position x store) pairs, active stores only, shown for comparison: ${defaultRowPairsActiveOnly}`);
  console.log(`    x ${CAPABILITY_COUNT} capabilities = ${defaultRowCount} position_capability_defaults rows (the real number 0152 writes).`);
  console.log(`    Distinct people who would receive materialised person_grants: ${grantedPersonCount}`);
  console.log(`    x ${CAPABILITY_COUNT} capabilities = ${personGrantCount} person_grants rows.`);
  console.log(`    TOTAL rows the backfill would write: ${defaultRowCount + personGrantCount}`);
}

try {
  await main();
} finally {
  await sql.end();
}
