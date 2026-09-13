# Handoff — 2026-09-13

> ✅ **GATES ARE GREEN AT `3c25275`.** No red banner. ⚠️ But read the integration line below before
> quoting a green: the **full local integration suite was NOT run to a trustworthy result** — it was
> OOM-killed twice today, and **DEF-245's standing rule is that CI is the only real integration
> gate.** This handoff says so rather than implying a local green.
>
> ⛔⛔ **NOTHING IS PUSHED. `main` is four commits ahead of `origin/main`, deliberately.** Pushing is
> what deploys, and the top commit **rewrites how people sign in**. See *"Do not decide these
> alone"* — this is the one thing waiting on Ian.
>
> ⭐ **Yesterday's headline is CLOSED: the nightly orphan sweep RAN on production**, verified in its
> own log (`removed 0 · 1 orgs`, `Result=success`), after the first successful deploy in twenty
> hours. **Neither hypothesis in DEF-326 was right** — see below.
>
> Written for a **COLD start**. Read `docs/RULES.md` first, then this. `PROJECT_BIBLE.md` wins any
> disagreement.

## Where things stand

**Production is healthy and current.** Deploys work and have proven it unattended three times. All
nine timers are armed and all eight scheduled jobs report `success`. The database is at migration
`0147` locally; **production is at `0146`** and gets `0147` on the next deploy.

⛔ **PIN sign-in is still broken in production** (DEF-333) — and the fix is committed but not
deployed. Email sign-in works and is the only way in. **Two people, so it is livable; it is not
fixed until the cutover in *"Pick up here"* runs.**

## Gates at `3c25275`

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **exit 0** — 111 files, 1472 passed, 1 skipped |
| `npm run build` | **exit 0**, port 9008 enumerated free first |
| `npm run toc` | exit 0, 2 files checked |
| Integration — **scoped** | **exit 0** — 21 files, **810 passed**, 295s, on `shareat_test_orch` (`packages/auth` + `packages/db` + `apps/erp` integration) |
| Integration — **full suite** | ⛔ **NOT RUN.** OOM-killed twice today; **2.6 GB free of 15.6** measured at the second kill. **DEF-245** — CI is the real gate |
| Secrets scan | clean — nothing under `secrets/` or `.env*` in status or in the last four commits |

⚠️ **A scoped sweep earlier showed 808/810.** The two failures were `rls.test.ts` hook timeouts;
run alone that file passes **28/28, exit 0, 49.86s**. DEF-313, discriminated by measurement, not
assumed. Both were the *tenancy* invariants — exactly where a `persons.kind` regression would show.

## What happened this session

### 1. Nothing had deployed for twenty hours, and neither recorded hypothesis was right

`DEF-326` left two theories and told the next session to read the run logs instead of adopting
either. Both were wrong.

- **DEF-327** — every Deploy had been failing at the migrate step since the production role was
  tightened: `permission denied for database defaultdb`, 42501. `deploy.yml` ran a bare
  `npm run db:migrate` and inherited `shareat_app_prod`, which by design cannot migrate. Under
  `set -e` that aborts **before** the symlink swap, so the host kept serving the old release and
  showed no error anywhere. **`docs/ops/README.md` predicted this on the day it started.**
- **DEF-328** — CI was red for a **one-character mismatch between two placeholder project ids** in
  `ci.yml`, not for DEF-325. **DEF-325 never once appeared as a CI failure.**
- Three blockers were stacked where the brief named one. Fixed in `5bd6d44`, `fd95578`.

### 2. Ian's own bug report was, for the fourth time, bigger than it looked

*"it says no store is configured but I can see the store inside"* → **PIN sign-in dead in production
for everyone** (DEF-333). The sign-in page read `stores` through the ordinary connection before
anyone authenticated. ⭐ **Found only because the first authenticated request under the tightened
role had never happened** — five sessions, latest 2026-09-11, role changed 2026-09-12 — and he was
asked to sign in specifically to test that.

### 3. Sign-in is now two layers (T-304 + T-303, `58f198a`) — built, green, NOT deployed

A per-store shared email/password signs the tablet in; a PIN then identifies the person. **It is
v1's own pattern** (`ERP-rebuild/src/app/local-user-login/page.tsx`). It closes DEF-333 by
**deleting the read, not widening a door** — `PRE_AUTH_PATHS` went 3 → **1**.

Review caught one thing that would have shipped: the cooldown message rendered a **UTC** time to a
Manila cashier — eight hours in the past, at the shift change the whole tuning argument was about —
and every test passed because CI is UTC too.

### 4. Nine documents asserted zero organisations; production has one (T-300, `f6c7df6`)

**SHAREAT OPC**, `created_at 2026-09-08T15:56:52Z`, measured directly. 35 assertions re-derived, not
patched. ⭐ **`ops/README`'s own `count(*) → 0` was never a census** — it was run as a non-bypassing
role under FORCE RLS and would read 0 against any number of organisations.

### 5. The pattern of the day, found SIX times

**The knowledge was already written down, correctly, and disconnected from the decision that needed
it.** `PRE_AUTH_PATHS` vs bible row 194 · `bible:1503` vs `ops/README` · nine timer files vs eight
armed · `credentials.ts:64` vs DEF-335 · a spec's rejected draft above its own ruling · and
`formatBusinessDateTime` — the *only sanctioned* server date formatter, **never once called**, which
is why the first person who needed it reached for the UTC-broken one.

⛔ **That is a different problem from ignorance and needs a different fix: reconcile the lists we
already keep, not write more of them.**

### Decisions Ian made today, and where each lives

| Decision | Recorded in |
|---|---|
| Apply the three pending migrations **by hand, watched**, before trusting the pipeline | DEF-327 · done, 127 → 130 |
| Arm `shareat-month-end-retry.timer` | **DEF-332, closed same day** |
| PINs become **globally unique**; block duplicates | `docs/tasks/302-*.md` — **deferred, built SECOND** |
| Two-layer sign-in, v1's pattern | `docs/tasks/304-*.md` |
| One shared credential **per store**, not one for the business | `docs/tasks/304-*.md` |
| *"several, regularly"* work at more than one branch | T-302's sequencing |
| Lockout **10 misses / 60s / 2-minute cooldown** (revised from 5/5min) | `docs/tasks/303-*.md` |
| Terminal password **remembered on the tablet** | `docs/tasks/304-*.md` |
| `provision-terminal.ts` joins the closed cross-org caller list | ⭐ **`PROJECT_BIBLE.md` row 201** |
| CI: make docs-only pushes cheap rather than switching CI off | `docs/tasks/306-*.md` |

⭐ **Every decision is recorded outside the transcript.** Nothing is pending write-up.

## Pick up here

1. ⛔ **PUSH, THEN RUN THE SIGN-IN CUTOVER.** It is written in full in
   `docs/tasks/304-two-layer-terminal-sign-in.md` §Cutover. The sentence the whole procedure exists
   to make true: **an admin signing in by email reaches the app at every step.** Preconditions, the
   ordered steps and the rollback are all there. ⚠️ Ian creates the store's Firebase account (that
   half cannot be ours), then `scripts/provision-terminal.ts`.
2. **Watch the first push's CI run against T-306's written prediction** — a docs push ~2-4 min with
   four steps **skipped**, a code push unchanged ~11 min. The next push carries the change and is
   therefore its own first test. ⭐ Hold it to the prediction rather than assuming it worked.
3. **T-302** — global PINs. Specced, approved, deferred **on purpose** until sign-in is healthy, so
   that re-issuing the two live PINs happens on a system where PIN login works.
4. **DEF-325's stall is still unexplained.** DEF-334 was confirmed deterministically but its shape
   is wrong (a fast explicit error, not a 30s stall), so **the 120s timeout is NOT yet dead weight.**
   Re-measure before deleting it.

## Do not decide these alone — they are Ian's

- ⛔⛔ **WHETHER TO PUSH.** Four commits sit unpushed. Pushing deploys the sign-in rewrite to
  production. ⭐ **Recommendation: push.** It cannot make things worse — PIN sign-in is already at
  zero, `0147` is additive-only, and invariant 7 + test 6 protect the email form from both states.
  But it changes the front door of a live system and the cutover has steps only he can do.
- **DEF-329** — nothing asserts CI's own env block satisfies the contracts the app refuses to start
  without. Recommended shape is written; unbudgeted, needs a task number.
- **A fourth `persons` reader** could appear and compile clean — the `kind` filter is fail-open.
  Lane C found no fourth today and explained by category. A build-enforced guard is the fix.

## Traps that have actually bitten — live in this area right now

- ⛔ **A shell heredoc or `-e` string with backticks EXECUTES them.** It corrupted seven identifiers
  in this very handoff earlier today. **Write the row to a plain file and insert with a
  column-checked script** — the register edits did this all day and never broke.
- ⛔ **`npm run build` dirties `apps/erp/next-env.d.ts`** (`.next/dev/types` → `.next/types`); `dev`
  flips it back. It is generated — **restore it, do not commit it.**
- ⛔ **The full local integration suite OOMs** with lanes active. Scoped runs are healthy. DEF-245.
- ⛔ **`systemctl list-timers` CANNOT show a timer that was never enabled** — even with `--all`. Use
  `systemctl is-enabled`. That is how DEF-332 hid for three days.
- ⛔ **`/srv/shareat` is the symlink the deploy swaps LAST.** When a deploy is broken it points at
  the *stale* release, so the documented manual-migrate recipe applies nothing and prints success
  (DEF-330). Resolve the newest release directory instead, and verify with a before/after count.
- ⚠️ **Server runtimes are UTC.** A bare `toLocale*` tells a Manila reader a time eight hours off.
  `formatBusinessDateTime` is the only sanctioned formatter — and until today it had **no callers**.

## Live agent sessions at wrap-up

| Session | Model | Lane DB | State |
|---|---|---|---|
| `system32-85` | Opus 5 | `shareat_test_orch` | orchestrator — this session |
| `webapps-65` | Sonnet 5 | `shareat_test_lanea` | **idle.** Built T-298, the T-301 census, T-304/T-303 |
| `webapps-4e` | Sonnet 5 | `shareat_test_laneb` | **idle.** Built T-299, T-305, T-306 |
| `webapps-f7` | Opus 5 | — | **idle.** Wrote T-300, specced T-302/303/304, reviewed T-304 |

⭐ All lane databases are current at **131 migrations** and re-attachable by name.

## Numbers to allocate from

- Next task **T-307** · next defect **DEF-336** · next migration **`0148`** (`when` > `1798774307084`)

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 194-201,
docs/DEFECTS-REGISTER.md section E (DEF-325 through DEF-335 are the live ones).

HEAD is 3c25275 on main, tree clean, gates green — but FOUR COMMITS ARE UNPUSHED ON PURPOSE.
Pushing deploys, and the top commit rewrites sign-in. Read "Do not decide these alone" before you
push anything.

PIN sign-in is broken in production (DEF-333). The fix is committed and not deployed. Email
sign-in works and is the only way in. The cutover is written in full in
docs/tasks/304-two-layer-terminal-sign-in.md under "Cutover" — the sentence it exists to make true
is "an admin signing in by email reaches the app at every step". Ian creates the Firebase account;
scripts/provision-terminal.ts does the rest.

Do NOT claim a local integration green. The full suite OOMs on this machine (DEF-245, and it bit
twice on 2026-09-13). CI is the only real integration gate and the handoff must say so.

THE PATTERN OF 2026-09-13, found six times: the knowledge was already written down, correctly, and
disconnected from the decision that needed it. Before filing anything, grep whether this repo
already says it. Six wrong dispositions now (DEF-279, 301, 309, 307, 250, and DEF-315's own
correction) — a row's REMEDY is as perishable as its DIAGNOSIS.

Editing docs/DEFECTS-REGISTER.md via a shell string EXECUTES its backticks. Put the row in a plain
FILE and insert with a column-checked script anchored on section E's own last row.

Ask each lane a QUESTION, not just for a change. On 2026-09-13 the lanes corrected the orchestrator
three times — every one by checking a premise instead of building to it.

Next task T-307 · next defect DEF-336 · next migration 0148 (when > 1798774307084).

-----------------------------------------------------------------------------------------------
