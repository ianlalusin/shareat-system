# T-361: "no credit for a cash-on-delivery supplier" is enforced in the domain (DEF-492)

**Status:** SPEC 2026-09-29 (Opus planner) — awaiting orchestrator approval. ⛔ **Q1 (below) is a sequencing decision for
Ian and it gates the BUILD.** The tester may start. **Model:** Sonnet, tester then builder.
**Migration:** none, and the reason is given in R7.
**Line numbers** were checked at HEAD `e4d9ff3`. None of the BUILDER paths is dirty at that HEAD.
- `apps/erp/tests/action-link-sweep.test.ts` is dirty (T-348). This task does not touch it.
- This task edits **no file under `apps/erp/src`** (R1).

## Why
DEF-492 (`docs/DEFECTS-REGISTER.md`, the DEF-492 row, T-358 spec audit C2), verified at source:
- **The rule lives only in the web action.**
  - `parseExpenseForm` re-reads the supplier (`apps/erp/src/app/expenses/actions.ts:154-156`).
  - It then calls `validateMoneyLines` (`:157-169`), which refuses a credit line when `supplierCreditTermsDays` is
    null. That check is at `packages/domain/src/shared/money-lines.ts:386-403`, with the sentence at `:398-400`.
- **The domain does not check it.**
  - `createExpense` (`packages/domain/src/expenses/create.ts:99-208`; the register cites it under `ap/index.ts`,
    where it is not) does not refuse a credit line for a cash-on-delivery supplier.
  - Nor does `recordExpenseForInvoice` (`packages/domain/src/ap/index.ts:668-689`).
  - Nor does `editExpense` (`packages/domain/src/expenses/edit.ts:54-173`), which can replace payments (`:138-156`)
    and re-point the supplier (`:103-129`).
- **A second caller already exists.** It is not hypothetical:
  - The recurring-expense job calls `createExpense` (`packages/domain/src/recurring-expenses/job.ts:182-195`).
  - For a template with no default money account it drafts a **credit** payment (`paymentForAccount`,
    `job.ts:78-87`), whatever the supplier's terms.

## ⛔ Finding that changes the blast radius (new; not yet registered)
**Nothing in the codebase can set `suppliers.credit_terms_days`.**
- The column was added by migration 0141 (T-266 §5) and is read in three places:
  - `apps/erp/src/app/expenses/actions.ts:163`
  - `apps/erp/src/app/ap/invoices/[id]/page.tsx:60,392`
  - `MoneyLines.tsx:255`
- `CreateSupplierInput` (`packages/domain/src/ap/index.ts:69-90`) has no terms field. Neither does
  `EditSupplierInput` (`:93-…`), and no repo write names the column.
- T-358's tester hit this and set the terms by raw SQL (`apps/erp/tests/integration/t358-ap-invoice-expense-form.test.ts:166-170`).
- Consequences:
  - **Every production supplier is cash-on-delivery.** The web path refuses Credit for all of them today.
  - Row 247's credit default (T-358 C1) never fires in production.
  - Once this task lands, the recurring job's no-account templates are refused for every supplier (Q1).
- The orchestrator logs this as a new DEF (section E) at approval, whatever Ian answers.

## Rulings (planner, 2026-09-29)

- **R1: ADD the check to the domain, and leave the web action untouched.** The brief said "move". This is not
  a move, and the reasons follow.
  - **The web path stays byte-identical.** That includes which sentence wins when a form has several issues:
    `validateMoneyLines` reports per line, in line order (`money-lines.ts:322-404`).
    - Removing its credit judgement from the action would need a skip flag on the shared validator, which is a
      switch that turns a rule off.
    - It would also reorder those sentences.
  - **The action's call is the component-parity check by design** (`actions.ts:145-152`: *"THE SAME FUNCTION THE
    COMPONENT CALLS"*).
    - The domain copy is the authority for every caller. The action copy is the early, per-line answer for the
      screen.
    - This follows the two-layers shape of bible §15.11, as `assertNotInverted` does (`adjustments.ts:195-205`).
  - **One rule definition** (R4), with two call sites.
  - **No edit under `apps/erp/src`** while other lanes are editing it.
  - ⚠️ **What this leaves.** `parseExpenseForm` judges every money-line issue before `createExpense`'s
    `authorize`, so a non-holder sees a field sentence. That is DEF-478's shape, for the whole expenses form.
    - It is out of scope here. The orchestrator logs it as its own DEF.
    - Its fix, T-352-style, is the natural moment to drop the action's copy.
- **R2: the home is `runCreateExpense`, and `recordExpenseForInvoice` inherits it.**
  - `recordExpenseForInvoice` has no gate of its own. It calls `createExpense` then `approveExpense` in one
    transaction (`ap/index.ts:674-684`).
  - The check goes after the supplier-mismatch refusal (`create.ts:168-179`) and before `insertExpense` (`:181`).
  - It judges the **invoice's** supplier (`supplier`, loaded at `:156`). That is the authoritative one, never the
    caller's `supplierId`.
  - ⛔ **The order is part of the contract.** The existing refusals keep their priority:
    `authorize` → particulars → no payments → category → invoice missing → capacity → supplier gone → supplier
    inactive → supplier mismatch → **cash-on-delivery credit**.
    - `ap.test.ts:689-702` (mismatch) and `:858-869` (inactive) pay on credit against a cash-on-delivery supplier.
    - They pass only because those refusals win. If the new check moved earlier, it would turn them red.
- **R3: `editExpense` holds the same rule.** Without it, DEF-492 is one function over.
  - The check runs after `authorize` (`edit.ts:84-88`) and after the invoice/supplier block (`:103-129`).
  - It fires when `input.payments` is given, OR when the supplier or invoice is re-pointed.
  - The payments judged are `input.payments ?? await expensesRepo.getPaymentsForExpense(tx, expenseId)`
    (`packages/db/src/repo/expenses.ts:580`), read only when payments were not supplied.
  - The supplier judged is `patch.supplierId ?? expense.supplierId`, read with `apRepo.getSupplierById`.
    - That read happens ONLY when some judged line is `credit`.
    - The success path of an edit with no credit gains no query.
  - The web edit action passes only `categoryId` and `particulars` (`actions.ts:305-308`), so the check never
    fires from the web.
- **R4: one sentence, one definition.**
  - Extract the sentence from `money-lines.ts:398-400` into
    `export function cashOnDeliverySentence(supplierName: string | null): string`, returning
    `` `${supplierName ?? 'This supplier'} is cash-on-delivery. Set payment terms on the supplier to pay on credit.` ``.
  - `validateMoneyLines` calls it. Its output is byte-identical, which the existing unit tests pin.
  - The domain calls it with `supplier.name`.
  - `money-lines.ts` stays client-safe: it imports only `@shareat/core/money` (`:25`), and the new function is
    pure. Check that `create.ts`/`edit.ts` → `../shared/money-lines` creates no cycle. If it does, STOP and report.
- **R5: the refusal.**
  - In the domain:
    `throw refuse(\`createExpense: ${supplier.name} is cash-on-delivery (credit_terms_days is null) — a credit payment cannot be recorded against it\`, cashOnDeliverySentence(supplier.name))`.
  - `editExpense` uses an `editExpense:` prefix.
  - Condition: `payments.some((p) => p.method === 'credit') && supplier.creditTermsDays === null`.
  - `packages/domain/src/expenses` stays at **0** raw throws (`tests/unit/t343-throw-ratchet.test.ts:84`).
- **R6: the recurring job inherits the rule. There is no exemption.**
  - A caller-side bypass is exactly the hole DEF-492 names.
  - A template that can no longer draft is REPORTED through the job's own failure path (`job.ts:218-226`, the
    shape of test 7 in `recurring-expenses-job.test.ts:286`). It is never skipped quietly.
  - Its failure `reason` is the raw message (`e.message`, `job.ts:224`), which is why R5's raw text is written to
    be read.
  - ⛔ Whether that is acceptable **before** a terms setter exists is Q1.
- **R7: no migration.**
  - The column exists.
  - A trigger on `expense_payments` was considered and declined, for three reasons:
    - the rule reads a mutable supplier attribute at write time, and the sentence needs the supplier's name, which
      a domain `refuse` gives and a raised SQLSTATE does not;
    - the brief places it in the domain;
    - §15.11's second layer already exists (the action).
  - RULES §6.3 ("the database enforces") covers balance, period and immutability CHECKs. This is a
    document-coherence rule of the same kind as the supplier-mismatch refusal beside it, which is also domain-only.
- **R8: other `validateMoneyLines` rules stay action-only.** Examples are "only one credit line" (`:408-414`) and
  the staff-float party (`:356-365`). They are out of scope, and the orchestrator logs them with R1's DEF.

## BUILDER items
1. **B1. `packages/domain/src/shared/money-lines.ts`.**
   - Add `cashOnDeliverySentence` (R4) just above `validateMoneyLines` (`:313`), with a JSDoc naming T-361 /
     DEF-492 and its two callers.
   - Replace the template literal at `:398-400` with a call to it. Nothing else in the file changes.
2. **B2. `packages/domain/src/expenses/create.ts`.**
   - Import `cashOnDeliverySentence` from `'../shared/money-lines'`.
   - After `:179`, add the R5 check against `supplier` and `input.payments`, with a comment citing R2's order.
   - Add one line to the header (`:1-36`): the cash-on-delivery rule is enforced here for every caller (T-361).
3. **B3. `packages/domain/src/expenses/edit.ts`.** Add the R3 check after the invoice/supplier block (`:129`) and
   before the particulars block (`:130`), so no write has happened yet.
   - Import `cashOnDeliverySentence`. `apRepo` and `expensesRepo` are already imported (`edit.ts:15`).
4. **B4. `packages/domain/src/ap/index.ts`.**
   - Change only the comment on `recordExpenseForInvoice` (`:661-667`): the cash-on-delivery rule reaches it
     through `createExpense` (T-361).
   - No code change.

**BUILDER paths:** `packages/domain/src/shared/money-lines.ts`, `packages/domain/src/expenses/create.ts`,
`packages/domain/src/expenses/edit.ts`, `packages/domain/src/ap/index.ts`.

⛔ Off limits to the builder:
- `apps/erp/**` (R1).
- `recurring-expenses/job.ts` (R6, pending Q1).
- `MoneyLines.tsx`.
- Any supplier-terms setter (that is the new finding's own task).
- Every test file.

## TESTER paths (disjoint from BUILDER)
**New files** (all **integration**, real Postgres):
- `packages/domain/tests/integration/t361-cod-credit-in-domain.test.ts`: legs D1-D9 and E1-E3.
  - Fixture shape: `ap.test.ts:182-186`, with `fixtureWithSupplier` and a `verifiedInvoice` helper.
  - Terms are set by raw SQL, as t358 `:166-170` does (`update suppliers set credit_terms_days = 30 …`).
- `packages/domain/tests/integration/t361-recurring-cod.test.ts`: legs J1-J2.
  - Fixture shape: `recurring-expenses-job.test.ts:54-122` (`template`/`dueTemplate`, `counts` at `:126-133`).
- `apps/erp/tests/integration/t361-cod-credit-web-parity.test.ts`: legs P1-P3.
  - Harness and fixture from `t358-ap-invoice-expense-form.test.ts`, which has a supplier with terms and a
    cash-on-delivery one.

**Fixture edits to EXISTING integration files.** These are the tester's, done BEFORE the build, and they are the
only existing-file edits allowed.
- Today these files pay on credit against a supplier created without terms. Each will go red once the domain
  enforces the rule.
- The fix is one statement each: `await sql\`update suppliers set credit_terms_days = 30 where id = ${…}\``, with
  a comment: `// T-361: credit needs terms now the domain enforces it (DEF-492).`
- The files are:
  - `packages/domain/tests/integration/ap.test.ts`: `fixtureWithSupplier` (`:182-186`), and the "Someone Else"
    supplier at `:353` (used by `creditExpense` at `:355`).
    - ⛔ NOT the supplier at `:689`, whose leg expects the mismatch refusal. It stays cash-on-delivery; R2 keeps it
      green.
    - ⛔ NOT the inactive leg at `:858-869`, which must still hit "not active".
  - `packages/domain/tests/integration/ap-aging.test.ts:113`
  - `packages/domain/tests/integration/ap-auto-allocate.test.ts:112`
  - `packages/domain/tests/integration/supplier-returns.test.ts:112` (Acme Meats). Grant Beta Foods (`:113`)
    terms only if a credit expense uses it.
  - `packages/domain/tests/integration/recurring-expenses-job.test.ts:81-83` (the Landlord).
- **The census is the proof.** The tester runs these five files three times, all against the lane DB:
  1. before editing: green;
  2. after editing, still before the build: green, which shows the edit changes no meaning today;
  3. at READY: green.
- Any OTHER file that goes red at READY is reported with its leg. It is not patched quietly.
  - The planner's grep (`'credit'` across `packages/domain/tests`, `apps/erp/tests`, `tests/integration`) found
    only these five plus t358, which already sets terms.

**Database.** `TEST_DATABASE_URL` points at **the lane's own `_test` DB**, with the name guard (RULES §2; two lanes
on one DB truncate each other).

**Baselines.** The authorization refusal is always the same non-holder's message for the same call with a CASH line
(T-351 W1 precedent). It is never hard-coded.

## Legs
Every leg asserts the TARGET. Record the raw red for each one.
- `COD` means a supplier with `credit_terms_days` null.
- `TERMS` means 30.
- `S(name)` means `cashOnDeliverySentence(name)`'s exact text: `<name> is cash-on-delivery. Set payment terms on the
  supplier to pay on credit.`
- "Nothing written" means: no new `expenses` row for the org, no new `journal_entries`, and the invoice's remaining
  capacity is unchanged.

| Id | Call (manager unless stated) | Target | Red today |
|---|---|---|---|
| D1 | `createExpense`, COD supplier's pending invoice, `[{credit, 500}]` | rejects, `userMessage` = `S(<name>)`; nothing written | a draft is saved |
| D2 | `recordExpenseForInvoice`, COD, verified invoice, `[{credit, 500}]` | as D1; no journal entry | posts: a 2110 credit to the supplier |
| D3 | `createExpense`, COD, `[{cash, 200, drawer}, {credit, 300}]` | as D1 (any credit line refuses) | saves |
| D4 | **positive control.** `recordExpenseForInvoice`, TERMS, `[{credit, 500}]` | posts; one credit payment | green (guard) |
| D5 | **positive control.** `createExpense`, COD, `[{cash, 500, drawer}]` | saves a draft | green (guard) |
| D6 | **ordering: a STAFF non-holder** (no `create_expense`, `CAPABILITY-MATRIX.md:46`), `createExpense`, COD, credit | the message equals the same staff's message for a cash line; ⛔ no "cash-on-delivery"; nothing written | green (guard); stays green |
| D7 | **order guard, R2.** COD supplier made inactive, credit | `/not active/i`, not `S(…)` | green (guard) |
| D8 | **order guard, R2.** `supplierId` ≠ the invoice's supplier, invoice from COD, credit | the mismatch sentence, not `S(…)` | green (guard) |
| D9 | **R2: the invoice's supplier is judged.** Invoice from COD, a caller naming the same supplier; then invoice from TERMS | the first refuses with `S(<COD name>)`, the second posts | the first posts |
| E1 | `editExpense` on a COD draft (cash line), `payments: [{credit, 500}]` | `S(<name>)`; the draft's payments are unchanged (`getPaymentsForExpense`) | payments replaced |
| E2 | `editExpense` on a TERMS draft with a credit line, re-pointed (`supplierId` + `supplierInvoiceId`) to a COD supplier's invoice, no `payments` | `S(<COD name>)`; the draft still names the TERMS invoice | re-pointed |
| E3 | **positive control.** `editExpense` on a TERMS draft, `payments: [{credit, 500}]` | saves | green (guard) |
| J1 | the recurring job: a due template, COD supplier, NO default account | the run's `failures` names the template and the reason contains "cash-on-delivery"; `counts` unchanged (no invoice, expense or draft row); the cursor is not advanced | a draft is created, with credit |
| J2 | **positive control.** The same, COD supplier, office CASH account | drafts one cash expense | green (guard) |
| P1 | web `createExpenseAction`, COD invoice, a credit line | the redirect `error` === `S(<name>)` (byte-identical, via the action's own `validateMoneyLines`); no row | green (guard: R1 parity); stays green |
| P2 | web `recordExpenseForInvoiceAction`, the same | as P1 | green (guard) |
| P3 | web `recordExpenseForInvoiceAction`, TERMS, a credit line | redirects to `/expenses/<uuid>`, posted | green (guard) |

**Proving the ordering leg is not vacuous (D6):** at READY the auditor makes a throwaway worktree mutant (the R5
check moved above `authorize` in `runCreateExpense`) and records D6 going red. Nothing about the mutant is committed.

**Must stay green UNCHANGED:**
- `packages/domain/tests/unit/money-lines.test.ts` (its credit-terms gate pins R4's byte identity);
- `apps/erp/tests/integration/t358-ap-invoice-expense-form.test.ts` (A2, A4 and C1);
- `packages/domain/tests/integration/`: `expenses`, `expenses-staff-float`, `budgets`, `fixed-assets`,
  `oil-wave-2`, `recurring-expenses`;
- `packages/domain/tests/t343-s5-refusal.test.ts`, `t343-s5-2-verify-invoice-rewrap.test.ts`;
- `tests/unit/t343-throw-ratchet.test.ts`, `tests/unit/production-caller-ratchet.test.ts`;
- The five fixture-edited files, per the census above.
- The full integration suite before push (RULES §2).

## §9.4
Smoketest on **9008**, per `docs/SMOKETEST.md`, signed in as admin:
1. On `/ap/invoices/<id>` for a COD supplier's verified invoice, the Credit option shows "— no terms set".
   - In devtools, enable it and submit a credit line. Screenshot the refusal: `S(<name>)`, unchanged from before.
2. On the lane DB, `update suppliers set credit_terms_days = 30` for another supplier. There is no screen for this
   (the finding above); say so in the report.
   - Record a credit expense on its verified invoice and screenshot the posted expense.
3. Run `scripts/recurring-expense-draft.ts` against the lane DB with one COD, no-account template due. Paste the
   printed result, which should show `refused 1` naming the template.
   - This is the only non-web caller, and the reason this task exists.

## Out of scope
- **Any way to set supplier credit terms.** That belongs to the new finding's own task (Q1).
- DEF-478's shape across `parseExpenseForm`: every money-line issue is judged before `authorize` (R1). The
  orchestrator logs it.
- The other action-only money-line rules (R8).
- Re-checking terms at `approveExpense`, or at `verifyInvoice`'s auto-post, when terms were removed after a
  credit draft was made. A draft judged at creation and at edit is enough for this defect.
- Changing `paymentForAccount`'s "no account ⇒ credit" default (`job.ts:78-87`). That is Q1(c).

## Done when
- D1-D3, D9's first half, E1, E2 and J1 go red→green.
- D4-D8, E3, J2 and P1-P3 are green before and after. D6's mutant proof is recorded.
- The five-file census is green at all three points, and the must-stay-green list passes with no other test edited.
- Typecheck is clean, and `expenses` has 0 raw throws.
- §9.4 is pasted. The builder edited only the BUILDER paths.
- **Orchestrator:**
  - DEF-492 → `fixed (T-361, <commit>)`, correcting the row's `createExpense` path to `expenses/create.ts:99`.
  - Log three new rows: the terms-setter gap, the `parseExpenseForm` pre-authorize judging (R1), and R8.

## Questions for Ian
**Q1 (gates the build).** Once this lands, the recurring-expense job can no longer draft a bill on credit for a
cash-on-delivery supplier. No screen can set a supplier's payment terms today (the finding above), so **every**
supplier counts as cash-on-delivery. Every recurring template without a default money account would then show up
as "refused" each morning until it is fixed.
- **(a) Recommended.** First, a small task that lets a supplier's payment terms be set on the supplier screen
  (create and edit). Then this task, as specced.
- **(b)** Land this now. Those templates are refused daily until someone sets an account on the template, or terms
  on the supplier by hand.
- **(c)** Change the job so a cash-on-delivery supplier's no-account template drafts as **cash** instead. That
  matches row 247's "cash for cash-on-delivery" default. The person approving then picks the drawer.

(c) can be combined with (a). Exempting the job from the rule is not offered, because that exemption is the defect
itself.
