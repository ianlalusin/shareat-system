import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T-371 S0 — the numeric-write guard. `docs/tasks/371-nan-sweep.md` §S0 "The four guard legs".
 *
 * Keyed on the COLUMN, not on how a value is read: every constrained numeric column is derived from the Drizzle schema at runtime,
 * every write that targets one is found with the type checker anywhere in `packages/**`, `apps/**` and `scripts/**` (bulk inserts
 * unwrapped to their rows), and the argument property for that column must carry a `__decimal` brand whose literal equals the column's
 * `'p,s'`. The instrument is `tests/unit/lib/numeric-write-census.ts`; `t371-census-selftest.test.ts` proves each detector can FAIL.
 *
 *   G1 writes      — red today until S1/S3: unbranded, cast, any and SQL-typed values; raw-SQL parameters judged by brand.
 *   G2 comparisons — red today until S2: every flagged relational comparison on a string-derived value is un-EXEMPT.
 *   G3 forgery     — red today until S1: type assertions onto a brand (or a container of one) exist outside `packages/core/src`.
 *   G4 schema      — GREEN today (160 of 160 carry a `*_finite_check`, ✎R7); shown red only by its mutant (in the self-test).
 *
 * ⛔ TESTER. Nothing here is a list of spellings; the only hand-written tables are `RAW_SQL_WRITERS` (fail-closed registry of raw-SQL writers
 * by function name), `RAW_SQL_EXEMPT` (a dev-only seed, by `file::function`, valid only while the file still refuses non-`_dev` databases),
 * `EXEMPT` (comparisons that are provably not column values, with a reason from a CLOSED list), and the two recorded fail-closed ceilings
 * for targets the checker cannot name. The builder shrinks the red by fixing code, never by widening these. Each leg fails if its population
 * is 0, and named sentinels (specific, not OR-ed) must be present in their population (✎R8). Each module is its own `it.each` case so a
 * workflow reads a per-module done signal. No test name carries a count; every denominator is derived at runtime.
 */
import ts from 'typescript';
import {
  byModule,
  constrainedColumns,
  countTypeAssertions,
  findComparisons,
  findForgeries,
  findRawSqlWriters,
  findWrites,
  finiteCheckGaps,
  loadCensus,
  rawScriptWriters,
  ROOT,
  type Comparison,
} from './lib/numeric-write-census';

/** Raw-SQL writers, by function name. A new one fails closed. */
const RAW_SQL_WRITERS: ReadonlySet<string> = new Set(['insertInvoiceLines', 'mergeItemInto', 'refreshOrderTotal', 'upsertItemPricing']);

/**
 * A dev-only seed that is OUT of G1's production scope, by `file::function`. The exemption holds only while the file still refuses to run against
 * anything but a `*_dev` database (asserted first); a NEW script or function still trips the guard.
 */
const RAW_SQL_EXEMPT: Readonly<Record<string, { reason: string; mustContain: string }>> = {
  'scripts/dev-seed-inventory.ts::item': { reason: 'T-391 S1: dev seed inserts items without purchase_unit or purchase_factor (both stay null); never runs on production', mustContain: "endsWith('_dev')" },
  'scripts/dev-seed-inventory.ts::main': { reason: 'dev-only seed, never runs on production', mustContain: "endsWith('_dev')" },
  'scripts/smoke-pin-throttle.ts::main': { reason: 'T-395 smoke fixture: inserts an org, store and persons (no numeric money columns) and resets a tier-1 counter; refuses any database not named *_test', mustContain: 'shareat_test|_test' },
};

/**
 * The recorded fail-closed ceilings (L7): how many write targets / raw statements the checker could NOT name when this guard was written.
 * A new split chain, computed key, aliased table, `sql.raw` or `insert into ${ident}` pushes the count over and fails the leg.
 * Writes: 0 (every target resolved). Raw SQL: ENUMERATED below (low-stock refreshOrderTotal now resolves: `update ${tradeOrders}`, no bound params).
 */
const UNRESOLVED_WRITES_CEILING = 0;
/**
 * The raw-SQL statements the checker cannot resolve, ENUMERATED as `file::function::why` and compared for EQUALITY (a count would let a swap
 * pass: a new one and a stale one both fail). Each has the reason it cannot be resolved; none writes a constrained numeric column.
 */
const UNRESOLVED_RAW_SQL: Readonly<Record<string, string>> = {
  'packages/db/src/cutover/purge.ts::applyPurge::dynamic-table': 'the table name is a runtime identifier from the cutover purge plan (`update ${quoteIdent(p.table)} set k = $n`); no static table to resolve',
  'packages/db/src/repo/budgets.ts::consumptionWindow::sql.raw': 'a SQL fragment (a date window) inside a SELECT, not a write',
  'packages/db/src/repo/commissary-kpis.ts::manilaDateOf::sql.raw': 'a SQL fragment (a column cast to a Manila date) inside a SELECT, not a write',
  'packages/db/src/repo/cutover.ts::purgeComplete::sql.raw': 'a SQL fragment inside the purge-completeness read, not a write',
  'packages/db/src/repo/payroll.ts::freezeDays::sql.raw': 'a SQL fragment (an IN list) inside an UPDATE of non-numeric columns (frozen_at)',
};

/** The closed list of reasons a comparison may be exempt (C4 (b)); anything else is a G2 failure. */
const EXEMPT_REASONS = ['not-a-column-value', 'display-only'] as const;
/** `file::function::normalised expression` -> reason. Filled by the S2/S3 builders, one entry per proven-safe comparison. */
const EXEMPT: Record<string, (typeof EXEMPT_REASONS)[number]> = {
  // T-387 S5 (dashboard range): whole-day counts and loop indexes from validated business dates, and ISO business-date ordering (lexicographic by design). No numeric(p,s) column value.
  'apps/erp/src/app/dashboard/lib.ts::previousRange::days < 1': 'not-a-column-value',
  'apps/erp/src/app/dashboard/lib.ts::eachDay::n < 1': 'not-a-column-value',
  'apps/erp/src/app/dashboard/lib.ts::eachDay::i < n': 'not-a-column-value',
  'apps/erp/src/app/dashboard/lib.ts::resolveRange::dayCount(from, to) > MAX_RANGE_DAYS': 'not-a-column-value',
  'apps/erp/src/app/dashboard/lib.ts::resolveRange::prev.from < MIN_RANGE_START': 'not-a-column-value',
  'apps/erp/src/app/page.tsx::DashboardPage::days > 1': 'not-a-column-value',
  // string-vs-string ORDERING of fiscal-period keys / ids / dates ('2026-01' <= '2026-02'): lexicographic by design, never a money comparison
  'packages/domain/src/shared/straight-line.ts::periodsThroughOf::p.period <= asOfPeriod': 'not-a-column-value',
  'packages/domain/src/shared/allocate-oldest-first.ts::compareItems::dateA < dateB': 'not-a-column-value',
  'packages/domain/src/shared/allocate-oldest-first.ts::compareItems::tieA < tieB': 'not-a-column-value',
  'packages/domain/src/shared/allocate-oldest-first.ts::compareItems::a.id < b.id': 'not-a-column-value',
  // integer-only bounds of a whole-number box (months, days, terms): `Number.isInteger`-guarded counts, never a numeric(p,s) column value
  'packages/domain/src/shared/whole-number-input.ts::parseWholeNumberInput::n > max': 'not-a-column-value',
  'packages/domain/src/shared/whole-number-input.ts::parseWholeNumberInput::n < min': 'not-a-column-value',
  // orchestrator ruling (T-371 S3): ISO business-date ordering and a TCP port range check — not numeric(p,s) column values
  'apps/erp/src/lib/period-override.ts::closedMonthOf::date <= m.endsOn': 'not-a-column-value',
  'apps/erp/src/lib/period-override.ts::closedMonthOf::date >= m.startsOn': 'not-a-column-value',
  'apps/erp/src/components/ClosedMonthOverride.tsx::ClosedMonthOverride::date <= m.endsOn': 'not-a-column-value',
  'apps/erp/src/components/ClosedMonthOverride.tsx::ClosedMonthOverride::date >= m.startsOn': 'not-a-column-value',
  'apps/erp/src/app/sign-in/firebase-client.ts::signInFirebase::parsedPort <= 65535': 'not-a-column-value',
  'apps/erp/src/app/sign-in/firebase-client.ts::signInFirebase::parsedPort > 0': 'not-a-column-value',
  'packages/db/src/cutover/purge.ts::planPurge::asOf >= nb': 'not-a-column-value',
  // S4 (T-371): a row count from count(*)::text, a YYYY-MM-DD date-string check (isValidDateString), and an ordinal rank of the grant-source enum — none is a numeric(p,s) column value
  'packages/db/src/repo/access.ts::grantCapability::grantSourceRank(input.grantSource) > grantSourceRank(existingSource)': 'not-a-column-value',
  // S4 (T-371): fiscal-period YYYY-MM-DD ordering, count(*) > 0 existence checks, and day-difference ageing thresholds (date minus date / daysBetweenDates) — not numeric(p,s) column values
  'packages/db/src/repo/fiscal-periods.ts::coverageHoles::p.startsOn > addOneDay(prevEnd)': 'not-a-column-value',
  'packages/db/src/repo/fiscal-periods.ts::coverageHoles::p.endsOn > prevEnd': 'not-a-column-value',
  'packages/db/src/repo/fiscal-periods.ts::coverageHoles::through > prevEnd': 'not-a-column-value',
  'packages/db/src/repo/fiscal-periods.ts::coverageHoles::p.startsOn > closeFrontierStartsOn': 'not-a-column-value',
  'packages/db/src/repo/fiscal-periods.ts::firstCoverageGapBefore::h.endsOn <= through': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::periodicPostingsMissed::Number(r.depreciable) > 0': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::periodicPostingsMissed::Number(r.prepaid) > 0': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::remittanceOverdue::age > limit': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::assetHeldPastOpening::days <= HELD_PAST_OPENING_THRESHOLD_DAYS': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::serviceChargeFloatAgeing::ageDays <= SERVICE_CHARGE_MAX_DAYS': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::reimbursablePayableAgeing::ageDays <= thresholdDays': 'not-a-column-value',
  'packages/db/src/repo/findings.ts::grniNotAtRest::ageDays <= thresholdDays': 'not-a-column-value',
  // S3 (T-371): the rest of the proven-safe set — ISO business-date / period-key ordering, whole-number counts and loop indexes, row-id tie-breaks. None is a numeric(p,s) column value;
  // the two BudgetHint lines are display-only (a client warning colour: the hint warns and never blocks — see its header, T-175).
  'packages/domain/src/ap/index.ts::run::dueDate < invoiceDate': 'not-a-column-value',
  'packages/domain/src/ap/index.ts::parseCreditTermsDays::Number(t) > 365': 'not-a-column-value',
  'packages/domain/src/loans/interest.ts::accruedInterest::days <= 0': 'not-a-column-value',
  'packages/domain/src/remittance/index.ts::run::on < variance.remittedOn': 'not-a-column-value',
  'packages/domain/src/owners/index.ts::run::nextMonthOf(periodMonth) > input.on': 'not-a-column-value',
  'packages/db/src/repo/owners.ts::monthlyOwnerFifoDeltas::l.entryDate < since': 'not-a-column-value',
  'packages/db/src/repo/owners.ts::monthlyOwnerFifoDeltas::l.entryDate >= since': 'not-a-column-value',
  'packages/domain/src/prepaid/index.ts::checkFullyAmortised::asOfPeriod < last.period': 'not-a-column-value',
  'packages/domain/src/prepaid/index.ts::run::posted.size > coverageMonths': 'not-a-column-value',
  'packages/domain/src/liabilities/index.ts::isOverdue::dueOn < asOf': 'not-a-column-value',
  'apps/erp/src/app/expenses/actions.ts::parseExpenseForm::i < lineCount': 'not-a-column-value',
  'apps/erp/src/app/expenses/recurring/lib.ts::periodsBehind::nextDue > today': 'not-a-column-value',
  'apps/erp/src/app/expenses/recurring/lib.ts::periodsBehind::cursor <= today': 'not-a-column-value',
  'apps/erp/src/app/expenses/recurring/page.tsx::RecurringExpensesPage::t.nextDueDate <= now': 'not-a-column-value',
  'apps/erp/src/app/expenses/recurring/page.tsx::RecurringExpensesPage::periodsBehind(t.interval, t.anchorDay, t.nextDueDate, now) > 1': 'not-a-column-value',
  'apps/erp/src/app/expenses/new/BudgetHint.tsx::BudgetHint::after < 0': 'display-only',
  'apps/erp/src/app/expenses/new/BudgetHint.tsx::BudgetHint::after < Number(cap.amount) * 0.1': 'display-only',
  'apps/erp/src/app/attendance/lib.ts::defaultRange::p.start <= today': 'not-a-column-value',
  'apps/erp/src/app/attendance/lib.ts::defaultRange::today <= p.end': 'not-a-column-value',
  'packages/domain/src/attendance/config.ts::supersedeConfig::effectiveFrom <= live.effectiveFrom': 'not-a-column-value',
  'apps/erp/src/app/customers/[customerId]/AutoAllocateCollectionForm.tsx::AutoAllocateCollectionForm::i.dueDate < today': 'not-a-column-value',
  'apps/erp/src/app/customers/[customerId]/page.tsx::CustomerDetailPage::c.dueDate < now': 'not-a-column-value',
  'packages/domain/src/recurring-expenses/recurrence.ts::firstDueDate::parse(thisMonth) >= base': 'not-a-column-value',
  'packages/domain/src/recurring-expenses/index.ts::run::template.nextDueDate < manilaToday()': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::tilesTheMonth::p.end < p.start': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::periodForDate::date >= p.start': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::periodForDate::date <= p.end': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::payoutDateFor::period.start <= `${ownMonth}30`': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::payoutDateFor::iso >= period.end': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::maxPayoutGapDays::earlier > GAP_PAIR_TO': 'not-a-column-value',
  'packages/domain/src/payroll/periods.ts::maxPayoutGapDays::earlier < GAP_PAIR_FROM': 'not-a-column-value',
  'apps/erp/src/app/payroll/lib.ts::currentPeriod::today >= p.start': 'not-a-column-value',
  'apps/erp/src/app/payroll/lib.ts::currentPeriod::today <= p.end': 'not-a-column-value',
  // T-190: ISO 'YYYY-MM-DD' business-date ordering (a table's effective_from vs the latest posted period_end) - string-vs-string, never a money value
  'packages/domain/src/payroll/rates.ts::assertNotPaidAlready::effectiveFrom <= latest': 'not-a-column-value',
  'packages/domain/src/stock/layers.ts::sortForFifo::a.id < b.id': 'not-a-column-value',
  'packages/domain/src/stock/layers.ts::sortForFifo::a.id > b.id': 'not-a-column-value',
  'packages/domain/src/fixed-assets/schedule.ts::periodsThrough::p.period <= asOfPeriod': 'not-a-column-value',
  'packages/domain/src/fixed-assets/dispose.ts::runDispose::input.disposedOn < asset.acquiredOn': 'not-a-column-value',
  'packages/domain/src/fixed-assets/in-service.ts::resolveMode::openingDate > asset.acquiredOn!': 'not-a-column-value',
  // T-316 S2: ISO 'YYYY-MM-DD' business-date ordering in tillFloorPosition (latest verified day vs a report's day) — string-vs-string, never a money value
  'packages/db/src/repo/remittance.ts::tillFloorPosition::r.businessDate > latestVerified': 'not-a-column-value',
  // T-374 S5: whole-number bounds, each NaN-safe. `lineCount` passed `/^\d+$/` first; `typedLife` is a `parseWholeNumberInput` result (regex ^\d+$, finite) or a typed
  // number already refused by `!Number.isInteger(...)` (which catches NaN) before `< 1` / `> MAX` are reached; `usefulLifeMonths` is likewise `Number.isInteger`-guarded first.
  'apps/erp/src/app/expenses/actions.ts::parseExpenseForm::lineCount > 50': 'not-a-column-value',
  'packages/domain/src/fixed-assets/capitalize.ts::runCreateAsset::typedLife < 1': 'not-a-column-value',
  'packages/domain/src/fixed-assets/capitalize.ts::runCreateAsset::typedLife > MAX_USEFUL_LIFE_MONTHS': 'not-a-column-value',
  'packages/domain/src/fixed-assets/capitalize.ts::runCreateAsset::usefulLifeMonths < 1': 'not-a-column-value',
  'apps/erp/src/app/fixed-assets/page.tsx::FixedAssetsPage::Number(sp.failed ?? \'0\') > 0': 'display-only',
  'packages/domain/src/stores/service.ts::setStoreOpeningDate::input.openingDate > firstTrading': 'not-a-column-value',
  'packages/domain/src/stores/service.ts::setStoreOpeningDate::input.openingDate > asset.acquiredOn!': 'not-a-column-value',
  'packages/db/src/repo/stores.ts::isPreOpening::openingDate > today': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/holes.ts::splitIntoMonthPieces::cursor <= endsOn': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/holes.ts::splitIntoMonthPieces::monthLast < endsOn': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/holes.ts::classifyHoles::piece.endsOn < closeFrontierStartsOn': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/holes.ts::createMissingClosedPeriod::p.startsOn <= input.endsOn': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/holes.ts::createMissingClosedPeriod::p.endsOn >= input.startsOn': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/index.ts::refuseOnMissingEarlierPeriod::p.startsOn >= gap.startsOn': 'not-a-column-value',
  'packages/domain/src/fiscal-periods/index.ts::refuseOnMissingEarlierPeriod::p.endsOn <= gap.endsOn': 'not-a-column-value',
  'packages/domain/src/missed-months/index.ts::monthOverlapsOpenPeriod::r.startsOn <= endsOn': 'not-a-column-value',
  'packages/domain/src/missed-months/index.ts::monthOverlapsOpenPeriod::r.endsOn >= startsOn': 'not-a-column-value',
  'packages/domain/src/missed-months/index.ts::bookMissedMonth::belongsToPeriod < earliestMonth': 'not-a-column-value',
  'packages/domain/src/missed-months/index.ts::bookMissedMonth::belongsToPeriod < bookOnMonth': 'not-a-column-value',
  'packages/domain/src/missed-months/index.ts::bookMissedMonth::bookOn > today': 'not-a-column-value',
  'packages/domain/src/missed-months/index.ts::missedMonths::p.period < earliestMonth': 'not-a-column-value',
  'packages/domain/src/people/index.ts::endEmployment::input.endedOn < existing.startedOn': 'not-a-column-value',
  'packages/domain/src/scheduler/index.ts::runBudgetReissue::elapsedDays < windowDays': 'not-a-column-value',
  'packages/domain/src/scheduler/index.ts::runBudgetReissue::key <= currentPeriodKey': 'not-a-column-value',
  'packages/domain/src/scheduler/index.ts::runFiscalPeriodSeedForOrg::p.yearMonth >= mLabel': 'not-a-column-value',
  'packages/domain/src/scheduler/index.ts::runFiscalPeriodSeedForOrg::p.yearMonth < mLabel': 'not-a-column-value',
};

const keyOf = (c: Pick<Comparison, 'file' | 'fn' | 'text'>) => `${c.file}::${c.fn}::${c.text}`;

// The type-checked program is built ONCE, at collection time, because the per-module `it.each` cases are derived from it.
const census = loadCensus();
const writes = findWrites(census);
const rawSql = findRawSqlWriters(census);
const raw = rawSql.writers;
const comparisons = findComparisons(census);
const forgeries = findForgeries(census);
const assertions = countTypeAssertions(census);

const describePair = (p: (typeof writes.pairs)[number]) => `${p.file}:${p.line} ${p.fn} -> ${p.table}.${p.key} (${p.shape}) is ${p.status}${p.text ? ` — ${p.text}` : ''}`;

/** Every domain module: each directory AND each loose `.ts` file (the loose-file case), plus any module the comparison scan found outside the domain. */
const domainSrc = join(ROOT, 'packages', 'domain', 'src');
const domainEntries = readdirSync(domainSrc)
  .filter((d) => statSync(join(domainSrc, d)).isDirectory() || /\.tsx?$/.test(d))
  .map((d) => d.replace(/\.tsx?$/, ''));
const comparisonModules = [...new Set([...domainEntries, ...byModule(comparisons).keys()])].sort();

describe('G1 — every write to a constrained column carries a same-shape `__decimal` brand', () => {
  it('floor: the scan found constrained columns, write sites and (site × column) pairs', () => {
    expect(constrainedColumns().length, 'no constrained numeric column was derived').toBeGreaterThan(0);
    expect(writes.sites.length, 'an empty write scan cannot pass').toBeGreaterThan(0);
    expect(writes.pairs.length).toBeGreaterThan(0);
  });

  it('sentinels (each specific, none OR-ed): the money-accounts overdraftLimit writer, the BULK trade-order-line insert, the production remainingQuantity SQL value, repo/items.ts item_pricing', () => {
    expect(writes.pairs.some((p) => p.fn === 'renameMoneyAccount' && p.table === 'money_accounts' && p.key === 'overdraftLimit'), 'sentinel: renameMoneyAccount -> overdraftLimit').toBe(true);
    expect(writes.pairs.some((p) => p.file === 'packages/db/src/repo/trade.ts' && p.fn === 'insertLines' && p.table === 'trade_order_lines' && p.key === 'quantity'), 'sentinel: the bulk repo/trade.ts insertLines quantity (a bulk insert read as nothing)').toBe(true);
    expect(writes.sites.some((s) => s.file === 'packages/db/src/repo/trade.ts' && s.fn === 'insertLines' && s.bulk), 'the trade insertLines site is not marked bulk').toBe(true);
    expect(writes.pairs.some((p) => p.file.startsWith('packages/domain/src/production/') && p.table === 'stock_layers' && p.key === 'remainingQuantity'), 'sentinel: production/index.ts remainingQuantity SQL value').toBe(true);
    expect(raw.some((r) => r.file === 'packages/db/src/repo/items.ts' && r.fn === 'upsertItemPricing' && r.table === 'item_pricing'), 'sentinel: repo/items.ts `insert into item_pricing`').toBe(true);
  });

  const caseModules = [...byModule(writes.pairs).keys()];
  it.each(caseModules)('module %s: every constrained argument property is branded with the column shape, with no cast and no any/unknown', (module) => {
    const bad = writes.pairs.filter((p) => p.module === module && p.status !== 'ok');
    expect(bad.map(describePair), `${bad.length} unbranded write(s) in ${module}`).toEqual([]);
  });

  it('an SQL-typed value assigned to a constrained column interpolates only a same-shape brand, a column reference or a literal (an EXEMPT reason alone does not pass it)', () => {
    const bad = writes.pairs.filter((p) => p.status === 'sql-unbranded');
    expect(bad.map(describePair)).toEqual([]);
  });

  it('raw-SQL writers: every one is registered by function name or exempt by file::function (a new one fails closed)', () => {
    const unregistered = raw.filter((r) => !RAW_SQL_WRITERS.has(r.fn) && RAW_SQL_EXEMPT[`${r.file}::${r.fn}`] === undefined);
    expect(unregistered.map((r) => `${r.file}:${r.line} ${r.fn} (${r.verb} ${r.table}) is not registered`), 'a raw-SQL writer is not registered').toEqual([]);
    expect([...RAW_SQL_WRITERS].filter((fn) => !raw.some((r) => r.fn === fn)), 'RAW_SQL_WRITERS names a function that no longer writes raw SQL').toEqual([]);
    expect(Object.keys(RAW_SQL_EXEMPT).filter((k) => !raw.some((r) => `${r.file}::${r.fn}` === k)), 'a RAW_SQL_EXEMPT entry no longer writes raw SQL').toEqual([]);
  });

  it('the dev-seed exemption holds only while its file still refuses a non-_dev database', () => {
    for (const [key, { mustContain }] of Object.entries(RAW_SQL_EXEMPT)) {
      const f = key.split('::')[0]!;
      expect(readFileSync(join(ROOT, f), 'utf8'), `${f} no longer contains ${mustContain} — the dev-only exemption is void`).toContain(mustContain);
    }
  });

  it("raw-SQL parameters: every numeric parameter bound to a constrained column is branded with that column's shape (judged by brand, not by name)", () => {
    const bad = raw.filter((r) => r.unbranded.length > 0 && RAW_SQL_EXEMPT[`${r.file}::${r.fn}`] === undefined);
    expect(bad.map((r) => `${r.file}:${r.line} ${r.fn} (${r.verb} ${r.table}) binds unbranded ${r.unbranded.join(', ')}`)).toEqual([]);
  });

  it('fail-closed: the number of write targets / raw statements the checker cannot name does not exceed the recorded ceiling', () => {
    expect(writes.unresolved.map((u) => `${u.file}:${u.line} ${u.fn} ${u.why} ${u.text}`), `more than ${UNRESOLVED_WRITES_CEILING} unresolved write target(s)`).toHaveLength(UNRESOLVED_WRITES_CEILING);
    const got = [...new Set(rawSql.unresolved.map((u) => `${u.file}::${u.fn}::${u.why}`))].sort();
    expect(got, 'the unresolved raw-SQL set changed (a new statement, or a stale entry): enumerate it with its reason, or fix the code').toEqual(Object.keys(UNRESOLVED_RAW_SQL).sort());
  });

  it('uncompiled scripts (*.mjs / *.js) write no constrained table (they are invisible to the type checker, so they are read as text)', () => {
    expect(rawScriptWriters()).toEqual([]);
  });
});

describe('G2 — relational comparisons on a value derived from a string equal the EXEMPT set exactly', () => {
  // ⭐ A sentinel that names a site the repair will fix must not assert the site is FLAGGED (S2/S3 rewrite it to compare*/isZero and it stops flagging — that is the
  // guard working). It asserts the scanner VISITED the file and saw relational operators in it: a file dropped from the program, or a scan that stopped looking at
  // relational expressions, fails; a repaired comparison does not.
  const RELATIONAL = new Set([ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken]);
  const relationalOperatorsIn = (file: string): number | null => {
    const sf = loadCensus().files.find((x) => x.fileName.replaceAll('\\', '/').endsWith(`/${file}`));
    if (!sf) return null;
    let n = 0;
    const walk = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && RELATIONAL.has(node.operatorToken.kind)) n += 1;
      node.forEachChild(walk);
    };
    walk(sf);
    return n;
  };

  it('floor: the scan found comparisons, and it VISITED cash-requests/index.ts and payroll/periods.ts and saw relational operators in both (sentinels)', () => {
    expect(comparisons.length, 'an empty comparison scan cannot pass').toBeGreaterThan(0);
    for (const file of ['packages/domain/src/cash-requests/index.ts', 'packages/domain/src/payroll/periods.ts']) {
      const n = relationalOperatorsIn(file);
      expect(n, `sentinel: the scanner did not visit ${file}`).not.toBeNull();
      expect(n, `sentinel: ${file} has no relational operators for the scanner to judge`).toBeGreaterThan(0);
    }
    // payroll/periods.ts is a stable EXEMPT ISO-date ordering site, so it must ALSO still be flagged — proves the scanner judges, not only visits.
    expect(comparisons.some((c) => c.file === 'packages/domain/src/payroll/periods.ts'), 'sentinel: payroll/periods.ts is flagged').toBe(true);
  });

  it.each(comparisonModules)('module %s: every flagged comparison is rewritten to compare*/isZero on branded values or is EXEMPT with a reason from the closed list', (mod) => {
    const flagged = comparisons.filter((c) => c.module === mod);
    const unexempt = flagged.filter((c) => EXEMPT[keyOf(c)] === undefined);
    expect(unexempt.map((c) => `${c.file}:${c.line} ${c.fn}: ${c.text} (${c.reason})`), `${unexempt.length} NaN-blind comparison(s) in ${mod}`).toEqual([]);
  });

  it('overall: every flagged comparison anywhere in scope (domain, db, apps/erp) is EXEMPT — no module can slip between the per-module cases', () => {
    const unexempt = comparisons.filter((c) => EXEMPT[keyOf(c)] === undefined);
    expect(unexempt.map((c) => `${c.file}:${c.line} ${c.fn}: ${c.text}`)).toEqual([]);
  });

  it('no EXEMPT entry is stale or has a reason outside the closed list (the flagged set equals the EXEMPT set — there is no ceiling that could hide a swap)', () => {
    const flaggedKeys = new Set(comparisons.map(keyOf));
    expect(Object.keys(EXEMPT).filter((k) => !flaggedKeys.has(k)), 'stale EXEMPT entries').toEqual([]);
    expect(Object.entries(EXEMPT).filter(([, r]) => !(EXEMPT_REASONS as readonly string[]).includes(r)), 'a reason outside the closed list').toEqual([]);
  });
});

describe('G3 — no type assertion outside packages/core/src targets a brand or a container of one', () => {
  it('floor: the forgery scan looked at type assertions at all', () => {
    expect(assertions, 'an empty assertion scan cannot pass').toBeGreaterThan(0);
  });

  const forgeryModules = [...new Set(forgeries.map((f) => f.module))].sort();
  it.each(forgeryModules)('module %s: no `as Money` / `as Quantity` / `as Decimal<…>` / `as Money[]` (any alias or container)', (module) => {
    const bad = forgeries.filter((f) => f.module === module);
    expect(bad.map((f) => `${f.file}:${f.line} ${f.fn}: ${f.text}`), `${bad.length} brand forgery(ies) in ${module}`).toEqual([]);
  });
});

describe('G4 — every numeric column has a finite check (green today; its mutant is in t371-census-selftest)', () => {
  it('no PgNumeric column lacks a *_finite_check of the real form', () => {
    expect(constrainedColumns().length, 'an empty column scan cannot pass').toBeGreaterThan(0);
    expect(finiteCheckGaps(constrainedColumns()).map((c) => `${c.table}.${c.sqlName}`)).toEqual([]);
  });
});
