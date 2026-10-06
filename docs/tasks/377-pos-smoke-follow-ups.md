# T-377: two follow-ups from the T-375 screen smoke — DEF-596, DEF-597

**Status:** SPEC 2026-10-06 (Opus planner). Written at HEAD `fb082de`. ✎REV 2026-10-06: independent review, REV-1/2/3/5/6/8 inline; ready after them. **DONE 2026-10-06:** S1 `5ee87c9` (mutants 4/4), S2 `53e0020` (mutants 13/13; two extra auditor mutants on the page's void-pull guard survive, harmless: the server refuses a void pull). Smoked on 9008, both ✅. Out of scope N1–N3 not yet filed.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** none. (If one turns out to be needed, the next free number is **0186**, and any migration is gated on the
FULL suite on a fresh gate DB. Stop and report first: it would be a spec defect.)
**Parent:** `docs/tasks/375-pos-v1-day-feed.md` (S5-lite for usage, S6/R10 for the basis and corrections).

## Goal
- The T-210 reconciliation page says what its first POS column really is: the figures the ledger is posted from,
  which a POS correction moves (DEF-596, 🔸, not money).
- A day whose POS usage is fully handled stops raising `posUsagePullNotRun`: a pull is finalized once every section
  that has something to review has been reviewed, and an empty section has nothing to review (DEF-597, 🔸).

## Census, verified at source (corrections to the register marked ✎)

### DEF-596 — "At import" shows the posted basis
- `getPosDayReconciliation` (`packages/domain/src/reports/pos-day-reconciliation.ts:63-83`) reads the first column from
  `posV1Repo.basisFor` (`:66`), and calls the result `atImport` (`:34`, `:69`).
- `basisFor` (`packages/db/src/repo/pos-v1.ts:304-313`) returns the latest correction's `to_feed_id`, else the import
  feed. So after one correction the column shows the corrected reading.
- The card labels it "At import" (`apps/erp/src/components/reports/PosReconciliationCard.tsx:69`), its doc says
  "what the day was posted from" (`:35`), and the delta line says *"latest check − at import"* (`:88`).
- **The data is right; only the name is wrong.** T-375's own S6 text says *"At import" (basis)* (`375:1047`). R10 wants
  the comparison against the basis: drift is "POS now vs what the ledger holds". Comparing against the original import
  would show a permanent false mismatch after every correction.
- The original import is not lost. The import feed (`sales_days.pos_v1_day_feed_id`), every correction's `from_feed_id`
  and `to_feed_id`, and both journal entries are stored. The day page lists the corrections
  (`apps/erp/src/app/sales-days/[id]/page.tsx:292-317`).
- `atImport` is also used at `apps/erp/src/app/reports/pos-reconciliation/page.tsx:102`, and in the tests
  `packages/domain/tests/integration/pos-day-reconciliation.test.ts` (`:16-19`, `:37`, `:80-143`) and
  `apps/erp/tests/integration/t375-s6-reconciliation-web.test.ts:210-247`. No test drives a correction on this page.

### DEF-597 — an empty section is never stamped, so the pull is never finalized
- The detector (`packages/db/src/repo/findings.ts:1899-1925`) fires for a verified day on a mapped store with no pull
  where `status = 'finalized'` (`:1909-1911`). That is the right question, asked of the right column.
- A pull goes `finalized` only when all three section stamps are set (`packages/domain/src/pos/usage-pull.ts:437-440`,
  `markPullFinalized`, `repo/pos-mapping.ts:372-374`). A section is stamped only when someone asks to finalize it
  (`:371-435`).
- The screen never asks for an empty section. `SectionTable` renders *"Nothing here today."* and no form when
  `lines.length === 0` (`apps/erp/src/app/inventory/pos-usage/page.tsx:59-60`). The action finalizes one section per
  click (`pos-usage/actions.ts:52-57`).
- So "direct finalized, recipe and orphan empty" stays `planned` forever, and a ₱0 day (S5-lite plans all three empty)
  can never be finalized at all. ✎ The register names only the first case.
- ✎ **Confirmed: it predates S5-lite and T-374.** `git log -S` for the all-three check
  (`refreshed.recipeFinalizedAt && refreshed.orphanFinalizedAt`) and for the empty-section render
  (`lines.length === 0`) both return only `5678d35` (T-177, 2026-09-04). T-374 S7 and S5-lite did not change either.
- The database has no rule here. 0127 checks only the shape of a finalized row (`pos_usage_pulls_finalized_shape_check`,
  `0127_t177_pos_mapping.sql:110-111`). "When is a pull done" lives in `finalizeSections` alone.

## Rulings (planner)
- **R1 (DEF-596). Relabel, and rename the field. Do not add the original import.**
  - Smaller and correct. The column already shows the right figure for its job (R10). It is only named for the wrong
    one. Adding the original import would be a fourth figure nobody acts on: the ledger never holds it after a
    correction, and it is already kept in the feeds and the correction rows.
  - Label: **"Posted basis"**, with the sub-line *"What the ledger holds: the import, or the latest correction."*
  - Delta line: *"Delta (latest check − posted basis)"*.
  - The result field `atImport` becomes **`postedBasis`**. A field named for the opposite of what it holds is the
    trap GLOSSARY warns about. Not `basis`: the result already has `basis` (the input echo, `:42`).
- **R2 (DEF-597). The fix belongs in the pull's finalize path, not in the detector.**
  - ✎REV-1: RULES item 3 ("the database enforces the rules") is about CHECK constraints and triggers and does not
    govern this; there is no rule in the database here (census). The ruling stands on single-source-of-truth grounds
    alone: the detector reads the pull's `status`, the one recorded answer to "is this day's usage done". Teaching the
    detector that "direct stamped and the rest empty" also counts as done would be a second copy of the finalize rule,
    the page would still show the pull `planned` (with no way to close it), and `buildPlan` (`:188`, `:217`) would
    still treat it as open, so the pull row, the page and the detector would disagree.
  - So `finalizeSections` decides it once: **after the section loop and before the all-three check, if EVERY
    unstamped section is empty, it stamps them all** (✎REV-2: all or none, never one empty section on its own). The
    detector stays unchanged.
  - ✎REV-2 why all-or-none: a stamped section is frozen. `buildPlan` passes the stamped sections to
    `replacePullLines` as `keepSections`, which DROPS every fresh line of a kept section (`repo/pos-mapping.ts:411`).
    Per-section stamping fails like this: direct has lines, recipe is empty, orphan has item B. Finalize direct, and
    recipe is auto-stamped. Someone maps B to a recipe and rebuilds. B's recipe line is dropped because recipe is
    frozen, and orphan is now empty. The next call stamps orphan and finalizes the pull. B's stock and COGS are never
    posted, and nothing on screen says so. If every unstamped section is empty, every sold item is already in a stamped
    section or has a `no_stock` map, which yields no line by design (`plan.ts:173`). So no unreviewed section is
    frozen.
- **R3. "Empty" means empty in BOTH the stored plan and the fresh rebuild.** Any line counts, blocked or not.
  - The stored lines come from `posMappingRepo.listPullLines(tx, pull.id)`, read after `getPullForUpdate` (`:331`) so
    a rebuild that committed first is seen (✎REV-8). The fresh ones are `freshLines` (✎REV-8: `:346`).
  - If either has a line in any unstamped section, nothing is stamped (REV-2). A person must look at it.
  - Stored-only would stamp a section that a mapping added since the build has just filled.
  - Fresh-only would silently stamp a section whose shown lines vanished. Today that case refuses `PLAN_CHANGED` on its
    own finalize, and the person rebuilds.
- **R4. The stamp never runs on a refused call.** It sits after every early return (void, stale snapshot, day lock,
  pin, feed change, `PLAN_CHANGED`), so a refused finalize stamps nothing, as today.
  - An auto-stamped section adds no row to `results`. `SectionOutcome` and the action's banner are unchanged.
- **R5. The ₱0 day, and pulls already stuck, get one button.** When the pull is `planned`, not `viewOnly`, and every
  unstamped section has zero lines, the page shows one form after the three sections.
  - The button reads **"Finish this pull — nothing left to post"**.
  - ✎REV-3: it submits `finalizeSectionAction` with a hidden `finish` = `1` and NO `section` and no `confirmedKeys`.
    The action calls `finalizeSections` with `sections: []`, so the loop stamps nothing and only the R2/R3 sweep runs.
    - Why not "`section` = the first unstamped section" (the original R5): the loop stamps a REQUESTED section
      unconditionally (`:432`), and it never checks R3. Say a sold item's `no_stock` map is changed to direct after the
      page rendered. The button would stamp direct with that item's fresh line unconfirmed and silently excluded, so
      its stock is never posted, under a button that says "nothing left to post". With `sections: []`, R3 sees the
      fresh line and stamps nothing (E10).
    - `FinalizeResult`'s ok branch gains `pullFinalized: boolean`, read from `refreshed` after the all-three check.
      This is additive: no existing caller reads it.
    - Banner: if `pullFinalized`, `ok` = *"Pull finished — nothing left to post."*. Otherwise `error` = *"Something
      new turned up in this pull. Build the plan again and review it."*.
    - The action accepts `section` only as `direct`/`recipe`/`orphan` when `finish` is absent. Today it casts any
      string (`actions.ts:52`).
  - No new action and no new capability: `finalize_pos_usage_pull` as today, authorized first in `finalizeSections`
    on the pull's store. The R5 button goes through the same action, the same RLS session (`withOrgPrincipal`) and
    every refusal before the loop.
  - A pull stuck before this fix has a stale snapshot. The existing `SNAPSHOT_STALE` sentence tells the person to
    rebuild, and a rebuild of a partly finalized pull is already allowed.
  - No backfill and no migration.

## Parallel plan
| Slice | DEF | Files (BUILDER) | Shared state | Parallel-safe with |
|---|---|---|---|---|
| S1 | 596 | `packages/domain/src/reports/pos-day-reconciliation.ts`, `apps/erp/src/components/reports/PosReconciliationCard.tsx`, `apps/erp/src/app/reports/pos-reconciliation/page.tsx` | none | S2 |
| S2 | 597 | `packages/domain/src/pos/usage-pull.ts` (`finalizeSections` and `FinalizeResult` only), `apps/erp/src/app/inventory/pos-usage/page.tsx`, `apps/erp/src/app/inventory/pos-usage/actions.ts` (`finalizeSectionAction` only, ✎REV-3) | `pos_usage_pulls`, stock usage, the lane DB | S1 |

The two slices share no files. Neither touches `POSTING-PATTERNS.md`, a migration, `classification.ts` or the RLS
registry. Each lane runs on its own lane DB.

## Invariants
- I1. No new capability, no new action, no new table. `authorize()` stays first in `finalizeSections` (`:310`).
- I2. `repo/findings.ts` is not edited (R2). The detector's SQL is byte-identical.
- I3. No money changes. S1 is labels and a field name. S2 posts exactly the lines it posts today: an auto-stamped
  section is empty by R3, so it has nothing to post.
- I4. Refusals carry no ids. The banners use the existing `?error=`/`?ok=` pattern.

---

## S1: DEF-596, "Posted basis"
**BUILDER:**
- `pos-day-reconciliation.ts`: rename `atImport` → `postedBasis` in the type (`:34`), the body (`:69-82`) and the doc
  comments (`:4`, `:40`). There is no logic change; `basisFor` stays the source.
- `PosReconciliationCard.tsx`: the prop rename, the label and sub-line (R1), the delta text (`:88`), the doc comment
  (`:35`).
- `reports/pos-reconciliation/page.tsx:102`: pass `postedBasis`.

**TESTER:**
- Edit `packages/domain/tests/integration/pos-day-reconciliation.test.ts`: the field rename only. Add **P1**: import
  (₱1,050), recheck (₱1,000), post the correction (fixture from `t375-s6-correction.test.ts`). Then expect:
  - `postedBasis.paidTotal` = `'1000.00'`;
  - `latest` = `'1000.00'`;
  - `matches` true, delta `'0.00'`.
- Edit `apps/erp/tests/integration/t375-s6-reconciliation-web.test.ts`: `columns()` keys on "Posted basis". Every
  existing assertion is unchanged except the label. Add **W1**: the P1 fixture rendered:
  - the page says "Posted basis" and the sub-line, and no longer says "At import";
  - the first column shows ₱1,000.00 and not ₱1,050.00;
  - the page says "Matches".

**Tests:**
- P1. Mutants:
  - read `getFeedById(day.posV1DayFeedId)` (the import) instead of `basisFor` → P1 red (₱1,050, mismatch);
  - delta computed against the import → P1 red.
- W1 (red on HEAD: the label). Mutants:
  - revert the label → W1 red;
  - card reads `latest` for both columns → the existing W1 leg in `t375-s6-reconciliation-web.test.ts:246` red.

**Smoke (9008, dev fake POS):** a day with one posted correction on `/reports/pos-reconciliation`: "Posted basis"
shows the corrected figure, and the card says "Matches". Screenshot at 375px and in dark mode.

---

## S2: DEF-597, an empty section counts as done
**BUILDER:**
- `usage-pull.ts` `finalizeSections`: after the section loop (`:435`) and before the all-three check (`:437`), R2/R3.
  ✎REV-2: let `open` = the sections not stamped in `alreadyFinalized`. If `open` is non-empty and no stored line and
  no fresh line has a section in `open`, call `markSectionFinalized` for each and set `alreadyFinalized`. Otherwise
  stamp nothing. Add `pullFinalized` to the ok result (REV-3). Update the T-177 header comment (`:25-28`): when every
  unstamped section is empty, any successful finalize call stamps them all.
- `pos-usage/page.tsx`: the R5 button, a `finish` form (REV-3). The condition is `pull.status === 'planned'`,
  `!viewOnly`, at least one unstamped section, and every unstamped section with `lines.length === 0`. It is computed
  from the `pull` the page already holds (`pull.direct/recipe/orphan` and the three `*FinalizedAt`). There is no new
  read.
- `pos-usage/actions.ts` `finalizeSectionAction`: the `finish` branch and the section validation (REV-3).

**TESTER:**
- `packages/domain/tests/integration/t377-s2-empty-sections.test.ts` (new). Fixture from
  `t375-s5-usage-from-feed.test.ts`: a linked, mapped store, an imported verified day, the pinned `sold_items` feed.
- Edit `apps/erp/tests/integration/t375-s5-pos-usage-page.test.ts`: add W1–W3 (render and action legs, its harness).

**Tests (domain):**
- **E1** (red on HEAD; the smoke's case). The sold items map only to direct. Build, then finalize `['direct']`. Expect:
  - the pull is `finalized`, with `finalized_at` and `finalized_by` = the actor, and `pullFinalized` true;
  - all three stamps are set;
  - ✎REV-6: `sections` has exactly ONE row, `direct`;
  - the direct usage record is posted;
  - `findingsRepo.posUsagePullNotRun(tx, orgId)` has no row for the store.
  - Control, before the finalize: the finding fires for the store.
- **E2** (red on HEAD; the ₱0 day). All three sections are empty. ✎REV-3: finalize with `sections: []` and no keys →
  `finalized`, `pullFinalized` true, `sections` empty (REV-6), zero usage records. Control: E2 again with
  `['direct']` → the same.
- **E3** (a section waiting for a person). The items map to direct and recipe. Finalize `['direct']` → recipe is NOT
  stamped, ✎REV-2 orphan is NOT stamped either (all or none), the pull stays `planned`, `pullFinalized` false, and the
  finding still fires.
- **E9** (✎REV-2, the remap hole). Item A maps to direct, item B is unmapped (orphan), recipe is empty. Finalize
  `['direct']` → recipe and orphan NOT stamped. Then map B to an active recipe and build again. Expect: the stored
  plan has B's recipe line, and finalize `['recipe']` with its key posts B's usage record.
- **E10** (✎REV-3, R3 on the button path). Item B has a `no_stock` map, which yields no line (`plan.ts:173`), so all
  three sections are empty at build. Then change B's map to direct, and finalize with `sections: []` → nothing
  stamped, `pullFinalized` false, `planned`. Mutant: the button path sends `['direct']` (the original R5) → direct is
  stamped with B unposted → E10 red.
- **E4** (blocked counts as a line). Items A (direct) and C (a recipe made inactive before the build, so C's recipe
  line is blocked, `plan.ts:207`). Orphan is empty. Finalize `['direct']` → recipe and orphan not stamped, `planned`.
- **E5** (R3, fresh side). ✎REV-5: items A (direct) and B (`no_stock`), so recipe and orphan are empty at build. Then
  change B's map to recipe, and finalize `['direct']` with A's key → recipe and orphan NOT stamped, `planned`.
  - Not "add a recipe map for a sold item" (the original E5). An unmapped item is already an orphan line in the
    stored plan, so the stored side alone refuses, and the stored-only mutant stays green.
- **E6** (R3, stored side). ✎REV-5: items A (direct) and C (recipe). Build. Then change C's map to `no_stock`, so the
  fresh plan has no line for C anywhere. Finalize `['direct']` → recipe NOT stamped, `planned`.
  - Not "archive that recipe's map" (the original E6). C then becomes a fresh orphan line, the fresh side refuses
    alone, and the fresh-only mutant stays green.
- **E7** (R4). ✎REV-5: on the E1 fixture, so the sweep WOULD fire if it ran. A refused finalize stamps nothing. Two
  refusals, each with zero new stamps and status `planned`:
  - a confirmed key no longer in the rebuild (`direct:none`) → `PLAN_CHANGED`. This is the leg the mutant hits;
  - the day is voided → the voided-day refusal. This is a pin only: the sweep needs `freshLines` (`:346`), which only
    exist after the day lock, so no mutant can place it before that refusal.
- **E8** (control). The order of today is unchanged. Finalize `['recipe']`, then `['direct']`, then `['orphan']` on a
  pull with all three non-empty. Expect:
  - `finalized` only after the third call;
  - each call's `results` names only the section it asked for.
  - ✎REV-6: this does not catch a `results` row pushed by the sweep, because the sweep never fires here. E1 and E2
    catch that.
- Mutants:
  - delete the sweep → E1, E2 red;
  - sweep ignores blocked lines (counts only `!blocked`) → E4 red;
  - sweep checks stored lines only → E5, E10 red;
  - sweep checks fresh lines only → E6 red;
  - ✎REV-5: sweep moved above the `PLAN_CHANGED` loop (`:353`) → E7 first leg red;
  - sweep stamps every unstamped section → E3 red;
  - ✎REV-2: sweep stamps each empty section on its own (the original R2) → E3 (orphan), E9 red;
  - ✎REV-6: sweep pushes a `results` row → E1, E2 red.

**Tests (web, `t375-s5-pos-usage-page.test.ts`):**
- **W1** (red on HEAD). A pull with direct stamped and recipe/orphan empty → the HTML carries *"Finish this pull —
  nothing left to post"* in a form with hidden `finish` = `1` and no `section` input (✎REV-3). A ₱0-day pull → the
  same.
- **W2** (control). The button is absent in three cases:
  - a pull with an unstamped non-empty section;
  - a `finalized` pull;
  - `viewOnly`.
  - Positive control: W1.
- Mutants:
  - the condition ignores the stamps (it checks only "all sections empty") → W1's first leg red;
  - drop the `viewOnly` guard → W2 red.
- **W3** (✎REV-3, the action). `finalizeSectionAction` with `finish` = `1` on the W1 pull → redirect `ok` = "Pull
  finished — nothing left to post.", and the pull is `finalized`. On the E10 setup → redirect `error` = "Something new
  turned up…", nothing stamped. A `section` outside direct/recipe/orphan without `finish` → refused, nothing stamped.
  Mutant: the `finish` branch sends `[firstUnstampedSection]` → the E10 leg red.

**Smoke (9008, dev fake POS):**
1. On a mapped store, import and verify a day whose items map only to direct. Build, then finalize direct → the pull
   shows three "Finalized" stamps.
2. `/findings` has no "no finalized POS usage pull" for that store-day.
3. A pull stuck the old way (direct stamped before this fix): rebuild it, then press **Finish this pull** →
   finalized, and the finding clears.

Take screenshots of 1–3.

---

## Out of scope
- N1. A section whose lines are ALL blocked has no Finalize button either (`page.tsx:115`, `confirmable.length > 0`).
  It stays open on purpose: blocked means something needs fixing. Whether a person may close it anyway is a separate
  question. The orchestrator files it.
- N2. A CHECK that `status = 'finalized'` implies all three stamps would move the done rule into the database (RULES).
  It needs a migration (0186) and the full suite. It is not needed for this fix. The orchestrator files it.
- The day page's drift sentence *"it was {X} when the day was posted"* (`sales-days/[id]/page.tsx:320`): after a
  correction, X is the corrected figure. Same naming fault as DEF-596, on another screen. The orchestrator files it
  with N1.
- The register, the bible and the ROADMAP. The orchestrator handles these at wrap-up.

## Done when
- S1 and S2 are green. Each red is shown red on HEAD or against its named mutant before the build.
- Typecheck is clean. The unit suite passes. The FULL integration suite passes on a fresh gate DB before any push.
  `npm run build` passes with the dev server stopped. Touched files are LF.
- Each slice's smoke is done on 9008 with screenshots.
- Each builder touched only its BUILDER paths, and each tester only its TESTER paths.
- The orchestrator, at wrap-up:
  - marks DEF-596 and DEF-597 fixed with the hashes;
  - applies ✎: 597 also covers the ₱0 day, and its cause predates S5-lite (`5678d35`, T-177);
  - files N1, N2 and the drift-sentence nit.

## Questions only Ian can answer
None.
- R1 is a label on a report.
- R2–R5 change no money and no permission, and they follow the finalize rule already in force: a section is done when
  it has been reviewed.

## Ruling log
- 2026-10-06, planner: R1–R5. No migration. The detector is unchanged (R2). DEF-597's cause is confirmed as T-177
  `5678d35`, not S5-lite.
