# Handoff — 2026-09-20 (wrap-up), T-330 shipped

> ✅ **THE BUILD IS GREEN.** Gates below are real numbers, run at wrap-up with 9008 free.
> ⚠️ **IT IS NOT LAUNCHED.** No staff use it. That changes urgency, never correctness.
> ⛔ No present-tense claim is made here about which commit production runs (DEF-360).
> Ask `/api/health` and compare all forty characters against `git rev-parse origin/main`.

## Where things stand

**T-330 shipped** — a supplier payment or customer collection now fills its allocation boxes
most-overdue-first, and the operator still presses Save. **T-187 is specced and fully ruled** but
unbuilt; Ian's answers cut it from a module to about a day's work. **Phase 2 and Phase 5 remain**,
in that order, and Phase 6 was already closed.

⛔ **The one thing to carry:** T-330's screen was **reviewed, not smoketested**. Nobody has loaded
it. Three screen-layer defects in it were caught by code review alone — no test in this repo can
reach them.

## Gates at `0a7f39d` (+ this wrap-up's doc edits)

```
GATES: PASS  typecheck=0/44s  unit=0/55s  integration=0/14s  build=0/15s
  typecheck    0 type errors
  unit         135 files · 1878 passed | 1 skipped (1879)
  integration  2 files · 20 passed (20)   [lane DB shareat_test_t330_builder]
  build        exit 0, full route manifest
CALLERS        0 zero-caller/test-only exports
```
⚠️ `callers.mjs --forbid <test paths>` also prints `3 forbidden path(s)` — that is the test files'
**untracked presence**, not an edit (DEF-390). Without `--forbid` the same tool returns `CALLERS: OK`.

## What happened this session

**T-330, by theme.** Ian ordered auto-allocation; the spec had already taken seven amendments,
five of which fixed the previous orchestrator's own defects. The tests were written by one lane, the
code by another, and reviewed by a third. **Three audit rounds found the same ending by three
different doors** — a payment posting as though nothing were allocated, the whole amount to `1240`
/`2140`, invoices still open, **no error** — and **rounds 2 and 3 were each created by the fix for
the round before**. Details in §1 of the commit message on `5daafcd` and in the roadmap row.

**Decisions Ian made, and where each is recorded:**

| Decision | Recorded in |
|---|---|
| *"service charge turn on so we can test"* | **bible row 222** — and the measurement was that **there is nothing to turn on**; no flag exists, the field has always been enterable. Read as WHAT; the HOW is T-187. |
| The five T-187 questions — three **dissolved**, not answered | **bible row 223**, `docs/tasks/187-service-charge-distribution.md` |
| Row 223 **CONFIRMED** (*"1 yes"*) | bible row 223 — relayed, then confirmed, so it is authority rather than a flagged claim |
| Unticking a box: **no change** (*"2 no change needed"*) | **bible row 224** — an unticked box counts as EMPTY and auto-allocate refills it |

**Defects filed:** DEF-401 (dev server 500s; **corrected same night — dev-server-only**), DEF-402
(`--probe` takes the symbol name as its scan root), DEF-403 (**JSX prose counted as a call site**, in
both the census and `callers.mjs`), DEF-404 (AP screen shows no due date).

**Documents corrected:** ROADMAP's stale T-187 reason and DEF-382's *"T-328 closes it"* disposition
— both found by a read-only census that reported them as contradictions rather than picking a side.
**T-329's status line still read SPEC after two tiers had shipped**; corrected at wrap-up.

⭐ **Roadmap: T-330 added as done, T-329 added as partly done.** It was missing both.

## Pick up here

1. ⭐⭐ **T-187 — service-charge distribution.** Specced, all five questions ruled, **no migration
   needed**. One aggregate entry per store per payday: **Dr `2160` (that store) / Cr the money
   account, capped at that store's available balance**, refused if it exceeds. ⛔ **Regroup
   `serviceChargeFloatAgeing` per store in the SAME task** — it groups by `je.entry_date` only, so a
   payout at one store would tick off another store's older accrual. ⭐ **Its best red already
   exists:** the four existing detector cases must go **QUIET** after a payout.
2. **Phase 2** — DEF-395/DEF-382 re-derivation (needs a NEW task; DEF-395 specs four hard
   requirements for the redo) · DEF-386 · DEF-374 · DEF-393 · T-136 §2 · T-316 · T-276 (slot `0156`).
3. **Phase 5** (payroll, 16 of 18) — T-190 on row 217's trigger, then T-193. ⚠️ **Check the
   contribution rates against the current year first — SSS changes yearly.**

## Do not decide these alone — they are Ian's

- ⭐ **One elevated command unblocks screen testing for every future task:**
  `npx playwright install chrome`, **run as Administrator**. It failed for me on privileges.
  ⭐ **The app itself is fine** — `npm run start` serves it correctly.
- **RA 11360's ≤16-day rule vs *"every payday"*** (bible row 223). Semi-monthly is ~15–16 days and
  almost certainly lawful, but **nobody has checked each store's configured cadence**, and a month
  with a 31st can stretch it. Recommendation: verify before calling T-187 done.
- **`daily-review/2026-09-17` is unmerged** and holds findings plus a `NEXT-PROMPT.md`. Merge or
  close it before it rots.

## Traps that have actually bitten

- ⛔ **`next dev` is dead (DEF-401) but the app is NOT.** `npm run start` serves it —
  `/` → 307 → `/sign-in`, `/sign-in` → 200 with a real form. **Smoketest against `next start`**,
  re-running `next build` first and stopping any server on 9008. ⚠️ The earlier claim that nobody
  could open the app came from testing only `next dev` and generalising; it was wrong for hours.
- ⛔ **Two of our own guard scripts count English as code (DEF-403).** Shipping the word
  "auto-allocate" in operator copy removed a real zero-caller finding. **The error hides uncalled
  code.** Its fix must also restore `allocate` to `docs/production-caller-baseline.txt`.
- ⛔ **`--probe` reports `MISSING: true` and `Controls: FAILING`, both false** (DEF-402). Pass a
  root first: `node scripts/production-caller-census.mjs . --probe <name>`.
- ⛔ **A register row containing a literal `|` breaks `register-row-shape`** and turns `main` red on
  a docs-only commit. Escape it. This has now happened twice.
- ⛔ **A bible row means `npm run toc`.** Every time.
- ⚠️ **Every session commits as the same git identity.** `%an` can never attribute a commit to a
  lane — only contents and timestamps can.
- ⚠️ **Never stage** `apps/erp/next-env.d.ts`, `docs/reviews/NEXT-PROMPT.md`,
  `docs/reviews/2026-09-17.md` — an exited session's.
- ⛔ **Lane DBs:** verify routing through the **restricted role** the way
  `tests/integration/setup.ts` derives it, not just the raw URL (DEF-392). `shareat_test` is
  **155+ migrations behind — never use it**.

## Numbers

Next task **T-332** (`T-331` is allocated to PIN throttling, row 219) · next defect **DEF-405** ·
next migration **`0157`** (`0156` is allocated to T-276). ⛔ `0155` is **applied in production**.
Reserved, do not re-issue: `0149`/`0150`/`0151`.

## The lanes — idle, stood down, re-adoptable

⛔ **Ask each its model; never read it from a table (DEF-361).** A session cannot run `/model` or
`/clear` itself — both are Ian's.

| Session | Role | Model (as it reported) |
|---|---|---|
| `webapps-4d` | BUILDER | Sonnet 5 |
| `webapps-d1` | TESTER | Sonnet 5 |
| `webapps-42` | AUDITOR | Opus 5 |
| `webapps-17` | Ian relay + read-only census | (not asked) |

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Put `/effort medium` for your own terminal in the first
status board's "needs you".

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED.

READ FIRST: docs/HANDOFF-TODAY.md (all of it — it is short), then docs/RULES.md. ⛔ GREP the big
ones, never read them whole: DEFECTS-REGISTER.md ~1.2MB, PROJECT_BIBLE.md ~430KB, ROADMAP.html.

T-330 SHIPPED (`5daafcd`). Gates green. NEXT UP IS T-187 — spec at
docs/tasks/187-service-charge-distribution.md, all five questions ruled by Ian (bible rows 222-224),
NO migration needed. Then Phase 2, then Phase 5. Phase 6 is already closed; do not go looking.

⛔ THE TWO THINGS THAT WILL COST YOU A CYCLE IF YOU DO NOT KNOW THEM:
1. `next dev` is DEAD on this machine (DEF-401) but THE APP IS NOT — `npm run start` serves it
   correctly. Smoketest against `next start`, not `next dev`. Nobody can drive a browser yet:
   Playwright needs Chrome and the install requires Administrator, which is Ian's to run.
2. Two of this repo's own guard scripts COUNT ENGLISH AS CODE (DEF-403) — shipping a function's
   name in operator copy silently deletes a real zero-caller finding, and the error HIDES uncalled
   code. `--probe` is also broken (DEF-402); pass a root first.

⭐ THE LESSON FROM T-330, WHICH HELD ACROSS THREE AUDIT ROUNDS: a deliberately asymmetric guard
leaves half the error space unpoliced ON PURPOSE, so work out the DIRECTION of an error before its
SEVERITY. And every fix concentrates risk onto whatever the single surviving path now trusts — ask
what that is before calling anything done. Four lanes are alive, idle and re-adoptable
(webapps-4d builder, webapps-d1 tester, webapps-42 auditor, webapps-17 relay). ⛔ ASK each its
model; never read it from a table.

-----------------------------------------------------------------------------------------------
