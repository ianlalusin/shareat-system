# Handoff — 2026-09-13

> ⚠️⚠️ **GATES WERE GREEN AT `3c25275` — ON THIS LAPTOP ONLY, AND CI HAS NEVER RUN ON ANY OF IT.**
> `gh run list --commit` returns **zero runs** for `58f198a`, `3c25275` and `d2e32a1`. So the code
> now in production was gated by: typecheck, unit, a production build (green on the deploy runner),
> a **scoped** integration run, and the orchestrator re-running `terminal-sign-in.test.ts` alone
> (23/23, vitest exit 0, on `shareat_test_orch`). ⛔ **It was NOT gated by the full integration
> suite, anywhere, ever** — the local suite OOM-killed twice today (DEF-245) and CI was disabled.
> **DEF-245's standing rule is that CI is the only real integration gate; that gate did not run.**
> Ian was told this plainly before choosing to deploy, and chose to. Say it this way to the next
> session — not "gates green".
>
> ✅ **PUSHED AND DEPLOYED — `origin/main` is `d2e32a1` and production is serving it.** Ian chose to
> ship after being given the choice in plain language. The sign-in rewrite is live; an admin reached
> the app by email, so invariant 7 holds in production. **PIN sign-in is not usable yet** — the
> cutover's steps 4-5 (Firebase account, then `provision-terminal`) gate it.
>
> ⚠️ **The line this replaces said `main` is FOUR commits ahead. It was three** — `origin/main` had
> already advanced to `d6b600e`. Two documents disagreed with `git ls-remote` and neither was checked
> until this session checked it. Recorded because the handoff's most alarming line being wrong is
> exactly the failure this file exists to prevent.
>
> ⛔⛔ **CI HAD BEEN DISABLED SINCE 11:42 AND EVERY PUSH WAS INERT — DEF-336. IT IS BACK ON NOW.**
> The `CI` workflow was `disabled_manually`, so **the push of all three commits created zero runs**,
> and because `Deploy` is gated on `CI`, nothing would ever have deployed. It reached production
> only because the orchestrator dispatched `Deploy` **by hand**. ✅ **Re-enabled the same evening on
> Ian's decision** (`gh workflow enable CI`; verified `CI active`). ⛔ **The click is not the fix and
> the row stays open:** Ian also authorised a guard, budgeted as **T-308**, and lane C re-scoped it
> — it asserts **deployed-revision lag**, not CI liveness, because `Deploy` reported `active`
> throughout while being **structurally dead**. ⚠️ **A `git push` that exits 0 proved nothing for
> nine hours and nobody noticed.**
>
> ⭐ **Yesterday's headline is CLOSED: the nightly orphan sweep RAN on production**, verified in its
> own log (`removed 0 · 1 orgs`, `Result=success`), after the first successful deploy in twenty
> hours. **Neither hypothesis in DEF-326 was right** — see below.
>
> Written for a **COLD start**. Read `docs/RULES.md` first, then this. `PROJECT_BIBLE.md` wins any
> disagreement.

## Where things stand

**Production is healthy and current, and is now serving `d2e32a1`.** All nine timers are armed and
all eight scheduled jobs report `success`. **Production is at migration `0147`** — applied by the
deploy, not by hand.

⭐ **THAT LAST SENTENCE IS A FIRST AND IT MATTERS.** Lane A established that the four unattended
Deploys everyone was citing as proof the pipeline works **all had zero pending migrations** — Ian
had hand-applied `0144`-`0146` beforehand. So "proven unattended" only ever meant *connected
cleanly and no-op'd*. **Run 34758896635 is the first time this pipeline has applied a real pending
migration by itself** (`Migrations applied in 303ms`, against 177ms for the no-ops). That half of
the pipeline is now proven; it was not before, and no document said so.

⛔ **PIN sign-in still does not work in production — but the cause has changed, and the distinction
is the whole point.** DEF-333's defect (an unprincipalled pre-auth `stores` read) is **deleted from
the code and deployed**; `PRE_AUTH_PATHS` is down to one entry. What blocks PIN sign-in now is that
**no terminal credential exists yet** — cutover steps 4-5. ⚠️ **A green deploy does not close
DEF-333's outage and a red one would not re-open it.** Email sign-in works and is verified working
in production today.

## Gates on what is now in production (`d2e32a1`)

⚠️ **`d2e32a1`'s code tree is byte-identical to `3c25275`** — the wrap-up commit touched only
`docs/HANDOFF-TODAY.md` and `docs/ROADMAP.html`, confirmed with `git diff --name-only`. That is why
the rows below carry over legitimately, and it is the only reason they do.

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** (at `3c25275`; code tree unchanged since) |
| `npm run test` (unit) | **exit 0** — 111 files, 1472 passed, 1 skipped (same) |
| `npm run build` | **exit 0** locally, **and again on the deploy runner** for `d2e32a1` |
| `npm run toc` | **exit 0 at `d2e32a1`**, re-run this session, 2 files checked |
| Integration — **scoped** | **exit 0** — 21 files, **810 passed**, 295s, on `shareat_test_orch` |
| Integration — `terminal-sign-in.test.ts` alone | ⭐ **exit 0, 23/23, 4.62s** on `shareat_test_orch`, re-run this session by the orchestrator. **This is invariants 7 and 8** — the admin email form surviving both states, and a terminal person being refused by the admin form. Run because *"the worker said the gates are green"* is a red flag, not evidence |
| Integration — **full suite** | ⛔ **NOT RUN, HERE OR ANYWHERE.** OOM-killed twice locally (**2.6 GB free of 15.6** at the second kill, DEF-245) **and CI never ran at all** (DEF-336). The only real integration gate did not execute against this code |
| **CI** | ⛔⛔ **ZERO RUNS** for `58f198a`, `3c25275`, `d2e32a1` — workflow `disabled_manually`. DEF-336 |
| Deploy | **success** — run `34758896635`, `workflow_dispatch`, migrate + restart + health all green |
| Production smoke | ✅ `/sign-in` 200, serving the two-layer page; **an admin signed in by email and reached the app** (cutover step 3, the unrecoverable case) |
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

### 3. Sign-in is now two layers (T-304 + T-303, `58f198a`) — built, deployed, LIVE

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

1. ⛔ **FINISH THE SIGN-IN CUTOVER — steps 1-3 are DONE, steps 4-8 are not.** Pushed, deployed,
   and **step 3 passed: an admin signed in by email and reached the app**, which was the only
   unrecoverable case. Remaining, from `docs/tasks/304-two-layer-terminal-sign-in.md` §Cutover:
   Ian creates the store's shared Firebase account in the console (that half cannot be ours), runs
   `scripts/provision-terminal.ts`, then steps 6-8 on a device. ⚠️ **Read DEF-337 before running
   the script** — if `SYSTEM_DATABASE_URL` is missing on the box it reports *no store with that
   code*, which is indistinguishable from a typo.
2. ⛔ **RE-ENABLE `CI`, OR DECIDE NOT TO — DEF-336.** Until then every `git push` is inert and
   silent. ⭐ **T-306's docs-only prediction was NOT tested and could not have been:** lane B
   established that the classifier diffs the whole push (`github.event.before` → `github.sha`), and
   this push spanned code, so it would have been `docs_only=false` regardless. **A docs-only push
   only exercises the cheap path if the day's code was pushed separately, earlier** — batching code
   and the wrap-up commit into one push defeats it every time. That is a habit to change, not a
   code fix.
3. ⛔ **DEF-330's manual-migrate recipe is still broken and is the thing people reach for when the
   pipeline is down.** `docs/ops/README.md:100-103` — line 102 got DEF-327's admin-string fix and
   line 101 still says `cd /srv/shareat`, the symlink that points at the *stale* release exactly
   when a deploy is half-broken. **Someone edited four lines to fix one defect and left the defect
   the register records against the same four lines.** Lane B has written a correct,
   resolve-the-release-explicitly replacement with a before/after verification; it is in this
   session's transcript and should be written into `ops/README.md`.
4. **T-302** — global PINs. Specced, approved, deferred **on purpose** until sign-in is healthy, so
   that re-issuing the two live PINs happens on a system where PIN login works.
5. ⛔ **DEF-338 FIRST — a comment tells the next reader to delete the timeout the register forbids
   deleting.** `position-defaults.test.ts:541-546` instructs *whoever fixes that root cause should
   come back and delete this timeout override*; the root cause is fixed **eleven lines below it**,
   so the precondition is met and the instruction is live and wrong. One comment to rewrite, no
   behaviour change. **It is the only finding today that causes a wrong action rather than a wasted
   hour.**
6. **DEF-325's stall is still unexplained.** DEF-334 was confirmed deterministically but its shape
   is wrong (a fast explicit error, not a 30s stall), so **the 120s timeout is NOT yet dead weight.**
   Re-measure before deleting it.

## Do not decide these alone — they are Ian's

- ✅ **WHETHER TO PUSH — ANSWERED 2026-09-13: Ian said ship, twice.** Put to him in plain language,
  once before the CI discovery and once after, when the honest framing became *"nothing anywhere has
  fully tested the change we are about to put on your front door"*. He chose to deploy without CI on
  the second asking. **Recorded because the second question was the one that mattered and the
  recommendation had changed underneath it.**
- ⛔⛔ **WHETHER TO RE-ENABLE `CI` — OPEN, AND IT IS A SPENDING DECISION (DEF-336).** Actions minutes
  were running ~3,000/month against a 2,000 allowance, which is the likeliest reason it was switched
  off. ⚠️ **Until it is on, every push is inert and silent** and every deploy must be dispatched by
  hand. **The guard against not-noticing is ours regardless of what he chooses** — see DEF-336.
- ⚠️ **A fourth `persons` reader** could appear and compile clean — the `kind` filter is fail-open.
  Lane C found no fourth today and explained by category. A build-enforced guard is the fix.
  ⭐ **This is the only genuinely-Ian item left in this list**, and even it is arguably engineering.
- ⛔ **DEF-329 WAS MIS-ROUTED HERE AND HAS BEEN MOVED OUT — read this before adding anything.** It
  sat under this heading meaning *"unbudgeted, needs a task number"*, which is a **sequencing**
  statement; the heading turned it into a **decision-rights** statement, and it stayed there
  unexamined. Lane C checked it against `RULES.md`: it amends no bible row, removes no capability,
  widens no door, deploys nothing, and adds one unit assertion whose shape, location and rejected
  alternative are all already argued in its own register row. **§0.1 — Ian describes WHAT, Claude
  decides HOW — and a test asserting CI's env block is HOW.** It is now **T-307**. ⭐ **The lesson
  generalises to this whole section: escalating a fully-analysed cheap fix is the day's own pattern
  in reverse — knowledge written down correctly and disconnected from the person able to act on it.
  A thing belongs here because a RULE reserves it, never because it is merely unscheduled.**

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
| `webapps-f7` | Opus 5 | — | **idle.** Wrote T-300, specced T-302/303/304, reviewed T-304; then the DEF-325..335 disposition review that found DEF-338 |

⭐ All lane databases are current at **131 migrations** and re-attachable by name.

⚠️ **A fifth interactive session, `webapps-36`, has been alive ~10h and is in no lane.** It was
treated as **foreign** all session — no work given to it, no assumption that its files are ours.
The tree stayed clean throughout, so it never collided with anything. **Do not adopt it by name
without asking Ian what it is.**

⭐ **What the lanes were asked for, and why it is worth repeating: a QUESTION, not a change.** All
three were sent read-only premise checks rather than build orders, and all three came back having
corrected the orchestrator — the `workflow_dispatch` rehearsal was killed as redundant, *"proven
unattended three times"* was shown to mean *"no-op'd four times"*, DEF-329 was shown not to be
Ian's, T-306's prediction was shown untestable on this push, and DEF-338 was found in a file nobody
had asked about. **Not one of those came from building; every one came from checking a premise.**

## Numbers to allocate from

- Next task **T-309** · next defect **DEF-340** · next migration **`0148`** (`when` > `1798774307084`)

⚠️ **Allocated on 2026-09-13, so do not re-issue them:** **T-307** (DEF-329, CI env-block assertion) and **T-308** (the deployed-revision-lag guard, Ian authorised) —
stub reserved at `docs/tasks/307-ci-env-contract-assertion.md`, spec not yet written) · **DEF-336**
(CI disabled, every push inert) · **DEF-337** (`provision-terminal.ts` has no `SYSTEM_DATABASE_URL`
guard) · **DEF-338** (a test comment orders a deletion the register forbids) · **DEF-339** (a docs-only push still rebuilds and RESTARTS production — T-306 fixed the CI half only). ⭐ **`0148` is still
free — no migration was written today; `0147` shipped from `58f198a`.**
## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 194-201,
docs/DEFECTS-REGISTER.md section E (DEF-325 through DEF-338 are the live ones).

HEAD is d2e32a1 on main, tree clean, NOTHING UNPUSHED — origin/main is d2e32a1 and production is
serving it. The sign-in rewrite is DEPLOYED and an admin has signed in by email, so the one
unrecoverable step of T-304's cutover is behind you. Do not re-litigate the push.

⛔⛔ VERIFY CI IS STILL ENABLED BEFORE YOU TRUST ANY PIPELINE — THIS IS THE FIRST THING TO CHECK,
NOT THE LAST (DEF-336). It was `disabled_manually` from 2026-09-13 11:42 for nine hours; a git push
exited 0 and created NO run, and Deploy is gated on CI so nothing deployed either. It was
re-enabled that evening, but NOTHING YET GUARDS IT — that is T-308, authorised and unbuilt. Check:
  gh workflow list --all
⚠️ Do NOT satisfy yourself with `Deploy: active`. Deploy reported active for the whole nine hours
while being structurally dead, because it is workflow_run-gated on CI. That is DEF-332's
list-timers trap on a different provider, and it is why T-308 asserts DEPLOYED-REVISION LAG rather
than workflow state.

Do NOT claim ANY integration green. The full suite has never run against this code — OOM locally
(DEF-245) and CI disabled (DEF-336). What was actually run is listed in the gates table; quote that
table, not the word "green".

FINISH THE CUTOVER: docs/tasks/304-two-layer-terminal-sign-in.md §Cutover, steps 4-8. Ian creates
the store's shared Firebase account in the console, then runs scripts/provision-terminal.ts.
⛔ Read DEF-337 first — if SYSTEM_DATABASE_URL is missing on the box the script reports "no store
with code X", which is indistinguishable from a typo. Run it WITHOUT --confirm first and read back
the STORE NAME, not the code: a wrong code that matches a different real store succeeds silently.
⛔ Step 8's refusal sentence is deliberately reused for "no person at all", so seeing it does not
prove the terminal refusal fired — the only unambiguous FAILURE is reaching the app.

THE PATTERN OF 2026-09-13, now found EIGHT times. The knowledge was already written down,
correctly, and disconnected from the decision that needed it. Two of today's instances were found
by lanes checking a premise instead of building to it, and one of them — DEF-338 — is a stale
comment that ORDERS A DELETION the register forbids. Before filing anything, grep whether this repo
already says it. Before following any instruction in a comment, check whether its precondition
quietly came true. A row's REMEDY is as perishable as its DIAGNOSIS, and so is a comment's.

Editing docs/DEFECTS-REGISTER.md via a shell string EXECUTES its backticks. Put the row in a plain
FILE and insert with a column-checked script anchored on section E's own last row. Scripts that did
this correctly today are in the scratchpad pattern: Write tool → plain file → node script that
asserts exactly-one-match on every anchor and refuses to write on mismatch.

Ask each lane a QUESTION, not just for a change. On 2026-09-13 the lanes corrected the orchestrator
FIVE times — the workflow_dispatch rehearsal hypothesis was killed outright, "proven unattended
three times" was shown to mean "no-op'd four times", DEF-329 was shown not to be Ian's, T-306's
prediction was shown untestable on that push, and DEF-338 was found in a file nobody had asked
about. Every one came from checking a premise.

⛔ SSH to the production droplet was BLOCKED for the orchestrator by the permission classifier on
2026-09-13. Ian ran the host-side steps. If you need the box, ask him rather than working around it.

Next task T-309 · next defect DEF-340 · next migration 0148 (when > 1798774307084).
T-307 and T-308 are RESERVED (stubs at docs/tasks/307-*.md and 308-*.md, specs unwritten). T-308 is
the CI-liveness guard Ian authorised; read its file before re-deriving the design, it is settled.

-----------------------------------------------------------------------------------------------
