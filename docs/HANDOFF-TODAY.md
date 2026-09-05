# Handoff — 2026-09-05 (evening)

## Where things stand

**Two tasks shipped and pushed since the midday wrap-up**: **T-219** (users and roles,
`/admin/users`) and **T-218** (one clock for every findings detector, plus the detector T-213
promised). Both are on `main` at `40a0cd0`, and the working tree is completely clean.

**T-219 closed a chain that had been dangling since this morning.** `authorize.ts` treats *no
active role* as a hard denial by design, and nothing in the hire flow assigns a role — so once
T-217 shipped PIN issuance, the sequence read **hire → PIN → sign in → nothing**. Every hire could
authenticate and was then authorized for zero capabilities at zero stores. The list page proves it
with live data: the four `SMOKETEST T217` people hired that same morning all render *"no role —
cannot do anything."*

Phase 6 is effectively done (T-209–T-213, T-218, T-219). **T-214** (manager responsiveness
scorecard) is next in the phase plan. Phase 7's other half — **store creation/management** — was
deliberately deferred by Ian today and has no spec yet.

## Gates at `40a0cd0`

- **typecheck**: clean, exit 0
- **unit**: **1016 passed / 1 skipped / 1 failed** — the failure is
  `tests/golden/attendance-adjudication.test.ts`, DEF-170's 3 residual golden-master divergences.
  Pre-existing, unchanged all day, tracked, **not a regression**.
- **integration**: **2351/2351, 94/94 files, exit 0**, 1329s on an isolated lane DB
  (`shareat_test_lane15`). ⭐ **This was T-218's first successful full-suite run ever** — that
  session had never managed to complete one. Arithmetic, so nothing is assumed skipped: this
  morning's 2327 across 92 files + T-219's 19 + T-218's 5 = 2351; 92 + T-219's two new files = 94.
- **build**: **exit 0** — Next 16.3.2/Turbopack, compiled 8.9s, 11 static pages, dev server
  confirmed stopped first. One run covering both tasks.
- **smoketest (T-219)**: **20/20** live on 9008, headless Chromium, screenshots reviewed. §C.1's
  refusal renders as a real sentence; appointing an admin reports *"granted store scope for 3
  store(s)"* — **3, not 4, because one store is inactive**, so the active-store exclusion holds in
  the app and not only in a test; the last admin cannot be demoted; the self page offers no role
  form at all; grant/revoke round-trips; **zero horizontal overflow at 1280 AND 390**.
- **smoketest (T-218)**, stated precisely because it matters: `/findings` rendered with no page
  errors, but `receivingDisputeOverdue` **did not fire on real dev data** — both live disputes are
  2 days old. One row was temporarily aged to 20 days to see it render, then restored to its exact
  original timestamp. *Not* "seen on real data."

## What happened this session

**T-219 — users and roles (`/admin/users`), closing DEF-167.** Specced first per RULES rule 8,
then built. `assignRoleAsActor` is the single gated entry point and carries five checks:
`authorize(manage_users)`, no self-change, target-in-org, the §C.1 authority chain (only a
super-admin appoints an admin), and the last-admin guard. **It lives in `packages/auth`, not the
server action `CAPABILITY-MATRIX.md` §C.1 literally names** — that ADR was written when no screen
existed, and its actual rule is *"the check belongs at the call site and must be tested there."* A
rule living in one route file is a rule the second caller misses, which is exactly how DEF-180
happened, and a Next server action cannot be integration-tested against real Postgres. 19 new
integration tests, each watched fail first.

**Four defects filed, and they are not all the same kind:**

- **DEF-180** — `CAPABILITY-MATRIX.md` §C.2 decided on 2026-08-25 that appointing an admin
  materialises a store-scope row per store. `assignRole` implemented §B.1's sibling decision and
  **nothing for §C.2**. It never fired only because nothing called `assignRole`. Fixed inside
  `assignRole`, not the caller.
- **DEF-181** — `/settings` and `/settings/attendance` shipped with T-201 linked from nowhere, the
  exact defect `nav.tsx`'s own header comment was written about. New "Setup" nav group.
- **DEF-182** — `roles.ts` asserted the authority chain was *"enforced by the CALLER via
  `authorize()`"*. §C.1 established six days later that `authorize()` **cannot** express it. The
  comment named an enforcement that was impossible, and read as settled for two weeks.
- **DEF-183** — ⭐ **the one worth reading.** `person_roles`' RLS policy checks the *row's*
  `org_id`; its two sibling tables derive org *through the person* with an explicit `WITH CHECK`.
  All three end in `= app_current_org()` and read as equivalent. **Only the latter two isolate**, so
  a cross-org role assignment was allowed. Found by writing a test that expected a refusal and
  getting *"promise resolved instead of rejecting."* Closed at the call site; **the proper fix is a
  migration and is still open.**

**T-218 — findings clock correctness (`ianla-25`'s work, committed here at `40a0cd0`).** DEF-172
was filed as "four detectors use bare `current_date`" and was **ten sites across four files in
three mechanisms**, with the row naming the wrong function for one. `MANILA_TODAY` /
`daysBetweenDates` now live once in `packages/db/src/repo/sql-time.ts`, and
`tests/unit/findings-single-clock.test.ts` fails the build on any bare `current_date` or
`Date.now()` across all 55 files in `packages/db/src/repo`. DEF-176's `receivingDisputeOverdue`
now exists and is registered.

⭐ **Four of the day's rows share one shape, and it is worth naming**: *a claim of coverage with
nothing executable behind it.* DEF-175 (a comment naming the wrong basis) · DEF-176 (a plan naming
a task that never built it) · DEF-180 (an ADR decided, never written into the function) · DEF-182
(a comment naming an impossible enforcement). **DEF-183 is the sharper counter-case**: there the
prose was *right* and the mechanism was subtly wrong. Reading it reassured; running it refused.
A sweep for coverage-claiming phrases that name no test was discussed and **deliberately not
smuggled into either task** — it is Ian's to schedule.

**Decisions of Ian's this session:** one — **store creation/management is a separate task from
user/role management** (2026-09-05). Recorded in `docs/tasks/219-user-and-role-management.md`'s
*Out of scope* with the reasoning. `ianla-25` confirms no design decisions of Ian's arose in their
session; everything in T-212/T-218 was their own judgement and is already in the task docs and
register rows. **Nothing is left living only in a transcript.**

**Roadmap**: updated — T-218 and T-219 both marked `t-done` with real scope, masthead line and
Phase 6 chip refreshed (`39db5b8`, `40a0cd0`).

## Pick up here

1. **⭐ DEF-183's RLS migration — small, and it should not wait.** Align `person_roles`' policy
   with its two siblings by adding the person-org `EXISTS` clause to its `WITH CHECK`, so the
   database enforces isolation rather than one function (RULES §6.3). T-218 added no migration and
   T-219 changes no schema, so this has had no home; **the next access migration is its home.**
   ⚠️ A person-keyed access table must use the `via_person` form whether or not it carries its own
   `org_id` — the realistic failure is someone adding a fourth access table and copying whichever
   policy they opened first.
2. **Store creation/management (`/admin/stores`)** — Phase 7's other half, deferred by Ian today.
   Needs its own spec. ⚠️ **It is not a form**: a store carries cash-custody policy behind a DB
   check constraint (`stores_pooling_requires_ceiling_check`), and **§C.2's second half applies** —
   *a store created later appears in nobody's scope*, so `createStore` must fan scope rows out to
   that org's existing admins or a new branch is invisible to the person who just opened it,
   failing like a permissions bug. No `createStore`-shaped function exists anywhere today.
3. **T-214 — manager responsiveness scorecard**, next in
   `docs/plans/phase-6-reporting-and-dashboards.md`.
4. **DEF-170's 3 residual golden-master items** — low urgency, still needs an owner (whoever holds
   the attendance lane). Unchanged from prior handoffs, and the reason `npm test` is 1-red.

## Do not decide these alone — they are Ian's

- **Should `manage_users` move to `manager`, scoped to their own org?** `CAPABILITY-MATRIX.md`
  §Open 3 already predicts this as *"the friction point"* and sets the trigger: *"if it happens
  twice, move it."* Building the screen produces the first real evidence. **New today.**
- **A sweep for "claims of coverage that name no test"** — four of today's defects share that
  shape. Cheap version: grep `packages/**/src` and `docs/plans/**` for *"enforced by"*,
  *"guaranteed by"*, *"covered by"*, *"handled in"*, then check each for a named test.
  **Recommendation: worth one timeboxed pass. New today.**
- **DEF-063 (PIN sign-in rate limiting)** — deferred 2026-08-25 pending real staff and real data;
  both conditions are now true. **Recommendation on the table: reactivate.** Carried, unchanged.
- **Should `/sign-in`'s default post-login redirect move from `/sales-days` to `/`?** Only sound
  for roles passing `view_financial_reports`. Carried, unchanged.
- **Should the dashboard's "Expenses" tile split into Cost of sales / Operating expenses?**
  Carried, unchanged — `docs/tasks/211-manager-owner-dashboard.md`'s Open Questions.
- **Should PIN issuance require a capability distinct from viewing the staff roster?** T-217 reused
  `enrol_staff`. Carried, unchanged.
- **SC/PWD discount ID/name capture and BIR 1601-E withholding tax** — both live compliance
  exposures, neither v1 nor v2 handles either. Carried, unchanged.
- **Service-charge distribution (T-187)** — do not enable service charge in POS before it exists
  (DEF-082). Carried, unchanged.

## Traps that have actually bitten

- ⛔ **We share the MACHINE, not just the tree — and you cannot trust your own belief about what
  you stopped.** Tonight both sessions repeatedly believed processes were dead that were alive.
  Three independent causes, each of which could only ever confirm what we already thought:
  **(a)** stopping a backgrounded `npm run dev` / `npx vitest` kills the pipeline wrapper and
  **orphans the real child** — seven live processes accumulated, including a 1.4 GB dev server,
  while both sessions believed the machine was idle; **(b)** `pgrep -f vitest` in Git Bash
  **cannot see Windows command lines** and silently returned nothing all evening; **(c)** a command
  ending in `| grep …` **buffers**, so the log sits at 0 bytes until exit and a healthy run looks
  dead. ⭐ **Verify by enumeration:**
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*shareat-system*' }`
  ⚠️ **Neither of tonight's two "the suite died" reports has any support left** — both are equally
  consistent with a healthy run and a blind checker. Do not record them as OOM events.
- **Vitest's default reporter prints nothing without a TTY** — a redirected log shows `RUN` and
  then silence until the very end, indistinguishable from a hang. **Use `--reporter=dot`**;
  `--maxWorkers=4` keeps parallelism without the memory spike. (`--reporter=basic` does not exist
  in vitest 4 and dies with `ERR_LOAD_URL`, which reads like a project fault.)
- **`git diff` shows whole-file rewrites in this repo and it is cosmetic.** `ROADMAP.html` reads as
  ~2100 changed lines for ~5 real ones. It is a CRLF display artifact; **staging normalises** —
  verified by identical blob hashes for LF and CRLF input via `git hash-object --path`. Read the
  real diff with `git diff --ignore-cr-at-eol`. **Do not "fix" it.**
- **`git add <path>` takes the whole file, and this tree is shared.** A peer's concurrent edit to
  the same file lands in your commit. It happened three times today (`3e0089f`, `243da57`,
  `39db5b8`). Say so plainly in the commit message rather than rewriting history.
- **`next dev`'s worker pool wedges** — every dynamic `[id]` route returns 500 *"Jest worker
  encountered 2 child process exceptions"* while static routes serve fine. It never self-heals.
  Prove it is the server by hitting an untouched `[id]` route with a fake id, then kill by pid and
  restart.
- **`setPin` has no `authorize()` call of its own** — any new caller adds its own gate. Unchanged.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then
docs/RULES.md if you haven't this session.

Everything is committed and pushed at 40a0cd0 and the tree is clean —
T-219 (users and roles) and T-218 (findings clock) both shipped, gates
green except DEF-170's known-red golden master.

Pick up DEF-183: person_roles' RLS policy checks the row's org_id, never
the person's, unlike person_store_scope and person_grants which derive it
through the person with an explicit WITH CHECK. A cross-org role
assignment was therefore allowed; T-219 closed it at the call site in
assignRoleAsActor, but RULES.md 6.3 says the database should enforce it.
Write the migration. A person-keyed access table must use the via_person
form whether or not it carries its own org_id.

Then, if Ian agrees: spec store creation/management (Phase 7's other
half, deferred 2026-09-05). It is not a form — see the handoff's "Pick up
here" item 2 for the two constraints that make it a design pass.

Check ListAgents first — this repo is a shared tree, and verify processes
by enumeration, not by belief. See the handoff's traps section.
```
