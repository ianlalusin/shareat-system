# T-358: the AP-invoice expense form posts what the parser reads (DEF-485)

**Status:** APPROVED 2026-09-29 (orchestrator, after an independent Opus spec audit; amendments C1–C4 at the end bind; C1 answered). Runs after T-353 S3 commits.
**Migration:** none.
**Why now:** Ian, 2026-09-29 (bible §13 row 245): *"yes fix DEF-485 before launch."*
- ⛔ **It runs AFTER T-353 S3 commits.** `apps/erp/src/components/money/MoneyLines.tsx` is being changed right now
  (touched-at-attempt), and it is dirty in the tree.
- This task changes **nothing** in MoneyLines. It only mounts it.
- The `MoneyLines.tsx` line numbers below were read from the dirty working tree. The builder re-verifies them after
  S3 lands. Every other line was checked at HEAD `a47e0a7`.

## Why
DEF-485 (`docs/DEFECTS-REGISTER.md`, the DEF-485 row), confirmed by execution:
- The form embedded on `/ap/invoices/[id]` (`apps/erp/src/app/ap/invoices/[id]/page.tsx:338-390`) posts a hand-rolled
  trio: `method_1` (`:369`), `amount_1` (`:376`) and `moneyAccountId_1` (`:379`). It posts no `lineCount`.
- `parseExpenseForm` (`apps/erp/src/app/expenses/actions.ts:119-133`) reads `lineCount`, then loops **0-based** over
  `lineMethod_i`, `lineAmount_i`, `lineAccount_i`, `lineRequest_i`, `lineStaff_i` and `lineRef_i`.
- So every submit is refused with *"Add at least one payment line."* (`packages/domain/src/shared/money-lines.ts:319`).
- A rename alone would still fail: `_1` is not index 0, and `moneyAccountId_*` maps to nothing.
- `/expenses/new` has used `<MoneyLines>` since T-266, which is why only this form is broken.

## Rulings (planner, 2026-09-29)

- **R1: mount `<MoneyLines direction="out">` exactly as `/expenses/new` does, with the AP page's own supplier
  context.**
  - The props (`MoneyLines.tsx:58-71`; `name` defaults to `'line'` at `:79`):

    | Prop | `/expenses/new` (`new/page.tsx:173-179`) | AP page (this task) |
    |---|---|---|
    | `sources`, `staff` | `loadMoneyLines(orgId, storeId)` (`new/page.tsx:37`) | `loadMoneyLines(orgId, invoice.storeId)`. It is the same loader the parser re-runs server-side (`actions.ts:153`), so the picker and the refusal agree |
    | `supplierId` | `null` (no invoice chosen yet) | `invoice.supplierId` |
    | `supplierName` | not passed | `supplier?.name ?? null` (`page.tsx:34`) |
    | `supplierCreditTermsDays` | `null` | `supplier?.creditTermsDays ?? null` |
    | `mustTotal`, `initialLines`, `name` | not passed | **not passed** (R3, R4) |

- **R2: the AP context restricts nothing new.** The method rule already lives in one shared function.
  - `MoneyLines` disables Credit, with the reason "no terms set", when `supplierCreditTermsDays` is null or there is
    no supplier (`MoneyLines.tsx:247-252`).
  - The server refuses the same case, through `validateMoneyLines` (`money-lines.ts:385-400`), with the terms it
    re-reads itself (`actions.ts:154-163`).
  - Passing the supplier's real terms makes the screen and the server agree: a supplier with terms can be paid on
    credit, and a cash-on-delivery supplier cannot.
  - Today's trio offered Credit unconditionally, and even pre-selected it (`:369`). That was a second, divergent
    rule. The trio is deleted, not ported.
- **R3: no `initialLines` (so Credit is not pre-selected).**
  - Server-supplied initial lines start "touched" and are judged at once (`MoneyLines.tsx:89-93`, T-353 R2.3). A
    pre-filled credit line with an empty amount would paint an error on first paint.
  - That behaviour is what T-353 S3 is changing right now.
  - The blank default line is cash; the user picks Credit. Pre-selecting Credit for suppliers with terms is out of
    scope.
- **R4: no `mustTotal`.**
  - An invoice can take several expenses. `capacityOf` (`packages/db/src/repo/ap.ts:381-397`) gates the remainder
    server-side, and the page already shows it (`page.tsx:46`).
  - Forcing lines to equal the invoice total would refuse a legitimate partial expense.
- **R5: dead data goes.** `wallets` (`listMoneyAccountsForPicker`, `page.tsx:36,43`) fed only the trio's select
  (`:381`). It is dropped from the `Promise.all`, along with its import if nothing else uses it.
  `loadMoneyLines` replaces it.
- **R6: the tests pin the component to the parser, not to the parser alone.**
  - The action leg builds its FormData from the `name` attributes that `renderToStaticMarkup(<MoneyLines …/>)`
    actually emits, not from a list copied out of `parseExpenseForm`.
  - If either side renames a field, the leg goes red.

## BUILDER items

1. `apps/erp/src/app/ap/invoices/[id]/page.tsx`:
   - Replace the Method / Amount / "Paid from" grid (`:367-386`, the `grid-cols-3` block) with `<MoneyLines
     direction="out" … />` and R1's props, under the same `canRecord` form.
   - Keep the four hidden inputs (`:339-342`), the Category and Particulars fields, and the submit button unchanged.
   - Add `loadMoneyLines(orgId, invoice.storeId)` (import from `@/lib/money-lines/load`, as `new/page.tsx:2` does).
     Import `MoneyLines` from `@/components/money/MoneyLines`.
   - Remove `wallets` (R5).
   - Add a short heading line above the component, mirroring `/expenses/new`'s "Payments — add a line for each place
     the money came from."
2. Nothing else. `MoneyLines.tsx`, `expenses/actions.ts` and the domain are unchanged.

**BUILDER paths:** `apps/erp/src/app/ap/invoices/[id]/page.tsx` only.
⛔ Not `MoneyLines.tsx` (T-353 S3 owns it), not the parser, not the domain, and no test file.

## TESTER paths
- **New file.** `apps/erp/tests/integration/t358-ap-invoice-expense-form.test.ts`.
  - Real Postgres through `TEST_DATABASE_URL`, with the `_test` name guard.
  - Mock `next/navigation`'s `redirect`, and `requireActor` / `requireSession` from `../../src/lib/session`, in the
    shape of `apps/erp/tests/integration/t343-s5-5n-followups.test.ts` (its redirect class and `expectRedirectTo`).
  - For the page render, use the real-DB render technique of `apps/erp/tests/integration/t350-s2-render.test.ts`
    (`renderToStaticMarkup`, with only the session mocked).
  - The fixture:
    - one org and store, and an active cash money account at that store with a positive balance;
    - one expense category with an account code, and an admin actor holding `create_expense` + `approve_expense`;
    - a supplier WITH `credit_terms_days` and a supplier WITHOUT (cash-on-delivery);
    - one **verified** supplier invoice per supplier, with remaining capacity ≥ ₱500.
  - Seed through the existing AP repo/domain entry points, as `packages/domain/tests/integration/ap.test.ts` does, not with raw status writes.
- **`emittedNames()`:** a helper that renders `<form><MoneyLines direction="out" sources={…} staff={[]}
  supplierId={…} supplierCreditTermsDays={…}/></form>` with `renderToStaticMarkup`. It returns every `name="…"` and
  the value of the `…Count` input.
  - Every A-leg builds its FormData ONLY from these names, filling the values by meaning: Method → the method string,
    Amount → the amount, Account → the money-account id, and the rest empty.
  - It asserts the helper found ≥1 Method, Amount and Account name for index 0, plus a Count name. With an empty
    render, the legs would pass vacuously.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.

| Id | Case | Target | Red today |
|---|---|---|---|
| R1 | Render `/ap/invoices/[id]` for a verified invoice with capacity, as the admin | The markup contains `name="lineCount"`, `name="lineMethod_0"`, `name="lineAmount_0"` and `name="lineAccount_0"`, and none of `name="method_1"`, `name="amount_1"`, `name="moneyAccountId_1"` | It emits the trio and no `lineCount` |
| R2 | The same render for the cash-on-delivery supplier's invoice | The Credit `<option>` is `disabled` and carries "no terms set". For the supplier WITH terms, Credit is enabled | Credit is enabled and pre-selected for both |
| R3 | The page's form names ⊇ `emittedNames()` for the same props | Every name `MoneyLines` emits appears inside the `recordExpenseForInvoiceAction` form (it is mounted there, not in another form) | The names are absent |
| A1 | `recordExpenseForInvoiceAction` with Category, Particulars, the four hidden inputs and a **cash** line from `emittedNames()`: the store's cash account, ₱500 | It redirects to `/expenses/<uuid>`. One POSTED expense linked to the invoice, total ₱500, one payment line: cash, that account | Refused: "Add at least one payment line." (the trio's names; state which FormData produced the red) |
| A2 | The same, with a **credit** line, for the supplier WITH terms | It redirects to `/expenses/<uuid>`, posted, with a credit payment line | Refused as A1 |
| A3 | Refusal still refuses: the same as A1 but Count = 0 (no lines) | It redirects to the invoice's `returnTo` with `error=` "Add at least one payment line." No expense row | Green (guard: the parser's refusal is intact) |
| A4 | Refusal: a credit line for the cash-on-delivery supplier | It redirects with `error=` the "…is cash-on-delivery…" sentence (`money-lines.ts:396-400`). No expense row | Green (guard: R2's server half) |
| A5 | Refusal: a cash line of ₱500 whose Account is an account at ANOTHER store of the same org | Refused (the server re-fetches sources per store, `actions.ts:153`). No expense row | Green (guard) |

- The old trio's FormData is recorded once, as the red for A1/A2: `method_1=cash`, `amount_1=500`,
  `moneyAccountId_1=<id>`, no `lineCount`. That is the DEF-485 repro, kept as evidence.
- Existing suites stay green UNCHANGED: `t353-money-line-visibility.test.ts`,
  `t353-money-lines-first-paint-render.test.ts`, `t353-s2-money-lines-wiring-guard.test.ts`, the `/expenses/new`
  create tests, the AP suites, and `action-link-sweep.test.ts`. Also the full integration suite before push
  (RULES §2).

## §9.4
Boot the app on **9008** (`docs/SMOKETEST.md`) and sign in as an admin:
1. Open a **verified** supplier invoice with remaining capacity, from a supplier that has payment terms.
2. In "Record an expense against this invoice", pick a category and type particulars. On payment line 1 choose
   **Cash**, pick a store drawer, and enter an amount within the remaining capacity. Submit.
3. Screenshot the resulting `/expenses/<id>` page: posted, linked to the invoice, with the cash line. Then screenshot
   the invoice page showing the expense in its linked list and the reduced remaining.
4. Repeat once with **Credit** on the same invoice. Screenshot.
5. Open an invoice from a cash-on-delivery supplier. Screenshot the Credit option shown disabled with "no terms set".
- ⛔ A green A-leg set is not a substitute. DEF-485 lived because no one clicked this form.

## Out of scope
- Any change to `MoneyLines.tsx` (T-353 S3 owns it), `parseExpenseForm`, or `validateMoneyLines`.
- Pre-selecting Credit for suppliers with terms (R3). If wanted, it is a small follow-up once T-353 S3's touched rules
  are final.
- A shared "payments" sub-form component for the two expense entry points. Two call sites do not justify it.
- Other forms. The parser's two actions are posted to only by `expenses/new/page.tsx` and this page (grepped); the
  only `<MoneyLines>` consumers are `expenses/new/page.tsx:173` and, after this task, the AP page.

## Done when
- R1-R3, A1 and A2 go red→green. A3-A5 stay green.
- `emittedNames()` is shown non-empty.
- The existing suites above are green unchanged, typecheck is clean, and the full integration suite passes.
- The §9.4 screenshots are pasted. The builder edited only the page.
- **Orchestrator:** DEF-485 → `fixed`, citing the commit. Correct the register's `:339-379` to `:367-386` (the
  trio's grid at HEAD `a47e0a7`).

## Questions for Ian
None. Ian ruled the MoneyLines swap (row 245). R2-R4 follow rules that already exist.

## Orchestrator amendments (bind; from the independent spec audit, 2026-09-29)
- **C1 — ANSWERED (Ian, bible row 247): Credit default for a supplier WITH terms, one line, the remaining amount pre-filled; Cash for cash-on-delivery.** Build it; add a render leg for each arm. Was: v1 defaults to credit when an expense is recorded
  against a supplier delivery (`ERP-rebuild/src/components/inventory/LinkExpenseDialog.tsx:89`,
  `DeliveryExpenseSplitDialog.tsx:112`), and today's v2 trio pre-selects it (`page.tsx:369`). With plain `<MoneyLines>`
  the default becomes Cash, and a slip posts a real drawer cash-out instead of AP. Orchestrator recommendation: for a
  supplier WITH terms pass `initialLines=[{ method: 'credit', amount: <remaining> }]` (amount pre-filled, so no
  empty-field paint); Cash for a cash-on-delivery supplier. Build waits for Ian's answer.
- **C2 — R2 states where the credit rule lives:** only in `parseExpenseForm` (`apps/erp/src/app/expenses/actions.ts:153-167`
  → `validateMoneyLines`, `packages/domain/src/shared/money-lines.ts:386-400`), not in `createExpense` /
  `recordExpenseForInvoice` (`packages/domain/src/ap/index.ts:668-689`). A real server control for both web entry points;
  the domain gap is DEF-492.
- **C3 — A-legs map names to meaning by SUFFIX on the emitted names** (`/Method_0$/`, `/Amount_0$/`, `/Account_0$/`)
  and take the rendered Count value. `lineAccount_0` is a hidden input rendered as `''` — the leg sets it explicitly and
  never relies on `lineSource_0` (the parser ignores it), or A1 passes with no account and fails for the wrong reason.
- **C4 — re-verify MoneyLines by NAMES and the "— no terms set" text after T-353 S3 lands**, not by line numbers.
