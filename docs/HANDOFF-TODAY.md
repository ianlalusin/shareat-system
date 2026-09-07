# Handoff — 2026-09-07 (orchestrated multi-lane session)

## Where things stand

⭐ **A three-session orchestration shipped two tasks and closed the pilot's biggest blocker.** One
session led (the orchestrator); two Opus worker lanes built T-228 and T-229 in the shared tree,
coordinated by `SendMessage`, with the orchestrator reviewing every diff and doing every commit and
push. `main` is at `dad2053` and **the tree is clean** — nothing is half-built, both workers are
parked at task-complete boundaries.

⛔ **THE ONE THING THAT IS IAN'S, AND IT IS THE PILOT ITSELF.** Production now has the
`bootstrap-org` code but still holds **zero organizations**, and `shareat-finding-observation` exits
1 nightly until one exists. **Ian runs this himself** (`IAN-SETUP-CHECKLIST.md` §4b — no agent SSH),
once T-228's deploy lands:

```
npm run bootstrap-org -- --code=SHAREAT_OPC --name="SHAREAT OPC" \
                         --admin="<Ian's real full name>" \
                         --store-code=LIPA --store-name="SharEat Lipa" --confirm
```

The write path was de-risked against a throwaway DB (org/102 accounts/38 categories/admin/store/room/scope, atomic, PIN once, exit 0). The runbook is `docs/ops/README.md` §"Standing up an
organization". ⚠️ Values are Ian's: org code recommended `SHAREAT_OPC`, admin is a real person with a
real PIN (attributed on the ledger's first entries), and **only the FIRST store is created here** —
SharEat Malvar (and Banay-Banay/Davao if wanted) come afterward through `/admin/stores`, which is
that screen's first real production smoketest. The PIN prints once and is not recoverable.

## Gates (wrap-up, 2026-09-07)

- **typecheck** exit 0 · **unit** 1058 passed / 0 failed / 1 skipped (64 files) · **build** exit 0
  (9008 free, dev server stopped).
- **Full integration:** CI is the authoritative gate and it **passed on `d72c9be`** (the current
  tip, which includes T-228) — a fresh-checkout run of the whole suite + build. T-228's own CI run
  (`dad2053`) was cancelled by the `d72c9be` push seconds later, so `d72c9be`'s green is what covers
  it. Locally, T-228's two mandatory gates re-ran green (chart-of-accounts 77/77 plain-client,
  organizations 12/12 in a Drizzle tx), and lane A's full project run was 2489/2489 on its lane DB.
  ⚠️ The full local suite is **memory-bound on this machine** — run it chunked via `it.mjs`, as lane
  A did (13 chunks of 8 files), never as one `npm run test:integration` here.
- This wrap-up's roadmap + bible-row-180 commit re-runs CI on push; `toc-freshness` verified locally (4/4).

## What shipped today (all pushed; CI green on each)

| Ref | What | Where |
|---|---|---|
| **T-226** | AR clearing (collections, void, write-off, `/customers/[id]`) | live |
| **T-215** | Expense budgets (the envelope + cap) | live |
| **T-216** | Recurring-expense TEMPLATES (the job is blocked, deliberately) | live |
| **T-227** | Caller + nav-reachability guards | live |
| **T-229 slice 1** | Settings shelf `/settings` + map a category to an account — closes DEF-193's remedy | live (`31afb96`) |
| **T-228** | `bootstrap-org` — create an org atomically (DEF-195). Ian runs it on prod | pushed (`dad2053`), deploying |
| **Bible v3.7** | §13 row 179 — Ian's completeness + data-recency doctrine | committed |

**DEF-204–209 filed** (register §E). DEF-204 (Drizzle strips the shared client's jsonb serializer;
seeds now bind `()::text::jsonb`) is **fixed** in T-228. DEF-209 (RLS has no production callers — a
dormant safety net) is the significant one; see below.

## Ian's four decisions (2026-09-07) — FORMALIZE INTO BIBLE §13

Made via one AskUserQuestion; recorded in the register change-log; **the next Opus session should add
a §13 row** (the TOC-regen ceremony was deferred at the clear point):

1. **T-228 → push to production.** Done.
2. **DEF-207 → build a sales-channel admin surface** (not seed-at-creation). Lane B's next task.
3. **Q3 → order-wastage tracked-vs-instant becomes a per-CHANNEL policy**, not a per-record choice.
   Removes a choice staff have today; closes the skip-the-monitor/dispute-window/backstop hole.
4. **DEF-209 → schedule a dedicated RLS-enforcement assessment.** Lane A's next task.

## Queued work — the fresh session re-assigns these to the two lanes

**Lane A — DEF-209 RLS enforcement assessment** (READ-ONLY, no migration, no code). Deliverable
`docs/discovery/29-rls-enforcement-assessment.md`. Three questions in order: (1) does the app's
connecting role actually bypass RLS, or does it just never set `app_current_org()`? Prove it live on
a scratch DB. (2) Is any production org-scoped query missing its `org_id` predicate — i.e. is the net
load-bearing today? (3) What would routing every `transaction()` through `withPrincipal` cost? Read
bible §7 and RULES §3.6 first.

⭐ **HEAD START — lane A did the read-only reading before it was paused; use this, don't re-derive
(all citable; the one live PROBE was NOT run, so the conclusion is a HYPOTHESIS):**
- RLS is fully built, not merely dormant: `0011_row_level_security.sql` creates `app_current_org()`
  and role **`shareat_app` NOLOGIN** (sessions connect as owner, `SET LOCAL ROLE shareat_app` inside
  the tx by design). Across migrations: **126 ENABLE, 127 FORCE, 128 CREATE POLICY**; policies carry
  **no `TO` clause** so they apply to PUBLIC. `rls.test.ts` reads `pg_policies` and passes — the
  policies genuinely exist and are shaped right.
- ⚠️ **The paradox that IS the finding:** FORCE removes the owner's exemption, and
  `app_current_org()` is NULL with no principal, so `org_id = NULL` → a no-principal session should
  see ZERO rows and everything should break. It doesn't — 2489 tests read rows with no principal set.
  So **something bypasses FORCE, and the only candidates are: the connecting role is a SUPERUSER, or
  holds `BYPASSRLS`.** Migration 0011's own comment names this as trap #1 (*"running the app as
  `postgres` disables every policy while all tests still pass"*). This is SHARPER than my original
  brief — it is not "no principal set", it is likely "the app runs as a superuser, so RLS is entirely
  off."
- ⛔ **The one-line probe that settles Q1** (run on a scratch `_test` DB, not prod/dev):
  `select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;`
  A fuller probe (role attrs + ownership + enable/force counts + cross-org read with and without the
  GUC, all rolled back) was written to lane A's SESSION scratchpad as `rls_probe.ts` — it vanishes on
  clear, so re-derive from this line; the core is trivial.
- **Two doc issues the assessment must reconcile / fix:** (a) RULES §6 item 3 *"the database enforces
  the rules, not the service layer"* is about CHECK/triggers (balance, period, immutability), NOT
  tenancy — while **bible §7 rule 4** says store scoping is enforced in the REPO layer. The two point
  different ways on exactly DEF-209's question. (b) **`bible §6.3` does not exist** (§6 is Data
  conventions, no subsections) yet `packages/db/src/repo/stores.ts` cites it twice and T-222's spec
  repeats it — a citation that misdirects on this very design question. Worth a register line or a
  bible fix.

**Lane B — "sales channels: admin surface + wastage policy"** (DEF-207 + Q3). One package because
both touch `sales_channels`. Research → spec (orchestrator approves) → build. **Owns the ONE
migration this cycle** (a `sales_channels` wastage-mode column, plus whatever the admin CRUD needs).
Pilot-relevant: DEF-207 is why a bootstrapped store reads "not ready" (no channel writer in prod).
Then lane B's remaining slices: 2 (category create/rename + the normalised `lower(trim())` index,
DEF-205 — a migration), 3 (wastage monitor `stores.wastage_monitor_person_id`, DEF-206 — no
migration), 4 (org/store identity + TIN, DEF-208 — a migration). One migration lane at a time.

## How to resume the orchestration

1. This is the `/orchestrator` pattern — global skill at `~/.claude/skills/orchestrator/`
   (SKILL.md, `worker-briefing.md`, and `tools/make-test-dbs.mjs` + `tools/it.mjs`). Invoke
   `/orchestrator shareat system`.
2. `ListAgents` to find the worker sessions (they were `ianla-3a` = lane A, `ianla-14` = lane B; a
   fresh clear gives them new names). If they were cleared too, Ian opens fresh terminals and each
   sends "worker ready" to the orchestrator per the skill's one-liner.
3. Lane DBs already exist and are migrated: `shareat_test_t228` (lane A), `shareat_test_t229`
   (lane B). Run integration via `node ~/.claude/skills/orchestrator/tools/it.mjs <db> <files>`,
   NEVER `npm run test:integration` (that hits shared `shareat_test` and truncates a peer's fixtures).
4. Orchestrator alone commits (stage explicit paths, never `git add -A`; never `checkout -b` in the
   shared tree) and pushes. Workers never run git, `build`, or `dev`.

## Traps / state, live right now

- ⛔ **`sql.json()` after `getDb()` mis-binds** (DEF-204). Seeds are fixed; any NEW raw `getSql()`
  query needing jsonb must use `()::text::jsonb`, and a `Date`-typed timestamptz read through a raw
  client is unswept.
- ⛔ **Never hand-split the Postgres URL** — the password has an `@`; use `new URL()`. The lane
  tools do this correctly.
- ⚠️ Migrations `0131` (budgets) and `0132` (recurring) are on production (applied by the deploys).
  `TEST_DATABASE_URL` is `shareat_test`; its setup runs NO migrations — re-run
  `make-test-dbs.mjs shareat_test` after any new migration or its tables are missing at test time.
- ⚠️ `next-env.d.ts` flip-flops on dev-vs-build; HEAD carries the dev variant, restore it, don't commit the build one.
- ⚠️ Eight-plus stale lane DBs from earlier sessions (`shareat_test_a/_b/_e2/_lane15/_lane25/...`)
  plus `_t228`/`_t229` are on the server; drop the ones no longer in use.
- ⚠️ Two older peers may still be idle (`Dispatch background conversation`, and Remote Control rows) — ignore them; they are not lanes.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then docs/RULES.md if you
haven't this session. You are the ORCHESTRATOR — invoke /orchestrator shareat system.

⛔ FIRST, ONE THING IS IAN'S: production has the bootstrap-org code (T-228, dad2053) but zero
organizations. Ian runs `npm run bootstrap-org -- --code=SHAREAT_OPC --name="SHAREAT OPC"
--admin="<his name>" --store-code=LIPA --store-name="SharEat Lipa" --confirm` on production
himself (IAN-SETUP-CHECKLIST §4b). Confirm T-228's deploy landed first (gh run list).

Nothing is half-built; the tree is clean at dad2053. Ian's four decisions from 2026-09-07 are in
docs/DEFECTS-REGISTER.md's change-log — ADD a bible §13 row for them (run npm run toc after).

Re-adopt or re-brief the two worker lanes (ListAgents). Assign: Lane A = DEF-209 RLS assessment
(read-only, docs/discovery/29, three questions in the DEF-209 register row). Lane B = sales-channel
admin surface + Q3 per-channel wastage policy (one package, owns the next migration), then its
slices 2–4. One migration lane at a time. Orchestrator alone commits and pushes; workers use
it.mjs on their lane DB (t228/t229), never npm run test:integration.
```
