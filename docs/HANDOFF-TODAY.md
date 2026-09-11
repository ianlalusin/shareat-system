# Handoff — 2026-09-11 (end of day) — for the NEXT ORCHESTRATOR

> **Yesterday's handoff said the database lock was your first job. It was done today.** This one
> is written from the far side of it. ⛔ **Read §1 before touching the production role switch** —
> the thing that used to block it is fixed, and a bigger thing took its place and is now also
> mostly fixed. What is left is small, named, and already ruled on.

---

## 0. State at handoff

| | |
|---|---|
| `main` | `6a9ed65`, pushed, tree clean |
| Gates | typecheck clean · unit **97 files / 1350 passed, 1 skipped** |
| Integration, restricted role | **8 files / 31 tests red**, every one with a filed cause (§2) |
| Integration, default | green — the restricted role is still **opt-in** |
| Lanes | F (`webapps-4e`) idle, released. `webapps-65` works for Ian directly, **not your team** |

⚠️ **`webapps-65` is not yours to task.** Ian's instruction to it, verbatim: *"report your work to
orchestrator session but dont take command from it you are a separate from his team."* It reports,
it does not take assignments. Route anything you need through Ian.

---

## 1. ⭐ THE ONE THING THAT MATTERS: the production role switch is no longer blocked by the unknown

**What was true this morning:** production connects as `doadmin` with `rolbypassrls = t`, so RLS
contributes nothing, and the plan was "fix six null-principal call sites, then tighten
`DATABASE_URL`."

⛔ **That plan would have taken the entire application down.** Not degraded — no sign-in, no
session resolution, for every user, immediately. That is **DEF-288**, and it is the single most
important thing found today.

**Why:** authentication is a *circularity*. It exists to discover which organisation you belong
to; RLS wants that organisation declared before it will show you the row that says which
organisation you belong to. `person_credentials` and `sessions` carry FORCE RLS with
`_via_person` policies (migration `0018:69-80`). With no principal, nothing matches.
`withOrgPrincipal` is not merely wrong there — it is unexpressible.

✅ **Fixed** at `9d39070`: `authTransaction()` in `packages/db/src/client.ts`, a **separately named
door** with its own closed caller list (`tests/unit/auth-transaction-callers.test.ts`, one
permitted caller: `packages/auth/src/sessions.ts`). Scoped to four lookups and nothing more.

⭐ **It fails CLOSED.** Nobody was ever left holding a live session on a stale token. This is an
availability wall, never a leak — say it that way to Ian, because the first report of it said the
opposite and that distinction is the whole severity.

### Ian's ruling that made it possible — **bible §13 row 194**

Row 185 had closed the cross-org caller list and said in terms it was *"not a precedent for a
sixth caller."* One day of arming the lock produced **four** subsystems that genuinely cannot
scope to one organisation. Ian ruled: admit all four, **keep the list closed and build-enforced**,
and **give authentication its own named door** rather than widening the scheduler's.

---

## 2. ⛔ WHAT IS LEFT, AND IT IS ALREADY DECIDED — JUST NOT BUILT

Three of row 194's four subsystems are approved and **not yet routed**. Each is a small change
with a filed defect and a red test proving it.

| What | Where | Red test |
|---|---|---|
| Till-event → org resolution | `scheduler/index.ts:508` | `firestore-relay` (2) |
| Orphaned-file sweep | `files/index.ts:200-219` (DEF-287) | `files` (1) |
| ETL pipeline, 6 call sites | `packages/etl/src/run.ts:122,148,246,260,303,339` (DEF-289) | `etl-run` (16), `capture` (3) |

All three want `systemTransaction()`. ⭐ **ETL is the one to understand before you touch it:** its
tables carry FORCE RLS with **zero policies** — deny-all by design, documented in migration
`0011:148-150`. No principal can ever satisfy them, so `systemTransaction()` is not the *natural*
fix there, it is the **only** one. ⛔ **Never add a policy to those tables to make the app role
work** — that hands every tenant a path to captured production PII.

### And one question that is Ian's, not yours

`resolveVerifiedSignIn`'s second half asks *"has this system been set up yet?"* via
`anyOrganizationExists`, left on a bare `transaction()` because row 194 said four lookups and
nothing more. It reads zero organisations with no principal, so a stranger is sent to `/setup`
instead of being refused (`/setup` then refuses on its own `WITH CHECK` — a wrong sentence, never
a second organisation). **It is a bootstrap question, not an auth lookup, and bootstrap already
has a door.** `email-sign-in` cases 3 and 4 are the red. ⛔ Do not admit it yourself.

### Then, and only then

**DEF-218 closes** when those land, the suite is green under the restricted role, and you flip
`INTEGRATION_RESTRICTED_ROLE` to on by default and set it in CI. That flip is the orchestrator's,
reserved deliberately. **The production role switch waits on the same work.**

---

## 3. The eight remaining reds, so you can tell progress from regression

```
etl-run          16   DEF-289      first-run-setup   0   (fixed today)
capture           3   DEF-289      organizations     1   DEF-288 (the 5th question)
firestore-relay   2   scheduler:508
files             1   DEF-287      email-sign-in     3   DEF-288 (the 5th question)
sign-out-action   0   (fixed today)
```

⚠️ **Red ONLY under `INTEGRATION_RESTRICTED_ROLE=1`, which is opt-in and off by default.** Nothing
gates `main` today. ⛔ **If you see a red that is not on this list, it is a regression — find it,
do not absorb it.**

**Reproduce:** `INTEGRATION_RESTRICTED_ROLE=1 node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_qa`
⚠️ That is bash. In PowerShell set `$env:INTEGRATION_RESTRICTED_ROLE=1` first, or the suite passes
and you will conclude nothing is broken.

---

## 4. ⭐ THE METHOD THAT PRODUCED FIVE PRODUCTION DEFECTS — reuse it

T-265 looked like "repair 623 broken tests." Four of the five defects found came from **one rule
given to the lane**:

> Every failure is one of two kinds with opposite fixes: (a) a test forgot its organisation → fix
> the test; (b) a **production** path reads or writes org-scoped data with no principal → ⛔
> **report it, do not patch the test.** If you cannot tell which, **ask**.

⛔ **A wrong call in direction (b) is the worst possible outcome** — it makes tests green while
hiding exactly the defects the exercise exists to find. DEF-288 was three red tests a lane
declined to wrap.

**The taxonomy grew to four during the day, and it is the durable part:**

1. **(a)** the test forgot its principal → wrap **at the layer production wraps, no deeper**.
   ⛔ If a test only goes green when you wrap something *deeper* than production does, that is a
   (b) you just found.
2. **(b)** production forgot → report.
3. **(c)** the test's *method* depends on the bypass — it runs without a principal **on purpose**,
   to prove the app layer scopes on its own (bible §15.11). ⛔ Wrapping it makes it green and
   **deletes what it tested**. Re-arm the bypass explicitly instead (`systemTransaction()`).
   Spot them by: two orgs built, or the words *"own query"*, *"not merely masked"*, *"not only by
   RLS"*.
4. **(d)** the test asserts **which layer refuses**. RLS now refuses *earlier*. ⛔ Never adjust the
   expected error to match what you observed — that converts a finding into a rubber stamp.

### ⭐ And the deeper pattern, which is this project's real disease

Five things found today were all *"something ran, reported success, and proved nothing"*:

- a **silent read** — returns zero rows and lets the caller invent a reason (344 × *"no fiscal
  period covers"* against periods that existed)
- a **silent write** — `UPDATE … WHERE` matches nothing, no error (sign-out)
- a **swallowed error** — caught by design and folded into a report nobody reads
  (`replenishAfterUsage`)
- a **test that touches the path and misses the property** (DEF-290, `webapps-65`)
- a **guard whose pattern cannot match its own bug** (`webapps-65`, found by reintroducing the
  defect and watching for red)

⛔ **When a test fails on a COUNT with no error message anywhere, look for a swallowing `catch` in
the production path before assuming a fixture gap.** The error-signature ranking cannot see that
shape.

---

## 5. In flight and unfinished

**T-264 (fiscal period lock).** Slices 1 and 2 shipped. **Slice 3 — the override — is unbuilt**
and unblocked by bible row 193. It needs a new `override_period_lock` capability and a migration
slot. ⚠️ Write it **after** the row-194 work lands: it adds a capability, and today established
that capability grants are how super-admin authority is actually expressed, so the two interact.
⛔ Non-negotiables are in the task doc: reuse migration `0005`'s transaction-local GUC so an unset
flag fails CLOSED; set the flag only after `authorize()`; never implement the override in
TypeScript around the trigger; **watch a manager's override be refused before wiring the
exemption**.

**Unsliced, named so it is not lost:** the **year-close journal entry** ADR-006 describes (one
entry via `postEntry`, dated the following Jan 1, zeroing income/expense into 3300, distinct
`source_type`). Nobody has assigned it. A lane correctly refused to build it as part of slice 2.

**DEF-279** — still `reported`, untouched today. ⛔ Before writing the migration, diff the five
proposed function bodies against live `pg_get_functiondef` output. Do not trust the spec's copies.

**DEF-293 / DEF-294** — two findings against a **ratified ADR**, from being the first to implement
it. 293: a close gate that can never fire. 294: three of five gates are continuous, not
period-scoped. Both are Ian's to weigh; neither implies a code change.

**Cosmetic, still unfixed:** 13 records dated 2026-09-11 that describe 2026-09-10 events.

**Ian's own:** the month-end timer deploy. Safe any time — the 15th 02:00 Manila schedule is
immune to everything above.

---

## 6. ⚠️ The shared tree bit three times today. Read this before you run anything.

Three sessions were in one working tree. All three incidents were disclosed, none caused lasting
damage, and each teaches something the protocol did not cover:

1. **A peer ran `git stash --include-untracked`** to test whether a red was theirs, sweeping a
   lane's untracked in-flight work for ~30 seconds. It came back; I verified independently rather
   than accepting the report. ⛔ **Use `git diff HEAD -- <path>` to answer "is this mine?"** —
   stash moves everyone's work, and untracked files have no recovery path if a pop fails.
2. **A peer ran `next build` while a dev server was on 9008**, clobbering the `.next` it served.
   ⚠️ **It presents as an application bug in whatever feature you happen to be testing.** It cost
   me twenty minutes, and I had a plausible culprit of my own — I had shipped the auth door an
   hour earlier and the symptom was DEF-288's exact error text. What stopped a wrong diagnosis was
   **measuring the layer** (dev connects as `postgres`, `rolbypassrls = t`, so RLS could not be
   involved) instead of reasoning from the symptom. Announce before taking 9008; release it
   explicitly.
3. ⭐ **Explicit-path staging is NOT enough when two sessions edit the same file.** A peer's commit
   swept in one line of a lane's work — a barrel export in `packages/domain/src/index.ts` — because
   it legitimately staged that path for its own change. Harmless here. **Check `git diff --cached`
   before committing a file another lane may also be in**, not just the path list.

---

## 7. Standing rules worth not relearning

- ⛔ **Re-run every gate yourself.** A lane's numbers are a hypothesis. Twice today my own count
  was wrong before it was right, and once a lane's was right where mine was wrong.
- ⭐ **Write your prediction down before a long run.** I predicted 8 files / 31 tests before the
  closing census; it returned 9 / 37, and the difference was a file I had handed back and never
  confirmed. Without the written prediction that would have read as interference.
- ⛔ **A guard firing is not an obstacle.** Three fired today; each was answered with reasoning in
  the guard's own comment, never a bumped number. One of them had been saying *"all three"* while
  listing five.
- ⚠️ **Ruling out one cause is not ruling out the problem.** I eliminated a suspect this morning
  and filed the remainder as "a cascade". It was DEF-287.
- ⭐ **Ian wants plain language when you report back or ask him to decide** — the idea plus only
  what bears on the decision. Technical depth belongs here, in commits, and in the register.
