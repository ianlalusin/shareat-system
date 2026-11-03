# Goldfish Review Report (Stage 8, Intermediate Zoom Out)

**Target:** `docs/designs/channel-settlement-upload.md` (lines 1-563)
**Reviewer lens:** `zoom-out`
**Earlier report:** `zoom_out_report.md` (Stage 5)

Verdict: the Risks table, approval order (decision 9), separation of duties (decision 10) and the interest default (decision 11) are cheap and reuse existing parts. The month-close guard (Component M) is the weak point. It sits in the wrong layer, its deferral table has the wrong owner, and its permission does not exist as described.

Counts: 0 Blocker, 3 Major, 5 Nit.

## Prioritized Findings

### 1. The close guard bypasses the findings feed - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** 259, 529-531 (M1), 535-537 (M3), 99, 72
* **Discrepancy Description:** Close readiness is already a filter over the findings feed: "the close checker and the findings feed are ONE machine" (`packages/domain/src/findings/index.ts:139-142, 345-349`). `closeBlockers` already takes its hard blockers from `closeReadiness` (`packages/domain/src/fiscal-periods/index.ts:64`). Component M adds a separate check inside `closeBlockers`, which makes a second rule engine. `/findings` would not show the blocker until someone tries to close, so M3 must build its own display.
* **Rationale & Recommendation:** Add a period-scoped hard detector (for example `channelReceivableUnsettled`) to `findingsRepo`, next to the existing detectors (`findings/index.ts:149-252`). Have it read account 1220 per channel by extending `outstandingFor` with an as-of date (`repo/channel-settlements.ts:168-185`), not a new query in `repo/fiscal-periods.ts` (M2, 532-534). The findings page then shows it for free and M3 only needs the "defer" action. An acknowledged hard finding still blocks close on purpose (`findings/index.ts:356-357`), so deferral is a deliberate exception. Say so in the design. Build it as the detector excluding (or downgrading to soft) a deferred channel and period. Do not reuse `acknowledgeFinding`, which would weaken that rule for every finding.

### 2. The deferral table lives in the intake feature, so the dependency runs the wrong way - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** 407 (`settlement_deferrals` in migration 0213), 532-534 (M2), 446, 449, 257
* **Discrepancy Description:** The guard covers every channel not remitted daily, including settlements typed by hand through T-150 that never pass an upload. Period close would read a table owned by `settlement-intake`, so a core module depends on a feature module. Items 14 and 15 (446, 449) register "four staging tables and the loan legs table" ("five new tables") and omit `settlement_deferrals`. The RLS registry and cutover guards would fail the build. The deferral record (257) stores no amount, so a receivable added after the deferral but before close is covered silently.
* **Rationale & Recommendation:** Put the deferral table and its repo with period close (fiscal-periods or findings) or at least with `channel-settlements`, which owns 1220. Add it to the table-registration items and the count. Store the deferred amount and treat the deferral as void if the balance differs at close.

### 3. "Existing admin period-close permission" does not exist - Severity: Major
* **Reviewer Lens:** `zoom-out`
* **Affected Scope:** 245 (Component J), 257, 99
* **Discrepancy Description:** `close_period` is also granted to managers (`packages/auth/src/capabilities.ts:34, 192-193`; store-scoped for managers, noted at 567). The codebase already refused this widening once: `override_period_lock` was made admin-only, "NOT close_period, deliberately" (`capabilities.ts:188-198`), and `create_missing_period` follows the same pattern (200-204). Reusing `close_period` lets managers defer, contradicting decision 8 ("an admin").
* **Rationale & Recommendation:** Reuse an existing admin-only capability that touches closed books (`override_period_lock` or `create_missing_period`), or add one. Name which.

### 4. Store-code uniqueness disagrees between component and migration - Severity: Nit
* **Affected Scope:** 172 vs 407
* **Discrepancy Description:** Component A: unique "across all channels, active or not". Migration item 1: unique index "among active channels".
* **Rationale & Recommendation:** Pick A's single rule; it is simpler.

### 5. Old loan columns may survive as the "first leg" - Severity: Nit
* **Affected Scope:** 213, 410, 419
* **Discrepancy Description:** "The two old columns either become the first leg or are dropped" splits one fact across a column pair and a child table. Items 2 and 5 do not mention dropping them.
* **Rationale & Recommendation:** Decide now: drop the columns in 0214.

### 6. Two acknowledgement mechanisms for one concept - Severity: Nit
* **Affected Scope:** 207, 214, 410, 490
* **Discrepancy Description:** Goal 10 requires a typed reason both ways, yet the design keeps `recognizeGain` (no stored reason) and adds a separate variance flag plus reason.
* **Rationale & Recommendation:** One "acknowledge difference" with a reason, where the sign picks 6420 or 7100. Place it beside the existing gain check (`channel-settlements/index.ts:363-377`).

### 7. The normal `settledOn` is implicit - Severity: Nit
* **Affected Scope:** 215, 258, 123
* **Discrepancy Description:** Only the deferred case is spelled out. Normal uploads book with `settledOn` equal to the sales date, which is only implied.
* **Rationale & Recommendation:** State it. For an arrival date in a closed period, `firstOpenDateOnOrAfter` (`repo/fiscal-periods.ts:567-589`, used at `recurring-expenses/job.ts:184`) already solves "first open date" and may answer part of the open question at 123.

### 8. Some F blockers repeat T-150's - Severity: Nit
* **Affected Scope:** 203, 492
* **Discrepancy Description:** "No destination account", "negative net deposit" and "posted settlement already exists" come from T-150's preview (`channel-settlements/index.ts:400-409`, `339-344`). The closed-period wall is enforced by the database (`docs/RULES.md:115-117`). Item 34 (492) still adds field rules.
* **Rationale & Recommendation:** Say the screen takes these from `previewChannelSettlement` and the new module adds only intake checks.

## Stage 5 Status

| # | Stage 5 finding | Status | Evidence |
|---|---|---|---|
| 1 | Release scope too large | Knowingly decided (booking in release 1); fallback kept, loan-form extras cut | 92, 397, 193 |
| 2 | Four staging tables | Still open | 188-191, 407 |
| 3 | Two registers for loan legs | Partly addressed (interest decided; old columns undecided) | 102, 213 |
| 4a | Fingerprint reuse | Addressed | 174 |
| 4b | CSV reader reuse | Still open (`parseCsv` at `packages/etl/src/master-data/sheets.ts:20`) | 460 |
| 4c | Upload capability reuse | Still open (`PURPOSE_CAPABILITY` could map to `record_ar_collection`, `files/index.ts:56`) | 504 |
| 4d | Single library / "this is a rewrite" | Not stated | 387 |
| 5 | Altitude (file-by-file items) | Still open, grew | 454-483, 476 |
| 6 | Loan check by id | Knowingly deferred to slice 1 | 110, 200 |
| 7 | Open questions | Addressed | 88-102, 61, 111-112, 4 |
| 8 | Approval reuses T-150 | Partly addressed (see finding 8) | 207, 203, 492 |
| 9 | Platform column and uniqueness | Partly addressed (see finding 4; "why not derive platform from channel" still unsaid) | 172, 407 |
| 10 | Two migrations | Fine, but 0213 now wrongly hosts the deferral table | 407 |
| 11 | Three new capabilities | Still open | 504 |
| 12 | Observability and reader version | Partly addressed (reader version has a consumer; refusal counters have none) | 274, 252 |
| 13 | Alternatives restate decisions | Partly addressed (intake doc linked; D-I and K still repeat) | 6, 298-344 |

## Additions with no concern
Risks table (261-276), decision 9 and its test (100, 266, 538), decision 10 (101, 207), decision 11 (102, 270). Approval order matches how T-150 clears against the channel's whole balance (`channel-settlements/index.ts:354`).
