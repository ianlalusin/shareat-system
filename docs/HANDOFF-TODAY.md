# Handoff — 2026-09-21, T-187 shipped and the screen gate is open

> ✅ **GREEN AND COMMITTED at `9a4e78a`.** Gates below are real numbers from the run that shipped it.
> ⚠️ **IT IS NOT LAUNCHED.** No staff use it. That changes urgency, never correctness.
> ⛔ No present-tense claim about which commit production runs (DEF-360). Ask `/api/health` and
> compare all forty characters against `git rev-parse origin/main`.

## 1. ⭐ THE SCREEN GATE IS OPEN — read `docs/SMOKETEST.md` before saying otherwise

It had been reported impossible three times. Every premise was re-measured and two were wrong.

| Yesterday's claim | Truth |
|---|---|
| *"The app 500s"* | `next dev` is dead (DEF-401). **The APP is not.** `npm run start` serves it. |
| *"Playwright needs Chrome → needs Administrator"* | ⚠️ True of the **pinned MCP tool only.** A standalone script drives Playwright's own chromium, installed here since **April**. ⛔ **Drop that task from Ian's list.** |
| *"Neither sign-in route works"* | One blank line — the server-side `FIREBASE_PROJECT_ID`, required because `next start` runs as `NODE_ENV=production`. Now `ok` / `database: reachable`. |

⛔ **THE LIMIT, IN EVERY REPORT THAT USES IT:** the session is **FORGED** (`SMOKETEST.md` §3). It
**bypasses sign-in on purpose**, so it proves things about **SCREENS** and **nothing about
authentication**. ⭐ **Real end-to-end sign-in still needs Ian to create the Firebase terminal
account** — the only outstanding environment item.

## 2. What shipped

**T-187 — the service-charge float can be discharged.** Closes **DEF-082**, open since the float
existed. Per store, capped at that store's own float, **refused not clamped**. Detector regrouped
per store. **Smoketested in a real browser on all four money-account codes** — which T-330 could
not claim.

```
GATES: PASS  typecheck=0/18s  unit=0/59s  integration=0/53s  build=0/22s
  unit         136 files · 1883 passed | 1 skipped
  integration  2 files · 70 passed   [lane DB shareat_test_t187_builder]
CALLERS: OK    0 zero-caller/test-only exports
```

⚠️ **It ships with three defects NAMED rather than hidden** — DEF-406, DEF-407, and a second
confirmed member of DEF-374. All three are in §5.

## 3. Numbers

Next task **T-334** · next defect **DEF-409** · next migration **`0157`** (`0156` is T-276's).
⛔ **DEF-405 is SPENT AND RETRACTED** — duplicate of **DEF-249**; cite DEF-249 (with DEF-251,
DEF-256). ⛔ `0155` is applied in production. Reserved, never reissue: `0149`/`0150`/`0151`.
**T-333 is reserved and PROPOSED, not approved** — awaiting Ian.

## 4. ⛔ GREP THE REGISTER BEFORE ISSUING A DEFECT NUMBER

**DEF-405 was filed, specced and committed as a duplicate because nobody ran one grep.** It nearly
happened twice more the same night. ⛔ **A duplicate passes every guard this repo has** — they check
whether a row is well-formed and whether documents agree; **none asks whether a row is new.** That
is what **T-333** proposes to fix, and the case for it is now three near-misses in one night.

## 5. What T-187 ships with, and what it taught

- **DEF-406** — ⛔ **the FIFO detector family goes silent once an account is driven negative**
  (`findings.ts:611`, `992`, `1406`), and there is no negative-balance detector anywhere. **It had
  eaten T-187's own acceptance criterion:** *"show the detector goes quiet"* was satisfied equally
  by success and by over-discharge. The gate is now **the exact residual, as a literal**.
- **DEF-407** — after a **full** distribution the cap refuses a resubmit with *"the float only holds
  ₱0.00"*, reading as failure when it succeeded. ⭐ **Downgraded on measurement:** the screen renders
  **no form at all** at zero float, so it needs a stale page plus DEF-374's concurrency class.
- **DEF-374 gains a second confirmed member.** The cap is read without a lock under READ COMMITTED
  — ⛔ **while AP and AR both take a documented lock-before-read.** It is a class of three
  (`createRemittance`, `distributeServiceCharge`, `payLiability`), not one function forgetting.
- **DEF-408** — `parseMoneyInput` answers every rejection with *"use at most two decimal places"*,
  wrong for most of its refusal set. ⚠️ Narrowed the same night: a number input drops the comma, so
  the separator case is not reachable **on this screen**.

⭐⭐ **THE METHOD FINDINGS, worth more than the feature:**
1. **A static read nominates; running settles.** Two register rows were narrowed by driving a
   browser after three sessions had reasoned confidently from correct premises.
2. **An assertion about an ABSENCE** — no finding, no error, no row — **is satisfied by every cause
   of that absence, including the ones nobody enumerated. An assertion about a VALUE fails for
   every cause but one.** Two tests were rewritten on this in one night.
3. ⛔ **A faithful copy of a precedent inherits its blind spots.** The `1140` party fix was verified
   byte-identical to `payLiability` — which has the same hole at `1120`.
4. **Four audit rounds, three created by the previous fix.** Same as T-330. Expect it.

## 6. Pick up here

1. **T-332** — the payday check. Specced on measurement; **the settings screen already exists**, so
   this is the detector plus the missing config row. ⛔ Fix at **`createStore`** — one INSERT, one
   caller, three doors — **not** `bootstrap-org.ts`.
2. **Phase 2** — DEF-395/DEF-382 re-derivation (needs a NEW task) · DEF-386 · **DEF-374** (now a
   class of three) · DEF-393 · T-136 §2 · T-316 · T-276 (slot `0156`).
3. **Phase 5** (payroll, 16 of 18) — T-190 on row 217's trigger, then T-193. ⚠️ Check contribution
   rates against the current year.

## 7. Traps

- ⛔ **`/api/health` hides WHY in production.** Run `env()` under `NODE_ENV=production` to get the
  variable name; the HTTP response will never tell you.
- ⛔ **`gates.mjs` needs the lane's integration FILES** (`-- <paths>`) or it runs the whole
  integration project and outlives any sane timeout. ⚠️ **And never point it at a lane's DB while
  that lane is working** — I did, and caused deadlocks the builder spent three runs diagnosing.
- ⛔ **`git diff` shows NOTHING for an untracked file.** Anyone verifying a remedy in a new file
  with diff alone concludes nothing changed.
- ⛔ **Two guard scripts count English as code (DEF-403)**; `--probe` is broken (DEF-402).
- ⛔ **A register row with a literal `|` turns `main` red.** ⛔ **A bible row means `npm run toc`,
  and §13 rows have FIVE columns.**
- ⛔ **Never run a browser binary with `--version`** — it launches a GUI and hangs.
- ⚠️ **`apps/erp/next-env.d.ts` is a toolchain artifact that keeps flipping. Never stage it.**
- ⚠️ **The sidebar is now collapsible categories** — `/service-charge` is two clicks: expand
  **Money**, then click. The link is not in the DOM until Money is expanded.

## 8. The lanes

⛔ **Ask each its model; never read it from a table (DEF-361).** All four were asked and answered.

| Session | Role | Model | State |
|---|---|---|---|
| `webapps-4d` | BUILDER | Sonnet 5 | clean, stopped at a task boundary |
| `webapps-d1` | TESTER | Sonnet 5 | clean, stopped |
| `webapps-42` | AUDITOR | **Opus 5** | clean, read-only throughout |
| `webapps-17` | relay + census | Sonnet 5 | clean |

⭐ **Every one of them corrected me at least once, and every correction was right.** The tester
found the contract wrong before source existed and narrowed two register rows by measurement; the
auditor found the spec contradicting its own done-when, caught a duplicate filing, and **retracted
its own critique** when the evidence turned; the census lane caught DEF-405 and a live contradiction
between two documents written the same hour — both times while sent to check something else.
⭐ `webapps-42` takes direction from Ian, not from an orchestrator, beyond read-only audit work.
**That is correct; do not argue it.**

## 9. FOR IAN — three decisions, none blocking

1. ⭐ **Drop `npx playwright install chrome` from your list.** Never needed.
2. ⛔ **Only you can create the Firebase terminal account** so PIN sign-in is drivable end to end.
3. **Three rulings:**
   - **Should a statutory staff payout be payable against a PROVISIONAL till balance?** Observed on
     screen: a cashier e-wallet posted a distribution **on overdraft, down to −₱20,000**. Legal
     today; nobody chose it.
   - **Who may silence an overdue statutory staff payout?** The regroup means a **store-scoped
     manager** can now acknowledge their own store's finding — **the person whose lateness it
     reports.** It needed the org-wide gate before.
   - **T-333** — a guard reporting duplicate register rows. Proposed, with the case against it
     written in.

## 10. The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Put `/effort medium` for your own terminal in the first
status board's "needs you".

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED.

READ FIRST: docs/HANDOFF-TODAY.md (all of it), docs/RULES.md, docs/SMOKETEST.md. ⛔ GREP the big
ones, never read them whole: DEFECTS-REGISTER.md ~1.2MB, PROJECT_BIBLE.md ~430KB, ROADMAP.html.

T-187 SHIPPED (`9a4e78a`) — gates green, tree clean. NEXT IS T-332 (docs/tasks/332-*.md), specced
on measurement: the payday settings screen ALREADY EXISTS, so this is the compliance detector plus
a missing config row, fixed at `createStore` and NOT at bootstrap-org.ts. Then Phase 2, then Phase
5. Phase 6 is closed; do not go looking.

⭐ THE SCREEN GATE IS OPEN. Do NOT report §9.4 as impossible — read docs/SMOKETEST.md. Playwright
and chromium have been here since April; the Administrator install was never needed. ⛔ BUT the
session is FORGED and bypasses sign-in: it proves things about SCREENS and NOTHING about
AUTHENTICATION. Say so in every report.

⛔ THE FOUR THINGS THAT WILL COST YOU A CYCLE:
1. `next dev` is DEAD (DEF-401) but the APP is not — `npm run start`. `/api/health` hides WHY in
   production; run `env()` under NODE_ENV=production to get the variable name.
2. GREP THE REGISTER BEFORE ISSUING A DEFECT NUMBER. DEF-405 was filed, specced and committed as a
   duplicate because nobody did. A duplicate passes every guard here.
3. `gates.mjs` needs the lane's integration FILES after `--`, or it runs the whole project and
   never finishes. NEVER point it at a lane's DB while that lane is working.
4. Two guard scripts COUNT ENGLISH AS CODE (DEF-403); `--probe` is broken (DEF-402).

⭐ THE LESSONS THAT HELD ALL NIGHT: a static read NOMINATES, running SETTLES — two register rows
were narrowed by driving a browser after three sessions reasoned confidently from correct premises.
An assertion about an ABSENCE is satisfied by every cause of it; assert a VALUE. A faithful copy of
a precedent inherits the precedent's blind spots. And work out the DIRECTION of an error before its
SEVERITY.

⭐ LET THE LANES CORRECT YOU — all four did, and every correction was right. Four are alive and
re-adoptable (webapps-4d builder, webapps-d1 tester, webapps-42 auditor, webapps-17 relay/census).
⛔ ASK each its model; never read it from a table.

-----------------------------------------------------------------------------------------------
