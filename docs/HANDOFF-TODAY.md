# Handoff — 2026-09-20, late evening. T-330 SHIPPED, and every fix created the next defect.

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> ⚠️ **IT IS NOT LAUNCHED.** No staff use it. That changes urgency, never correctness.
> ⛔ This document makes **no present-tense claim** about which commit production runs (DEF-360).
> Ask `/api/health` and compare all forty characters against `git rev-parse origin/main`.

## ⛔⛔ THE HONEST HEADLINE

**T-330 IS COMPLETE AND COMMITTED. IT IS NOT PUSHED.** ⚠️ **And read §2's CORRECTION before
repeating this document's claim that the app cannot be opened — it can.** Two commits, both local:

| Commit | What |
|---|---|
| `5daafcd` | T-330 — a payment allocates itself oldest-first. 17 files, 41 tests. |
| `8f5cec3` | Ian's service-charge rulings — bible rows 222 and 223, T-187's spec. |

`main` is **GREEN**, verified after committing: **135 files, 1878 passed, 1 skipped, 0 failed.**
⛔ **PUSHING IS IAN'S CALL AND HE HAS NOT GIVEN IT.** It was put to him and he had not answered when
this was written. **Do not push on your own initiative** — CI gates Deploy.

⛔⛔ **AND THE THING THAT MATTERS MOST: THE PAYMENT SCREEN WAS REVIEWED, NOT SMOKETESTED.**
Nobody has ever loaded it. See §2 — not a formality, it is the whole risk profile of `5daafcd`.

## ⛔⛔ 1. THE STRUCTURAL FINDING OF THE NIGHT — READ THIS FIRST

**Three rounds of audit found the SAME ENDING by THREE DIFFERENT DOORS**, and rounds 2 and 3 were
each created by the fix for the round before. The ending, every time: *a payment posts as though
nothing was allocated — the whole amount to `1240` (AP) or `2140` (AR), invoices still showing open,
**no error**.*

| Round | The door |
|---|---|
| 1 | The new checkbox was CONTROLLED by `Number(value) > 0` — **character-for-character the predicate T-328 DELETED from that same file.** A typed `3,000.00` is `NaN`, so the row unticked itself and was never submitted. The comment explaining T-328's deletion sat directly above the code reading the form. |
| 2 | **The fix for round 1.** `typed` (what the server is told) meant *touched AND non-blank*; the merge skip (what the screen enforces) meant *touched, blank or not*. Every id in the gap had money planned for it and then refused display: boxes empty, banner "Fully allocated". |
| 3 | **The fix for round 2.** The race repair read live state at merge time; the staleness detector's key was then computed FROM the merged state, so it compared that state **against itself** and could never fire for an in-flight edit. |

⭐⭐ **THE GENERALISATION, FROM THE AUDITOR, AND IT IS THE BEST THING PRODUCED TODAY — IT IS WHY
ROUND 3 WAS A BLOCKER AND NOT A COSMETIC NOTE:**

> **A deliberately asymmetric guard leaves half the error space unpoliced ON PURPOSE — so the
> DIRECTION of an error must be worked out BEFORE its SEVERITY.**

Round 3's wrong figure was harmless in one direction and **silent** in the other. The only thing
deciding which was `allocatedTotal > amount + 0.005` being one-sided **because Ian ruled short
allocation legal (DEF-394)**. ⛔ **Ian's own correct ruling is what made the bug invisible.**
⚠️ **This codebase has other deliberately one-sided guards. Every one has a quiet side.**

⭐ **AND THE COROLLARY:** after consolidating, ask what the single surviving path now trusts. That
question caught all three rounds.

⛔⛔ **A SECOND PATTERN, FIVE TIMES IN ONE TASK: THE THING CHECKING THE WORK WAS ITSELF UNCHECKED.**
The `??` inside the rule written to make Ian's ruling falsifiable; the census counting prose as a
call site; `callers.mjs` counting a comment; `--probe` reading a symbol name as a directory; and the
auditor's own round-3 simulation, which compared a key to itself.
⭐ **The shape, in the auditor's words: every one returned a confident, well-formed answer. None
errored. None looked broken.** ⛔ **The only control that caught any of them was a second measurement
that DISAGREED — never inspection of the instrument, and never re-running it.**

## ⛔ 2. §9.4 IS UNMET — AND THE REASON CHANGED TWICE TODAY

⭐ **DEF-368 IS CLEARED.** Ian pasted the five `NEXT_PUBLIC_FIREBASE_*` values within minutes of
being asked. They are real (`API_KEY` len 39 `AIzaSy…`, `APP_ID` len 41 `1:765…`) and the server
logs `[storage] Firebase driver installed for bucket shareat-hub-v2`.

⛔⛔ **A WORSE BLOCKER WAS SITTING BEHIND IT: DEF-401.** `next dev` starts, binds 9008, and returns
**500 on EVERY route**. Turbopack panics writing the `/page` endpoint, in PostCSS on `globals.css`,
at `creating new process` → `node process exited … 0xc0000142`.

⭐ **MEASURED, so nobody repeats it:** deterministic across two clean starts · **NOT** resource
exhaustion (`execFileSync` spawned **12 of 12** children seconds later) · `--webpack` is **NOT a
workaround** (it fails differently and spuriously; that output is noise) · ✅ **`npm run build` is
UNAFFECTED — exit 0, full route manifest.** Only the click-it gate is lost.

⛔⛔ **SO THE RISK PROFILE OF `5daafcd` IS: three screen-layer defects were caught by CODE REVIEW
ALONE.** No test in this repo can reach them and nobody could open the app. ⭐ **The green suite
proves less than it usually does, and the commit message says so in those words.**
⛔ Do NOT close this by loosening DEF-388's sign-in guard.

✅✅ **CORRECTED LATE THE SAME NIGHT, AND THIS IS THE MOST IMPORTANT CORRECTION IN THIS DOCUMENT:
DEF-401 IS DEV-SERVER-ONLY AND §9.4 IS *MEETABLE*.** Ian asked for a retry; the dev server failed a
**third** identical time, and then the obvious thing that had not been tried was tried:

> **`npm run start` — `next start` on the production build — SERVES THE APP CORRECTLY.**
> `GET /` → **307 → `/sign-in?next=%2F`** (the auth redirect, working as designed).
> `GET /sign-in` → **200**, a real rendered form: 10,346 bytes, `type="password"`, `name="email"`,
> a submit button, the PIN route. **The application runs.**

⛔ **The “nobody can open the app” claim above was reached by testing ONLY `next dev` and
generalising.** That generalisation was wrong, it was believed for several hours, and it is why the
three screen-layer defects in `5daafcd` were reviewed rather than clicked. ⭐ **It is the same failure
this register keeps recording — a present-tense claim broader than the thing actually measured.**

⚠️ **WHAT IS STILL BLOCKED IS THE BROWSER, NOT THE APP.** The Playwright MCP server is pinned to the
`chrome` channel; Chrome is not installed here; `npx playwright install chrome` **FAILS, requiring
Administrator**. Playwright's own chromium builds ARE present (`AppData/Local/ms-playwright`) but the
MCP tool exposes no channel override. ⭐ **The remaining blocker is ONE ELEVATED INSTALL ONLY IAN CAN
RUN** — after which the T-330 payment screen can finally be clicked, against `next start`.

⭐ **SO: RUN SMOKETESTS AGAINST `next start`, NOT `next dev`, UNTIL THE PANIC IS FIXED.** ⚠️ Remember
`next build` must be re-run for the served bundle to include new changes, and the dev server must be
stopped first (RULES §1 rule 10).

## ⛔ 3. WHAT IS STILL OPEN IN `5daafcd`, BY DESIGN

**The click-to-merge race is NOT closed.** Only its false banner is. If the operator types while the
request is in flight, the returned figures were computed without that edit.
⭐ **The reasoning for stopping there, which was deliberate:** stale boxes are **visible and
editable**; the BANNER was what made it post silently. After the fix the residual is *visible*,
*legal* (DEF-394) and *warned* ("boxes changed — press Auto-allocate again", figure suppressed,
`lastComputedKey` nulled). ⚠️ **Do not let a future session "finish" this without a browser** — it is
in the two `*Form.tsx` files and cannot be tested here.

⚠️ **AND ONE SENTENCE THAT WAS OVERSTATED TWICE — do not restate it wrongly a third time:**
`typedIds` (a `Set`) and `typedCentavos` (a `+=`) are now derived in ONE pass, adjacent and visibly
coupled. ⛔ **They are NOT structurally incapable of disagreeing.** `typedIds.add` on a repeat is a
no-op; `+=` is not. **The duplicate-id refusal is still what makes them agree.**

## ⭐ 4. WHAT IAN RULED TODAY (evening) — bible rows 222, 223

**Row 222 — *"service charge turn on so we can test."*** ⭐ **Measured before recording: there is
NOTHING to turn on.** No feature flag exists anywhere; `sales_days.service_charge` is an ordinary
`numeric` defaulting to `'0'`; `/sales-days/new` already renders the field. The switch DEF-082 warns
about is a **POS** setting and `apps/pos` is unbuilt. ⛔ **No flag was built** — inventing one would
be scope conjured out of a sentence. The ruling was read as WHAT (make it exercisable end to end);
the HOW is **T-187**, which therefore moves AHEAD of the DEF-395 re-derivation.

**Row 223 — T-187's five questions, and THREE WERE DISSOLVED, NOT ANSWERED.** Verbatim: *"the
business will collect it and dispense it every payday. thats all erp should record. as to split erp
wont know that, who counts erp does not have to know. odd centavo erp not know too, per store , pay
only whats available never negative ----- ALL erp does not have to know will be processed manually
and documented manually too."* Plus: *"simplify its build."*

- **Q1 split / Q2 eligibility / Q3 rounding → OUT OF ERP SCOPE.** ⭐ **No eligibility field, therefore
  NO schema change, no migration, no backfill.** This is what cut T-187 from a module to about a day.
- **Q4 → `2160` IS PER STORE.** ⛔ This makes `serviceChargeFloatAgeing` **wrong as built**: it groups
  by `je.entry_date` only, no `jl.store_id`, so it FIFO-ages one org-wide pool while every credit
  carries a real `storeId` — and its siblings in that same file DO group by store. **Regroup it WITH
  T-187**, not after.
- **Q5 → pay only what is available, never negative.** Refused, not clamped.
- ⚠️ **Cadence changed:** *"every payday"* **supersedes** T-136 §6's closed daily-or-weekly list.
- ⛔ **THE TRADE, ACCEPTED EXPLICITLY:** the ERP will hold **no record of who received what.** It can
  prove the float was discharged and by how much; it cannot answer *"was this person paid their
  share"* from its own data.
- ⚠️⚠️ **COMPLIANCE CAUTION, RAISED ONCE, UNVERIFIED:** RA 11360 requires intervals **not exceeding
  sixteen days**. *"Every payday"* is lawful only while every store's cycle stays inside that.
  **Nobody has checked each store's configured cadence**, and a month with a 31st can stretch a
  semi-monthly gap. ⭐ Once the payout date is recorded and the alarm is per store, this becomes
  **self-reporting** — which is the reason to do Q4's regrouping *with* T-187 rather than after it.

⛔⛔ **ROWS 222 AND 223 ARRIVED RELAYED (via `webapps-17`), NOT TYPED IN THE ORCHESTRATOR'S TERMINAL.**
Recorded with Ian's words verbatim and **flagged to him for confirmation, which he had not given when
this was written.** ⛔ **Confirm row 223 with Ian before building T-187 on it.**

## 5. Numbers and shared state

Next task **T-332** (⛔ `T-331` is ALLOCATED to PIN throttling, row 219) · next defect **DEF-405** ·
next migration **`0157`** (⛔ `0156` is ALLOCATED to T-276). ⛔ `0155` IS APPLIED IN PRODUCTION.
Reserved, do not re-issue: `0149`/`0150`/`0151`.

**Lane DBs:** `shareat_test` (shared, ⛔ **NOT migrated, 155+ behind — never use**),
`shareat_test_t327_builder`, `shareat_test_t328_{tester,builder}`, `shareat_test_t330_{tester,builder}`.
⛔ **Verify routing through the RESTRICTED role** the way `tests/integration/setup.ts` derives it,
not just the raw URL — that is the gap DEF-392 lived in for a whole cycle.

⛔ **`docs/wip/` IS GONE — deliberately.** It held the stub safety-net patch; the real implementation
is committed, so the patch was deleted exactly as the previous handoff instructed.
⚠️ **NOT OURS, NEVER STAGE:** `apps/erp/next-env.d.ts` (modified), `docs/reviews/NEXT-PROMPT.md`
(modified), `docs/reviews/2026-09-17.md` (untracked) — an exited session's since 2026-09-17.
**These three are the ONLY things in the working tree.**

⚠️ **AND A TRAP FOR WHOEVER INVESTIGATES AN UNEXPLAINED `HEAD`, found tonight:** **every session on
this machine commits as the same git identity.** `%an` reads `Ian Lalusin` for the orchestrator's
commits, a peer's, and a lane's alike. **Only contents and timestamps distinguish lanes.** A session
reaching for the author field to attribute a commit learns nothing — which is exactly what happened
tonight: the auditor reached the right conclusion ("nothing is wrong") for the wrong reason.

## ⛔ 6. FOUR DEFECTS FILED TONIGHT, AND TWO ARE IN THE TOOLS WE GATE COMMITS WITH

| | |
|---|---|
| **DEF-401** ⛔ | The ERP renders no page on the dev machine. §2. **Blocks §9.4 for EVERY task, not just T-330.** |
| **DEF-402** ⚠️ | `production-caller-census.mjs --probe` takes the **symbol name as its scan ROOT**, so it reports `Controls: FAILING` and `MISSING: true` — **both false**. ⛔ The script's own control-failure message tells you to run the broken form. ✅ Workaround, verified: pass a root FIRST (`node … . --probe allocate`). |
| **DEF-403** ⛔ | **JSX TEXT IS COUNTED AS A CALL SITE**, in BOTH the census and **`callers.mjs`**. `allocate` was credited with two "callers" that are the words *"Auto-allocate"* and *"more than allocated"* in operator copy. ⛔ **The error HIDES uncalled code** — the DEF-129 shape, arriving through the guard built to catch it. ⛔⛔ **Its fix MUST also restore `allocate` to `docs/production-caller-baseline.txt`** — the baseline was regenerated tonight without it, and the day the scanner is fixed the ratchet fires on a name the fixer did not add. That trigger is written into DEF-403's own fix line. |
| **DEF-404** ⚠️ | The AP payment screen shows **no due date** (`apRepo.openItems` never selects it; AR's does). ⭐ Worse after T-330: **a machine now picks the order and calls it most-overdue-first, and the operator cannot audit that claim.** |

## ⭐ 7. THE LANES — all four were excellent, all four are IDLE and STOOD DOWN

⛔ **ASK each its model; never read it from a table (DEF-361).** ⛔ `/clear` is Ian's — a session
cannot clear itself. ⚠️ A session also cannot run `/model`; asking it yields its own runtime
identity string, which is what you want, but say so rather than claiming `/model` output.

| Session | Role | Model (as it reported) |
|---|---|---|
| `webapps-4d` | BUILDER | Sonnet 5 |
| `webapps-d1` | TESTER | Sonnet 5 |
| `webapps-42` | AUDITOR | Opus 5 |
| `webapps-17` | Ian relay + read-only census | (not asked) |

⭐ **WHAT EACH DID THAT A REPLACEMENT WOULD NOT:**

- **AUDITOR** — found the defect that would have shipped, then found **both defects its own fixes
  created**, and **reversed the orchestrator's hypothesis in round 3**, which is what turned a
  cosmetic note into a blocker. Checked the obvious one-line fix **before proposing it** and found it
  wrong (it would have fired on 100% of runs and become noise). ⭐ **Reported a tautological
  simulation of its own, against its own account, rather than silently substituting the right answer.**
- **TESTER** — ⭐ **found the sharpest defect of the night, which BOTH the auditor and the
  orchestrator had missed**: `typedIds` a `Set` vs `typedCentavos` a raw `reduce` — skipped once,
  subtracted twice. Verified lane-DB routing through the **restricted role**, not just the raw URL.
  **Flagged two unruled cases instead of deciding them**, which is what let the orchestrator rule
  deliberately instead of discovering an invented rule inside a test.
- **BUILDER** — three honest READYs, each with a "what I did NOT verify" section, including that it
  could not produce a positive control for the race fix. **Never touched a test file, not once**,
  across three rounds with new cases landing under it mid-cycle.
- **`webapps-17`** — relayed Ian verbatim with its own reading kept separate and the RA 11360 risk
  flagged as a risk rather than asserted. Its read-only census found **two self-contradicting
  documents** (ROADMAP's stale T-187 reason; DEF-382's *"T-328 closes it"* disposition, contradicted
  by DEF-395) — **both fixed in `8f5cec3`** — and reported the third as unresolvable rather than
  guessing which half was right.

## ⛔ 8. THE ORCHESTRATOR'S OWN FAILURES

1. ⛔ **THREE OF THE NIGHT'S FAILING CHECKS WERE MINE, NOT ANY LANE'S:** a stale bible TOC (my row-222
   edit; fixed with `npm run toc`), `register-row-shape` broken by **two literal pipe characters in
   code I quoted** in DEF-402 — *the row documenting a broken script, broken by the character class
   the task spent the day on* — and an incomplete instruction to the builder that scoped a
   stale-comment fix to `createdAt` only, leaving the STUB docstrings standing for another round.
2. ⛔ **I TOLD THE AUDITOR ABOUT ONE COMMIT AND MADE TWO**, so it correctly inferred a peer had landed
   on top of me. Its check was right; my report was incomplete.
3. ⚠️ I ran the census with `2>/dev/null` and nearly accepted an uncontrolled result — the exact
   failure that script's header exists to prevent.

## ⛔ 9. PICK UP HERE

1. ⛔ **ASK IAN: push `5daafcd` and `8f5cec3`?** Unanswered. Do not push unilaterally.
2. ⛔ **CONFIRM ROW 223 WITH IAN** before building T-187 on a relayed ruling.
3. **T-187** — specced at `docs/tasks/187-service-charge-distribution.md`, all five questions ruled.
   One aggregate entry per store per payday: **Dr `2160` (that store) / Cr the money account, capped
   at that store's available balance.** ⭐ Regroup `serviceChargeFloatAgeing` per store in the SAME
   task. ⭐ **Its best red already exists:** the four existing detector cases must go **QUIET** after a
   payout — a detector nobody ever saw stop is one nobody can prove stopped.
4. **Then Phase 2** — DEF-395/DEF-382 re-derivation (needs a NEW task; DEF-395 specs four hard
   requirements for the redo) · DEF-386 · DEF-374 · DEF-393 · T-136 §2 · T-316 (blocked on two of
   Ian's answers) · T-276 (queued, slot `0156`).
5. **Then Phase 5** (payroll, 16 of 18) — T-190 on row 217's trigger, then T-193. ⚠️ **Review the
   contribution rates against the CURRENT year first — SSS changes yearly.**
6. **T-331** (PIN throttling, row 219) — cheap now, an incident later.

## ⭐ 10. FOR IAN — five, and one is free

1. **Push or not.** Both commits local, `main` green.
2. **Confirm the service-charge ruling** recorded from a relay.
3. ⭐⭐ **ONE ELEVATED COMMAND UNBLOCKS THE SCREEN TEST FOR EVERY FUTURE TASK.** In a terminal run as
   **Administrator**: `npx playwright install chrome`. It failed for me on privileges. The app itself
   is fine — `npm run start` serves it correctly — so Chrome is the only thing standing between this
   project and a real §9.4 smoketest. (The `next dev` panic is separate, still open, and costs only
   hot-reload.)
4. ⭐ **Optional follow-up:** under his rule a box he has **unticked** counts as empty, so
   Auto-allocate refills it. Faithful to what he said; unticking is the natural *"not this one"*
   gesture and having it undone will surprise whoever does it. Small, clean change if he wants it.
5. `/clear` the terminals, and `/effort medium` on the orchestrator's.
