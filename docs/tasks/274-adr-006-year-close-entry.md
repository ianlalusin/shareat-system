# T-274 — ADR-006's year-close journal entry: the one posting a year-end actually makes

> **Status: ✅ COMPLETE — shipped 2026-09-12, `8381413`, lane B. No migration needed.** ⚠️ **Not reachable from any screen** — a deliberate second slice, registered in `tests/unit/domain-actions-have-callers.test.ts`’s EXEMPT list so it is a stated gap, not a silent one. ⭐ Review caught a bug every test missed: closing lines were built from an account’s RAW totals rather than its NET, which the database rejects on any year where one account has activity on both sides. DEF-305 was filed out of this task’s spec phase.

## Why now, and why it was deliberately left out of T-264

`packages/domain/src/fiscal-periods/index.ts:6-9` names this work in its own header and says in
terms that it is **not** built there:

> ⛔ **This is the generic lock for ANY period — month or year alike.** The year-close journal
> entry ADR-006 describes (one entry via `postEntry`, dated the following Jan 1, zeroing
> income/expense into 3300, distinct `source_type`) is deliberately NOT built here — it is
> unsliced follow-on work, ruled explicitly rather than half-built into a December special case.

⚠️ **The first real year-close is Dec 2027** (ADR-006 §intro), so nothing is on fire. ADR-006's own
reason for designing it early stands and is the reason to build it now: *"a close mechanism is very
hard to retrofit once the ledger holds a year of data."*

⭐ **It was kept out of the 2026-09-12 cycle for a concrete reason, now gone:** it touches the same
ledger code T-264 slice 3 was editing. That work is committed (`018af6f`), so the conflict no longer
exists.

## What ADR-006 fixes, and therefore what the spec may NOT re-argue

| Decided | Where |
|---|---|
| Exactly **one** journal entry, posted by the **existing `postEntry`** | ADR-006 §"Year close does that" |
| Every income and expense balance for the year zeroes into **3300 Retained earnings** | same |
| Dated the **first day of the following year**, matching ADR-005's opening-balance convention | same |
| It is an **ordinary posted entry** — balanced, immutable, corrected only by `reverseEntry` | same |
| ⛔ **No closing-voucher entity.** The submit/cancel/amend lifecycle already exists for every entry | same |
| A **distinct `source_type`** (e.g. `year_close`), and reporting is written knowing it — a date-range P&L excludes it, a balance-sheet-as-of includes it. ⚠️ **A requirement of the ADR, not an implementation detail** | ADR-006 §"must be distinguishable in queries" |
| Periods close in order; December closes first, then the year close runs | ADR-006 §Gates, `fiscal-periods/index.ts:79-83` |

## Out of scope — hard

- ⛔ **Reopening a closed year.** Not built, not to be built (ADR-006 §"Reopening — NOT BUILT",
  bible §13 row 193). Corrections are prior-period adjustments via `reverseEntry`, or the narrow
  T-264 slice 3 exemption.
- ⛔ **Touching T-264 slice 3's override.** It is complete and shipped; this task consumes it.
- ⛔ **The scheduler, `docs/ops/`, `packages/domain/src/files/`, `packages/domain/src/scheduler/`,
  `packages/db/src/repo/files.ts`, `packages/db/schema/scheduler.ts`, `tests/unit/scheduler-*.ts`
  and any migration** — lane A holds all of those this cycle (T-272).

See `docs/decisions/ADR-006-period-close.md`; `docs/decisions/ADR-005-*`;
`packages/domain/src/fiscal-periods/index.ts`; `packages/db/src/repo/reports.ts:71`
(`getTrialBalance`); `PROJECT_BIBLE.md` §13 rows 193, 196.

---

# SPEC — Lane B, 2026-09-12. Answers first, contract second, per the briefing's own instruction.

**Goal:** implement `closeYear` — the one journal entry ADR-006 describes, computed from a real
year's ledger activity and posted through the existing `postEntry`, plus the `closed -> locked`
transition ADR-006 §7.5 requires alongside it.

## Answer to Q1 — does January's period exist when the year-close runs, and what does `postEntry` do if not?

**`postEntry` refuses cleanly. It does not auto-create and it does not do anything worse.**
`journalRepo.findPeriodForDate` (`packages/db/src/repo/journal.ts:61-81`) is a plain `SELECT …
WHERE starts_on <= date AND ends_on >= date`; if nothing matches, `post-entry.ts:142-147` throws
`postEntry: no fiscal period covers entry date ${entryDate} for org ${orgId}` before touching the
database. That is the honest, actionable half of the answer.

**The finding worth more than this task, as predicted:** nothing in this codebase ever creates a
`fiscal_periods` row on an ongoing basis. The only writer, anywhere, is `seedCalendarMonths`
(`packages/db/src/repo/fiscal-periods.ts:75`), called from exactly two places:

1. `createOrganization` (`packages/domain/src/organizations/index.ts:169`) — **once**, at bootstrap,
   seeding 12 calendar months forward from whatever month the org is created in
   (`fiscalPeriodSeedWindow`, same file, line 113).
2. `scripts/backfill-fiscal-periods.ts` — a **manual**, `--confirm`-gated CLI script. Nobody and
   nothing schedules it.

`packages/domain/src/scheduler/index.ts` (the month-end sweep, the attendance sweep, the Firestore
relay, the wastage backstop — every recurring job this codebase has) contains **zero** references to
`fiscal_periods` or `fiscalPeriodsRepo`. `fiscalPeriodSeedWindow`'s own doc comment names the cliff
explicitly: 12 months from a 2026 bootstrap "STOPS covering [2027-01-01] from 2027-02 onward" — and
that comment is about the *cutover* date, seeded once. Nobody owns keeping coverage rolling forward
after that.

**So ADR-006's sequence — "close December first, then run the year close" on 15 January — silently
assumes January's period already exists, and nothing in the code guarantees it.** Whether it does,
by the first real year-close (Dec 2027, ADR-006 intro), depends entirely on whether someone has
re-run `backfill-fiscal-periods --confirm` recently enough. This is real and load-bearing, but it is
**not a defect in ADR-006's accounting decision** — it's a missing operational owner for a mechanism
ADR-006 never had to specify. I have not built anything to close it; see "One decision needing your
ruling" below for the two ways to handle it and my recommendation.

## Answer to Q2 — how many reporting queries filter on `source_type`, honestly?

**The premise is wrong, and it's wrong in the direction of "already done," not "already broken."**
`packages/db/src/repo/reports.ts` has six exported functions. Four filter on `source_type`, with
exactly the include/exclude defaults ADR-006 requires; the other two don't query the ledger by
`source_type` at all, for reasons that hold up:

| Function | Line | Default | Matches ADR-006? |
|---|---|---|---|
| `getTrialBalance` | 71 | `includeYearClose ?? true` | ✅ balance-sheet-style → includes |
| `getIncomeStatementLines` | 139 | `includeYearClose ?? false` | ✅ date-range P&L → excludes |
| `getBalanceSheetLines` | 201 | `includeYearClose ?? true` | ✅ as-of → includes |
| `getAccountEntries` (drill-down) | 255 | `includeYearClose ?? true`, excludable | ✅ |
| `getSalesByPeriod` | 318 | filters `source_type = 'sale'` (raw SQL, line 337) | N/A — never touches year-close rows by construction |
| `getSalesByChannelAndMode` | 374 | queries `sales_days`/`sales_day_channels`, no `journal_lines` join at all | N/A — not a ledger query |

This isn't speculative plumbing either. `packages/db/schema/views.ts:33,68-69` exposes `sourceType`
as a column on all three reporting views **specifically so the year-close entry can be excluded** —
written before this task existed. `docs/POSTING-PATTERNS.md:1142-1165` already documents the exact
worked example (`year_close.annual`: 4100 debit 20,000.00 / 6900 credit 8,000.00 / 3300 credit
12,000.00, dated 2028-01-01). `tests/worked-examples/fixtures.ts:1241-1269` encodes that fixture, and
`tests/integration/posting-patterns.test.ts:381-415` ("invariant 11") already posts it — generically,
straight through `postEntry`, **not through any dedicated domain function** — and asserts all three
ADR-006 requirements pass today: `source_type = 'year_close'` sticks; a 2027 date-range P&L excludes
it; a trial-balance-as-of through 2028 includes it in 3300 at exactly `12000.00`; passing
`includeYearClose: false` explicitly drops it back to zero.

**What this actually means for T-274:** the reporting requirement ADR-006 states as a REQUIREMENT is
already built and already proven end-to-end (shipped in T-108/T-110, before this task was reserved).
**Nothing in `reports.ts` needs to change.** What's still missing is narrower than the orchestrator's
question implied: nobody has written the function that computes a *real* year's P&L and constructs
the balanced closing lines from it — today that shape only exists as a hand-typed fixture in a test.
That is the actual, and only, gap. See the contract below.

## Answer to Q3 — does a corrected year-close entry need T-264 slice 3's override?

**No. `reverseEntry`'s existing path already covers it, and covers `locked` too, not only `closed`.**

`reverseEntry` (`packages/domain/src/ledger/reverse-entry.ts:143-159`) branches on exactly one thing:
whether the ORIGINAL entry's period is currently `open`. If not — and the code never distinguishes
`closed` from `locked` here, it's a single `else` — the caller must supply an explicit `reversalDate`
that resolves to a period that IS currently open; the memo gets `[prior period] ` prefixed; and the
reversal posts through the ordinary `postEntry` call, with no `periodOverride` anywhere in the path.

This works for `locked`, not just `closed`, because of how migration `0003`'s trigger is actually
written, not because anyone extended it for this task. `journal_entries_check_period_open`
(`0003:214-238`) returns immediately — without even looking up `fiscal_periods` — whenever
`NEW.period_id IS NOT DISTINCT FROM OLD.period_id AND NOT (OLD.status='draft' AND NEW.status='posted')`.
A reversal's effect on the ORIGINAL entry is exactly `status: posted -> reversed` with the same
`period_id` — that condition is true, so the original's period status (open, closed, OR locked) never
re-enters the check for that transition. The only period-open check that actually fires is on the
**new** reversal entry, dated `reversalDate`, in whatever period that resolves to — which, by the
function's own precondition, must be open.

So correcting a mistake in the year-close entry needs no override and no new code: it's the same,
already-shipped, already-tested path (`reverseEntry` with an explicit `reversalDate`) every other
closed-or-locked-period correction uses. T-264 slice 3's override solves a different problem
(re-posting a corrected ORIGINAL into the period it actually belongs to); a reversal never needs it
because it always targets a currently-open period instead. T-264's own spec already says this in
terms (`docs/tasks/264-def-284-fiscal-period-lock.md:97`): *"Reversals of entries in already-closed
periods are legitimate and already handled by migration 0003 lines 202-208. Your override must not
disturb or duplicate that path."*

**One nuance traced through, not assumed:** `reverseEntry` copies `sourceType: original.sourceType`
(`reverse-entry.ts:190`) onto the reversal — so a reversed year-close entry's reversal ALSO carries
`source_type = 'year_close'`. Traced against Q2's table: `getTrialBalance`/`getBalanceSheetLines`
default to *including* `year_close` rows, so the original's 3300 credit and the reversal's 3300 debit
correctly net to zero in any as-of view that includes both. `getIncomeStatementLines` defaults to
*excluding* `year_close` rows from any date-range P&L, so neither the original nor its reversal ever
leaks into one either way. It self-consistently nets out correctly with zero special-casing required.

---

## The contract for `closeYear` — what T-274 actually builds

One new function, `closeYear`, in a new file `packages/domain/src/fiscal-periods/close-year.ts`
(exported from `packages/domain/src/fiscal-periods/index.ts` alongside `closePeriod`), reusing
existing, already-tested machinery wherever one exists rather than re-deriving it:

```ts
export interface CloseYearInput {
  orgId: string;
  /** The calendar year being closed, e.g. 2027. The entry posts 2027-01-01 of the FOLLOWING year. */
  year: number;
}
export interface CloseYearResult {
  entryId: string;
  created: boolean;       // false = idempotent replay, nothing new written
  periodsLocked: number;  // 0 on a replay where locking already happened
}
export async function closeYear(tx: Tx, actor: Actor, input: CloseYearInput): Promise<CloseYearResult>
```

**Gate order** (cheapest and least ambiguous first, matching `closePeriod`'s own documented
discipline at `fiscal-periods/index.ts:41-49`):

1. `authorize(tx, actor, 'close_period', {})` — **the same capability `closePeriod` already checks,
   reused, not a new one.** ADR-006 §7.4 says this in terms: *"Since reopening is never permitted,
   the grant covers closing and the year-close posting only."* No new capability, no migration.
2. `fiscalPeriodsRepo.hasEarlierOpenPeriod(tx, orgId, `${year + 1}-01`)` — **reused as-is, no new
   query.** It already means exactly the right thing here: "is any period starting before 1 January
   of `year + 1` still open" is precisely "has every month through December of `year` been closed."
   Refuse with a message naming that December (or an earlier month) is still open if true.
3. Compute the year's income/expense activity via **`reportsRepo.getIncomeStatementLines(tx, {orgId,
   fromDate: '`year`-01-01', toDate: '`year`-12-31', includeYearClose: false})`** — reused as-is, no
   new SQL. `storeId` is omitted (every store combined): ADR-006 says "every income and expense
   balance for the year", never per-store. **`includeYearClose: false` is passed EXPLICITLY here and
   is LOAD-BEARING, never left to the default — corrected after system32-85 caught my original
   reasoning as wrong.** A year-close entry does NOT only touch 3300: zeroing income/expense INTO
   3300 is its entire purpose, so (per the worked example quoted above — `4100 debit`, `6900
   credit`) two of its three lines land squarely inside `v_income_statement`. Closing year `N` posts
   an entry dated `N+1`-01-01 — the FIRST DAY of the range this same step queries when someone later
   closes year `N+1`. Left on the `?? false` default (`reports.ts:143`), the outcome is accidentally
   correct today only because nobody has changed that default; passed explicitly, it stays correct
   regardless. Without it, `closeYear(N+1)` would absorb year `N`'s own closing entry into `N+1`'s
   totals and credit 3300 for that income a second time — a compounding retained-earnings error that
   still balances and looks like a good year. See test 10.
4. **If every returned row has `debitTotal` and `creditTotal` both `'0.00'`, refuse** — "nothing to
   close for `year`". A balanced entry needs at least two non-zero lines; there is no such thing as a
   legitimate empty year-close.
5. Build one closing line per account with nonzero activity: `{ accountCode: row.accountCode, debit:
   row.creditTotal, credit: row.debitTotal }` — the same debit/credit-swap mirror `reverseEntry`
   already uses (`reverse-entry.ts:177-181`), aggregated to one line per account instead of one per
   original entry, because these are `getIncomeStatementLines`' own period TOTALS, not a
   reconstruction of individual postings.
6. **The 3300 plug, computed, not assumed:** sum of all closing lines' credit minus sum of all
   closing lines' debit. If positive (net income for the year), add one more line crediting 3300 that
   amount. If negative (net loss), add one more line debiting 3300 `|amount|`. **If exactly zero,
   add NO 3300 line at all** — the closing lines already balance each other in that case, and
   `journal_lines_exactly_one_side_check` (migration `0003:74-76`) rejects a line with both `debit`
   and `credit` at `'0.00'`, so a zero-amount plug line would not just be redundant, it would be
   illegal.
7. `postEntry(tx, { orgId, entryDate: `${year + 1}-01-01`, sourceType: 'year_close', sourceId:
   `${orgId}:${year}`, idempotencyKey: `year_close:${orgId}:${year}`, memo: `Year close ${year}`,
   postedBy: actor.personId, lines })` — **passed the SAME `tx`** `closeYear` was given, so this and
   step 8 commit or roll back together.
8. **Always** call a new `fiscalPeriodsRepo.lockYearPeriods(tx, orgId, year)` — even when step 7
   returned `created: false` on an idempotent replay. It is itself idempotent (`UPDATE fiscal_periods
   SET status = 'locked' … WHERE … AND status = 'closed'` — a bare guard, not a pre-read, matching
   `closePeriod`'s own race-safety idiom at `fiscal-periods.ts:137-157`), so re-running it on a replay
   is a safe no-op, and running it unconditionally means a prior attempt that posted the entry but
   crashed before locking self-heals on retry rather than leaving the year permanently un-locked.
   Implements ADR-006 §7.5: *"`closed` → `locked`. Automatic once the following year's close posts
   successfully."* **This has no implementation anywhere in the codebase today** — `locked` is a
   valid schema enum value (`packages/db/schema/fiscal-periods.ts:22`) that nothing has ever written.

   ⚠️ **Invariant, stated explicitly because it is a real consequence, not an implementation detail:
   shipping `closeYear` permanently removes T-264 slice 3's admin override from every month of the
   closed year.** `post-entry.ts:158` refuses `periodOverride` unconditionally for a `locked` period
   — "locked is entirely out of the override's reach" — and step 8 is what makes a month `locked` in
   the first place. **This is intended, not a regression**: bible row 193's scope reasoning is that a
   locked period's balances have already been consumed by a later year's close, so letting a further
   entry in would silently invalidate the closing entry that already consumed them. Named here so a
   future reader who notices the override stops reaching, say, December once the year closes does
   not read it as something `closeYear` broke.

### One decision needing your ruling before I build — not mine to make silently

Given Q1's finding, should step 7 (`postEntry`) be allowed to fail with its existing "no fiscal period
covers entry date" error when the target January simply hasn't been seeded yet, or should `closeYear`
defensively call `fiscalPeriodsRepo.seedCalendarMonths(tx, orgId, { startYear: year+1, startMonth: 1,
months: 1 })` immediately before step 7, so the routine is self-sufficient?

**My recommendation: let it fail with the existing error.** `seedCalendarMonths` is idempotent and
cheap to call, but a year-close routine silently creating fiscal-period rows as a side effect is a
bigger behavior change than ADR-006 asked for, and it blurs who is responsible for period coverage —
the same "auto-created is auto-opened" reasoning T-264 slice 1 used to reject lazy period creation
inside `postEntry` itself (`docs/tasks/264-def-284-fiscal-period-lock.md:179`) applies here by the
same logic, one level up. The existing error is already clear and actionable. I'd log the real gap —
nothing keeps `fiscal_periods` coverage rolling forward automatically — as a follow-up finding for
the ops runbook or a future scheduler task, out of scope here. **Tell me if you want the defensive
seed instead; it's a one-line addition if so.**

## Files touched

- `packages/domain/src/fiscal-periods/close-year.ts` — new, `closeYear`.
- `packages/domain/src/fiscal-periods/index.ts` — export it; update its header comment (currently
  says this work is "deliberately NOT built here" — true of `closePeriod`, now stale once this lands).
- `packages/db/src/repo/fiscal-periods.ts` — add `lockYearPeriods`. No other change; `closeYear`
  reuses `hasEarlierOpenPeriod` as-is.
- `packages/domain/tests/integration/year-close.test.ts` — new. `packages/domain/tests/integration/
  fiscal-period-close.test.ts` — one-line fix to its own header comment (same staleness as above),
  no test changes.
- No change to `packages/db/src/repo/reports.ts` (Q2) or `packages/db/schema/`. No migration.

## Tests (written first, watched failing for the right reason before implementation)

1. Happy path: a year with real 2027 activity closes into 2028-01-01, one entry, correct lines, 3300
   correct, `getIncomeStatementLines` over 2027 still shows the original activity, `getTrialBalance`
   through 2028 shows 3300 at the right figure — same shape `posting-patterns.test.ts` invariant 11
   already proves for the hand-typed fixture, but here proving the COMPUTED path produces it.
2. Net-loss year: 3300 gets debited, not credited.
3. Exact-zero year: no 3300 line is added, entry still balances (two-plus real accounts net to zero
   against each other) — or, if truly no activity at all, refused per gate 4.
4. Gate 2 watched failing: an earlier month still `open` refuses, naming it.
5. Gate 1 watched failing: a `staff` actor is refused by `authorize`.
6. Idempotency: calling `closeYear` twice returns `created: false` the second time and does not
   double-post; `periodsLocked` still reflects real state (0 if already locked from the first call).
7. Locking: every month of the closed year flips `closed -> locked`; a period NOT in that year, or
   not yet `closed`, is untouched.
8. Missing-January precondition (Q1): with no `${year+1}-01` period seeded, `closeYear` surfaces
   `postEntry`'s existing error rather than hanging or silently doing something else — proves the
   recommendation above rather than asserting it.
9. Reversal, reusing existing machinery: `reverseEntry` on the posted year-close entry, with an
   explicit `reversalDate` in a currently-open period, succeeds with no override — confirms Q3 against
   the real function, not just by reading it.
10. **Watched failing first, per system32-85's instruction.** Close year `N` with real activity, then
    close year `N+1` with its own real activity. Assert `N+1`'s closing entry's lines do not contain
    `N`'s closing amounts, and that 3300's balance after both closes is the SUM of both years' net
    income, not one year double-counted. Prove the test actually catches the bug it is named for:
    temporarily pass `includeYearClose: true` in step 3, confirm 3300 comes out wrong in exactly the
    over-counted way this change describes, then revert to `includeYearClose: false` and confirm it
    passes. Report both runs' actual numbers in the READY message, not just "watched it fail."

## Out of scope (restating the briefing's, plus what this investigation adds)

- Reopening a closed year; touching T-264 slice 3's override; the scheduler, files, migrations (lane
  A's, unchanged).
- Any screen or Server Action surfacing this — `apps/` is a second slice per the briefing.
- **Building a mechanism to keep `fiscal_periods` coverage rolling forward automatically** (Q1's
  finding). Real, but a different task with a different owner than this one.
- Changing `reports.ts` or the views — Q2 found nothing to change there.

## Done when

typecheck clean · unit green · integration green against `shareat_test_laneb` (real numbers,
reported) · self-reviewed · the three questions above answered in this document, not only in chat ·
a `FOR IAN` block in the READY report per RULES §3.5.
