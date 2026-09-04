# Handoff — 2026-09-04

## Where things stand

Phase 3 is 19 of 20 built (only T-177, POS mapping, left — now unblocked). Attendance/payroll's
"tested engine, no caller" pattern is closed (DEF-131–134). Production deployment happened for
the first time ever and is **live**: https://erp2.shareat.net. A separate session is mid-way
through remediating 6 of 8 findings from today's accounting-foundation audit — uncommitted, in
progress, do not touch its files (see "In flight elsewhere" below).

## Gates

**At `59c4082`** (T-176/T-178, code) — verified green before committing: typecheck clean,
996/997 unit, **2202/2202 integration**, build clean, both new screens live-smoketested on 9008
against real data (a real journal entry confirmed in `shareat_dev`).

**At `82c309d`** (HEAD, this wrap-up's own commit) — docs only, no code changed.

**⚠️ A gate run just now (for this wrap-up) shows red — NOT from either of the above commits.**
9 tests failing across 5 files (`ar.test.ts`, `loans.test.ts`, `prepaid.test.ts`,
`fixed-assets.test.ts`, `liabilities.test.ts`), all traced to a **different, currently-active
session's uncommitted, in-progress work** on T-207 (DEF-156/158/160/161/162/163 remediation) —
e.g. `prepaid.test.ts` calls `undoWriteOff`, which isn't exported yet. That session's own files
to finish and gate before it commits; nothing here was touched or fixed on its behalf. Build was
skipped both times — port 9008 has a dev server live for the whole session.

## What happened this session

**T-176 + T-178 — Phase 3's last parallel-safe pair, built as two concurrent lanes.**
Production/prep conversion (slab → slice, recipe → batch, the Phase-5 slicer-payment lock
stubbed) and order/channel wastage (disposition, the 15-day backstop, settlement matching)
merged, gated, and live-smoketested by the coordinator after both landed on isolated test
databases with no shared tables. Two spec-defects logged rather than silently matched:
**DEF-154** (T-176 §9 test 1's own worked numbers don't reconcile with its formula) and
**DEF-155** (the spec says sliced output posts to `1330`; the existing account router already
routes `meat_sliced` to `1310`, and reusing it — rather than adding an unspecced `prepped` item
kind — is the boring, standard choice). Both task docs' own `> **Status:**` lines updated
directly, not left to drift (they still said `SPEC` after being built and committed).

**DEF-164 — a bug the live smoketest caught that no test suite could.** Every one of
`wastage/actions.ts`'s five server actions called `redirect()` from inside its own `try` block;
Next.js signals a redirect by throwing, so the throw landed in that same function's own generic
`catch` and showed the user the literal string `"NEXT_REDIRECT"` on every save/dispute/resolve/
reverse click. Fixed with a re-throw guard, reverified live end to end. A repo-wide grep found
~37 `actions.ts` files with the same textual shape (redirect + a catch block) but that's not
proof of the same bug — two spot-checked files use the safe pattern. Logged as unverified,
not claimed fixed or ignored.

**Roadmap brought current** (Phase 3 → 19/20, the deployment story corrected from "in progress"
to "live," T-206 added, stale notes on T-201/T-204 fixed) across the whole range since the last
wrap-up (`da94710`, 2026-09-01), which also included: the four Phase 3 stock screens and channel
settlement's own screen catching up to engines that had been green-but-unreachable for days
(DEF-135, DEF-129, DEF-136, DEF-137, four engine bugs found building them); staff onboarding,
terminal/credential admin, and the Firestore sync relay actually running (DEF-131–134/151); T-205
— first production deployment, shipped and now live, with two ADR-002 amendments recording a
real conflict Ian resolved (keep the new droplet, not the old shared one); T-206 scoping the old
droplet's eventual retirement; and 8 new accounting-foundation findings (DEF-156–163) from an
audit run at Ian's request.

## Pick up here

1. **T-177 — POS item mapping and the daily usage pull.** Depends on T-176's recipe/unit-
   conversion module, which shipped today. Nothing else blocks it.
2. **Merge T-207/T-208** (the in-flight audit remediation) once that session commits — it's
   deliberately scoped around this session's own `findings.ts`/`repo/findings.ts` edits to avoid
   colliding, per its own task doc.
3. **DEF-153** — the bible's infra summary (line 598) and ADR-002's own overview/§5 still
   describe the rejected Cloud SQL + Firebase App Hosting architecture. Opus-planner edit,
   still open since T-205 shipped.

## Do not decide these alone — they are Ian's

- **DEF-154/155**: either correct T-176's spec text to say `1310`, or add a real `prepped` item
  kind so a `cook` run's output can use `1330` as originally intended. Recommendation: correct
  the spec — no `cook`-path use case has asked for a `prepped` kind yet, and inventing one now
  is exactly the kind of scope creep §0.5 warns against.
- **T-178's staff-charge disposition**: switched off on purpose (`isPhase5StaffAdvancesAvailable()`
  returns `false`), even though the payroll machinery it needs already exists. One-line flip
  when ready.
- **DEF-164's repo-wide scope**: is the redirect-in-try pattern worth a dedicated audit task, or
  wait and fix instances as they're found live (as happened here)? No recommendation either way
  — genuinely a judgment call on how much this class of bug is worth chasing preemptively.

## In flight elsewhere — do not touch

A separate, currently-active session has uncommitted changes across `ar/index.ts`,
`loans/index.ts`, `prepaid/index.ts`, `fixed-assets/capitalize.ts`, `trade/index.ts`,
`expenses/void.ts`, `chart-of-accounts.ts`, `liabilities.ts`, plus new files
`docs/tasks/207-audit-remediation-batch-1.md`, `docs/tasks/208-audit-remediation-batch-2.md`,
and two scratch scripts (`scripts/.tmp-it.mjs`, `scripts/.tmp-make-test-dbs.mjs`). This is T-207,
remediating 6 of today's 8 audit findings. Not committed, not gated, not touched by this
wrap-up — the 9 test failures above are its incomplete state, not a regression to chase.

## Traps that have actually bitten (this area, right now)

- **A redirect called inside a `try` whose `catch` is generic is silently broken** — the throw
  Next.js uses to signal a redirect gets swallowed and shown to the user as `"NEXT_REDIRECT"`.
  No test suite catches this; only a live click does. See DEF-164.
- **`INVENTORY_ACCOUNT_BY_ITEM_KIND` is the one account router — never hardcode a second one**,
  even when a spec's own worked example shows a different account. See DEF-155.
- **Two sessions sharing one working tree will both touch `docs/DEFECTS-REGISTER.md`,
  `classification.ts`, `rls/registry.ts`, and barrel files.** Re-read before editing if your own
  `Edit` call fails on a stale match — that's the other session having landed first, not a bug.

## The paste-ready prompt

```
Working in C:\Users\ianla\webapps\shareat-system. Read docs/RULES.md, then
docs/tasks/177-pos-item-mapping-and-usage-pull.md in full — it's SPEC status,
ready to build, and its one dependency (T-176's recipe/unit-conversion module)
shipped 2026-09-04. Before starting, run `ListAgents` — another session may
still be mid-way through T-207/T-208 (uncommitted work in ar/loans/prepaid/
fixed-assets/trade/expenses/chart-of-accounts/liabilities); do not touch those
files. Follow docs/RULES.md's TDD and definition-of-done exactly: typecheck,
unit, integration against real Postgres, live-smoketested on 9008, self-
reviewed, then update docs/tasks/177-*.md's own status line and
docs/ROADMAP.html before committing.
```
