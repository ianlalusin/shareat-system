# Handoff — 2026-09-06 (third wrap-up)

## Where things stand

⭐ **Phase 6 is CLOSED.** T-214 — the manager responsiveness scorecard — was specced and built in
this session, and it was the last slice. Earlier today T-222 shipped store creation. Both are
pushed; `main` is at the sha below and the tree is clean.

The next agent is **starting Phase 7**, not finishing Phase 6. Nothing in `docs/tasks/` is
half-built.

## Gates at `b1c496c`

| Gate | Result |
|---|---|
| **typecheck** | exit 0 |
| **unit** | ✅ **1022 passed · 1 skipped · 0 FAILED — green for the first time.** DEF-170 fixed this session (was 1021 / 1 failed) |
| **integration** | ✅ **2422/2422 · 96/96 files · exit 0**, against `shareat_test` |
| **T-214 alone** | ✅ **24/24**, run twice to prove no cross-run pollution |
| **build** | ✅ exit 0, dev server stopped first by process enumeration. `/findings/scorecard` present |
| **smoketest** | ✅ **13/13** on 9008 (T-214) · 0px horizontal overflow at 390px on both findings routes |
| **the new job, for real** | ✅ `npm run finding-observation` on `shareat_dev`: 5 occurrences opened; **second run opened 0**, proving idempotence; both recorded in `scheduler_runs` |

## What happened this session

### T-222 — store creation (`/admin/stores`), and DEF-189

Shipped earlier today. Until it landed **nothing in the codebase created a store**. The store row,
its default room and the §C.2 admin fan-out commit in one transaction, proved by an injected
failure. **DEF-189** was found by the smoketest, not the suite: a manager clicking a store in a list
they may read got an **HTTP 500** instead of a refusal. The trigger is **calling a domain function
to satisfy a page read** (domain functions authorize by contract) — not, as it first appears, an
ungated list beside a gated detail page; `/admin/users` is that shape and is clean.

### T-214 — the scorecard, and the clock findings do not have

⭐ **Specifying it established that v1's scorecard cannot be ported at all.** v1's score needs a
finding's **first-seen** date. A v2 `DetectedFinding` is a pure function of current state, carries no
timestamp and cannot, and almost no detector can be re-asked *"as of"* a past date. So two thirds of
the task is building the clock — `finding_occurrences`, an append-only log written by a new **daily**
`finding_observation` scheduler job — and the score itself is about forty lines.

⛔ **That log is an OBSERVATION, not finding state.** Nothing in the detection path reads it, asserted
by deleting every row and re-reading the feed. Bible row 123 stands.

⭐ **The design decision (bible row 177): score what was FIXED, never what was accepted.** Mapping
v1's *resolved* onto v2's *acknowledged* re-opens exactly the hole T-135 closed — acknowledging means
the condition **still holds** and is accepted for 30 days, so a score counting it pays managers to
accept risk. The action component counts occurrences that **cleared**; acknowledgement is reported
beside the score with its age, never inside it.

### ⚠️ Three self-inflicted errors, none caught by a test — the real lesson of the day

1. **The first render scored three innocent branches `0`.** Their findings had been raised that
   morning; `cleared / raised` cannot tell *"ignored"* from *"has not had a chance"*. Findings inside
   a 14-day grace window are now **pending** — excluded from the denominator, shown in their own
   column, scoring a dash. **Every test passed both before and after.** Found by looking at the page.
2. **Four of my own new tests were green only by luck** — their count queries were not scoped by
   `org_id`, so they passed against an empty table and read `expected '8' to be '2'` on the second
   run. Fixed, then verified green twice.
3. ⛔ **A wrong claim reached a pushed document.** This morning's handoff said migration `0129` was
   on "3 of 9 databases, `shareat_test` missing". It is **4 of 10 and `shareat_test` has it**. The
   probe built each URL with a string `replace`, and **this project's Postgres password contains an
   `@`**, so it connected elsewhere and reported confident nonsense. **The tell was visible and I did
   not read it: a database supposedly missing a migration whose own suite was green.** ⚠️
   `packages/db/migrate.ts` already carries a comment about that exact `@` (DEF-030).
4. ⭐ **The sharpest one, and only the FULL suite could catch it.** I applied `0130` to four
   databases **by hand**. That runs the SQL but does **not** write Drizzle's
   `drizzle.__drizzle_migrations` journal — so the databases were right and the journal was wrong,
   the real migrator considered `0130` unapplied, and `journal.test.ts`'s *"re-running the migration
   is a no-op"* failed with `relation "finding_occurrences" already exists`. ⛔ **A hand-applied
   migration is not an applied migration.** Fixed by reverting the objects on all four and letting
   `migrate()` apply and record them (journal 113 → 114 each). My targeted test run was 24/24 and
   could never have seen it.

### Where each decision is recorded

| Decision / finding | Recorded in |
|---|---|
| Score what was fixed; the observation log is not finding state | `PROJECT_BIBLE.md` **row 177** (`npm run toc` run) |
| T-222's atomic half + derived checklist | `PROJECT_BIBLE.md` row 176 — **its stale "not yet built" tail corrected** |
| DEF-189, and the three errors above | `docs/DEFECTS-REGISTER.md` |
| T-214 as built, incl. the two spec corrections | `docs/tasks/214-manager-responsiveness-scorecard.md` |
| T-214 done, Phase 6 closed | `docs/plans/phase-6-reporting-and-dashboards.md` Wave 3 |
| The new daily job, its timer, and how to arm it | `docs/ops/README.md` + `provision.sh` |
| The URL landmine | Claude memory `reference_postgres_url_string_surgery.md` |

**Roadmap: updated.** T-214 is `t-done`, both phase headers now read **Phase 6 COMPLETE ·
T-209–T-214, T-218–T-224 all shipped**, and the chip moved `c-active` → `c-done`. HTML verified
balanced (575/575 divs).

## Pick up here

1. ⛔ **THE TIMER CANNOT BE ARMED YET, AND THE REASON IS BIGGER THAN THE TIMER.** Ian asked for it
   on 2026-09-06 and it could not be done — established by checking, not assumed:
   - ⚠️ **CORRECTION — the app IS live.** An earlier version of this file said "nothing has ever
     been deployed". **Wrong.** `https://erp2.shareat.net/` returns **HTTP 200**. What is true is
     narrower: the *`Deploy` workflow* has never completed — 29 `skipped`, 1 `failure`, 0 success —
     and the live deployment was made another way (`9139f29`, *"deployment live: erp2.shareat.net"*).
     ⛔ **The error was inferring "never deployed" from "the workflow never ran" without checking
     the site**, which is the same shape as the `0129` mistake above: an indirect signal trusted
     over a direct one that took ten seconds to check.
   - ✅ **CI is now green** (DEF-170 fixed, item 3) and `Deploy` **ran for the first time**. It got
     as far as **Ship the artifact**, proving the droplet, the deploy key and the `shareat` user all
     work, then failed on:
     ```
     ln: failed to create symbolic link '/srv/shareat.new': Permission denied
     ```
     ⭐ **`provision.sh` already fixes exactly this** (`chgrp shareat /srv; chmod g+w /srv`, added
     in `9139f29` with a comment quoting this very error as *"found the hard way on a live deploy"*).
     So the repo is correct and **the droplet is stale** — it was provisioned before that fix.
   - ⚠️ **Production migrations DID apply** in that failed run (*"Migrations applied in 288ms"*
     against the DO managed Postgres), so **the production schema is now AHEAD of the running code**,
     including `0130`. That is safe here and only because `0130` is purely additive — two new tables
     and a widened CHECK constraint — so the older running code neither reads nor writes them
     (bible §15.5, expand/contract). ⛔ Do not assume the next migration is as forgiving.
   - **No agent or human holds standing SSH**, by Ian's own decision (`IAN-SETUP-CHECKLIST.md` §4b):
     deploys run from GitHub Actions with a key in Secrets. ⛔ Do not seek a way round this.
   - `DEPLOY_HOST` / `DEPLOY_SSH_KEY` **do** exist in Secrets (set 2026-09-04), so the credential
     half is done. Only a green CI is missing.

   **What is actually left, and both steps need root on the droplet — Ian's, not an agent's:**
   ```sh
   # 1. Re-run provisioning. It is idempotent, it fixes /srv's group-write (which unblocks the
   #    Deploy workflow), and it INSTALLS the new T-214 unit files, which is the only way they
   #    reach the box — the deploy workflow does not ship unit files.
   sudo bash /srv/shareat/docs/ops/provision.sh          # or from a fresh checkout

   # 2. Arm the timer.
   sudo systemctl enable --now shareat-finding-observation.timer
   systemctl list-timers          # NEXT and LEFT must be populated for all FOUR timers
   sudo systemctl start shareat-finding-observation.service   # prove it runs once, now
   journalctl -u shareat-finding-observation.service -n 50
   ```
   ⚠️ Step 1 is not optional and is easy to miss: **`provision.sh` is the only thing that installs
   unit files**, so without it `systemctl enable` in step 2 fails with "Unit not found".
   ⚠️ **A skipped day cannot be reconstructed** — the detectors read live state, so every day
   between now and arming is permanently absent from the record.
   ⚠️ Ian *can* bypass CI with a manual `workflow_dispatch` (the job allows it), but that ships a
   red build to production and is his call alone — no agent should trigger it.
2. **Phase 7 planning.** Phase 6 is closed; there is no half-built work to inherit. `docs/ROADMAP.html`
   and `docs/CAPABILITY-GAPS.md` are the inputs.
3. ✅ **DEF-170 — FIXED this session, which is what unblocked everything above.** It was CI's only
   failure, `deploy.yml` is gated on CI, and so every `Deploy` run in the repo's history read
   `skipped`. ⭐ **The engine was never touched** (`git diff` on `compute-day.ts` is empty) — both
   causes were in the golden master's *triage*: two specimens had two known causes each and every
   class carried a strict single-field signature, and `lipa-0359` was the mirror of class D, which
   only ever covered one direction. ⚠️ **One thing there is still Ian's**, and it is in the
   pay-movement list rather than hidden: `lipa-0359` claims **8h where v1 paid 9h** — a staffer who
   punched in 20 minutes early on Lipa's stale grid (DEF-087) now gets 5h as a half day plus **3h
   of PENDING overtime awaiting a manager**, by Ian's own `shortShiftHalfDayOt` rule. Nothing is
   taken from them; it needs an approval that v1 did not.

## Do not decide these alone — they are Ian's

1. **T-214 Q1 — is a per-STORE score acceptable?** A cleared finding has no actor, so per-person
   attribution is not missing but *meaningless*. Built as per-store with managers listed beside it.
2. **T-214 Q2 — should acknowledgement ever be scored, even negatively?** Currently reported only.
   Recommendation: leave it, until there is real data — there are still **0 acknowledgements ever**.
3. **T-214 Q3 — does the view log get scored later?** Built and shown, not scored.
4. **T-222 Q2 — should `deactivateStore` refuse with an open sales day or unremitted cash?** Still
   **not implemented**; it deactivates unconditionally.
5. **Should `manage_stores` stay in the admin-less manager elevation?** In an org with no admin a
   manager can open a branch. It was **inherited from the matrix, not chosen**.
6. **T-221's composite FK** proposal — open from an earlier session.

## Traps that have actually bitten — live in this area right now

- ⛔ **Never hand-split the Postgres URL.** The password contains an `@`; a string `replace` connects
  somewhere else silently. Use `new URL()` and set `.pathname`. This produced a wrong claim in a
  pushed handoff today.
- ⛔ **`TEST_DATABASE_URL` is `shareat_test`, not a lane DB**, and `tests/integration/setup.ts` runs
  **no migrations**. A new migration must be applied to it by hand or every new table is missing at
  test time. Migration `0129` is on `shareat_dev`, `shareat_test`, `_e2`, `_lane25`; **missing** on
  `_lane15`, `_a`, `_b`, `_202`, `_203`, `_204`. `0130` is on `shareat_dev`, `shareat_test`, `_e2`,
  `_lane25`.
- ⛔ **Never run two `vitest --project integration` processes at once** — they share `shareat_test`
  and truncate each other's tables. It surfaces as `PostgresError: deadlock detected` in fixture
  setup and looks like a code bug.
- ⛔ **Never hand-apply a migration.** Running the SQL yourself leaves the database right and
  Drizzle's `drizzle.__drizzle_migrations` journal wrong, and the divergence is invisible to every
  test except `journal.test.ts`'s migrator re-run. Use `migrate()` (or `npm run db:migrate` with
  `DATABASE_URL` pointed at the target), which applies **and records**.
- ⚠️ **Backticks inside a double-quoted shell string are COMMAND SUBSTITUTION.** Two code spans
  silently vanished from a `PROJECT_BIBLE.md` row today (`createLocation` and `manage_locations`
  became empty). Use the Edit tool or a file, never inline shell, for prose containing backticks.
- ⚠️ **`next-env.d.ts` flip-flops** between `./.next/dev/types/` and `./.next/types/` depending on
  whether `dev` or `build` ran last. HEAD carries the **dev** variant; restore it, don't commit it.
- ⚠️ **`pgrep -f vitest` in Git Bash cannot see Windows command lines.** Use
  `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*shareat-system*' }`.
- ⚠️ **`shareat_dev` still has ZERO `store_item_thresholds` rows**, so the low-stock features
  (T-223/224) cannot be exercised on dev data.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then docs/RULES.md if you
haven't this session. Check ListAgents first — this tree is shared and a peer may be mid-task.

Phase 6 is CLOSED (T-214 shipped last session). Nothing is half-built. You are starting Phase 7 —
read docs/ROADMAP.html and docs/CAPABILITY-GAPS.md, and ask Ian which slice he wants before
writing a spec.

⛔ FIRST, and it is one line: the new daily timer from T-214 is installed but NOT ARMED —
`sudo systemctl enable --now shareat-finding-observation.timer`. Until then the findings clock
never starts and /findings/scorecard stays empty. docs/ops/README.md explains why this exact step
has been missed three times before.

Before test:integration, confirm your DB has migrations 0129 AND 0130 — TEST_DATABASE_URL is
shareat_test (not a lane) and the setup runs no migrations. Never run two integration suites at
once; they share that DB and deadlock. Before npm run build, confirm 9008 is free by process
enumeration, not pgrep.
```
