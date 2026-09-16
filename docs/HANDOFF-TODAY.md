# Handoff — 2026-09-16

> ⭐⭐ **THE GOAL FOR THE NEXT ORCHESTRATOR, IN IAN'S WORDS: *"make the app as close as possible to
> deployment."*** Read that as the ordering principle for everything below — when two pieces of work
> compete, the one that unblocks a deploy wins.
>
> ⛔⛔ **AND THE FIRST THING TO KNOW IS THAT `main` IS CURRENTLY UNDEPLOYABLE — FOR A REASON THAT IS
> NOT IN THIS REPOSITORY.** Twelve commits are pushed and CI is green on all of them, but **the
> deploy job will not start:**
>
> > *"The job was not started because recent account payments have failed or your spending limit
> > needs to be increased."*
>
> ⛔ **This is GitHub Actions billing, and only Ian can clear it** — Settings → Billing & plans.
> ⭐ **How to recognise it rather than re-diagnose it: the run fails in about SIX SECONDS.** A deploy
> that genuinely reaches the migrate step takes around three minutes. **A six-second failure means
> no job ran at all.** ⚠️ **CI is on the same meter** — it is still launching, but if the limit is
> exhausted CI will stop starting too, and since Deploy is `workflow_run`-gated on CI, that blocks
> everything rather than only deployment.
>
> ⭐ **The migration gate that blocked the two earlier deploys is FIXED and pushed** (`71e33d2`).
> §1 is kept because the finding behind it outlives the fix.

## Where things stand

**Production is healthy and UNCHANGED** — still on the build from 2026-09-14, verified by asking
`/api/health` and comparing all forty characters, not by seeing the field appear. ⭐ **The failed
migration never touched the running release**, exactly as `deploy.yml`'s own comment promises: *"A
failed unpack or failed migration never touches the currently-running release."* **Nothing is
broken. Nothing is deployed either.**

⛔ **Do not read a production sha out of this file** (DEF-360). Ask the endpoint.

**Nine commits pushed**, CI green on all of them (run `35096409253`, 11m20s). **Deploy run
`35097516941` failed at the migrate step.**

## ✅ 1. FIXED — the gate that blocked two deploys, and the finding that outlives it

> ✅ **RESOLVED 2026-09-16 in `71e33d2`.** Ian was given both options in plain language — make
> himself a super-admin, or fix the gate — and chose the gate, which fixes it for every future
> organisation rather than only for today. **The section below is kept because the finding is the
> valuable part, and because it is the second time in one day that a premise checked against the
> development database turned out false in production.**
>
> ⚠️ **It is NOT verified end-to-end.** CI is green on the fix, but the deploy has not been allowed
> to run since (see the billing block above), **so migration `0152` has still never completed
> against production.** Treat it as fixed-and-unproven until a deploy lands.

Migration `0152` (T-318's access backfill) **refused to run**, with this exact message:

> `migration 0152 refuses to run: 1 organisation(s) do not have exactly one active super_admin to
> attribute this backfill to. Offending organisations: SHAREAT OPC (0 active super_admin(s): none)`

⭐⭐ **THE GATE DID ITS JOB AND FOUND SOMETHING NOBODY KNEW: PRODUCTION HAS NO SUPER-ADMIN AT ALL.**
The local development database has one, which is where the mechanism was designed and tested. **The
premise was checked against the wrong database** — bible §13 rows 207 and 208, at the level of a
production fact rather than an identifier.

⚠️ **Why this is not simply a bug to patch around: it collides with Ian's own ruling.** Asked in
plain language who should be recorded as having decided these rows, he chose **his own name**,
because he is the person who decided the policy. The mechanism resolved "Ian" to *the org's sole
active super-admin* — **and no such person exists in production.** Ian is presumably an `admin`
there, not a `super_admin`.

⭐⭐ **`0152` WAS NEVER APPLIED, SO IT MAY BE EDITED.** RULES §1 rule 9 forbids editing an **applied**
migration; this one failed before writing a single row and is absent from `__drizzle_migrations`.
**Correct `0152` in place — do not write `0153` for this.** ⚠️ Confirm that absence yourself before
relying on it.

**The three candidate resolutions, and the choice is Ian's:**
1. **Grant Ian `super_admin` in production.** Cleanest against the ruling as written, and it is a
   real privilege change to a live system.
2. **Widen Step 2 to accept a sole active `admin` when no `super_admin` exists**, still refusing on
   zero or on ambiguity. ⚠️ **This is the fallback the orchestrator explicitly overruled** when the
   lane proposed it, on the grounds that attributing to a different person is the fabrication Ian's
   ruling rejects. **The facts have since changed** — the person Ian meant does not hold the role the
   mechanism looks for — so the overruling deserves re-examination rather than restating.
3. **Name the person explicitly** in the migration, resolved from a value Ian supplies.

⛔ **Whichever is chosen, keep the refusal.** A migration that silently attributes several hundred
access decisions to the wrong person is the outcome the gate exists to prevent, and it has now
demonstrated its value on its first real run.

## Gates at `5d3c695`

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **exit 0** — 123 files, **1728 passed**, 1 skipped |
| `npm run build` | **exit 0**, port 9008 confirmed free by process enumeration first |
| Integration — scoped, orchestrator's own DB | migration `0152`'s suite **13/13** on `shareat_test_orch`, run twice |
| Integration — **FULL SUITE** | ✅ **passed in CI** on `5d3c695`, run `35096409253`, **11m20s** |
| Document guards | **59/59** across five files |
| Backtick parity | ✅ zero odd rows across the four documents of record |
| CI | ✅ **active**, fired automatically |
| Deploy | ⛔ **FAILED at migrate** — see §1 |

⚠️ **Say "passed in CI", never bare "green"** for the full suite. It OOMs locally (DEF-245).

⛔ **These gates describe the COMMITTED tree. The working tree is not green** — see §3.

## 2. What happened this session

**Four tasks moved and two documents of record were found lying.**

- **T-317 shipped** — six guards that fail the build when a document disagrees with the code. ⭐ **Its
  own guard 5 went red against its own status line** while the lane was editing it, and the lane
  reworded rather than exempting itself.
- **T-314 slice A shipped** — the portable fingerprint logic. ⛔ **The approved spec was wrong and a
  lane refused to build it:** it said to *derive* the match token from the fingerprint templates.
  **A content-derived token is an unrotatable credential, because a person cannot rotate a finger** —
  a leaked one could never be invalidated. Corrected to mint fresh randomness, as v1 does.
- **T-318 specced and its migration shipped** — on Ian's ruling that a position, not a role, should
  decide what a person may do. He reported that Dishwasher, Server and Panda could record a sale
  with no way to switch it off; that is not a screen fault, it is four roles with every kitchen
  position resolving to `staff`.
- **DEF-359 repaired** — six malformed bible rows. ⭐ **The register's own description of one was
  wrong in a way a pipe count cannot detect:** row 206 was five structural pipes plus two bare, and a
  row with six structural plus one bare is the same total. Repaired as the single stray the register
  claimed, it would have reached six pipes with no final cell and **the new guard would have gone
  green on a broken row.**
- **`CAPABILITY-GAPS.md` §1 closed** — all five items it called *"blocks the January books"* had
  shipped, and the section said otherwise for about three weeks.

**Defects filed: DEF-360 through DEF-363.** The sharpest is **DEF-363** — the clock terminal compares
a scanned value against card numbers and fingerprint tokens as one flat namespace, so a colliding
value resolves by array order. **A punch on the wrong person, and attendance feeds payroll.** Not
reachable by chance; reachable deliberately, because a card's number is whatever is written on it.
⭐ **Zero exposure today for a measured reason: card usage is zero across 703 real clock-ins.** It goes
live the day badges are issued.

**Bible row 208 added, and it is about this orchestrator.** Seven identifiers and figures reached
lanes that had never been read — a function name that exists nowhere, a column that does not exist,
a guard count, a match count, a claim about a terminal's own model, a stale sha, and a screen Ian was
sent to that has no PIN form on it. **Every one was caught, and only because each briefing told the
recipient to verify rather than accept.**

## ⛔ 3. THE WORKING TREE IS NOT CLEAN — read before touching anything

**T-318 slice C is applied and UNCOMMITTED.** The 21 capabilities are flipped to `staff: false` in
**both** `docs/decisions/CAPABILITY-MATRIX.md` and `packages/auth/src/capabilities.ts`, and the two
agree — `tests/unit/capability-matrix.test.ts` passes **208/208**, verified independently.

**Uncommitted files:**
`docs/decisions/CAPABILITY-MATRIX.md` · `packages/auth/src/capabilities.ts` ·
`packages/auth/tests/integration/authorize.test.ts` · `packages/domain/src/files/index.ts` ·
`packages/domain/src/people/position-defaults.ts` · **new, untracked:**
`packages/domain/tests/integration/_fixtures/staff-everyday-access.ts`

⛔ **THE INTEGRATION SUITE IS RED IN THIS STATE, DELIBERATELY, AND THE REDNESS IS THE MEASUREMENT.**
**17 of 19 predicted files confirmed broken, 262 individual test failures** — measured by flipping
first, exactly as asked, rather than estimated. **Two predicted files passed clean**
(`customer-returns`, `supplier-master`) and **nobody has found out why** — do not assume they are
fine.

⭐ **A finding the spec did not predict: `authorize.test.ts` itself has three MORE failures** in
blocks nobody touched, each using one of the 21 as a convenient *"this is true for everyone"*
stand-in to test an unrelated invariant. **The same disease one level up, inside the very file that
was supposed to be the fix.**

⚠️ **It was left uncommitted on purpose.** Committing it would make `main` red, and a red `main`
blocks every deploy — directly against this session's stated goal. ⭐ **A backup exists outside the
repository** so the work cannot be lost: a patch of the tracked changes plus a copy of the untracked
fixture, in this session's scratchpad. **Prefer the tree itself; the patch is insurance.**

## 4. Pick up here — ordered by what unblocks a deploy

1. ⛔⛔ **Resolve §1 with Ian, then correct `0152` in place and re-push.** Nothing else restores the
   ability to deploy. **This is the whole job until it is done.**
2. **Finish T-318 slice C.** The lane left an ordered plan and it is worth following: wire the new
   fixture helper into the 17 broken files; find out why the two clean ones are clean; fix
   `authorize.test.ts`'s three newly-found failures; write the test that is the whole task — **two
   people, one store, TWO DIFFERENT POSITIONS, one capability, one holds it and one is refused**;
   fix `position-defaults.test.ts`'s test of the now-deleted refusal; then sweep the remaining
   integration files in batches, **never the full suite in one local run**.
3. **T-314 slice B onward** — blocked on Ian: a tablet, the reader model, and ⛔ **the app's identity,
   which is one-way.**
4. **T-316** — blocked on two things that are Ian's.
5. **DEF-363** — needs a ruling between a kind-aware `resolveScan` and a cross-column constraint.
   Recommendation on file: **both**, on the rule that no layer may be the only one for a given risk.

## 5. Do not decide these alone — they are Ian's

- ⛔⛔ **Who is recorded as deciding the access backfill**, now that production has no super-admin. §1.
- ⛔ **The clock app's identity** — one-way, and it blocks the largest remaining arc.
- **A tablet and the fingerprint reader model.**
- **The live balance on the cashier float account** — any non-zero figure stops T-316. The
  orchestrator cannot read it; SSH is blocked for agents.
- **Do cashiers enter the day's cash before or after handing it over?**
- **DEF-358** — refuse remitting before any day is verified, or admit a variance with a null day?
- **DEF-363** — see above.
- **T-315's backfill** — migration, reviewed script, or leave it manual.

## 6. Traps that have actually bitten

- ⛔ **The shell eats a backslash and executes backticks.** Write tool → plain file → a script that
  READS the file. Never `node -e`.
- ⛔⛔ **Take a table's expected shape from its HEADER, never a neighbouring row.** ⭐ **And the
  register's five sections do not share a shape** — A through D carry an `App` column that E does
  not, so the State column sits at a different index. **Reading one section's shape onto another is
  how the open-defect count came out wrong by 48 rows and reached Ian in a published document.**
- ⛔ **`verified` does NOT mean fixed.** The register's own key says it means *"I read the code"* —
  the defect is confirmed real. **Only `fixed` closes a row.** This was misread and published.
- ⛔ **⛔ in the Sev column means "correctness and money", not "blocking."** It is a category, not an
  urgency. Also misread and published.
- ⚠️ **At least 18 register rows say open while their own Disposition records the fix.** No count
  taken from the State column alone is trustworthy. **The six new guards do not cover this column.**
- ⛔ **`npm run build` dirties `apps/erp/next-env.d.ts`.** Generated — restore it, never commit it.
- ⛔ **A bible row insertion shifts every line below it** — run `npm run toc`, which the TOC guard
  will demand anyway.
- ⛔ **The full integration suite OOMs locally** (DEF-245). CI is where it runs.
- ⛔ **SSH to the droplet is blocked for agents.** Ian runs host-side commands — suggest `! <command>`.

## 7. Numbers to allocate from

Next task **T-319** · next defect **DEF-364** · next migration **`0153`**
⚠️ **Reserved, do not re-issue:** `0149` and `0150` (T-314 slices F and G), `0151` (T-316).
⭐ **`0152` is TAKEN by T-318 and is UNAPPLIED — correct it in place rather than allocating `0153`.**
Each `when` must exceed `1798860707084` and follow ADR-012 §5's grid — ⛔ **re-derive it from
`packages/db/migrations/README.md` at build time, never from a message.**

## 8. Live agent sessions

⛔ **ASK A SESSION ITS MODEL; NEVER READ IT OUT OF THIS TABLE** (DEF-361). The worker briefing
already requires each session to name its own model in its ACK.

| Session | Lane DB | State at wrap-up |
|---|---|---|
| `system32-85` | `shareat_test_orch` | orchestrator — this session |
| `webapps-65` | `shareat_test_lanea` | **idle.** T-317 guards, T-318 census and migration `0152`, the audit that corrected the published figures |
| `webapps-4e` | `shareat_test_laneb` | **idle.** T-314 slice A, the T-318 review that found the 19 fixtures, slice C **uncommitted** |
| `webapps-f7` | — | **idle.** DEF-359's independent measurement |

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL, IN HIS WORDS: "make the app as close as possible to deployment." When two pieces
of work compete, the one that unblocks a deploy wins.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md rows 204-208, and
docs/DEFECTS-REGISTER.md section E (DEF-360 through DEF-363 are the newest).

⛔⛔ FIRST: main is UNDEPLOYABLE and the cause is NOT in this repository. The deploy job will not
start — GitHub Actions billing, "recent account payments have failed or your spending limit needs
to be increased". Only Ian can clear it, in Settings → Billing & plans. Recognise it by the
duration: a billing refusal fails in about SIX SECONDS, a real migrate failure takes about three
minutes. CI is on the same meter and Deploy is workflow_run-gated on CI, so an exhausted limit
blocks everything. Do not go hunting the migration — that gate was fixed in 71e33d2 and CI is
green on it. It is fixed-and-UNPROVEN: 0152 has still never completed against production.

⛔ THE WORKING TREE IS NOT CLEAN. T-318 slice C is applied and uncommitted, and the integration
suite is RED on purpose — 262 failures across 17 files, which is the measurement, not a break.
Handoff section 3 lists every file. Do not commit it to main without finishing it; a red main
blocks every deploy.

⛔ BEFORE TRUSTING ANY PIPELINE: gh workflow list --all. CI sat disabled_manually for nine hours
once and nothing reported it (DEF-336). Deploy is workflow_run-gated on CI.

⛔ A table's expected shape comes from its HEADER, never a neighbouring row — and the defects
register's five sections DO NOT share a shape. Reading one onto another put a wrong number in
front of Ian. In that register, `verified` means the defect is CONFIRMED REAL, not fixed; only
`fixed` closes a row. And the stop sign in the Sev column means "correctness and money", not
"blocking".

⛔ EDITING DOCS: the shell EXECUTES backticks and EATS backslashes. Write tool → plain file → a
script that READS the file. Then: node scripts/backtick-parity.mjs

⛔ THE LANE RUNNER: node ~/.claude/skills/orchestrator/tools/it.mjs <lane_db> <files...>
Never npm run test:integration. The full suite OOMs locally (DEF-245); say "passed in CI".

⭐ ASK EACH LANE A QUESTION, NOT JUST FOR A CHANGE, AND TELL IT TO CHECK YOU. Bible row 208 is
about the orchestrator handing lanes seven facts it had never read. Every one was caught, and
only because the briefing said verify rather than accept. On this day that discipline overturned
a security design, a spec premise, and three figures already published to Ian.

Next task T-319 · next defect DEF-364 · migration 0152 is TAKEN and UNAPPLIED, correct it in
place; 0149/0150 → T-314 F/G, 0151 → T-316.

-----------------------------------------------------------------------------------------------
