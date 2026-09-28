# T-353: the payment lines show no errors before input (DEF-484)

**Status:** DONE 2026-09-28 (gates PASS; §9.4 14/14 at 375 + 1366, forged session). APPROVED 2026-09-28 (orchestrator; presentation-only, no money/auth invariant) (Opus spec). **Model:** Sonnet, tester then builder.
**Migration:** none. One domain sentence, one pure helper, and the timing of when a client component shows
what the domain already says.
**Ian, 2026-09-28:** "yes fix def 484" (before launch).
Line numbers were checked at HEAD `55077ef`. `money-lines.ts` and `MoneyLines.tsx` have no local edits.
**Overlap:** T-348 touches `expenses/new/page.tsx` (width and description). This slice does **not** touch that
file, so the two can land in either order.

## Why
A fresh `/expenses/new` shows two red lines under "Paid 1" before the user has typed anything (screenshot
`~/.claude/skills/orchestrator/tools/t348-expenses-fresh-375.png`, 375px):
- `"" is not a valid amount. Use at most two decimal places.`
- `Choose where the money came from — every peso has to leave somewhere nameable.`

There are two faults, and both have to be fixed:
1. **Timing.** `MoneyLines.tsx:94-106` runs `validateMoneyLines` on every render. `:307-312` then prints every
   line issue, and `:357-359` prints every document issue. There is no touched state and no submit state, so
   the untouched `blankLine()` (`:65`) is judged on first paint.
2. **Wording.** `money-lines.ts:332-338` sends a blank amount to the malformed-value sentence, which quotes
   `""`. A blank required field should ask for the value, not call it malformed.

### Which forms have the symptom (evidence)
| Form | Uses | Symptom? | Evidence |
|---|---|---|---|
| `/expenses/new` | `<MoneyLines>` (`expenses/new/page.tsx:173`) | **Yes** | It is the only renderer of `<MoneyLines>` (grep `MoneyLines` under `apps/erp/src`). It passes no `initialLines`, so the state is `[blankLine()]` (`MoneyLines.tsx:78-80`), and the issues are rendered unconditionally (`:307-312`). |
| `/ap/invoices/[id]`, the "record an expense" form | `recordExpenseForInvoiceAction` → `parseExpenseForm` → `validateMoneyLines` (server only) | **No** first-paint symptom | Plain inputs (`ap/invoices/[id]/page.tsx:338-400`). The domain check runs only after submit. ⚠️ See "Found in passing": this form is broken for a different reason. |
| `service-charge/actions.ts` | a comment only (`:11`) | No | It names the subpath pattern. It imports nothing from `money-lines`. |
| `lib/money-lines/load.ts` | the loader | n/a | It fetches data and renders nothing. |

The DEF-484 row said "likely shared by every money-lines form". **Measured: one form.** `<MoneyLines>` has
exactly one host today. The fix is in the component, so every future host inherits it.

### The server path (what must not change)
`parseExpenseForm` re-runs the **same** `validateMoneyLines` (`expenses/actions.ts:153-169`), and it refuses
with the first issue (`:168`). That is the server-side truth (RULES rule 7) and it stays.
- **Note:** the server **drops** any line whose method or amount is blank before it validates
  (`actions.ts:124`, `if (!method || !amount) continue;`).
- So through the expense actions, a blank amount never reaches `validateMoneyLines`. The action's refusal
  for an all-blank form is `Add at least one payment line.` (`money-lines.ts:318-320`), and that does not
  change.
- The new blank sentence is therefore seen in the component, and by direct domain callers.

### v1 (requirement, not design)
`ERP-rebuild/src/app/financial/expenses/expense-editor.tsx:199-201` uses react-hook-form with
`mode: 'onChange'`. A field's `<FormMessage>` is empty until that field has changed, and a blank create form
paints clean.
- `:372-375` explicitly calls `trigger()` **only in edit mode** ("Validate a loaded record on open … blank
  create forms skip it").
- **The requirement, then:** a new form is quiet, and a loaded record is judged at once.
- v1 disables Save until the form is valid (`:771`). That part is not adopted: see Out of scope.

## Rulings (planner, 2026-09-28)
- **R1: fix the presentation, not the domain.** `validateMoneyLines` keeps judging every line it is given. It
  is the server truth, and a domain rule that skipped "untouched" lines would need the client to tell the
  server what was touched, which is exactly the trust RULES rule 7 forbids. **The component decides when to
  show an issue, never whether it exists.**
- **R2: the industry pattern (RHF `onTouched`, Formik `touched`, the GOV.UK / Material guidance).** An issue on
  a field shows once:
  1. that field has been **touched** (blur, or a change), **or**
  2. the user has **attempted to submit** (the enclosing form fired `submit`, **or** any control fired
     `invalid`; see R4), **or**
  3. the line came in as `initialLines`. Server-supplied data is judged at first paint, as in v1's edit-mode
     `trigger()`.

  Touched is tracked **per line and per field**, not per line. Filling in the amount must not flash "Choose
  where the money came from" for a picker the user has not reached yet.
- **R3: document-level issues** (`line: null`: the `mustTotal` mismatch, "Only one credit line") show once
  **any** line field is touched, or on a submit attempt. With no touch, nothing is shown. Today a host passing
  `mustTotal` would paint "The lines total 0.00 but this document is for …" on a fresh form. That is the same
  defect, found before it ships.
- **R4: the submit attempt is detected on the enclosing `<form>`, and the component never cancels it.**
  - Detection is `ref.closest('form')`, with a `submit` listener plus an `invalid` listener in **capture**
    phase. `invalid` does not bubble, and the browser fires it on each invalid control when native validation
    blocks the submit.
  - This matters because on a fresh `/expenses/new`, Category and Particulars are `required`
    (`page.tsx:~133,~160`). The browser blocks the submit and `submit` never fires. Without the `invalid`
    listener, "submit blank shows the errors" would be false.
  - ⛔ **No `preventDefault`.** What reaches the server, and every server refusal, is unchanged (the brief:
    "keep submit refusals unchanged"). Client pre-emption is Out of scope.
- **R5: the blank sentence.** In `validateMoneyLines`, an amount that is blank after `trim()` gives
  `Enter an amount.`.
  - Any other unparseable amount keeps the existing sentence **byte-identical**.
  - Field `'amount'` and the issue count are unchanged, so a blank cash line with no source still yields two
    issues (amount + moneyAccountId).
  - The check is a string test. It adds no `Number(…) <op> 0` site to the money-positivity census
    (`money-positivity-census.ts:97`).
- **R6: the visibility rule is a pure, exported helper**, so it can be tested without a DOM. The repo has no
  jsdom, happy-dom or testing-library, and the unit glob is `apps/**/*.test.ts` (`vitest.config.mts:71-76`,
  so no `.tsx`).
  - ⛔ **No new devDependency in this slice.** Adding a DOM test environment is a toolchain decision, not a
    defect fix.
  - The component wiring (the blur handlers and the form listeners) is proven in the browser (§9.4).

## BUILDER items
1. **R5: `packages/domain/src/shared/money-lines.ts:332-338`.** Replace the single message with:
   ```ts
   const blank = String(line.amount ?? '').trim() === '';
   issues.push({
     line: i,
     field: 'amount',
     message: blank
       ? 'Enter an amount.'
       : `"${line.amount}" is not a valid amount. Use at most two decimal places.`,
   });
   ```
   - `String(… ?? '')` covers a hand-posted non-string.
   - The comment cites DEF-484: a blank field asks for a value, and a malformed one is quoted back.
   - `:339-341` (`above zero`) and everything else are unchanged.
2. **R6: new file `apps/erp/src/components/money/money-line-visibility.ts`.** Pure. No React, and no `'use
   client'`.
   ```ts
   import type { MoneyLineIssue } from '@shareat/domain/money-lines';   // ⛔ subpath, never the barrel
   export type LineField = 'method' | 'amount' | 'moneyAccountId' | 'cashRequestId' | 'staffId';
   /** DEF-484. Which of the domain's issues the form shows now. The domain decides WHAT is wrong;
    *  this decides only WHEN it is shown (R1-R3). */
   export function visibleIssues(
     issues: readonly MoneyLineIssue[],
     touched: readonly ReadonlySet<LineField>[],   // index-aligned with the lines
     attempted: boolean,
   ): MoneyLineIssue[]
   ```
   - If `attempted` is true, return `issues` unchanged.
   - Otherwise keep a line issue iff `touched[issue.line]?.has(issue.field)`. `referenceNo` and `document`
     are never per-field touched.
   - Keep a `line === null` issue iff some set in `touched` is non-empty.
3. **R2-R4: `apps/erp/src/components/money/MoneyLines.tsx`.**
   1. State (`:78-80`). Beside `lines`, keep `touched: ReadonlySet<LineField>[]`, initialised to one
      **all-fields** set per `initialLines` entry (R2.3), or `[new Set()]` for the default blank line. Also
      keep `attempted: boolean`, initially `false`.
   2. Every place that changes the line count keeps `touched` index-aligned:
      - add (`:334`) appends an empty set;
      - remove (`:321`) filters the same index.

      Changing a method (`:179-189`) marks `method` touched.
   3. Mark fields touched **on blur**:
      - method select → `method`;
      - source select (`:212`) → `moneyAccountId` and `cashRequestId`;
      - staff select (`:253`) → `staffId`;
      - amount input (`:276`) → `amount`.

      `onChange` does **not** mark `amount` touched, so a half-typed `1.` shows nothing until the user leaves
      the box. The selects mark on change too, because a pick is a finished answer.
   4. Add a `ref` on the root `<div>` (`:150`), and a `useEffect` that finds `ref.current?.closest('form')`.
      - If it finds one, add `submit` → `setAttempted(true)`, and `invalid` (capture: `true`) →
        `setAttempted(true)`.
      - Remove both in the cleanup.
      - No `preventDefault` (R4).
      - The comment names why `invalid` is needed: native `required` blocks `submit` from ever firing.
   5. `issueFor` (`:108-109`) and `documentIssues` (`:110`) read from
      `visibleIssues(issues, touched, attempted)`, not `issues`. `issues` itself is still computed as today.
   6. The overdraft `verdicts` (`:123-144`) are unchanged. They derive from typed amounts, so they cannot
      fire on a fresh form.
   7. The header comment gains one ⭐ line: issues are computed live and **shown** on touch or on submit
      attempt (DEF-484), and the server re-runs the same function regardless.

**BUILDER paths:** `packages/domain/src/shared/money-lines.ts`,
`apps/erp/src/components/money/money-line-visibility.ts` (new), `apps/erp/src/components/money/MoneyLines.tsx`.
⛔ Not `expenses/actions.ts` (the server path is unchanged), not `expenses/new/page.tsx` (T-348 owns it), not
`money-input.ts` (see Out of scope), and no test file.

## TESTER paths
- `packages/domain/tests/unit/t353-money-lines-blank-amount.test.ts` (new): D1-D5.
- `apps/erp/tests/t353-money-line-visibility.test.ts` (new): H1-H6. Build the input with the real
  `validateMoneyLines`, so the helper is tested against real issues, not hand-written ones.
- `apps/erp/tests/t353-money-lines-first-paint-render.test.ts` (new): R1-R4.
  - Use `renderToStaticMarkup(createElement(MoneyLines, …))` (`.ts`, with no JSX, because of the unit glob).
    The style follows `t343-s5-5r-prepaid-refund-render.test.ts`.
  - Fixture: one `accountAsSource` cashier account, `staff: []`, `direction: 'out'`.
- **Ruled edits: none.** No existing test pins either `money-lines` sentence (grep of `apps/erp/tests`,
  `packages/domain/tests` and `tests`). `money-lines.test.ts:287-290` asserts `field`, not `message`.

**Must stay green, unchanged:**
- `packages/domain/tests/unit/money-lines.test.ts`.
- `tests/unit/client-bundle-boundary.test.ts`. The new helper imports the subpath.
- `packages/domain/src/shared/money-positivity-guard.test.ts`.
- `apps/erp/tests/service-charge-wiring.test.ts`.
- Every `parseMoneyInput` pin of `is not a valid amount. Use at most two decimal places.`. These are a
  different function (`money-input.ts:66-68`) and are not touched:
  - `t343-s5-5m-money-labels`, `t343-s5-5n/5p/5s/5t/5v/5w-followups` (including
    `t343-s5-5v-followups.test.ts:599` `RATE_BLANK_SENTENCE`);
  - `t328-trade-inputs-refused-by-parser`, `t343-s7-trade-line-numbers`, `t343-s5-5m-remittance-rewrap`,
    `t343-s5-5r-prepaid-refund-render`;
  - `money-input.test.ts`, `cutover.test.ts:550`, `t343-s5-5m-money-label-required`.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.

| Id | Case | Target | Red today |
|---|---|---|---|
| D1 | `validateMoneyLines`, one cash line, `amount: ''`, valid source | the `amount` issue's message is `Enter an amount.` | `"" is not a valid amount. Use at most two decimal places.` |
| D2 | `amount: '   '` | `Enter an amount.` | `"   " is not a valid amount…` |
| D3 | `amount: '1,5'` | exactly `"1,5" is not a valid amount. Use at most two decimal places.` | green (guard: the malformed sentence is byte-identical) |
| D4 | `amount: ''`, `moneyAccountId: null`, cash | exactly two issues: `amount` (`Enter an amount.`) and `moneyAccountId` (the Choose-where sentence) | red on D4's first message only; the count is a guard |
| D5 | `amount: '0.00'` | `An amount has to be above zero.` | green (guard) |
| H1 | the issues of one blank cash line with no source; `touched [∅]`; `attempted false` | `[]` | the module does not exist (the import fails; state that this is the red). Same for H2-H6 |
| H2 | as H1, `touched [{amount}]` | only the amount issue; ⛔ no `moneyAccountId` issue | as H1 |
| H3 | as H1, `touched [{moneyAccountId, cashRequestId}]` | only the Choose-where issue | as H1 |
| H4 | as H1, `touched [∅]`, `attempted true` | both issues (`Enter an amount.` + Choose-where) | as H1 |
| H5 | `mustTotal '100.00'`, one line `50.00` with a valid source; (a) `[∅]`,false (b) `[{amount}]`,false (c) `[∅]`,true | (a) no document issue; (b) and (c) include `The lines total 50.00 but this document is for 100.00.` | as H1 |
| H6 | two lines, both blank with no source; `touched [∅, {amount}]` | only line 1's amount issue; nothing for line 0 | as H1 |
| R1 | render a fresh `MoneyLines` (no `initialLines`) | ⛔ no `text-red-700`, no `is not a valid amount`, no `Choose where the money came from`, no `Enter an amount.` | contains both DEF-484 sentences (matches the screenshot) |
| R2 | `initialLines [{method:'cash', amount:'1,5', moneyAccountId:null}]` | contains `"1,5" is not a valid amount…` and the Choose-where sentence (R2.3: loaded data is judged at once) | green (guard) |
| R3 | `initialLines [{method:'cash', amount:'', moneyAccountId:null}]` | contains `Enter an amount.`; ⛔ no `""` | contains `"" is not a valid amount…` |
| R4 | fresh, `mustTotal '100.00'` | ⛔ no `The lines total` | contains `The lines total 0.00 but this document is for 100.00.` |

## §9.4
Smoketest in Chrome on 9008, per `docs/SMOKETEST.md`, on `/expenses/new`. Take a screenshot of each step.
1. **Fresh, at 375 and at 1366.** There is no red text anywhere under Payments.
2. **Blur the empty Amount.** `Enter an amount.` appears and the Choose-where sentence does **not**. Then pick a
   source: the Choose-where sentence never appears.
3. **Reload, then click Save draft on the blank form.** The browser stops at Category (native `required`), and
   `Enter an amount.` plus the Choose-where sentence both show under "Paid 1" (the R4 `invalid` path).
4. **Fill Category, Particulars and the invoice, leave the amount blank, and Save draft.** The server's banner
   reads `Add at least one payment line.`, which is unchanged. Record exactly what renders.
5. **Type `1,5` and blur.** The malformed sentence quotes `"1,5"`.

## Out of scope
- **Client pre-emption of submit** (`preventDefault` when issues exist, and focusing the first invalid field).
  It changes which posts reach the server. Also, the server drops blank-amount lines (`actions.ts:124`), so
  the client and the server disagree about a half-filled extra line. Both are a follow-up, together with the
  next point.
- **The server silently drops a half-filled line** (`actions.ts:124`). A line with a source picked but no
  amount disappears without a word. Candidate DEF; see "Found in passing".
- **`parseMoneyInput`'s blank sentence** (`money-input.ts:66-68`, pinned by `t343-s5-5v:599`). It also quotes
  `""`, but only in server refusals after a submit, never on first paint. Changing it touches around 30 pinned
  sentences. Candidate follow-up only.
- v1's disabled-until-valid Save button.

## Found in passing (for the orchestrator to register; not this slice)
**The embedded expense form on `/ap/invoices/[id]` cannot succeed.**
- The form posts `method_1` / `amount_1` / `moneyAccountId_1` (`ap/invoices/[id]/page.tsx:~369-380`), with no
  `lineCount`.
- `parseExpenseForm` reads `lineCount` and `lineMethod_${i}` / `lineAmount_${i}` / `lineAccount_${i}`
  (`expenses/actions.ts:119-133`). So `lines = []`, and every submission is refused with `Add at least one
  payment line.`.
- No test exercises `recordExpenseForInvoiceAction` (grep of `apps/erp/tests`).
- It is not in the register (grep for `method_1`, `recordExpenseForInvoice`).
- Severity: probably Med to High, because the verified-invoice expense path is dead from the UI. This is a
  `reported` finding, not yet reproduced in the browser.

## Done when
- Every red leg goes red→green, and every guard stays green.
- Every "must stay green" file is green **unchanged**.
- The money-positivity guard and `client-bundle-boundary` are green with no edit.
- Typecheck is clean.
- §9.4 steps 1-5 are done with screenshots at 375 (and at 1366 for step 1).
- The builder edited no test file.

## Questions for Ian
None. Timing and wording are HOW (RULES §4). The one behaviour choice, not cancelling the submit, keeps
today's server refusals exactly, as the brief requires.

## S2: follow-ups from the executed review of `f69a9ff` (APPROVED 2026-09-29, orchestrator — DONE 2026-09-29)
The fix is sound; the wiring is unpinned. **Model** Sonnet, tester then builder. **Migration** none.
- **K1 (MED-HIGH, tester).** Deleting all 7 `markTouched` call sites, the four `onBlur` handlers and the `invalid`
  listener kept 17/17 green. The repo has no DOM test library and this slice adds none, so: a SOURCE guard test
  (the repo's static-guard idiom, like `action-link-sweep`) asserting every line input/select in `MoneyLines.tsx`
  carries a blur/change handler that calls `markTouched` for its own field, and that the form `invalid` capture
  listener is registered. It must go red under that exact deletion mutant.
- **K2 (MED, builder + tester).** `attempted` never resets, so a row added after a submit attempt paints both errors
  before input — DEF-484 one row over. Ruling: a submit attempt reveals the lines that existed AT the attempt; rows
  added later start quiet (record the attempted line count, or mark those lines touched at attempt time).
- **K3 (MED, builder + tester).** A document-level issue unlocks on a bare tab-through (the method select has a
  default and marks touched on blur). Ruling: document-level issues show only after a submit attempt or once an
  AMOUNT field has been touched. Latent today (no host passes `mustTotal`) — fixed now, before the AP host does.
- Doc slip (CAPABILITY-GAPS.md:446 annotation) fixed by the orchestrator; scope note (f69a9ff carried T-350
  bookkeeping) recorded.
- **BUILDER paths:** `apps/erp/src/components/money/money-line-visibility.ts`, `apps/erp/src/components/money/MoneyLines.tsx`.
  **TESTER paths:** the three t353 test files + a new `apps/erp/tests/t353-s2-money-lines-wiring-guard.test.ts`.
