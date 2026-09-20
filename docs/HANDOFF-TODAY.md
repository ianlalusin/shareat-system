# Handoff — 2026-09-20, written after a day whose output was a CONTRACT, not a feature

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> ⚠️ **AND IT IS NOT LAUNCHED.** Production deploys exist; no staff use it yet. That changes urgency,
> never correctness. ⛔ **This document makes no PRESENT-TENSE claim about which commit production
> runs** (DEF-360). Ask `/api/health` and compare all forty characters against `git rev-parse origin/main`.

## ⛔⛔ THE HONEST HEADLINE, BEFORE ANY NUMBER

**T-330 IS NOT FINISHED, AND IT HAS ZERO IMPLEMENTATION.** One feature shipped this morning (T-329
Tier E, `e472f4b`). The afternoon produced **a spec that survived seven amendments, 35 tests that
fail for the right reasons, five of Ian's decisions recorded in the bible, five new register rows —
and not one line of working auto-allocation.** ⛔ **Do not infer a completed task from the commit
count.**

⭐ **Five of the seven amendments overturned the ORCHESTRATOR**, and every one came from a
measurement that disagreed with someone's reasoning. §7 is the part to read if you read nothing else.

## ⭐ WHAT IAN RULED TODAY — six rulings, all recorded, none left in a transcript

| Where | Ruling |
|---|---|
| bible row **217** | The business deducts, adds the employer share, and **remits to the agencies itself** → T-190 AND T-193 both in January scope, **including the employer share (6110–6130)** v1 left out. ⭐ **T-190's data gate finally has an owner and a date: HR collects SSS/PhilHealth/Pag-IBIG/TIN for all 126 staff by END OF OCTOBER 2026.** Start trigger: the first employment carrying a real SSS number, not all 126. |
| bible row **218** | SC/PWD discount identity is **captured at POS when POS is built** — not in the ERP. T-137's ERP half waits on `apps/pos`, which is reserved and unbuilt. ⚠️ Only HALF of blueprint §7 item 3. |
| bible row **219** | ⛔ **Sign-in throttling APPROVED — DEF-063's deferral is LIFTED, and it is T-331.** Per-store AND per-device throttling with a lockout; the attempt log feeds T-135's findings engine as *"repeated failed sign-ins at one terminal"*, **not a log line**. Spec unwritten. |
| bible row **220** | **Suppliers are paid in full** → BIR 1601-E expanded withholding is **out of v2 scope**. ⚠️ **Recorded with the caution it was given under:** if the business is legally a withholding agent for any class (**rent to a landlord** is the usual one), paying in full does not discharge the obligation — an accountant's question, not v2's. *"v2 does not build it"* and *"the obligation does not exist"* are different claims; only the first was decided. |
| bible row **221** | **T-187 (service-charge distribution, clearing 2160) is BUILT NOW and the service charge stays SWITCHED OFF.** ⭐ Defuses DEF-082 by SEQUENCING instead of by a warning sentence. ⛔ **The ENABLE decision is separate and STILL OPEN** — the only unruled item left from today. |
| `docs/tasks/276-*.md` | **T-276 QUEUED** — ordinary lane work before cutover. Design was ruled 2026-09-12 (option c); both remaining gates are clear. ⭐ **Migration slot `0156` ALLOCATED to it.** |

⛔⛔ **A STALE NUMBER CAUGHT WHILE RECORDING IT:** T-276's doc said *"build it next cycle on slot
0146"*, written when `0145` was live. **Migrations have since reached `0155`** — wrong for ten slots,
and it would have collided with an APPLIED migration. ⭐ Corrected visibly, not silently: a task doc
carrying a specific number nobody re-checked is how the hand-applied-migration defect of 2026-09-06
happened.

## ⭐⭐ PHASE 6 WAS ALREADY CLOSED, AND `ROADMAP.html` WAS CONTRADICTING ITSELF

Ian's closing directive was **"complete phases 2, 5 and 6"**. ⛔ **It is TWO phases, not three.**

`docs/ROADMAP.html` states every phase's status in **two places**, and for Phase 6 they disagreed:
the **phase summary** said `s-active`/`c-active`, *"T-209, T-210, T-211 & T-213 shipped"*; the
**detailed wave** said `c-done`, *"T-209a/b/c, T-210–T-214, T-218–T-224 — all shipped"*, and T-214's
own note says **"Phase 6 is closed"**, shipped 6 Sep. **Nothing was holding Phase 6 open. A stale
summary block was, for two weeks.** Corrected; `document-facts` + `task-status-banner` green (39/39).

⭐ **Generalises past this page:** a document that states the same fact twice will eventually state it
two ways, and the reader believes whichever half they opened. Found only because a lane said *"I
could not tell from the page"* and asked instead of picking one.

## ⛔ 1. PICK UP HERE — IAN RULED THE ORDER, 2026-09-20

**FINISH T-330 FIRST, then close Phases 2 and 5.** Asked directly and answered: the contract took
seven corrections and the tests are written, so **part-built is the expensive state** — whoever picks
it up cold pays again for the context that produced those corrections.

1. **T-330** — §2 and §3 below. ⛔ **THE SEVEN AMENDMENTS OVERRIDE THE ORIGINAL BODY, WHICH WAS
   CORRECTED FOUR TIMES. Read them LAST and let them win every disagreement.**
2. **Phase 2** (exit gate: subledgers tie to control accounts, a real closed period reconciles,
   divergences from v1 logged): the DEF-395/DEF-382 re-derivation · DEF-386 · DEF-374 · DEF-393 ·
   T-187 (row 221, switch off) · T-136's two open cash-custody sections · T-316 (blocked on two of
   Ian's answers: the live float balance, and count-before-or-after-handover) · T-276 (queued, slot
   `0156`; its cliff is 2027-09-01, so it closes the phase rather than blocking January).
3. **Phase 5** (payroll, 16 of 18): T-190 on row 217's trigger, then T-193. ⚠️ **Review the
   contribution rates against the CURRENT year first — SSS changes yearly.** Exit gate (rewritten 31
   Aug): a payslip a staff member could be shown, posted, days frozen, trial balance ties, an advance
   netted to zero by the following run.
4. **T-331** (PIN throttling, row 219) — ⭐ **ahead of T-187 despite arriving later**: cheap now, an
   incident later, and no terminal is in front of a cashier yet.

## ⛔⛔ 2. WHAT IS IN THE TREE AND DELIBERATELY NOT COMMITTED

**Six files are uncommitted BY DESIGN. They are not lost work and they are not junk.**

| Path | What it is |
|---|---|
| `packages/domain/src/shared/allocate-oldest-first.ts` | ⛔ **STUB, deliberately WRONG** — allocates nothing. Its header is the most important documentation in the task. |
| `packages/domain/src/ap/index.ts` (tail) | ⛔ **STUB** `suggestPaymentAllocation` — no allocations, **no `authorize` call on purpose** |
| `packages/domain/src/ar/index.ts` (tail) | ⛔ **STUB** `suggestCollectionAllocation` — mirror |
| `packages/domain/tests/unit/auto-allocate-order.test.ts` | 17 cases, all red |
| `packages/domain/tests/integration/ap-auto-allocate.test.ts` | 9 cases, all red |
| `packages/domain/tests/integration/ar-auto-allocate.test.ts` | 9 cases, all red |

⛔⛔ **WHY THEY ARE NOT COMMITTED, AND DO NOT "FIX" THIS BY COMMITTING THEM:** the 35 tests are
**intentionally red**, and the stubs add exports with no app caller, which fails
`tests/unit/domain-actions-have-callers.test.ts` and `tests/unit/production-caller-ratchet.test.ts`.
**Committing any of it makes `main` red, and CI gates Deploy** — the exact failure that left main red
for 90 minutes on 2026-09-19 AND again on 2026-09-20. ⭐ **They are safe on disk and named here by
path.** Commit them in the same commit as the implementation that makes them green.
⛔⛔ **TWO OF THE SIX ARE TRACKED MODIFICATIONS, AND A RESET DESTROYS THEM.**
`packages/domain/src/ap/index.ts` and `ar/index.ts` are ` M` — **modified tracked files**. Untracked
files survive `git reset --hard` and `git checkout -- .`; **tracked modifications do not.** Those two
hold the wrapper stubs carrying the signature that took seven amendments to arrive at: `tx` first,
`storeId` fail-closed, and amendment 7's `typed`. ⭐ **The spec alone does not reconstruct them.**

⭐ **SO A PATCH IS SAVED, UNTRACKED, AT `docs/wip/t330-wrapper-stubs.patch`** (158 lines,
`git diff` of both files against `6ebcbf0`). It survives a reset because it is untracked. To restore:
`git apply docs/wip/t330-wrapper-stubs.patch`. ⛔ **Delete it once the real implementation is
committed** — a stale patch of a superseded stub is worse than no patch.

⛔⛔ **DO NOT SANITY-CHECK IT WITH A PLAIN `git apply --check` — THAT IS EXPECTED TO FAIL, AND THE
FAILURE MEANS NOTHING IS WRONG.** A patch cannot apply to a tree that already contains its changes,
so while the stubs are still in the working tree you get `error: patch does not apply` for both
files. ⭐ **To verify it while the changes are present, use `git apply --check --reverse`** — that
passes, and it is the check that actually proves the patch matches the tree. Measured 2026-09-20:
plain `--check` fails on both files, `--check --reverse` is clean, and the patch is **byte-identical
to a fresh `git diff`** of the two files. **After a reset, against a clean HEAD, a plain `git apply`
is correct and works.**
⭐ **Found by the AUDITOR, which nearly reported the `--check` failure as a broken safety net and
ruled out the innocent mechanism before sending.** ⛔ The trap was in the INSTRUCTION, not the
artefact: a session that sanity-checks "restorable with `git apply`" — the correct instinct, and the
one this whole day trains — sees two hard errors and concludes the net is broken, then regenerates
the patch from a tree that has since moved, or abandons it.
⚠️ **One limit, recorded rather than hidden:** `git diff` warned `LF will be replaced by CRLF` for
both files. The round-trip is proven on this machine (`core.autocrlf=true`), so it does not affect
the reset case the patch exists for. It would only matter applying it after a fresh clone with a
different `autocrlf` — and the patch is meant to be deleted within the day.
⭐ **Found by the AUDITOR at the last possible moment** — after the wrap-up commit, with terminals
about to be cleared. The wrap-up committed the spec and the register rows and left **the executable
half of the contract in one working tree.**

⚠️⚠️ **AND A CLAIM ABOUT THE STUBS THAT TURNED OUT WRONG — WITH A MECHANISM THAT IS NOT THE OBVIOUS
ONE.** The auditor warned that the empty stub would make the five exact-sum vectors PASS, giving the
next builder a false-green baseline. ⛔ **Measured instead of accepted: `npx vitest run --project
unit packages/domain/tests/unit/auto-allocate-order.test.ts` → 17 tests, 17 FAILED.** None passes:
the tester had strengthened those five vectors with an `expectedAllocations` assertion the empty stub
cannot satisfy — the repair for the very vacuity the auditor had predicted in F6.

⛔⛔ **THE FIRST DIAGNOSIS OF THIS WAS ALSO WRONG, AND THE AUDITOR CORRECTED IT.** This section
originally read *"the auditor read the stub bodies and reasoned; the tester had run"* — as though
reading were the weak instrument. ⭐ **It was not.** Measured, three ways, after the auditor pushed
back: the test file is **225 lines** and was **105** when it read it; `grep -c expectedAllocations`
is **9** and was **zero**; `mtime 2026-09-20 16:35:28`. **Its inference was CORRECT for the file it
actually read** — a bare conservation identity over an empty result does pass. ⛔ **What failed was
saying *"on the tree as it stands today"* about a file three lanes had been editing for hours,
without re-reading or even re-`stat`ing it.**

⭐⭐ **SO THE LESSON IS NARROWER THAN "RUN THINGS, DO NOT REASON", AND THE WIDER VERSION WOULD BE
FALSE:** F6, F7 and the `''` finding — the three sharpest results of the day — were **all reached by
reading**, and two were confirmed by execution afterwards. ⭐ **The rule that actually applies: a read
of a shared tree is a PHOTOGRAPH, and any present-tense claim built on one needs the mtime checked
before it is sent.** A `stat` costs nothing and would have stopped this. ⚠️ The same instrument would
have resolved `{console.error('CONNECT`'s authorship (§9 item 3) — skipped there too, by both of us.

⭐ **Worth recording about the triage rather than the finding:** the warning was not written in
because it disagreed with a measurement already on the record, and the disagreement was investigated
rather than resolved by picking a side. **That is §7's rider applied in the hardest direction — against
a lane that had been right repeatedly that day.** Being right earlier is exactly what gets the next
claim waved through.

⚠️ **Three OTHER files are not ours and must never be staged:** `apps/erp/next-env.d.ts`
(Next-generated), `docs/reviews/NEXT-PROMPT.md` (modified), `docs/reviews/2026-09-17.md` (untracked)
— an exited session's since 2026-09-17.

## ⭐⭐ 3. T-330's SEVEN AMENDMENTS — the actual work of the day

The spec describes auto-allocation: a payment fills the allocation boxes most-overdue-first, and the
operator still presses Save. **Every amendment below replaced something that had been written,
reasoned, and believed.**

| # | What it overturned |
|---|---|
| **1** | The AP sort was **not total**: all three keys lived on the invoice, but allocation is per EXPENSE and `expenses.supplier_invoice_id` is not unique, so two expenses under one invoice tied on everything. |
| **2** | The spec **named no function at all** — no module, no export, no signature. The tester refused to start and was right: there was nothing to import, so no test could fail on an assertion. |
| **3** | ⛔ **"TypeError: not a function" is NOT a red.** 12 cases were failing because the code was absent, which proves only that it is absent. **Stubs were pre-wired — deliberately wrong, not empty — so cases fail on assertions.** That was the orchestrator's omission (skill §2a says stub before dispatch). |
| **4** | ⭐⭐ **IAN REVERSED HIS OWN `NULLS LAST` RULING.** An undated bill now falls back to its invoice date, matching `coalesce(si.due_date, si.invoice_date)` at `repo/ap.ts:651` and bible row 162. **The option he chose had never been put to him** — he was offered undated-first vs undated-last, and the rule the codebase already implemented was in neither. ⛔ Also: `created_at` DROPPED both sides — it is `defaultNow()` (the transaction timestamp, so it ties) and `id` is `uuidv7` (creation-ordered, so it can never disagree). **A key that cannot change an outcome cannot have a test that fails when it is omitted.** |
| **5** | The fallback's **location** was unstated, and the two sides would have implemented it differently (SQL on AP, TypeScript on AR). ⛔ The tidier fix — hand in one pre-resolved date — **would have made Ian's rule untestable**, recreating amendment 4's defect inside its own fix. Both dates now go in raw. |
| **6** | ⛔⛔ **`dueDate ?? documentDate` WOULD HAVE SHIPPED THE RULE IAN REJECTED.** `??` falls back on null/undefined only; `'' ?? documentDate` is `''`, and `''` sorts **before every real date** — i.e. **undated FIRST**. Guarded in BOTH the module and the mapper (§15.11). **The single most consequential finding of the task, and it was in the orchestrator's fix for amendment 5.** |
| **7** | Ian's ruling *"fill only the EMPTY boxes"* **had nowhere to be tested** — as contracted it could only live in the screen, and the screen cannot be tested at all (§9.4, below). So the typed amounts became part of the contract. ⭐ Found because the tester reported two rulings had no test and **declined to invent scope**. |

⭐ **THE PRINCIPLE, THREE TIMES IN ONE TASK: a rule belongs where a test can falsify it.** Each time,
the tidier-looking design put a rule **a person had explicitly decided** somewhere no test could reach.

## ⭐⭐ 4. THE LANES — all four excellent, and the role split is why

| Session | Role | Model (⛔ ASK, never read this table — DEF-361) | State |
|---|---|---|---|
| `webapps-d1` | TESTER | Sonnet 5 when asked | Idle. 35 red cases, **zero vacuous** |
| `webapps-4d` | BUILDER | Sonnet 5 when asked | Idle. **Zero implementation — see §9.2, my error** |
| `webapps-42` | AUDITOR | Opus 5 when asked | Idle, read-only all day, never wrote a file |
| `webapps-9f` | Tier E census | Fable when asked ⚠️ over-specced for a census | Idle, work committed in `e472f4b` |

**WHAT EACH DID THAT A REPLACEMENT WOULD NOT:**
- **TESTER** — ⭐ **three times reported something weaker than a clean pass when a clean pass was
  available**: five vacuous exact-sum cases (found by running against the stub, not by reading), one
  assertion that could not be falsified by the available control, and two degenerate vectors where
  `outstanding == payment` made a correct fill and a broken one identical. **Two of the three were
  defects in the orchestrator's own prescriptions.** Verified lane-DB routing with `select
  current_database()` before *every* run rather than trusting the runner (DEF-392).
- **AUDITOR** — ⭐ **overturned the orchestrator three times and measured instead of assuming.** Found
  amendment 4's untestable key, amendment 5's untestable seam, amendment 6's `??`, and the Ian
  question that reversed a ruling. **Recorded a non-finding explicitly** (it checked a float claim and
  found it correct) so that an audit reporting only findings could not be mistaken for one that found
  everything it looked for. **Refused to treat an orchestrator's relay as Ian's authorisation** and
  drew the line exactly right: read-only work yes, anything that writes needs his word.
- **BUILDER** — ⭐ reported an honest empty cycle where looking busy was available, with a
  "what I did not verify" section **longer than its "what exists" section**.
- **9f** — ⭐ **closed DEF-326 by measurement**: read the production host's units FIRST, then diffed
  the deployed `package.json` against the repo's (identical), which is what made "no in-repo caller"
  mean anything. Relayed six of Ian's rulings with **his words and its own reading kept separate**,
  flagging what he had NOT answered each time — which is why none needed re-asking.

## 5. Numbers and shared state

Next task **T-332** (⛔ `T-331` is ALLOCATED to PIN throttling, row 219) · next defect **DEF-401** ·
next migration **`0157`** (⛔ **`0156` is ALLOCATED to T-276**).
⛔ **`0155` IS APPLIED IN PRODUCTION — never edit it.** Reserved, do not re-issue: `0149`/`0150`/`0151`.
⚠️ **Lane databases: 5.** `shareat_test` (shared, ⛔ **NOT migrated — 155+ behind**),
`shareat_test_t327_builder`, `shareat_test_t328_{tester,builder}`,
`shareat_test_t330_{tester,builder}` (migrated today, exit 0).
⭐ **`shareat_test_t327_tester` was DROPPED** on Ian's direct ruling — and **before dropping it I
measured what it held: nothing.** 136 of 136 migrations applied including `0155`, zero non-finite
values across all 160 numeric columns. **The handoff's claim that it was "the database that FAILED to
migrate over 13 poisoned rows" had stopped being true** — it was cleaned and migrated at some point
and nobody updated the sentence. ⛔ **The artefact being protected had already evaporated.**

## ⛔ 6. §9.4 IS UNMET, AND THIS TIME THE REASON IS MEASURED

⛔ **No screen was loaded. No control was clicked. Nothing in T-330 is verified beyond typecheck.**
⭐ **And the cause is five empty strings, which I measured rather than inherited:** every
`NEXT_PUBLIC_FIREBASE_*` value in `.env.local` is EMPTY — `API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID`,
`STORAGE_BUCKET`, `APP_ID`. Sign-in cannot complete, so DEF-368 is confirmed by direct reading.
⭐⭐ **THIS IS CHEAPLY FIXABLE AND IT IS IAN'S CALL: a Firebase WEB config is public by design** —
shipped to every browser, not a secret. **Five values pasted into `.env.local` make the screen test
possible.** ⛔ Until then §9.4 is UNMET in those words (bible row 203 — Ian accepted the gap on
2026-09-20: *"fine to proceed without it for now, fix the browser setting later."* **An acceptance,
not a waiver.**)
⛔ **Do NOT close it by loosening DEF-388's sign-in guard** — that guard exists so a production build
cannot accept unsigned tokens. Chrome is absent; Edge and Playwright's Chromium are present.

## ⭐⭐ 7. THE TRANSFERABLE LESSON — the same one as yesterday, now with a second half

**Every defect found today was found by a SECOND MEASUREMENT THAT DISAGREED. Not one was found by
re-reading the reasoning.** Yesterday's handoff said exactly this; today it held across nine separate
findings, and the new half is worth naming:

⭐⭐ **A SECOND MEASUREMENT IS ONLY AVAILABLE IF SOMETHING IS ARRANGED TO DISAGREE.** The five vacuous
tests were found by a **deliberately wrong stub**, not by reading them. The one assertion that stub
could not judge was found by building the **opposite** stub — allocate everything to everyone — and
asking which cases pass under *both*. ⛔ **A case that passes when the code does nothing AND when it
does everything is pinning nothing at all, whatever its name says.**

⚠️ **Its limit, from the same exercise:** two vectors passed under both controls for an innocent
reason — a single item whose outstanding equalled the payment, where the correct answer and the bug
coincide. ⭐ **A disagreeing measurement is a prompt to find out why, not a finding.**

## ⛔ 8. THE METHOD FINDING, FOURTH DAY RUNNING AND ALL FOUR WERE THE ORCHESTRATOR'S

**A fix concentrates risk onto whatever the single new path now trusts — and that is what nobody
re-reads, because the visible reasoning about the fix reads as evidence the thinking is done.**

| The fix | What it opened |
|---|---|
| Adding `created_at` as a tie-break (amendment 1) | A key that **could not be tested at all** — `id` already decides, so omitting it changes nothing |
| Passing `openItems` IN rather than querying (amendment 2) | **Falsified its own stated reason for `authorize`** one item later, and left the store-scope unbound |
| Moving the fallback into the pure module (amendment 5) | ⛔ **`??`, which silently ships the rule Ian rejected** (amendment 6) |
| Prescribing `Σ + remainder === payment` (amendment 2) | An **identity of any single-counter loop** — all five vectors passed against a stub allocating nothing |

⛔ **The lesson is NOT "fix less."** After consolidating, ask what the single surviving path now
trusts — and check **that**.

## ⛔ 9. THE ORCHESTRATOR'S OWN FAILURES — read before trusting anything above

1. ⛔⛔ **FIVE OF THE SEVEN AMENDMENTS FIXED MY OWN DEFECTS**, each written confidently, each
   reasoned at length, **none re-read by me after writing.** The auditor overturned me three times
   and the tester twice. **That is the role split working, and it is also the measure of how much I
   got wrong unaided.**
2. ⛔ **I STARVED THE BUILDER'S CYCLE.** Briefing, then a scope change ~30 minutes later, then a
   wrap-up ~30 minutes after that — **three messages each superseding the last, arriving before the
   lane cleared the first.** The lane never had an uninterrupted window and correctly built nothing.
   ⭐ **Pipeline the lanes or leave them alone; do not re-brief a lane mid-cycle unless the change
   invalidates work in progress.**
3. ⛔ **I CREATED A JUNK FILE, THEN TREATED IT AS A PEER'S.** A mangled shell command left a
   zero-byte file named `` `{console.error('CONNECT` `` in the repo root. I put it to Ian as an
   unattributable file on a shared tree. **Its timestamp was 15:48 — during my own stub work.**
   ⭐ Check the timestamp before attributing anything on a shared tree.
4. ⛔ **I ASKED IAN TO PRESERVE AN ARTEFACT THAT NO LONGER EXISTED** (§5). I raised the caution
   correctly, he overrode it, and **only then did I measure and find the database held nothing.**
   The measurement should have come before the escalation, not after the override.
5. ⚠️ **I cited line numbers throughout seven amendments in a repo whose own rule (bible row 204,
   quoted in this very spec's banner) is to grep an anchor and never cite a line.** Filed as DEF-400
   against myself.

## ⛔ 10. FOR IAN — three open, one blocking nothing

1. **`/clear` the terminals.** `webapps-d1`, `webapps-4d`, `webapps-42`, `webapps-9f`, and the
   orchestrator. **⛔ They cannot do it themselves** — same class as `/model`.
2. ⭐⭐ **THE SERVICE-CHARGE *ENABLE* DECISION is the only unruled item from today** (row 221). Building
   it is approved; switching it on is not, deliberately.
3. ⭐ **FIVE FIREBASE VALUES WOULD UNBLOCK THE SCREEN TEST** (§6). Public by design, not secrets.
   Until they exist, every UI change ships verified by a passing build alone — which this project's
   own rules say has already shipped an app that could not start.
4. ⚠️ **`webapps-9f` is running on Fable** for a script census. Sonnet is the rule for delegated
   execution (RULES §2); the work was good, the model was over-specced.

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Put `/effort medium` for your own terminal in the first
status board's "needs you" — the loop is bookkeeping and running it high is most of the token bill.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED. No staff use
it yet. That changes urgency, never correctness.

⛔⛔ NEXT UP, RULED BY IAN 2026-09-20: FINISH T-330 FIRST, then close PHASES 2 AND 5 to their exit
gates. ⭐ TWO PHASES, NOT THREE — his directive said "phases 2, 5 and 6", and PHASE 6 WAS ALREADY
CLOSED. ROADMAP.html stated Phase 6's status in two places and they disagreed for two weeks; the
detail said "closed 6 Sep", the summary said in progress. Corrected. Do not go looking for Phase 6
work; there is none.

⛔⛔ T-330 HAS ZERO IMPLEMENTATION, AND SIX FILES ARE UNCOMMITTED BY DESIGN — three stubs
(packages/domain/src/shared/allocate-oldest-first.ts, and the tails of packages/domain/src/ap/index.ts
and ar/index.ts) plus three test files (packages/domain/tests/unit/auto-allocate-order.test.ts,
tests/integration/ap-auto-allocate.test.ts, ar-auto-allocate.test.ts). THE 35 TESTS ARE INTENTIONALLY
RED AND THE STUBS HAVE NO APP CALLER, SO COMMITTING ANY OF IT TURNS main RED AND CI GATES DEPLOY —
that is what left main red for 90 minutes on the 19th and again on the 20th. Commit them in the same
commit as the implementation that makes them green. ⛔ And never stage apps/erp/next-env.d.ts,
docs/reviews/NEXT-PROMPT.md or docs/reviews/2026-09-17.md — an exited session's.

⛔⛔ THE T-330 SPEC HAS SEVEN AMENDMENTS AND THEY OVERRIDE THE ORIGINAL BODY, WHICH WAS CORRECTED FOUR
TIMES. Read docs/tasks/330-auto-allocate-a-payment-oldest-first.md with the amendments LAST. Two of
them exist because a JavaScript operator (`??`) would have silently shipped the ordering rule Ian
explicitly REJECTED, and because a tie-break key was added that no test could ever fail on.

⭐ THE BUILDER'S OWN NEXT STEP, better ordered than mine: protocol step 0 — RULES.md, then the task
doc with amendments last, then the three stub file headers, then §8 of the handoff, then the tester's
35 red cases READ-ONLY — then implement allocateOldestFirst in the PURE module FIRST, before
ap/index.ts, ar/index.ts, packages/db/src/repo/ap.ts or the four screen files. The pure module is the
only place amendment 6's guard and amendment 7's `typed` handling can be proven in seconds instead of
a 25-minute integration cycle.

⭐⭐ FOUR LANES ARE ALIVE AND ALL FOUR WERE EXCELLENT: webapps-d1 (TESTER — 35 red cases, ZERO
vacuous, and it reported something weaker than a clean pass three times when a clean pass was
available), webapps-4d (BUILDER — zero implementation, and that was MY sequencing error, not its),
webapps-42 (AUDITOR — Opus, read-only all day, overturned me three times by measuring), webapps-9f
(the Tier E census; closed DEF-326 by reading the production host FIRST). ⛔ ASK EACH ITS MODEL, never
read it from a table (DEF-361). ⛔ AND /clear IS USER-INITIATED — a session cannot clear itself; that
goes in "needs you" for Ian, never in a briefing.

⛔⛔ READ §9 OF THE HANDOFF BEFORE TRUSTING ANYTHING ELSE IN IT. Five of the seven amendments fixed the
previous orchestrator's own defects — each written confidently, reasoned at length, none re-read after
writing. It also starved the builder's cycle with three superseding messages, created a junk file and
attributed it to a peer, and asked Ian to preserve an artefact that measurement later showed had
already evaporated.

⭐⭐ THE TRANSFERABLE LESSON, AND IT HELD ACROSS NINE FINDINGS: every defect was caught by a SECOND
MEASUREMENT THAT DISAGREED — not one by re-reading the reasoning. THE NEW HALF: a second measurement
is only available if something is ARRANGED to disagree. Five vacuous tests were exposed by a
deliberately WRONG stub; the one assertion that stub could not judge was exposed by building the
OPPOSITE stub and asking which cases pass under BOTH. A case that passes when the code does nothing
AND when it does everything is pinning nothing, whatever its name says. ⚠️ And a disagreeing
measurement is a prompt to find out why, not a finding — two cases disagreed innocently.

⛔ §9.4 IS UNMET AND THE REASON IS MEASURED, NOT INHERITED: all five NEXT_PUBLIC_FIREBASE_* values in
.env.local are EMPTY, so sign-in cannot complete (DEF-368 confirmed by direct reading). ⭐ A Firebase
WEB config is PUBLIC BY DESIGN — five pasted values make the screen test possible, and that is Ian's
call, in §10. ⛔ Do NOT close it by loosening DEF-388's sign-in guard.

⛔ TOOLING: lane-DB isolation only began working on the 19th (DEF-392) — VERIFY ROUTING with `select
current_database()` through run-with-db.mjs and quote it, as the tester did before every run. shared
`shareat_test` is still 155+ migrations behind. callers.mjs --forbid cannot attribute a shared-tree
file to its author (DEF-390); use a staged hash MANIFEST, not `git diff`, which goes empty if you
re-stage.

Numbers: next task T-332 (T-331 IS ALLOCATED to PIN throttling, bible row 219) · next defect DEF-401 ·
next migration 0157 (0156 IS ALLOCATED to T-276). 0155 is APPLIED IN PRODUCTION — never edit it.
Reserved, do not re-issue: 0149/0150/0151.

Read: docs/RULES.md, docs/HANDOFF-TODAY.md (§2, §3, §7, §8 and §9 especially), PROJECT_BIBLE.md rows
217–221. ⛔ GREP the big ones — the register is ~1.15MB and the bible ~430KB.

-----------------------------------------------------------------------------------------------
