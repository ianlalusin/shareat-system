# Handoff — 2026-09-12 (evening)

## Where things stand

**T-264 is COMPLETE — all three slices.** An accounting month can now be created (slice 1), closed
(slice 2), and posted into once on the record by an `admin` or `super_admin` (slice 3, today). The
period is never reopened, and no reopen path was built — bible row 193 is explicit that reopening
remains unbuilt and was not what Ian was asked.

**T-271 and T-273 also shipped.** Nothing is half-built. Both worker lanes stopped at task
boundaries with no uncommitted work of their own, and the tree is clean.

⚠️ **What remains Ian's, not an engineering step:** tightening `DATABASE_URL` on the production host.
Unblocked since yesterday; nothing in the codebase stands in the way.

---

## Gates at `9e04a56`

⚠️ Measured at `9e04a56`, the last commit that changed CODE. Everything after it is documentation.

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0**, clean |
| `npm run test` (unit) | **98 files · 1365 passed · 1 skipped · 0 failed** |
| `npm run build` | **exit 0** — dev server stopped and port 9008 **verified free by process enumeration** first, not by intent |
| Smoketest on 9008 | `/sign-in` **200** on the restarted dev server |
| Integration — **full suite** | ⭐ **119 files · 2788 passed · 0 failed**, 1624s, lane A's database with `0143` applied |
| Integration — **independent re-run** | ⭐ **6 files · 73 passed · 0 failed** on the orchestrator's OWN database |

⭐ **Both integration numbers are stated because they answer different questions.** The full suite
proves nothing else broke. The independent re-run proves the result is not an artefact of one
database or one lane's harness — it covered `period-override`, `post-entry`, `post-entry-party`,
`reverse-entry`, `fiscal-period-close`, `fiscal-periods-seeding`.

⚠️ **The two that mattered most were `reverse-entry` and `fiscal-period-close`.** Both exercise the
trigger functions `0143` rewrote, and `reverse-entry` posts into closed periods through reversal's
own legitimate path (`0003:202-208`) — exactly where a regression in this change would hide. ⭐ **The
lane named them as its own unverified gap before anyone asked it to.**

⚠️ **One deviation, named not buried:** lane A proved migration `0143` by applying it straight to its
own lane database rather than to a throwaway scratch database first (ADR-012 §5 step 8). Mitigated
after the fact — the orchestrator applied `0143` cleanly to a **second, independent** database — but
the step as written was not followed.

---

## What happened this session

### The main job

| Task | Sha | What |
|---|---|---|
| T-264 slice 3 | `018af6f` | The fiscal-period override, migration `0143` |
| T-271 part 1 | `627a856` | DEF-301 — the message map is looked up by name |
| T-271 part 2 | `0517bae` | The trap that bit twice in one day becomes a red CI run |
| T-273 | `a5c50b6` | DEF-303 — a job with nothing to run it now fails the build |
| pre-wire | `d7436fc` | `override_period_lock`, bible row 196, ADR-006 amended |

### ⛔ The four findings worth more than the tasks

1. **DEF-302 — the override is unreachable on three real flows.** `commissary/transfer.ts`
   `confirmReceipt`, `production/index.ts` `runProductionPosting` and `trade/returns.ts`
   `recordInternalReturn` each insert a stock movement and post a ledger entry on the **same
   transaction, movement first**. `stock_movements_check_period_open` has no override concept, so on
   those three the transaction dies before `postEntry` and an authorised admin sees a **stock** error
   with nothing indicating the override was never consulted. ⭐ **Found by a lane ANSWERING A
   BRIEFING QUESTION** — *"does any path that calls `postEntry` also insert into `stock_movements` in
   the same transaction?"* The orchestrator expected zero and the answer was three.
2. **The override quietly widened, and it took a ruling.** `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`
   is DERIVED as admin-yes/manager-no, so the new capability **enrolled itself** into the
   adminless-manager fallback — contradicting row 193's *"admin and super_admin, nobody else"* with
   **nothing going red**. Ian ruled the enrolment correct (row 196). ⚠️ The orchestrator recommended
   the opposite and was wrong on the codebase's own evidence: the pin's existing comments already
   record that a hand-maintained carve-out in a derived set is what drifts.
3. **T-271's first pass regressed DEF-279's five, and the 26-row table could not see it.** Every one
   of the 26 mapped constraints is a native violation populating **both** `constraint_name` and the
   prose, so all 26 rendered identically and the before/after pass was honestly complete — while the
   five hand-raised invariants, which populate only the first, were being flattened from *"journal
   entry 9f3a is unbalanced: debits 100.00 <> credits 90.00"* to *"That change isn't allowed for that
   record."* ⛔ **The same mistake T-270 made and reverted three days earlier.** Caught in review, not
   by any gate — every gate was honestly green.
4. **DEF-303 and DEF-304 — two more guards that see less than they claim.** `budget_reissue` is a
   seventh registered job with no `.service`/`.timer` pair at all; and T-236's own
   "every job has a caller" guard reads **one hardcoded file**, so `runRecurringExpenses` — which
   lives elsewhere — is invisible to it, not merely uncalled.

### ⭐ The pattern worth carrying forward

**Three guards this week were found asserting more than they check** — DEF-295 (two of nine source
roots), DEF-296 (could notice a DELETED file, never a FIXED one), DEF-304 (one hardcoded file). In
**all three** the guard's SCOPE was narrower than its CLAIM, and in all three it passed happily while
blind. ⛔ **A positive control on the SIZE of a scanned set cannot catch this. Only a control on
whether the set is the RIGHT one can.**

### Decisions Ian made today, and where each is recorded

| Decision | Recorded in |
|---|---|
| The override enrols into the adminless-manager fallback, and that is **intended** | `PROJECT_BIBLE.md` §13 **row 196** |
| Wire the orphaned-file sweep — **nightly** | `docs/DEFECTS-REGISTER.md` DEF-299 · `docs/tasks/272-*.md` |
| Amend ADR-006's Gates table (DEF-293, DEF-294) | `docs/decisions/ADR-006-period-close.md` §Gates |
| `webapps-65` stays on the team as lane B | this file, below |

### Decisions the orchestrator made, flagged in case they are wrong

- **`locked` is out of scope for the override** — only `closed`. A locked period's balances have
  already been consumed by a later year's close, so an entry there silently breaks the closing entry
  that consumed them. This reads bible row 193 precisely rather than narrowing it; both it and
  DEF-284 say **closed**.
- **The reason enum** — `late_supplier_invoice` · `regulatory_correction` · `data_entry_error` ·
  `other` with a mandatory note. A HOW, so not escalated.
- **DEF-303 rolls into T-272** rather than getting its own task.
- **Scoping the sweep per-org, and thereby removing it from row 194's closed cross-org list, is
  sanctioned without a fresh ruling** — row 194 says in terms that a subsystem leaves that list by
  being given a principal, and removal narrows privilege. ⚠️ **Record a bible row when T-272 does
  it.**

---

## Pick up here

**1. T-272 — the orphaned-file sweep, nightly, plus DEF-303's `budget_reissue`.** Ian ruled it.
⛔ **Read the SCOPE CORRECTION at the end of `docs/tasks/272-*.md` before planning** — it is **not**
"a script and a timer". `sweepOrphanedFiles` takes no `orgId` and `scheduler_runs.org_id` is
`NOT NULL`, so as written **it cannot record a run at all**, and the task's own non-negotiable is
that a sweep recording nothing is not wired. Migration slot **`0144`**, `when` must exceed
**`1798428707084`**.

**2. DEF-304** — T-236's guard reads one hardcoded file. Fix it with or right after T-273's sibling,
so the two agree on how jobs are discovered. ⛔ Prove it the way DEF-295 was proven: plant a
violation in a previously-unscanned location and watch it fail.

**3. The year-close journal entry** (ADR-006), still unassigned: one entry via `postEntry`, dated the
following Jan 1, zeroing income/expense into 3300, with a distinct `source_type`. ⭐ **No migration
needed** — `journal_entries.source_type` is free text with no CHECK constraint. It was kept out of
today's cycle because it touches the same ledger code T-264 slice 3 was in.

---

## Do not decide these alone — they are Ian's

| Question | Recommendation on the table |
|---|---|
| **`DATABASE_URL` on the production host** | Tighten it whenever you like. Unblocked since yesterday; no engineering step remains |
| **DEF-302** — the override is unreachable on three stock-moving flows | **(b) Make the refusal honest** — teach `stock_movements_check_period_open` to recognise the override GUC and refuse anyway, with a message saying the override does not extend to stock movements. Changes no behaviour, costs almost nothing, removes the whole diagnostic problem. (a) leave it; (c) extend the exemption — ⛔ expensive, recomputes inventory layers and COGS, needs its own ADR |
| **Two timers to arm, not one** | T-272 will produce unit files for both the orphan sweep and `budget_reissue`. Arming either on the droplet is Ian's step (DEF-194) |

---

## Traps that have actually bitten — live in this area right now

- ⛔ **A before/after table can be honestly complete and still blind.** T-271's 26 rows were all
  native constraints populating both the structured field and the prose; the five that populate only
  one were the entire point of the defect and no row could move. **Ask what the passing set cannot
  contain.**
- ⛔ **The LOOKUP and the SANITISER need different resolvers.** *Which constraint is this?* → the
  structured field. *Is this raw Postgres grammar a person must never read?* → the name appearing in
  the PROSE. A hand-written `RAISE EXCEPTION` is not raw grammar.
- ⛔ **A capability with `manager: false` enrols itself into the adminless-manager fallback.** The set
  is DERIVED. Adding an admin-only capability widens that fallback with no edit to any list and
  nothing red. Check `tests/unit/capability-matrix.test.ts`'s pin every time.
- ⛔ **Only a pre-edit measurement is a baseline.** Once `0143` is applied to a database the pre-0143
  refusal cannot be reproduced there. Capture the literal text first, in the report, not in scrollback.
- ⛔ **Never `npm run test:integration`** — it hits the shared database. Give every lane its own DB
  (`~/.claude/skills/orchestrator/tools/make-test-dbs.mjs`, run with `it.mjs`). No collision all day.
- ⛔ **Stop the dev server before `npm run build`** and verify by **process enumeration**, not intent.
- ⚠️ **In PowerShell, `VAR=1 cmd` does not set the variable.** Use `$env:VAR=1` as its own statement.
- ⚠️ **This handoff's own smoketest recipe went stale in one day.** Yesterday's said `/setup` with a
  forged cookie renders *"This system is already set up."* It now returns **307**, which is correct
  for a database that IS set up. The cookie name still matches; the recipe was just describing a
  different state. **Re-derive a smoketest recipe before trusting it.**

---

## Live agent sessions at wrap-up

| Session | Lane | Model | Lane DB | State |
|---|---|---|---|---|
| `webapps-4e` | A | Sonnet 5 | `shareat_test_lanea` | **released, idle**, no work in flight. Built T-264 slice 3 |
| `webapps-65` | B | Sonnet 5 | `shareat_test_laneb` | **released, idle**, no work in flight. Built T-271, T-273, the discovery doc |
| `system32-85` | orchestrator | Opus 5 | `shareat_test_orch` | this session — clear it |

**Worker lanes stay alive and are re-adopted; only the orchestrator is cleared** (CLAUDE.md, Ian
2026-09-07). ⭐ **Both lanes confirmed Sonnet in their own ACKs** — no `/model` switching needed.

⭐ **Both of today's real findings came from a lane raising something rather than from a test** —
DEF-302 from a briefing question, and T-271's regression from lane B flagging a concern *after* its
work had already been accepted and the easy move was to bank the commit.

---

## Numbers to allocate from

- Next task: **T-274**  ·  Next defect: **DEF-305**
- Next migration: **`0144`**, `when` must exceed **`1798428707084`**

---

## The paste-ready prompt

```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system), picking up
from the 2026-09-12 evening handoff. Run the global /orchestrator skill.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 193-196,
docs/DEFECTS-REGISTER.md section E (DEF-302 to DEF-304 are today's).

T-264 is COMPLETE — all three slices. Do not reopen it. Your first job is T-272, the orphaned-file
sweep; ⛔ read the SCOPE CORRECTION at the END of docs/tasks/272-*.md before planning, because the
task is NOT "a script and a timer" and its own spec above that section reads as if it were.

Tell Ian that tightening DATABASE_URL on the production host is still his call, and that DEF-302
has three dispositions waiting on him.

Two worker sessions are alive and idle and are yours to re-adopt: webapps-4e (lane A,
shareat_test_lanea) and webapps-65 (lane B, shareat_test_laneb), both Sonnet 5 and both confirmed.

Migration slot 0144 is free; `when` must exceed 1798428707084. Next task T-274, next defect DEF-305.

⭐ Ask each lane a QUESTION in its briefing, not only for a change. Both of today's real findings
came from that, and neither would have been found by a test.
```
