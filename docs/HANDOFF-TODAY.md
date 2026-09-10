# Handoff — 2026-09-11 — for the NEXT ORCHESTRATOR

> **Ian's instruction for you, in his words: *"next orchestrator shall help me with the db lock…
> we'll fix it now."*** That is your first job. Everything needed is in §1. Do not start it by
> reading the register row and believing it — §1 says which parts of that row are already stale.

## Where things stand

`main` at `5706a06`, plus this wrap-up commit, pushed, tree clean. **T-263 shipped. T-264 slice 1 shipped.
DEF-279 is investigated and specced but NOT built.** Production is unchanged — nothing deployed.

⭐ **The finding of the session: the production database connects as a role that switches the
tenancy lock off entirely, and it was settled by executing an experiment rather than by reading
Postgres documentation.** The second-biggest: a defect described as *"depreciation fails"* was
actually *"a freshly bootstrapped production org cannot post anything at all"* — a cutover blocker
that had been sitting in the register mis-described.

---

## 1. PICK UP HERE — the database lock. Ian is waiting to do this with you.

### What was measured, on production, by Ian at the orchestrator's request

```
current_user | rolsuper | rolbypassrls
doadmin      | f        | t
```

and on `expenses`, `journal_entries`, `stores`: `relrowsecurity = t`, `relforcerowsecurity = t`,
owner `doadmin`.

⭐ **`FORCE ROW LEVEL SECURITY` does NOT save you here, and this was PROVEN, not cited.** A role
with `BYPASSRLS` that OWNS a table with RLS enabled, FORCEd, and a `USING (false)` deny-all policy
**still saw the row**. The role attribute beats both the policy and FORCE. ⛔ Do not re-argue this
from documentation — the experiment is in commit `734488e`'s message and takes 30 seconds to redo.

⇒ **All 122 policies are correctly written and completely inert on the production connection.**

⚠️ **Not a breach, and do not escalate it to one.** `authorize()` runs on every path, the
repository layer still filters by org, and there is one organisation on production. What is missing
is the *second* layer — bible §15.11, *no layer may be the only one for a given risk*.

### ⛔ THE ORDER, AND THE PREVIOUS ORCHESTRATOR GOT IT WRONG TWICE BEFORE GETTING IT RIGHT

**Already done, despite what DEF-250's `reported` status implies:** T-251a did not merely ship
`systemTransaction()` — the DEF-250 paths are already **on** it. Verified at source:
`packages/domain/src/scheduler/index.ts:206` (`listOrgsToRun`) and
`apps/erp/src/app/setup/actions.ts:71` (`bootstrapOrganization`), with
`tests/unit/system-transaction-callers.test.ts` failing the build if anyone outside the closed
caller list calls it. **DEF-250's remaining half is configuration only.**

⭐ **And the two-role split is already built into the client.** `packages/db/src/client.ts:95`
reads `SYSTEM_DATABASE_URL ?? DATABASE_URL`. Its own comment says the variable is unset in
production *"until a separate, later decision says otherwise."* **This is that decision.** You are
setting an environment variable, not writing an architecture.

**The corrected order:**

1. **Fix the null-principal callers FIRST.** ⛔ The first attempt at this plan put them last. They
   cannot be last: the moment `DATABASE_URL` points at a non-bypass role, a path with no principal
   sees zero rows and every write fails the policies' `WITH CHECK`. **They break at the switch
   unless fixed before it.** All of them already hold `actor.orgId`, so each is a small change to
   use `withOrgPrincipal`.
2. **Then the role.** Create a restricted application role on the DigitalOcean managed cluster
   **without** `BYPASSRLS`; grant it DML on every table, `USAGE` on sequences, `EXECUTE` where
   needed; set `SYSTEM_DATABASE_URL` to the privileged (`doadmin`) connection and point
   `DATABASE_URL` at the restricted one. Keep migrations on the privileged role.
3. **Then verify** — and verify as the restricted role, not as yourself.

### ⛔ Three things that will bite you

- **THE COUNT OF SIX IS A HYPOTHESIS.** DEF-282 says six null-principal callers. The register also
  records a null-first-arg sweep returning **18**, and the discriminator between those numbers was
  never settled. **Re-derive the population before step 1.** This is the error class that bit this
  project every single day this week.
- **The database is NOT on the droplet.** It is a DigitalOcean **managed** cluster on the private
  endpoint at port 25060 — which only resolves from inside the VPC, i.e. from the droplet itself.
  `psql` was not installed there; `apt-get install -y postgresql-client` fixes it (Ubuntu's own
  suggestion of `postgresql-client-common` is wrong and does not contain `psql`).
- **A tightened role fails SILENTLY in the DEF-250 direction** — no error, an empty org list, every
  job reporting success. If you get step 2 before step 1, you will not find out from a red.

**Read:** `DEFECTS-REGISTER.md` DEF-282 and DEF-250 (both updated 2026-09-11 with the measurement
and the corrected ordering), `packages/db/src/client.ts:95-142`, `packages/db/src/rls/principal.ts`,
migration `0011_row_level_security.sql`, bible §15.11 and §7 rule 4.

---

## 2. Then: DEF-279 — investigated, specced, NOT built

Lane E did a read-only investigation and it is one of the better pieces of work this week. **Do not
re-investigate it. Do read its conclusion before writing the migration.**

⭐ **The obvious fix is only half of one, and this was executed, not reasoned.** Adding
`USING CONSTRAINT = '…'` to the five bare `RAISE EXCEPTION`s is necessary and **not sufficient**:

- `RAISE … USING CONSTRAINT` puts the name in the structured `constraint_name` field and **not** in
  the message text.
- The counter identifies a constraint with `parseConstraintName` —
  `/constraint "([a-zA-Z0-9_]+)"/` over the **message text** (`apps/erp/src/lib/constraint-messages.ts:84`).
- ⇒ Migration alone changes nothing observable. The app must also read `constraint_name`.
- ⚠️ It is `err.constraint_name` (postgres.js), **not** `err.constraint` (that is node-postgres, and
  the orchestrator's briefing guessed it wrong; the lane corrected it and the orchestrator
  re-verified before recording it).
- A genuine CHECK violation populates **both**, which is why the regex has worked until now.

⛔ **The complication nobody anticipated:** `journal_entries_balance_check` and
`journal_lines_balance_check` share ONE helper, `journal_check_entry_balance`, which cannot know
which trigger invoked it. The firing trigger's name must be threaded through as a parameter — and
because that changes the signature, `CREATE OR REPLACE` creates a **second overload** rather than
replacing it, so the old 1-arg version needs an explicit `DROP FUNCTION`.

⚠️ **Lane E's proposed SQL is a PROPOSAL, not a migration, and the orchestrator did not get to the
last check on it: diff every one of those five function bodies against the live definitions
(`pg_get_functiondef`) before writing the migration.** A hand-transcribed 30-line PL/pgSQL block is
a behaviour change waiting to happen. **That check is outstanding and is yours.**

Related and already filed: **DEF-286** — `errorMessage()` has the same message-text-only blind spot,
moot today only because none of the five has a friendly sentence yet. Fix it in the same function or
it returns as a "why is my new message not showing" bug.

---

## 3. Then: T-264 slices 2 and 3

**Slice 1 shipped today.** Slice 2 (a surface to close a period) and slice 3 (the override) remain.

⭐ **Slice 3 is UNBLOCKED and its design is settled — bible §13 row 193, ratified by Ian today.**
The override wins over ADR-006's rejection of a guarded escape path. ⛔ **The supersession is
NARROW and over-reading it is the live risk:** what is sanctioned is a transaction-local
per-posting exemption (period stays `closed`, one entry passes, flag dies with the transaction).
**Reopening — flipping `status` back to `open` — is still NOT built and was not asked about.**

- Capability: a **new** `override_period_lock`, granted to `super_admin` and `admin` only. ⛔ **NOT
  `close_period`** — that is granted to `manager` too (`capabilities.ts:682`, deliberately, per
  ADR-006 §7.4), so reusing it silently hands the override to every manager.
- Reuse migration `0005`'s transaction-local GUC so an unset flag reads as NOT exempt and any bug
  fails **closed**. Set it only after `authorize()` confirms the capability, never from a
  caller-supplied parameter. Do not reimplement the period rule in TypeScript around the trigger.
- Watch a `manager`'s override be **refused by the database** before wiring the exemption.
- ⚠️ Slice 3 needs a migration slot. Slices 2 and 3 pair naturally with **DEF-285** (below) — all
  three are the same missing thing: a screen where a human administers periods.

**Also queued:** DEF-285, DEF-280 (11 catch-less server actions), DEF-278, DEF-277, DEF-260
(execution, Ian decided the design in row 190), DEF-273, DEF-258 (triage first — 47 dark-mode
overrides, not all defects).

---

## What shipped today

| Commit | What |
|---|---|
| `e84d67b` | T-263 scope widened at dispatch — the spec said "two live callers"; there was also a **second implementation** of the same function |
| `8148e45` | T-264 has a ratified ADR nobody cited, and it said the opposite of slice 3 |
| `f785ee4` | **T-263 shipped** — `lastCompletedPeriod()` derives the month in Asia/Manila |
| `842c609` | T-264 slice 1 is not "depreciation fails" — a fresh production org cannot post anything |
| `9dbf63e` | **bible row 193** — the period-lock override wins over ADR-006, admin + super_admin only |
| `734488e` | **DEF-282/DEF-250** — production connects as a `BYPASSRLS` role, measured and proven |
| `5706a06` | **T-264 slice 1 shipped** — periods are created; the ledger works for a fresh org |

---

## Traps that bit TODAY

- ⛔ **A DEFECT'S DESCRIBED SEVERITY IS A HYPOTHESIS TOO.** DEF-284 said "blocks depreciation". It
  blocked **the entire ledger** for any fresh org — found by reading `postEntry`, not the row.
  *Depreciation was merely where the failure had a screen to appear on.*
- ⛔ **A RATIFIED DECISION CAN CONTRADICT ANOTHER RATIFIED DECISION, THREE WEEKS APART.** ADR-006
  rejected almost exactly what DEF-284 asked for, and **neither document cited the other.** Found
  by grepping a table name, not by reading either. **When a task touches a designed area, grep for
  an ADR before trusting the spec.**
- ⛔ **A PERMISSION IS NOT EVIDENCE UNTIL YOU KNOW WHICH LAYER PRODUCED IT — and the same is true of
  a REASSURING one.** `rls = t, forced = t` looks like protection and is not, against `BYPASSRLS`.
- ⛔ **MY OWN FIRST SWEEP WAS WRONG BECAUSE IT INCLUDED `.next`.** A `grep -rn` over the repo
  returned megabytes of compiled bundles and buried the answer. **Search source paths, and if a
  result looks absurd, it is.** The second copy of `lastCompletedPeriod` only surfaced on the redo.
- ⛔ **"WRONG BY TWO MONTHS" WAS WRONG.** The orchestrator briefed a lane with it; the lane did not
  adopt it and wrote the accurate version into the test comment. **A lane correcting you is the
  system working — say so out loud.**
- ⛔ **A COUNT INHERITED FROM YOUR OWN PREVIOUS BOARD IS STILL AN INHERITED COUNT.** "Seven screens"
  was six; the seventh had already been checked and cleared in the register. Repeated to Ian twice
  before re-deriving.
- ⚠️ **A STALE STATUS FIELD READS AS CURRENT.** DEF-250 says `reported`; its code half is done.
  DEF-283 said `fixed`; only its *scheduling* half was.
- ⚠️ **A GATE NUMBER WITH A COMMIT HASH BESIDE IT STILL GOES STALE** — the roadmap cited 1030 unit
  and 2422 integration at `b1c496c` while the suites had grown to 1303 and 2709.
- ⚠️ Killing the dev server leaves a truncated `apps/erp/.next/dev/types/routes.d.ts` that fails
  typecheck and reads like a source error. `rm -rf apps/erp/.next` first. **Also: `npm run build`
  rewrites `apps/erp/next-env.d.ts` to build paths; starting the dev server puts it back.**
- ⚠️ **The unit script is `npm test`. There is no `npm run test:unit`** — the orchestrator briefed a
  lane with the wrong name.

## The lanes

Lanes rename themselves per task — **match on `[ref]`, never the name.**

| Lane | ref | Model | Today | Lane DB |
|---|---|---|---|---|
| **B** | `6b575a` | Sonnet 5 | **built T-263 AND T-264 slice 1**, both green | `shareat_test_t229` |
| **C** | `523c43` | Sonnet 5 | idle all day, unused | `shareat_test_qa` |
| **D** | `074c83` | Sonnet 5 | idle all day, unused | `shareat_test_t216b` |
| **E** | `505d06` | Sonnet 5 | DEF-279 read-only investigation | `shareat_test_def219` |

⭐ **All four are on Sonnet — Ian switched C and D today and the orchestrator re-probed to confirm
rather than trusting it.** Probe every lane for its model before assigning; it has paid off twice.

⛔ **EVERY LANE REQUIRES IAN'S GO-AHEAD IN ITS OWN WINDOW BEFORE IT TOUCHES A FILE.** All four said
so independently today. A lane that answers a census has **not** thereby accepted a task — lane D
put it exactly right: *"that command only changed my model — it wasn't a task assignment."* **Ask
Ian; never route around it, and never treat your own relay of his words as a substitute for him
acting in that window.**

⭐ **Lane E refused credit for work it had no record of** and asked that authorisation come from Ian
directly rather than via the orchestrator. It was right on both counts. **Brief every lane as if it
knows nothing — because it does.**

**Protocol lanes must be told** (they will not remember): first line `[X] STATUS: sentence`,
STATUS ∈ ACK/QUESTION/SPEC/READY/BLOCKED. Workers never run git, build, dev, or
`npm run test:integration`; integration only via
`node ~/.claude/skills/orchestrator/tools/it.mjs <lane db> <files>`. **You alone** stage explicit
paths, commit with `-F`, push, run the dev server and browser, write migrations, and edit the
bible, registers, roadmap and board.

## Databases and tools

`shareat_dev` · `shareat_test` · four lane DBs · **`shareat_test_t240`** — PIN `246810` on
`Smoke Store (SMK)`. **Do not drop it.** `shareat_dev` signs in as **Dev Admin, PIN `111111`**.
⚠️ Sign-in is store-scoped — **pick the store BY NAME**, never index 0.
`node ~/.claude/skills/orchestrator/tools/q.mjs <db> "<sql>"` runs SQL quietly against any of them.

## The status board

Ian reads **https://claude.ai/code/artifact/b1555e09-a726-492b-a431-7a30791e1d50** rather than chat.
`Artifact action:"read"` it, edit, republish with that `url` at **every commit**. **Never make a
second one.** `docs/ROADMAP.html` moves at the same moments — do both, with an **anchored script
that refuses unless each anchor matches exactly once.** It refused three times today and was right
every time, including once when a previous edit had already changed the text it was looking for.

## For Ian, still open

- ⛔ **The database lock — §1. He has said he wants to do this next, with you.**
- **The month-end deploy.** ✅ **Safe to do whenever** — verified across all twelve months. The
  committed schedule is the 15th at 02:00 Manila, eight hours clear of any boundary, and the
  version currently on the server also resolves correctly. ⚠️ **An earlier claim on the board that
  this had to wait for T-263 was wrong and was corrected.**
- **The fingerprint capture gap**, multi-week, in `CAPABILITY-GAPS.md`. ⚠️ He has still not been
  asked about face recognition, which v1 also has.
- **DEF-258's triage** — 47 same-digit dark-mode overrides across 28 files. Not all are defects.
- Five practice cash requests remain in `shareat_dev` with purposes beginning `T260-`.
