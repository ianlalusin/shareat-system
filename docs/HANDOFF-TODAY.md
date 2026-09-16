# Handoff — 2026-09-16

> ⭐⭐ **THE GOAL FOR THE NEXT ORCHESTRATOR, IN IAN'S WORDS: *"make the app as close as possible to
> deployment."*** Read that as the ordering principle for everything below — when two pieces of work
> compete, the one that unblocks a deploy wins.
>
> ✅✅ **DEPLOYED AND VERIFIED. Production is running `5626cf9`**, compared against `origin/main` by
> all forty characters, built 14:21:58Z. **Migration `0152` APPLIED — the deploy log reads
> *"Migrations applied in 259ms"*** and both of its gates passed against real production data:
> every open employment has a position, and exactly one attribution person resolved.
>
> ⭐ **So the access backfill is LIVE. Roughly 735 rows now record what each position is currently
> allowed to do, and nobody's access changed** — that is the point of it. **The additive half of
> T-318's additive-then-flip order is done in production**, which means slice C's matrix flip can
> now land without stripping anyone. ⚠️ **Slice C itself is still unfinished — see §3.**
>
> ⚠️ **Three things blocked this deploy today and only the first was ours.** The migration gate
> refused twice for a real reason (§1). Then **GitHub Actions billing** stopped jobs from starting
> at all — Ian cleared it. ⭐ **Recognise that one by DURATION rather than re-diagnosing it: a
> billing refusal fails in about six seconds because no job runs; a deploy that genuinely reaches
> migrate takes about three minutes.** CI is on the same meter, and Deploy is `workflow_run`-gated
> on CI, so an exhausted limit blocks everything rather than only deployment.

## Where things stand

**Production is healthy and CURRENT** — running the tip of `main`, verified by asking `/api/health`
and comparing all forty characters rather than by seeing the field appear.

⛔ **Do not read a production sha out of this file** (DEF-360). **Ask the endpoint** — the sha named
in the banner above was true at wrap-up and the next deploy falsifies it, which is that defect's
whole lesson.

**Fourteen commits pushed today**, CI green on all of them, and the final deploy succeeded.

⭐ **Worth keeping from the three failures that preceded it: production was never at risk.** Two
refused inside the migration and one never started at all, and in every case the running release was
untouched — `deploy.yml` unpacks to a fresh directory and migrates BEFORE swapping the symlink, so a
failed migration cannot reach the live app. **That ordering is why a bad deploy cost nothing today**,
and it is worth knowing before anyone is tempted to "simplify" it.

## ✅ 1. FIXED — the gate that blocked two deploys, and the finding that outlives it

> ✅ **RESOLVED 2026-09-16 in `71e33d2`.** Ian was given both options in plain language — make
> himself a super-admin, or fix the gate — and chose the gate, which fixes it for every future
> organisation rather than only for today. **The section below is kept because the finding is the
> valuable part, and because it is the second time in one day that a premise checked against the
> development database turned out false in production.**
>
> ✅ **VERIFIED END-TO-END.** The fix deployed and **`0152` completed against production** —
> *"Migrations applied in 259ms"*, both gates satisfied by real data. ⭐ **The tiered rule resolved
> to the organisation's sole active admin, exactly as predicted**, because that is the account
> `createFirstAdmin` creates and no super-admin exists. **The premise that failed twice is now
> confirmed correct by the live system rather than by reasoning.**

**What happened, in the past tense, because it is now fixed.** Migration `0152` (T-318's access backfill) refused to run twice, with this exact message:

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

⛔⛔ **`0152` IS NOW APPLIED IN PRODUCTION. NEVER EDIT IT.** RULES §1 rule 9 applies in full from
this moment: **any correction is a NEW migration**, `0153` or later. ⚠️ **This paragraph previously
said the opposite** — that `0152` was unapplied and could be corrected in place — and that was true
when written and became false the instant the deploy succeeded. **A session acting on the old
sentence would have edited an applied migration**, which is exactly the class of stale instruction
bible §13 row 204 exists to forbid. It is corrected rather than deleted so the trap is visible.

✅ **RESOLVED — Ian chose option 2, and it is shipped and verified.** The three options put to him
were: grant himself `super_admin` in production; widen the gate to accept a sole active `admin`; or
name the person explicitly. **He chose the gate**, which fixes it for every future organisation
rather than only for today.

⭐ **The rule now in force:** exactly one active `super_admin` resolves to it; no `super_admin` and
exactly one active `admin` resolves to the admin; **anything else refuses, naming every candidate at
whichever tier was ambiguous.** ⛔ **The refusal was kept deliberately** — a migration that silently
attributes several hundred access decisions to the wrong person is the outcome the gate exists to
prevent, and it demonstrated its value on its first real run by catching this.

⚠️ **The orchestrator had explicitly overruled that fallback when the lane first proposed it**,
arguing that attributing to the admin names a different person. **That was wrong and production
proved it:** the sole admin is not a substitute for the owner, it **is** the account
`createFirstAdmin` creates for them.

## Gates at `5626cf9` — the commit production is running

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **exit 0** — 123 files, **1728 passed**, 1 skipped |
| `npm run build` | **exit 0**, port 9008 confirmed free by process enumeration first |
| Integration — scoped, orchestrator's own DB | migration `0152`'s suite **13/13** on `shareat_test_orch`, run twice |
| Integration — **FULL SUITE** | ✅ **passed in CI** on `71e33d2`, run `35103525852`, **11m39s** — the last run over changed code; the two commits after it are documentation only |
| Document guards | **59/59** across five files |
| Backtick parity | ✅ zero odd rows across the four documents of record |
| CI | ✅ **active**, fired automatically |
| Deploy | ✅ **SUCCEEDED** — `0152` applied against production, "Migrations applied in 259ms" |

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
blocks every deploy — directly against this session's stated goal.

⭐ **A BACKUP EXISTS OUTSIDE THE REPOSITORY, AND HERE IS THE PATH — the first draft of this handoff
said a backup existed and did not say where, which would have made it unfindable by exactly the
session it was written for:**

```
C:\Users\ianla\AppData\Local\Temp\claude\C--Windows-System32\596243e1-1b94-488a-8fe0-9301ee7b81c7\scratchpad\
  laneb-slice-c.patch          — git diff of the five tracked files (~46 KB)
  laneb-untracked\_fixtures\   — the new, untracked fixture helper
```

⛔ **Prefer the working tree; the patch is insurance only.** ⚠️ **That directory is session-scoped
and may be cleaned up** — if the tree still carries the changes, it is the authority and the patch
can be ignored. If the tree has been reverted and the patch is also gone, the work is recoverable
from this document's own description plus the lane's plan in §4, which is why both are written out
rather than summarised.

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

## 6a. Two pages built for Ian, and neither lives in this repository

⛔ **Recorded here because nothing else in the repo knows they exist**, and the next session will be
asked about them.

| Page | What it is | URL |
|---|---|---|
| **What's Left** | Everything outstanding before v2 can replace v1, counted from this repo's own records. ⚠️ **Corrected once already** — its first version had three wrong figures | `https://claude.ai/code/artifact/37fa7d33-9a59-4ce2-b796-69f9461aae3e` |
| **Access by Position** | The approved design for T-318 slice D's screen — all 96 capabilities, ordered by sensitivity, positions as toggles | `https://claude.ai/code/artifact/f5d644bb-50d5-4f98-9b35-a3027325f739` |

⭐ **"What's Left" carries a correction notice on its own face, deliberately.** Its first version
said 124 open defects and seven of nine phases complete; the real figures are **187–205** and
**four of nine**. All three errors came from reading prose instead of the definitions at the top of
the same files. ⛔ **Do not quote its figures without re-deriving them** — that is the mistake it
documents.

⚠️ **Republishing either page needs its URL passed explicitly**, or a second, separate artifact is
created instead of updating the existing one.

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

✅ FIRST, THE GOOD NEWS SO YOU DO NOT RE-DIAGNOSE A SOLVED PROBLEM: production is deployed and
healthy on 5626cf9, and migration 0152 APPLIED against the live database. The access backfill is
live — about 735 rows recording what each position may currently do, with nobody's access changed.
Verify by asking /api/health and comparing all forty characters; never read a sha out of a document.

⚠️ Three things blocked that deploy earlier and the lesson is worth keeping: the migration gate
refused twice for a real reason (handoff section 1), then GitHub Actions billing stopped jobs from
starting at all. Recognise the billing one by DURATION, not by reading logs — it fails in about six
seconds because no job runs, while a deploy that reaches migrate takes about three minutes.

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
