# T-475: AP and expense forms check business rules live, admins may verify their own invoice, and the two forms link up

**Status:** 2026-10-25: S1, S2 LIVE (#62, #65); S3 in PR #69 (self-verify capability, migration 0217; only Ian gains it); S4 (linkage) next. Spec 2026-10-24 (Opus planner).
**Ruling:** Ian, 2026-10-24, *"1A, 2A, 3 yes"*: (1A) business-rule errors show WHILE filling, Save off until fixed, the server
keeps re-checking; (2A) a new org-level capability `verify_own_supplier_invoice`, admin and super-admin, flagged and audited,
bypassing ONLY creator-is-not-verifier; (3 yes) expense-to-invoice linkage fixes. Follows row 293 / T-385 (`verify_own_sales_day`),
row 363 / T-440 (live field checks), row 289 (Save off until valid), row 262 (offer a control only where it can succeed).
**Model:** Sonnet lanes, tester first then builder (money + auth: Sonnet, never Haiku). Amendments in plan mode (Opus).
**Migration:** `0216` (reserved), S3 only. Hand-authored per ADR-012 §5; full suite on a fresh gate DB (memory: full suite for migrations).

## 1. Goal
Today the AP invoice and expense forms accept input, round-trip to the server, and only then say "no". Ian wants every
business-rule refusal that the page can know in advance to appear as the person types, with Save off and the reason next to
it, using the SAME rule and the SAME sentence the server uses. Ian, as admin, must be able to verify an invoice he logged
himself, visibly marked and reviewable, without loosening any other rule. And the new-expense form must stop forcing a
detour to /ap and back.

## 2. What the code does today (verified on fb17323)
- Refusals that come only after submit: self-verify `ap/index.ts:803`; attestation ticks `:808-823`; inactive supplier at
  verify `:830`, at log `:486`, at expense `create.ts:178`; receipt photo missing / foreign `ap/index.ts:834-859`; drafts that
  fail to post at verify `:868-886` (wraps `approveExpense`); duplicate invoice number `:613-626` (warning AFTER save);
  fees over total `:510-518`; VAT type/amount family `:532-590`; due before invoice date `:608`; capacity
  `create.ts:156` (via `assertOpenForRecording`, `repo/ap.ts:493`); credit on cash-on-delivery `create.ts:201-206`;
  pending invoice at approve `repo/ap.ts:484`; locked / closed month `approve.ts:293-310`.
- T-440's `CheckedForm` / `FieldCheck` / `EditableRecord` check single-field FORMAT rules only (T-440 Q4 left cross-field
  rules server-only). The verify form (`ap/invoices/[id]/page.tsx:380`) and the approve form (`expenses/[id]/page.tsx:216`)
  are plain `<form>`s.
- **New findings (linkage pains, verified):**
  - F1 `/expenses/new` passes `supplierId={null}` to `MoneyLines` (`new/page.tsx:168-169`), and `MoneyLines.tsx:272`
    disables Credit whenever `!supplierId`: **a credit expense can never be entered from /expenses/new**, even against a
    supplier on terms.
  - F2 The invoice page offers "Record an expense" only when VERIFIED (`canRecord`, `page.tsx:74`). A pending invoice has no
    way to start a draft from its own page, and `/expenses/new` takes no invoice preselect (`SearchParams` = store, error).
  - F3 "Approve & post" on a draft is offered while its invoice is still pending: a certain refusal.
  - F4 The draft edit category select (`expenses/[id]/page.tsx:195`) offers unmapped categories enabled; the new form disables
    them. A draft moved onto an unmapped category later blocks its invoice's verification.
  - F5 The invoice picker (`ap/lib.ts:77`) lists invoices of INACTIVE suppliers; `createExpense` then refuses.
  - F6 The verify form is shown to the invoice's creator and to people without `verify_supplier_invoice` at that store; it
    tells everyone "You cannot verify an invoice you logged yourself."
  - F7 `closedMonth` is computed only for override holders (`page.tsx:96`, `expenses/[id]/page.tsx:103`), so everyone else
    learns the month is closed only after submit.
  - DEF-485 (embedded expense form never saves) is already `fixed` by T-358; DEF-662 closed by T-432. No action on either.
    DEF-404 (no due date on the AP payment screen) is a different form: out of scope.

## 3. Design A: one business-rule check layer (S1, S2)

### 3.1 The rule leaf: `packages/domain/src/business-rules/` exported as `@shareat/domain/business-rules`
Pure, same import discipline as `field-rules` (only `./*`, `@shareat/core/money`, `@shareat/core/datetime`,
`../shared/money-input`, `../shared/money-lines`). Added to `tests/unit/client-bundle-boundary.test.ts`.
```ts
type Verdict = null | { level: 'block' | 'warn'; sentence: string };
interface BusinessCheck<F> {
  id: string;                                   // 'ap.invoice.dueNotBeforeInvoice'
  watch: readonly string[];                     // form control names it reads
  run(facts: F, values: Readonly<Record<string, string>>): Verdict;
}
export const BUSINESS_CHECKS: Readonly<Record<string, BusinessCheck<any>>>;   // the client resolves a check BY ID
```
- **Facts** are plain JSON the server already has or loads cheaply (a supplier's status, VAT status and terms; an invoice's
  remaining capacity; a period's status). They cross the server-to-client boundary as props; functions never do.
- **One source:** each domain refusal site in §4 calls `CHECK.run(facts, values)` with facts it read itself, and throws
  `refuse(raw, verdict.sentence)`. The inline sentence literals in `ap/index.ts` / `create.ts` / `approve.ts` move into the
  leaf in the same edit. Raw diagnostics stay where they are (T-343) and never carry the typed value.
- Where the backstop lives in `@shareat/db` (`assertOpenForRecording`, which domain code cannot be imported into), the
  domain pre-checks with the leaf FIRST and the repo stays the race-proof backstop; a parity test pins both sentences equal.

### 3.2 The client piece: `CheckedForm` / `EditableRecord` gain blockers
- `check-state.ts` gains `blockers: Map<id, sentence>` and `warnings: Map<id, sentence>`; `ctx.blocked` is
  `fieldsFail || blockers.size > 0`. Warnings NEVER disable Save. `CheckSummary` lists field requirements then blockers
  ("Save is off until: ...").
- New `<RuleCheck id facts />` (`components/forms/RuleCheck.tsx`, client): resolves `BUSINESS_CHECKS[id]`, asks the form
  context to also track `check.watch` names (the delegated listener reads them; unruled controls stay uncontrolled), runs on
  every change, renders its own `aria-live="polite"` line (danger + icon for block, warning + icon for warn, never colour
  alone) and registers/clears its blocker. Outside a form context it renders nothing.
- `useLookupCheck(action, inputs)` for facts the page lacks: debounced 400 ms, the answer becomes facts for a check. While
  unanswered or failed it gives NO verdict (never blocks on a pending lookup; the server re-checks anyway).
- Before hydration: Save enabled, no lines (T-440 §3.3 contract). The verify and approve forms become `CheckedForm` (rules
  optional, or an empty `defineFieldRules` set; the T-384 / T-412 / T-387 guards already treat `<CheckedForm` as a form).

### 3.3 Server side
Unchanged authority: the domain still runs every check on every save. The one new endpoint, `checkInvoiceNumberAction`
(`ap/actions.ts`), runs `authorize(record_supplier_invoice, { storeId })` FIRST (DEF-676), then
`apRepo.findDuplicateInvoices` scoped to the actor's org, and returns only what the after-save warning already reveals
(date and total of each match): no person, no id (T-343, row 353).

## 4. The checks
"Page" = already on the page; "loader" = one extra read in the page's server component; "lookup" = §3.2 lookup.

| # | Form | Rule and level | Facts and source | Exact sentence (server and screen) | Server re-check |
|---|---|---|---|---|---|
| A1 | Log invoice (/ap) | Supplier must be active, block | supplier status per option, page (`listSuppliersWithPosition`) | `{name} is {status}, not active — reactivate the supplier first if you really are still buying from them.` | `recordInvoice` :486 |
| A2 | Log invoice | Due date not before invoice date, block | values only | `A due date can't be before the invoice date.` | :608 |
| A3 | Log invoice | Delivery + other fees not over total, block (equal passes) | values only | `The delivery and other fees can't be more than the invoice total.` | :510-518 |
| A4 | Log invoice | VAT family: non-VAT supplier can't be vatable/zero-rated or carry VAT; vatable needs VAT > 0 and not over total; zero-rated has none; VAT amount only with vatable. `supplier_default` resolves from the supplier's VAT status, block | supplier `vatStatus` per option, page | the existing sentences at :544-575, moved verbatim | :532-590 |
| A5 | Log invoice | Duplicate number for this supplier, **warn** (Q1) | lookup on supplier + number | `{supplier} already has invoice "{no}" recorded ({date} ₱{total}). Check it is not the same bill twice.` (after-save flash keeps "Saved anyway; ..." suffix) | :613-626 unchanged |
| V1 | Verify | Creator may not verify unless they hold `verify_own_supplier_invoice` (S3) | `createdBy === viewer`, `can()`, page | `You logged this invoice, so you cannot also verify it. Verifying is a second pair of eyes — ask a manager who did not enter it, or an admin.` | :803 (S3 adds the exemption) |
| V2 | Verify | All four ticks, block | values only | the :819 sentence with the still-unticked labels | :808-823 |
| V3 | Verify | Supplier active, block | supplier status, page | `{name} is {status}, not active.` | :830 |
| V4 | Verify | Receipt photo present, in this org, of this store (commissary mirror exempt), block | `receiptFileId`, file store, `counterpartyStoreId`, page/loader | the :838 / :849 / :855 sentences | :834-859 |
| V5 | Verify | Every draft would post, block. A closed month lifts when the override is ticked; a locked month never lifts | per-draft `approvalVerdict` (§4.1), loader | `This invoice can't be verified yet: "{particulars}" — {draft's own sentence}` | :868-886 |
| E1 | New expense | Amount total not over the invoice's remaining (equal passes), block | `remaining` per picker option, page | the `assertOpenForRecording` sentence (leaf copy, parity-pinned) | `create.ts` pre-check + repo backstop |
| E2 | New expense | Credit line on a cash-on-delivery supplier, block | supplier terms per picker option (F1 fix) | `cashOnDeliverySentence(name)` (already shared) | `create.ts:201-206` |
| E3 | New expense | Invoice's supplier active, block (picker also marks such rows "(supplier inactive)", F5) | supplier status per option, page | the `create.ts:179` sentence | `create.ts:178` |
| E4 | Edit draft | Category must have a ledger account, block (current unmapped category still shown, F4) | `accountCode` per category, page | `This category has no ledger account yet, so the draft can't post. Pick another category.` | `editExpense` gains the check; `routeExpense` stays backstop |
| P1 | Approve draft | Invoice must be verified, block (F3) | invoice status, loader | `{The invoice phrase} hasn't been verified yet, so this can't post against it.` | `approve.ts` pre-check + repo :484 |
| P2 | Approve draft | Locked month block; closed month block unless override ticked (holder only) (F7) | period status for the date for EVERY viewer, loader (`journalRepo.findPeriodForDate`) | the `approve.ts:298` / `:304` sentences | `approve.ts:293-310` |
| P3 | Approve draft | Any other approval blocker (unmapped, missing money account, cash request not released / other store / overdrawn, routing invariant), block | `approvalVerdict`, loader | that verdict's own sentence | `approveExpense` |

### 4.1 `approvalVerdict`: one evaluator for approve and for the verify preview
Split `approveExpense` (`approve.ts`) into `gatherApprovalFacts(tx, actor, expenseId, { lock })` (reads; locks only when
`lock`) + a pure `approvalVerdict(facts, { invoiceVerifiedInThisTx?, periodOverride? })` returning the first blocker
`{ raw, sentence } | null`. `approveExpense` = gather (locked) + verdict + throw + post, so the preview can never disagree
with the real thing. The page calls gather with `lock: false`. No dry-run-and-rollback (it would burn sequence numbers and
take locks). The `transfer_funds` check stays an `authorize()` inside gather, savepointed so a refusal is a fact, not an abort.

## 5. Design B: verify your own supplier invoice (S3)

### 5.1 Capability
`verify_own_supplier_invoice` | org | super ✅ | admin ✅ | manager ✗ | staff ✗ | area `suppliers` | label `verify a supplier
invoice you logged yourself`. Matrix-held by role, so **no backfill** (unlike 0188). Consequence to pin, not to fight: it
enters the DERIVED `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` (a manager standing in for a missing admin), and does not change
the super-admin-only set (`super-admin-capability-set.test.ts` PINNED unchanged). Update the count comments in
`capabilities.ts` and add the row to `CAPABILITY-MATRIX.md` (Suppliers section).

### 5.2 Domain (`verifyInvoice`)
At :803: `if (invoice.createdBy === actor.personId)`: `selfVerified = await can(trx, actor, 'verify_own_supplier_invoice')`;
false → the V1 refusal, unchanged. True → continue through EVERY remaining check, unchanged and in the same order (ticks,
supplier, photo, drafts via `approveExpense`, which keeps period locks, routing and cash rules). `markInvoiceVerified` gains
`selfVerified`. After the existing `ap_invoice.approved` row, a second audit row `ap_invoice.self_verified`
(`audit/catalogue.ts`: money, high, store, `ap_invoices`, T-475) with `after: { selfVerified: true }`.

### 5.3 Data: migration `0216_t475_self_verified_supplier_invoices.sql`
1. `ALTER TABLE supplier_invoices ADD COLUMN self_verified boolean NOT NULL DEFAULT false;`
2. Replace `supplier_invoices_two_person_verification_check` (0046:61) with the same name:
   `CHECK (verified_by IS NULL OR verified_by <> created_by OR self_verified) NOT VALID` (stays NOT VALID like 0046: history).
3. `supplier_invoices_self_verified_means_self_check`: `CHECK (NOT self_verified OR verified_by = created_by) NOT VALID`,
   then `VALIDATE CONSTRAINT` (every existing row is false, so it passes).
4. Trigger `supplier_invoices_self_verify_requires_capability` BEFORE INSERT OR UPDATE, function decides inside:
   (a) INSERT with `NEW.self_verified`, or UPDATE where `NEW.self_verified AND NOT OLD.self_verified`: the person in
   `NEW.verified_by` must hold the capability as `authorize()` decides it: an active `person_roles` row in `NEW.org_id` with
   role `admin`/`super_admin`, OR a live `person_grants` row `verify_own_supplier_invoice` (mirror `accessRepo.activeRoleForPerson`
   and `personHasActiveGrant` exactly), else `23514` naming the constraint; (b) UPDATE where `OLD.self_verified AND NOT
   NEW.self_verified`: refused (the flag is history). Any other UPDATE (void, payment status) is NOT re-judged, so a later
   demotion never blocks voiding. SECURITY INVOKER. Registry: `validator`, `origin` (reads other rows' current state).
5. `CREATE INDEX supplier_invoices_self_verified_idx ON supplier_invoices (org_id, verified_at) WHERE self_verified;`
- **Why a trigger, not the CHECK alone:** a CHECK on `OR self_verified` lets any plain UPDATE set the flag and walk around
  segregation. The trigger makes the flag reachable only for a verifier who really holds the capability. **Limit, stated:**
  the database knows the named verifier, not the session actor (no actor GUC exists); that the verifier IS the actor stays the
  domain's job, as for every `verified_by` column. **Drift guard:** a test walks the four roles of `CAPABILITY_MATRIX` and
  asserts the trigger agrees with `can()` for each, plus a manager holding a person-level grant.
- **Locks:** one transaction. ADD COLUMN with a constant default is metadata-only but takes ACCESS EXCLUSIVE briefly; the two
  ADD CONSTRAINT NOT VALID are brief ACCESS EXCLUSIVE with no scan; VALIDATE takes SHARE UPDATE EXCLUSIVE with a scan; CREATE
  TRIGGER takes SHARE ROW EXCLUSIVE; CREATE INDEX blocks writes for its build. The table is small (single-thousands of
  rows); all locks are held to commit, so deploy outside store hours. Follow ADR-012 §5 for `lock_timeout` and the meta journal.
- **Prechecks** (read only, as `doadmin` with Ian, `docs/ops/README.md` row): P0216a `count(*) WHERE verified_by = created_by`
  (informational; historic rows stay legal under NOT VALID and are NOT back-flagged: they were not verified through the
  capability); P0216b active admins per org (who gains the power; Ian confirms); P0216c pending invoices whose creator is an
  admin (the backlog Ian can now clear).
- **Census:** no table, no FK, so the same-org census and `classification.ts` / `rls/registry.ts` are untouched; run the
  schema-coverage, same-org census and trigger-registry guard files anyway.

### 5.4 Review list
`/ap` invoice list gains a GET filter "Verified by its own creator" (`?selfVerified=1`, a flag, nothing typed in the URL)
and a badge on such rows and on the invoice page ("Verified by its own creator"). `apRepo.listSupplierInvoices` gains
`selfVerified?: true`. Shown to whoever can already see /ap: the only name shown is the verifier, already on the page.

## 6. Design C: linkage (S4, plus F1/F5 in S2)
- **C1 Log an invoice without leaving the expense.** `/expenses/new` gets "Log a new invoice" beside the picker, opening a
  `FormModal` rendered OUTSIDE the expense form (nested forms are invalid). Its body is the SAME invoice-log fields component
  extracted from `/ap` (one form, one rule set, the S1 checks), with the store fixed to the page's store. It posts to
  `recordInvoiceInlineAction`, sharing one core with `recordInvoiceAction` but returning
  `{ option, warning? } | { error }` instead of redirecting. The client appends the option to the picker, selects it, and
  closes. The expense form never navigates, so its typed values stay. A refusal keeps the modal open with its typing (React
  19 resets an uncontrolled `<form action>` after the action, T-440 A4: re-fill from the returned typed values, T-389 style).
- **C2 Supplier carries over.** Picker options carry `{ supplierId, supplierName, creditTermsDays, supplierStatus,
  remaining }`. A client `InvoiceMoneyLines` wrapper feeds the picked invoice's supplier into `MoneyLines` (fixes F1: Credit
  offered for a supplier on terms, refused live for cash-on-delivery, E2) and the hidden `supplierId`. Done in S2.
- **C3 From a pending invoice to a draft.** The invoice page shows "Add a draft expense to this invoice" while pending
  (only for `create_expense` at its store), linking `/expenses/new?store=S&invoice=I`; the page preselects it if it is in the
  store's open list, else ignores it silently (F2).
- **C4 Verify only where it can succeed (F6).** Creator without the capability: the form is replaced by the V1 sentence.
  Creator with it: the form shows, with a warning line `You logged this invoice. You may verify it yourself; it will be marked
  "verified by its own creator" for review.` Viewer without `verify_supplier_invoice` at the store: no form, `You can't verify
  invoices at this store.` Display only; the domain re-checks.
- **C5 Draft page:** when P1 blocks, the approve card links "Open the invoice to verify it".

## 7. Slices (build order). Tester writes the failing tests first; each names the mutant it kills.

**S1. Rule layer + invoice log + verify form.** Files: `packages/domain/src/business-rules/{index,check,ap}.ts`,
`packages/domain/package.json` (export), `packages/domain/src/ap/index.ts` (sentences from the leaf),
`packages/domain/src/expenses/approve.ts` (§4.1 split), `apps/erp/src/components/forms/{check-state,context,CheckSummary,
CheckedForm,EditableRecord,RuleCheck}.ts(x)`, `apps/erp/src/app/ap/{page.tsx,actions.ts}`, `ap/invoices/[id]/page.tsx`,
`tests/unit/client-bundle-boundary.test.ts`. Checks A1-A5, V2-V5 (V1 keeps its current sentence; S3 adds the exemption).
Tests:
- Unit per check, boundary cases: A2 equal dates pass (*mutant* `<=`); A3 fees equal total pass (`>=`); A4 each VAT branch
  incl. `supplier_default` resolution (*mutant* a branch dropped); V2 three ticks block (`some` for `every`).
- Parity: every leaf check's sentence equals the domain refusal's `userMessage` for the same case (*mutant* edit one literal).
- Form: a blocker disables Save and lists in the summary (*mutant* `blocked` ignores blockers); a warning never disables
  Save (*mutant* warn treated as block); pending lookup gives no verdict.
- Lookup: unauthorized caller gets the authorization refusal, not a duplicate answer (DEF-676); another org's invoice never
  matches; response carries no id or person.
- `approvalVerdict` agrees with `approveExpense` on: unmapped, locked month, closed month with and without override, overdrawn
  cash request (*mutant* gather skips a check). Verify page with an unmapped draft shows V5 and Save off.

**S2. Expense new / edit / approve.** Files: `packages/domain/src/business-rules/expenses.ts`,
`packages/domain/src/expenses/{create,edit,approve}.ts`, `apps/erp/src/app/expenses/{new/page.tsx,[id]/page.tsx,actions.ts}`,
`apps/erp/src/app/ap/lib.ts` (picker facts), new `components/money/InvoiceMoneyLines.tsx`. Checks E1-E4, P1-P3; C2.
Tests: E1 amount equal to remaining passes, one centavo over blocks (*mutant* `>=`); E2 Credit offered for a terms supplier
on /expenses/new (*mutant* `supplierId={null}` restored) and blocked for cash-on-delivery; E3 inactive-supplier invoice
marked and blocked; E4 `editExpense` refuses an unmapped category (*mutant* check removed) and the select disables it; P1
approve disabled on a pending invoice; P2 locked blocks even with override ticked, closed blocks a non-holder (loader runs for
everyone, *mutant* gated on holder again); server refuses each when the client is bypassed (raw POST).

**S3. Self-verify capability + migration 0216.** Files: `packages/db/migrations/0216_*.sql` + meta,
`packages/db/schema/suppliers.ts`, `packages/db/src/repo/ap.ts`, `packages/db/src/triggers/registry.ts`,
`packages/db/src/audit/catalogue.ts`, `packages/auth/src/capabilities.ts`, `docs/decisions/CAPABILITY-MATRIX.md`,
`packages/domain/src/ap/index.ts`, `apps/erp/src/app/ap/page.tsx` (filter, badge), `ap/invoices/[id]/page.tsx` (badge),
`docs/ops/README.md` (prechecks). Tests:
- Matrix: admin and super ✅; **manager ✗ and staff ✗ fire** (CAPABILITY-MATRIX rule); in the admin-less-manager derived set.
- Domain: admin creator verifies → `verified`, `self_verified`, both audit rows; manager creator → V1 refusal, still pending;
  non-creator → flag false, no self row (*mutant* flag set for everyone); admin creator with a draft in a LOCKED month →
  refused, still pending, no flag (*mutant* exemption skips the draft loop); unmapped draft, inactive supplier, no photo →
  each still refused for the admin creator.
- **DB, plain UPDATE:** set `verified_by = created_by` without the flag → `23514` two-person; set the flag with a manager as
  verifier → trigger refuses; set the flag with `verified_by <> created_by` → self-means-self check refuses; clear the flag on
  a verified row → refused; INSERT with the flag by a non-holder → refused; void a self-verified invoice after the admin is
  demoted → succeeds (*mutant* trigger re-judges every UPDATE). Role-drift test (§5.3). Trigger registry guard green.
- List: `?selfVerified=1` returns only flagged rows of the actor's org.

**S4. Linkage.** Files: invoice-log fields extracted to `apps/erp/src/app/ap/InvoiceLogFields.tsx`, `ap/page.tsx`,
`ap/actions.ts` (inline action), `expenses/new/page.tsx` + new `expenses/new/NewInvoiceModal.tsx`, `ap/invoices/[id]/page.tsx`,
`expenses/[id]/page.tsx`. C1, C3, C4, C5. Tests: modal save returns the option, picker selects it, expense typed values
(particulars, category, a payment line) unchanged (*mutant* action redirects); modal refusal keeps the modal's typing; the
inline action authorizes first and refuses another store; `?invoice=` from another store is ignored; C4 three viewer cases
(creator without, creator with, no capability) render as specified (*mutant* form always shown); browser check per
`verifying-ui-in-a-browser` at phone and desktop width.

**Parallel safety.** S1 first (it owns the leaf, the form context and the §4.1 split). Then S2 and S3 may run in parallel
worktrees: their files are disjoint. S3 must not touch `expenses/*` or `ap/lib.ts`, S2 must not touch `ap/index.ts` or the ap
pages. S4 last (needs S2's picker facts and S3's capability). One migration, S3 only: its own PR or prechecks with Ian
before wrap-up (row 296).

## 8. Out of scope
- Linking deliveries to invoices: bible row 119, deliveries book AP directly.
- Making a duplicate invoice number a hard stop (Q1 recommends keeping it a warning).
- Cross-field live checks on other forms (T-440 Q4 stands elsewhere); the AP payment form and DEF-404 (its due date).
- Self-verify for any other document; back-flagging historic self-verified rows (P0216a, informational).
- Reimbursement and recurring-expense forms.

## 9. Question for Ian (one; the build does not wait on it)
**Q1. A repeated invoice number for the same supplier: warn or stop?** (A) Show the warning while typing; Save stays on, as
today after save. (B) Stop the save until the number changes. **Recommend A:** suppliers do reuse numbers across years and
books, and a hard stop would force fake numbers; the warning now arrives before Save instead of after. S1 builds A.

**Note for Ian (not a question):** "admin" in the matrix means every person with the admin role in an org, plus a manager
standing in for an org with no admin. Precheck P0216b lists exactly who that is before deploy.

## Amendments R1-R16 (review 24 Oct). These WIN over any earlier text in this spec.
**S3 (data, trigger, capability)**
- R1 (§5.3 4a) The trigger first requires an ACTIVE `person_roles` row for `NEW.verified_by` in `NEW.org_id`, in every case
  (no role = refused, as `authorize()` refuses). Then: role `admin`/`super_admin`, OR a live `person_grants` row
  `verify_own_supplier_invoice` with no store filter (the capability is org-scoped). The drift test adds "grant, no active role" → refused.
- R2 (§5.3 4a) Also re-judge when the flag is true and `verified_by` or `created_by` changes on UPDATE. Test: a plain UPDATE
  that swaps `created_by`/`verified_by` on a self-verified row to a non-holder is refused.
- R3 (§5.3 4b) "The flag can't be cleared" becomes its OWN trigger `supplier_invoices_self_verified_immutable`, kind
  `history_guard`, mode `always` (registry + `ENABLE ALWAYS`, the 0168 pattern); it decides only from OLD/NEW. The capability
  trigger stays `validator` / `origin`. Test: clearing the flag is refused under `session_replication_role = replica` too.
- R4 (§5.2) The flag comes ONLY from `can(trx, actor, 'verify_own_supplier_invoice')` inside `verifyInvoice`; no form field,
  action input or `markInvoiceVerified` caller argument derived from the request may set it. Test: a POST carrying
  `selfVerified=on` from a non-creator leaves the flag false.
- R5 (§5.4) The badge also shows on the supplier page invoice list (`apps/erp/src/app/ap/suppliers/[id]/page.tsx:47`).
- R6 (§5.3 prechecks) P0216b also lists managers who are already elevated (in an org with no active admin), since they gain
  the capability through the derived set (see Q4).
- R7 (0216 file) First statement `SET LOCAL lock_timeout = '5s';`, last `RESET lock_timeout;` (0194:59 / :777). The new
  self-means-self CHECK is added NOT VALID then VALIDATEd (as §5.3 step 3). `packages/db/schema/suppliers.ts` marks the column
  and both checks `// NOTE: hand-added in 0216`. Number stays 0216 (0215 is reserved by the POS session, T-472).

**S1 / S2 (rule layer)**
- R8 Shared FACT BUILDERS, not only sentences: the leaf exports pure `xxxFacts(rows)` functions (e.g. `supplierFacts(supplier)`,
  `capacityFacts(capacityRow)`, `periodFacts(period)`) that turn repo rows into a check's facts. The page loader AND the
  domain both call them, so both judge identical facts. Test: a domain refusal and the loader verdict agree for the same rows.
- R9 (§4.1) `approvalVerdict` keeps today's first-refusal order exactly: authorize `approve_expense` (approve.ts:73) →
  capacity / pending invoice (:107) → category (:124) → money account (:182) → `transfer_funds` (:198) → cash-request draws
  (`checkDraw`) → routing → period (:295). Test per adjacent pair: a draft failing two checks reports the earlier one.
- R10 Previews never call `authorize()`: page loaders and C4 probes use `can()` / `canAt()` (no denial log rows per page view).
  The real (locked) path is unchanged: `approveExpense` still throws the ORIGINAL `AuthorizationError`, and `verifyInvoice`'s
  rewrap at `ap/index.ts:875` still carries its `userMessage`. Test: one page view by an unauthorized viewer writes no denial row.
- R11 (§3.3) The duplicate lookup response is `{ invoiceDate, totalAmount }[]` only: no `id`.
- R12 (E4) `editExpense` refuses only a CHANGE onto an unmapped category. A draft that already sits on one (recurring drafts
  do: `findings.ts:2050`) can still be edited in particulars, and keeping its category is allowed; P3 still blocks posting it.
  Test both legs (*mutant*: refuse any edit of such a draft).
- R13 (V5) The verify preview sums draws per money account and per cash request ACROSS all drafts, oldest first, as the cascade
  would; the second draft that overdraws is the one named. Test: two drafts that each fit but together overdraw → blocked.
- R14 A refused verify or approve keeps the four ticks and the closed-month override reason and note (refill per T-440 A4 /
  T-389). Test: refused verify reopens with ticks and reason intact.

**S4 (linkage)**
- R15 The modal Save is disabled while pending, and each modal opening carries a one-time idempotency token checked by
  `recordInvoiceInlineAction` (a double submit logs one invoice). An invoice logged in an abandoned modal is a normal pending
  invoice: it shows on /ap and can be voided there; nothing cleans it up.

**Fixes**
- R16 §7 parallel safety: S3 also touches `apps/erp/src/app/ap/lib.ts:44-48` (`listInvoices` passes the new `selfVerified`
  filter), and S2 touches `listOpenInvoicesForPicker` in the same file. Different functions; whichever merges second rebases.
  V1 sentence (table §4): the existing text is kept verbatim, `... so you cannot also verify it. Verification is a second pair of
  eyes — ask a manager who did not enter it, or an admin.` ("Verification is", not "Verifying is").

**Open questions (sent to Ian 24 Oct). S3 builds the recommendation unless he says otherwise.**
- **Q2. Recurring bills the job logs in the template author's name (row 183).** If Ian set up a template, the job's invoice
  has `created_by` = Ian, so the self-verify exemption would let him "verify his own" bill he never saw logged. **Recommend:
  keep row 183's control and exclude job-logged invoices from self-verify** (an invoice referenced by
  `recurring_expense_drafts.supplier_invoice_id` gets the V1 refusal even for a holder). Test both.
- **Q3. May an admin grant this capability to a manager?** **Recommend: no, not grantable.** Admin and super-admin by role
  only; the grant screen does not offer it. The trigger's grant branch stays only to mirror `authorize()` (R1).
- **Q4. Managers already elevated in an org with no admin.** The derived set (§5.1) would hand them the capability.
  **Recommend: no manager gets it.** Exclude it from `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` explicitly, with a pinned test.

## Ian's answers (2026-10-24)
Binding over Q2-Q4 above. Ian's words: "1b 2a 3a". Where this section and the text above differ, this section wins.
- **Q2 = B.** An admin MAY verify an invoice that the recurring-expense job logged in the admin's name. Same flag, same audit.
  This amends bible row 183 for `verify_own_supplier_invoice` only. Such invoices are still flagged "verified by its own
  creator" and audited. S3 must NOT exclude job-logged invoices. Test: an admin who is the template author verifies a
  job-logged invoice: verified, flagged, both audit rows.
- **Q3 = A.** `verify_own_supplier_invoice` is NOT grantable. Admin and super admin only, by role. The grant screen hides it.
  A person grant never confers it: `authorize()` refuses it, and the trigger's grant branch (R1) is dropped, so the trigger
  accepts only the `admin` / `super_admin` roles. Test: a manager holding a person grant of it is refused, both in
  `authorize()` and by the trigger on a flagged verify.
- **Q4 = A.** Stand-in managers do not get it. Remove it explicitly from `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`. Pinned test:
  a manager standing in for an org with no admin is refused it.
- **Knock-on:** P0216b and R6 now only confirm that the people who gain the capability are the active admins and super admins.
