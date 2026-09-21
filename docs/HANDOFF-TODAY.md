# Handoff — 2026-09-21, T-332 shipped whole and the theme stopped following the OS

> ✅ **GREEN, COMMITTED AND PUSHED at `bfa12ee`.** Gates below are the real numbers from the final run.
> ✅ **Tree clean** — not even `next-env.d.ts` is dirty. **`main` == `origin/main`.**
> ⚠️ **IT IS NOT LAUNCHED.** No staff use it. That changes urgency, never correctness.
> ⛔ No present-tense claim about which commit production runs (DEF-360). Ask `/api/health` and
> compare all forty characters against `git rev-parse origin/main`.

```
GATES: PASS typecheck=0/4s unit=0/31s integration=0/17s build=0/11s
  unit         138 files · 1912 passed | 1 skipped
  integration  2 files · 11 passed        [lane DB shareat_test_t332]
```

## 1. What shipped

| Commit | What |
|---|---|
| `88842e4` | **T-332 slice A** — every new store is born with a pay cycle (DEF-249) + the backfill script |
| `e96fdaa` | **ADR-013** — Ian's theme ruling, which existed nowhere in the repo |
| `cb2c8a9` | **ADR-013 amendment 1** — the source document found; nine tokens, not four |
| `bccae85` | **T-332 slice B** — `payoutIntervalTooLong` + `attendanceConfigMissing` |
| `ab8d512` | Records — DEF-249/251/256 and the roadmap |
| `d9a17bc` | **T-334 SPECCED** — the v2 theme, sliced |
| `bfa12ee` | **T-334 slice 1** — the OS stops deciding; the app opens light |

## 2. Numbers

Next task **T-335** · next defect **DEF-412** · next migration **`0157`** (`0156` is T-276's).
⛔ **T-333 is reserved and PROPOSED, not approved** — awaiting Ian.
⛔ **GREP THE REGISTER BEFORE ISSUING A DEFECT NUMBER.** DEF-405 was filed, specced and committed
as a duplicate on 2026-09-20 because nobody did. **A duplicate passes every guard this repo has.**

## 3. ⭐ THE LANES ARE ALL CLEARED. Start from nothing.

`webapps-4d`, `webapps-d1`, `webapps-cb`, `webapps-17` were cleared by Ian after T-332. **Nothing is
half-done and nothing is uncommitted.** Re-brief from scratch; the briefing template is
self-contained by design.
⭐ **Clearing `webapps-17` was safe ONLY because ADR-013 was written first** — see §6.

## 4. Pick up here — T-334 slices 2–4

**Slice 1 is done.** ⛔ **The app is NOT red yet, and expecting it to be is the likeliest
misunderstanding.** Slice 1's visible win is that it is **light**, not that it is branded — nothing
consumes the tokens until the slices below.

| Slice | What | Size |
|---|---|---|
| **2** | `components/ui/{Button,Input,Card}.tsx` carrying the tokens, **adopted by nothing yet** | ~half a day |
| **3** | Retire the **65** local `BTN`/`INPUT` constants, **a few files per commit** — shell, `/`, `/sign-in`, `/staff`, `/expenses` first | ~2–3 days spread |
| **4** | Re-point the **781 `red-*`** usages that mean *error* onto `--danger` | ~1 day |

⭐ **Slice 3 is a MECHANICAL SWEEP, not 65 judgement calls** — those files share only **~8–12
distinct strings**. It fits a `Workflow` (one agent per file, resumable) better than a lane.
⛔ **There is no spine:** 152 files carry `dark:` classes and the top 15 hold only **22.5%**. Anyone
promising this in one pass has not run the numbers.
⛔ **SLICE 4 IS A LANDMINE IF YOU FORGET ONE THING** — see §5, second bullet.

Also open: **Phase 2** (DEF-395/DEF-382 re-derivation needs a NEW task · DEF-386 · **DEF-374**, a
class of three · DEF-393 · T-136 §2 · T-316 · T-276 slot `0156`) and **Phase 5** payroll (16 of 18;
T-190 on row 217's trigger, then T-193 — ⚠️ check contribution rates against the current year).

## 5. Traps that cost time TODAY

- ⛔ **A GUARD CAN BE SATISFIED BY THE COMMENT DESCRIBING IT.** T-334's dark-mode test asserted the
  CSS contained `[data-theme="dark"]` — double quotes — while the rule uses single ones, so the only
  match in the file was **prose**. Deleting the entire dark block left it green. ⭐ **Strip comments
  before asserting on a file, and mutation-test every guard: break the thing and watch it fail.**
- ⛔ **BARE `var(--x)` TAILWIND COLOURS SILENTLY DELETE EVERY OPACITY UTILITY.** `bg-warning/20`
  emits **no rule, no warning, no build error**. `src` holds **11 amber opacity usages** that slice 4
  routes onto `--warning`. Fixed with `color-mix`; **do not revert it**, and there is a test.
- ⛔ **`callers.mjs` COUNTS IDENTIFIERS, NOT SYMBOLS (DEF-411).** *"manilaToday: 5 callers"* was
  three unrelated functions; it had two. A `KIND_LABEL` **string key** and **prose in comments**
  also inflate counts (DEF-403). **Verify a caller count before quoting it as evidence.**
- ⛔ **`next dev` is DEAD (DEF-401) but the APP is not** — `npm run start`. `/api/health` hides WHY
  in production; run `env()` under `NODE_ENV=production` to get the variable name.
- ⛔ **THE CHROME EXTENSION CANNOT SET THE SESSION COOKIE** — page JS can never override an HttpOnly
  cookie, and the tool **blocks reading cookies back**, so the failure is invisible. Use a
  standalone Playwright script with `context.addCookies()`. `SMOKETEST.md` §3 has it.
  ⭐ **Ian has now installed Chrome + Playwright**, so the pinned MCP route may work — but the
  standalone script is proven and was used all day.
- ⛔ **`gates.mjs` needs the lane's integration FILES** after `--`, or it runs the whole project.
- ⚠️ **`apps/erp/next-env.d.ts` flips between `next dev` and `next build`. NEVER stage it.**
- ⚠️ A register row with a literal `|` turns `main` red. A bible row means `npm run toc`.

## 6. ⭐⭐ THE METHOD FINDINGS — worth more than either feature

1. ⛔ **A DECISION THAT LIVES ONLY IN A SESSION'S MEMORY IS NOT A DECISION THE PROJECT HAS MADE.**
   Ian's theme ruling was made 2026-09-19 **while planning a different project** and never written
   down. A full repo search found **nothing**. It survived in one terminal's memory — and this
   project's own handoff ritual recommends clearing terminals. **Write rulings to the repo in the
   same pass, especially when they surface during unrelated work**, which is exactly when nobody
   thinks to.
2. ⛔ **THE DOCUMENT IS THE DURABLE MEDIUM; A MESSAGE IS NOT.** A ruling was reversed in a message
   and the amendment it reversed was left standing. The lane hit a spec contradicting its briefing
   and **flagged it instead of guessing**. That happened **four times today**.
3. ⭐ **A VALUE YOU CANNOT WRITE AN ASSERTION FOR IS EVIDENCE ABOUT THE DESIGN.** No test pinned
   T-332's reported gap — because it *couldn't*, while the number moved with the calendar. That was
   the tell for a design defect, not a testing lapse.
4. ⭐ **ASSERT THE CLAUSE, NOT THE NUMBER.** `31` is a legal day-of-month; a store name or uuid
   fragment carries it. *An unanchored match tells you a character appeared, not that a value was
   computed.*
5. ⛔ **A FINDING THAT FLATTERS OUR OWN WORK NEEDS THE SAME HOSTILE READ AS ONE AGAINST IT** — and
   will not get one from its author. *"DEF-256 delivered"* became *"its mechanism closed for new
   stores"*: **a screenshot evidences a checkbox, not a peso.**
6. ⭐ **READ THE CONSUMER, NOT ONLY THE PRODUCER.** Three decisions were queued for Ian and all
   three dissolved when someone opened the consuming query. The sweep never reads `effective_from`.
7. ⭐ **PUBLISH THE FALSIFICATION CONDITIONS BEFORE THE RUN.** DEF-409 was filed with the three
   outcomes named in advance, including the one that would have **retracted** it. It came back
   outcome 3, so `verified` there means something a later reader can check.

## 7. What T-332 ships with, honestly scoped

- ⛔ **The backfill has NOT been run against production.** Deploy-time decision.
- ⚠️ **DEF-251 is MITIGATED, NOT FIXED** — the INNER JOIN is unchanged; the state is merely visible
  now. **Do not close that row on T-332.**
- ⚠️ **DEF-256 is delivered PROSPECTIVELY** — `effective_from` is the seeding date, so history is
  not repaired, and reaching a config row is not the pay correction taking effect.
- ⚠️ **DEF-409/410 unexercised halves**: DEF-410's consequence was read, not run; T-332's live
  Dec→Jan selector is unexercised (and provably cannot change the answer — any twelve consecutive
  months hold the same month lengths).
- ⛔ **The T-332 screenshot predates the twelve-month fix.** The sentence template is unchanged so it
  still evidences the findings reaching the screen and citing Art. 103 — **never cite it for the
  number.**

## 8. FOR IAN — four, none blocking

1. ⭐ **Only you can create the Firebase terminal account** so PIN sign-in is drivable end to end.
   Every screen test today ran through a **FORGED session that bypasses sign-in on purpose** —
   screens proved, **authentication not**.
2. ⛔ **Dark-mode text reds are unruled.** `#d40909` is 3.84:1 and `#a00606` is 2.52:1 on black —
   **both fail AA as text.** A test pins the gap open. **Dark mode must not be called supported
   until you rule them.**
3. ⚠️ **Every new store now silently acquires a money-affecting default** (`short_shift_half_day_ot`,
   argued at ~9.2% of basic pay under T-197), live at creation **without re-ratification**. Correct,
   and the direction is cost not underpayment — **you have been told, not asked.**
4. **Three older rulings still open:** a statutory payout against a PROVISIONAL till balance (a
   cashier e-wallet was observed on overdraft to −₱20,000) · who may silence an overdue statutory
   payout (a store manager can now acknowledge their own store's lateness) · **T-333**.

## 9. The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD and ALL LANES ARE CLEARED — re-brief from scratch.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED.

READ FIRST: docs/HANDOFF-TODAY.md (all of it), docs/RULES.md, docs/SMOKETEST.md. ⛔ GREP the big
ones, never read them whole: DEFECTS-REGISTER.md ~1.2MB, PROJECT_BIBLE.md ~430KB, ROADMAP.html.

T-332 SHIPPED WHOLE (`88842e4`, `bccae85`) and T-334 SLICE 1 SHIPPED (`bfa12ee`). Tree clean,
pushed, main == origin/main. NEXT IS T-334 SLICES 2-4 (docs/tasks/334-*.md, built on
docs/decisions/ADR-013). ⛔ THE APP IS NOT RED YET — slice 1's win is that it is LIGHT. Slice 3 is
a MECHANICAL SWEEP (65 files, only ~8-12 distinct strings) and fits a Workflow better than a lane;
there is NO SPINE (top 15 of 152 files = 22.5%), so nobody should promise it in one pass.

⛔ THE FIVE THINGS THAT WILL COST YOU A CYCLE:
1. A GUARD CAN BE SATISFIED BY THE COMMENT DESCRIBING IT. Strip comments before asserting on a
   file, and MUTATION-TEST every guard — break the thing and watch it fail. One shipped vacuous
   yesterday and survived deleting the whole block it guarded.
2. BARE `var(--x)` TAILWIND COLOURS SILENTLY DELETE EVERY OPACITY UTILITY — no rule, no warning,
   no error. 11 amber opacity usages are waiting for slice 4. Keep the color-mix wrapper.
3. `callers.mjs` COUNTS IDENTIFIERS, NOT SYMBOLS (DEF-411), and comments and string keys inflate
   it (DEF-403). Verify a caller count before quoting it as evidence.
4. GREP THE REGISTER BEFORE ISSUING A DEFECT NUMBER — a duplicate passes every guard here.
5. `next dev` is DEAD (DEF-401) but the APP is not — `npm run start`. The Chrome extension CANNOT
   set the HttpOnly session cookie and hides the failure; use a standalone Playwright script.

⭐ THE LESSONS THAT HELD ALL DAY: a decision that lives only in a session's memory is not a
decision the project has made. The DOCUMENT is the durable medium; a message is not. A value you
cannot write an assertion for is evidence about the DESIGN. Assert the CLAUSE, not the number. A
finding that flatters your own work needs the same hostile read as one against it. Read the
CONSUMER, not only the producer. And publish the falsification conditions BEFORE the run.

⭐ LET THE LANES CORRECT YOU — every one did yesterday and every correction was right, including
two that caught the orchestrator stating a fix it had never made.

-----------------------------------------------------------------------------------------------
