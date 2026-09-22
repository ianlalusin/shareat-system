# Handoff — 2026-09-22, T-334 slice 2 shipped, and the spec's own headline number was wrong

> ✅ **GREEN, COMMITTED AND PUSHED at `82ab9d4`.** Tree clean. **`main` == `origin/main`.**
> ⛔ **ONE GATE IS RED AND IT IS NOT THIS WORK: integration 3/2982, all DEF-412, pre-existing.**
> ⚠️ **IT IS NOT LAUNCHED.** No staff use it. That changes urgency, never correctness.
> ⛔ No present-tense claim about which commit production runs (DEF-360). Ask `/api/health` and
> compare all forty characters against `git rev-parse origin/main`.

```
GATES (FULL SUITE, not lane-scoped): typecheck=0/10s unit=0/55s integration=1/1997s build=0/29s
  unit         142 files · 1947 passed | 1 skipped
  integration  3 failed / 2982   ← packages/domain/tests/integration/findings.test.ts — DEF-412
  build        exit 0
```

## 1. What shipped

| Commit | What |
|---|---|
| `6346f64` | **T-334 slice 2** — `components/ui/{Button,Input,Card}.tsx` carrying the ruled tokens, adopted by no screen on purpose |
| `82ab9d4` | **ADR-013 Amendment 3** (Ian: one size) + **T-334 slice 3 SPECCED** |

## 2. Numbers

Next task **T-335** · next defect **DEF-413** · next migration **`0157`**.
⛔ **T-333 is still reserved and PROPOSED, not approved** — awaiting Ian.
⛔ **GREEP THE REGISTER BEFORE ISSUING A DEFECT NUMBER.** I nearly filed DEF-412 for something
DEF-403 already covered; grepping first is the only thing that caught it. A duplicate passes every
guard this repo has (DEF-405 is the precedent).

## 3. ⭐ Pick up here — T-334 slice 3, fully specced, NOT started

**Read `docs/tasks/334-slice-3-retire-the-local-constants.md`, then ADR-013 Amendment 3.** The size
question is RULED (Ian, 2026-09-22): **one size, existing variation discarded, no `size` prop.**

⭐ **It is a `Workflow`, not a lane — but ONLY because of that ruling.** Each file is the same
deterministic operation. Had sizes been preserved, all 65 would have been judgement calls.
⛔ **Tranche it. Do `INPUT` before `BTN`** — 90% of inputs are two values, versus 44% of buttons.
⛔ **The barrel `components/ui/index.ts` is the ORCHESTRATOR's to create at first adoption**, never a
workflow agent's.
⛔ **A workflow does NOT remove the audit.** Tester writes the red, auditor reads the diff, exactly
as for a lane. Only the labour moves.

**Also open:** **slice 4** (the 781 `red-*`, the landmine — see §5) · **DEF-412** needs its own task
· Phase 2 (DEF-395/382 re-derivation needs a NEW task · DEF-386 · **DEF-374** · DEF-393 · T-136 §2 ·
T-316 · T-276 slot `0156`) · Phase 5 payroll (16 of 18; T-190 then T-193 — ⚠️ check contribution
rates against the current year).

## 4. ⛔ THE LANES ARE ALIVE AND NAMED. Re-adopt them; do not re-discover them.

| Session | Model | Was | State |
|---|---|---|---|
| `webapps-d1` | Sonnet 5 | **TESTER** | idle, stood down, tree clean |
| `webapps-4d` | Sonnet 5 | **BUILDER** | idle, stood down, tree clean |
| `webapps-cb` | **Opus 5** | **AUDITOR** | ⛔ **never audited — see §8.1** |
| `webapps-17` | Sonnet 5 | spare | idle; ⭐ it is the terminal ADR-013 was recovered from |

⭐ **Both working lanes performed above brief and the specifics are worth inheriting:** the builder
reported BLOCKED rather than enlarging an accepted-failure list, and fixed two real bugs of its own
first; the tester mutation-tested a vacuous assertion through the public interface only, without
reading source. Re-brief from disk — the briefing template is self-contained by design.

## 5. Traps that cost time TODAY

- ⛔ **A LANE-SCOPED INTEGRATION GATE CANNOT CERTIFY A COMMIT (DEF-412).** Yesterday's handoff said
  `integration 2 files · 11 passed` and `GATES: PASS`. Both true; the conclusion false — **2 files of
  141 ran.** T-332 broke `findings.test.ts` and it shipped green by construction. ⭐ **The masthead
  carried the evidence and nobody read it that way:** *"last FULL-SUITE run was T-328's, 20 Sep, 0
  failed."* **Run the full suite (~33 min) before committing.** DEF-126 recorded this exact lesson
  nineteen days earlier, on the same shared surface.
- ⛔ **THREE DOCUMENTS AGREED ON A NUMBER AND NONE HAD CHECKED IT.** "~8–12 distinct strings" was
  16+7=23, and the geometry nobody had looked at meant slice 2's components match **29% of buttons
  and 0% of inputs**. One `node` script settled it in seconds. ⚠️ **The `BTN`/`INPUT` declarations
  span TWO lines**, so a naive single-line grep finds almost nothing and reports a false "already
  done" — that is how I first mis-measured it.
- ⛔ **`bg-danger-surface` CONTAINS `bg-danger`.** A substring-matched "danger is never filled" guard
  cannot tell the permitted surface from the forbidden fill. Use a token-boundary regex.
- ⛔ **A `.test.tsx` FILE MATCHES NO INCLUDE GLOB AND PASSES SILENTLY** (`apps/**/*.test.ts`). There
  is no jsdom, no `@testing-library`, no React vitest plugin in this tree and slice 2 did not add
  one. ⭐ The proven route is `createElement` + `renderToStaticMarkup` in a `.ts` file —
  `apps/erp/tests/filter-row.test.ts` documents it in its own header.
- ⛔ **A COMMENT-STRIPPER THAT KILLS `//` UNCONDITIONALLY BLINDS THE GUARD IT SERVES.** `<svg
  xmlns="http://…" className="bg-red-600">` loses everything after `http://`. Fixed in slice 2 with
  a real string-aware scanner. ⚠️ And the old mutation check could never have caught it: it proved
  comments ARE stripped, never that non-comments SURVIVE.
- ⛔ **`callers.mjs` FLAGS UNTRACKED FILES AS "FORBIDDEN PATHS TOUCHED"** — it compares HEAD vs
  worktree *including untracked*. With nothing committed mid-slice that is pure noise, and it also
  means **git cannot prove a builder left the tests alone.** Ask the tester to verify its own files.
- ⛔ **`next dev` is DEAD (DEF-401) but the APP is not** — `npm run start`. ⚠️ `next-env.d.ts` flips
  between dev and build: **NEVER stage it.**
- ⛔ **THE CHROME EXTENSION CANNOT SET THE HttpOnly SESSION COOKIE** and cannot tell you it failed.
  Use a standalone Playwright script with `context.addCookies()`; `SMOKETEST.md` §3 has it, and
  `tools/smoke-t334.mjs` is a working harness. ⚠️ It only logs console output for `/findings` — the
  tester ran supplementary checks rather than report silence as cleanliness.
- ⚠️ `gates.mjs` needs the lane's integration FILES after `--`, or it runs everything (which,
  per DEF-412, is what you now want).

## 6. ⭐⭐ THE METHOD FINDINGS

1. ⭐⭐ **THE ROLE SPLIT PAID FOR ITSELF IN ONE CYCLE, MEASURABLY. Six defects were found in the
   CONTRACT by the lanes reading it cold, before a line of code existed** — four by the auditor, one
   by the builder, one by the tester, and the missing icon spec was found **independently by two of
   them**. Every one was the orchestrator's: a guard list ending in an ellipsis (so whether it fails
   is a matter of opinion), `text-white` specified while claiming every colour came from a table
   with no white in it, and no ruling on `'use client'` — invisible to the slice's own tests and a
   slice-3 defect in waiting. ⛔ **Ask for spec questions BEFORE tests. It is the cheapest review
   available and it happens before anything exists to be wrong.**
2. ⛔ **AN ASSERTION CAN BE VACUOUS AT BIRTH AND NOBODY CAN TELL.** "Primary and secondary emit no
   `<svg>`" passed trivially against empty stubs — `''` contains no svg — and only became real once
   code existed. ⭐ **Mutation-test it at the first moment that is possible**, not when it is
   written. It is what holds up ADR-013's *danger is a TREATMENT, not a hue*.
3. ⭐ **A STATIC READ NOMINATES; RUNNING SETTLES.** The builder proved the tap-target resolver
   limitation by making the effect appear and disappear on demand, not by argument. That is what
   decided the adjudication.
4. ⭐ **A TRUE EXCUSE CAN CARRY TWO REAL DEFECTS.** Three controls failed the sweep; two were the
   builder's own bugs and one was structural. A lane that had written all three off as "the
   resolver's limitation" would have shipped both defects behind one accurate sentence, and the
   report would have read identically.
5. ⭐ **ASK A SESSION WHAT IT HOLDS THAT THE REPO DOES NOT, BEFORE RELEASING IT.** One question in
   passing to `webapps-17` produced **ADR-013 Amendment 2**: `CUSTOMER`'s own `--primary` is
   `#E00000`, a near-identical WRONG red that ADR-013 never mentioned. ⛔ That is the **second**
   memory-only ruling recovered in two days, and this one would have vanished silently — nobody
   would have known to look.
6. ⛔ **THE GUARD BUILT TO CATCH VACUOUS GUARDS WAS ITSELF VACUOUS IN ONE DIRECTION.** See §5 on the
   comment-stripper. **Every guard needs both directions: the thing is caught, AND the innocent case
   survives.**
7. ⭐ **WHEN YOU MUST BREAK A RULE, SAY SO IN THE COMMIT.** I edited a test file and enlarged an
   accepted-failure baseline — the exact acts I forbade the builder. Both are defensible (a census
   count whose source of truth is the baseline file; controls genuinely *entering* the population,
   with a `53 → 56` precedent) and both are written down as decisions, with the cost named: those
   two files are now **permanently unmeasurable** by that sweep.

## 7. What slice 2 ships with, honestly scoped

- ⛔ **Nothing adopts these components.** The visible result is that nothing changed. That is the
  promise, and the screen gate confirms it rather than papering over it.
- ⛔ **`Button` matches 29% of the app's buttons and `Input` 0%** — Amendment 3 normalises them in
  slice 3, which is a **deliberate, visible resize of 71% of buttons and 100% of inputs.**
- ⚠️ **`Input` silently DISCARDS a caller's `aria-invalid`** (chosen, not inherited: the component
  owns it via `invalid`). TypeScript will not complain and a confused caller gets no diagnostic.
- ⚠️ **`components/ui/Button.tsx` and `Input.tsx` are now permanently UNRESOLVED to the T-262
  tap-target sweep.** Measured by hand instead: 42px and 38px against a 24px floor. A future edit
  shrinking them stays green.
- ⛔ **`Card` is invisible to the zero-caller ratchet** (DEF-403): the word "Card" in operator copy
  counts as a call site. **Any export named with a common English word is invisible to it.**

## 8. FOR IAN — four, one of them blocking the next audit

1. ⛔ **`webapps-cb` NEVER AUDITED SLICE 2.** It holds for your explicit go-ahead before ACKing an
   orchestrator briefing, and correctly refused to take mine — I will not claim your authority for
   it. **It needs one line from you.** I ran `/code-review` myself as the floor (it found the six
   findings above), but ⭐ **I am the wrong reviewer for my own contract and my own baseline
   adjudication.** Give it the go-ahead, or tell the next orchestrator it may release it.
2. ⛔ **DARK-MODE TEXT REDS ARE STILL UNRULED, AND NOW HAVE A DATE.** `#d40909` is 3.84:1 and
   `#a00606` is 2.52:1 on black — **both fail AA as text.** There are **5 destructive `BTN`
   declarations**; the first one slice 3 adopts makes a dark-cookie user's destructive label
   unreadable. A test pins the gap open so nobody walks into it silently. **Dark mode must not be
   called supported until you rule.**
3. ⚠️ **SHOULD THE ORCHESTRATOR RUN THE FULL INTEGRATION SUITE BEFORE EVERY COMMIT?** Measured
   **~33 minutes.** It would have caught DEF-412 on the 21st. The alternative is lane-scoped gates
   and accepting this class recurs — and it has now recurred, nineteen days after DEF-126 recorded
   the identical lesson on the identical surface. **I lean yes; it is a real slowdown and yours to
   accept.** Unanswered as of this handoff.
4. **Older rulings still open:** a statutory payout against a PROVISIONAL till balance (a cashier
   e-wallet was observed at −₱20,000) · who may silence an overdue statutory payout · **T-333** ·
   and the Firebase terminal account, still the one thing blocking a real end-to-end sign-in (every
   screen test runs through a forged session that bypasses authentication on purpose).

## 9. The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED.

READ FIRST: docs/HANDOFF-TODAY.md (all of it), docs/RULES.md, docs/SMOKETEST.md. ⛔ GREP the big
ones, never read them whole: DEFECTS-REGISTER.md ~1.2MB, PROJECT_BIBLE.md ~430KB, ROADMAP.html.

T-334 SLICE 2 SHIPPED (`6346f64`) and SLICE 3 IS SPECCED, NOT STARTED (`82ab9d4`). Tree clean,
pushed, main == origin/main. NEXT IS SLICE 3: docs/tasks/334-slice-3-retire-the-local-constants.md,
built on ADR-013 AMENDMENT 3 (Ian ruled ONE SIZE, 22 Sep). It is a Workflow, not a lane — but ONLY
because of that ruling. Tranche it, INPUT before BTN. The barrel components/ui/index.ts is YOURS.

⛔ FOUR LANES ARE ALIVE AND NAMED — re-adopt, do not re-discover: webapps-d1 (TESTER, Sonnet),
webapps-4d (BUILDER, Sonnet), webapps-cb (AUDITOR, Opus — ⛔ NEEDS IAN'S GO-AHEAD, it never audited
slice 2 and correctly refused to take mine), webapps-17 (spare, Sonnet — the terminal ADR-013 was
recovered from). All idle, all clean.

⛔ THE FIVE THINGS THAT WILL COST YOU A CYCLE:
1. A LANE-SCOPED INTEGRATION GATE CANNOT CERTIFY A COMMIT. "integration 2 files · 11 passed" plus
   "GATES: PASS" hid a repo-wide breakage for a day (DEF-412) — 2 files of 141 ran. Run the FULL
   suite, ~33 min. integration is CURRENTLY 3/2982 RED from DEF-412, pre-existing, not yours.
2. THREE DOCUMENTS AGREED ON A NUMBER AND NONE HAD CHECKED IT. Measure before dispatching. The
   BTN/INPUT declarations span TWO lines, so a naive grep reports a false "already done".
3. AN ASSERTION CAN BE VACUOUS AT BIRTH. "Emits no <svg>" passes trivially against an empty stub.
   Mutation-test at the first moment it is possible, not when it is written.
4. GREP THE REGISTER BEFORE ISSUING A DEFECT NUMBER. I nearly duplicated DEF-403.
5. `next dev` is DEAD (DEF-401) — `npm run start`. NEVER stage next-env.d.ts. The Chrome extension
   CANNOT set the HttpOnly session cookie and hides the failure; use standalone Playwright.

⭐ ASK EVERY LANE FOR SPEC QUESTIONS BEFORE TESTS. Six defects were found in my contract by the
lanes before a line of code existed, and every one was mine. It is the cheapest review available.
⭐ AND ASK A SESSION WHAT IT HOLDS THAT THE REPO DOES NOT, BEFORE YOU RELEASE IT — one such question
produced ADR-013 Amendment 2, the second memory-only ruling recovered in two days.

-----------------------------------------------------------------------------------------------
