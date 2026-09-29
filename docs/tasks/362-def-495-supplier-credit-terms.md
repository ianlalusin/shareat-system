# T-362: supplier credit terms can be set (DEF-495)

**Status:** DONE 2026-09-29 (DEF-495 fixed) — APPROVED 2026-09-29 (orchestrator, after Opus spec audit) with Amendment A1 — builds after T-360. **Model:** Sonnet, tester then builder.
**Migration:** **none** (R6 gives the reasons). No new table, so there is no `classification.ts` or `rls/registry.ts` entry either.
**Order:** this lands **before T-361** (bible §13 row 249). T-361's specs, legs and fixture edits are unchanged by it.
**Line numbers** were checked at HEAD `191d147`. None of the BUILDER paths is dirty at that HEAD. The dirty files are
`apps/erp/next-env.d.ts` and the two untracked T-360 tests, and this task touches none of them.

## Why
DEF-495 (`docs/DEFECTS-REGISTER.md`, the DEF-495 row), verified at source:
- **The column exists.** `suppliers.credit_terms_days` (`packages/db/schema/suppliers.ts:144`) was added by migration
  0141 (`packages/db/migrations/0141_t266_money_lines.sql:42`), with a CHECK at `:47-48`: the value is NULL, or 0 to
  365.
- **Nothing writes it.**
  - `CreateSupplierInput` (`packages/domain/src/ap/index.ts:69-90`) has no terms field. `EditSupplierInput` (`:103-106`)
    extends it and has none either.
  - `apRepo.insertSupplier` (`packages/db/src/repo/ap.ts:79-102`) and `updateSupplier` (`:128-161`) do not name it.
    `SupplierRow` reads it (`:74`).
  - The only writers in the repo are raw SQL in test fixtures (`apps/erp/tests/integration/t358-ap-invoice-expense-form.test.ts:166-170`).
- **The consequence.** Every supplier reads as cash-on-delivery:
  - The Credit option shows "— no terms set" (`apps/erp/src/components/money/MoneyLines.tsx:260`).
  - The expense action refuses credit (`apps/erp/src/app/expenses/actions.ts:163`).
  - Row 247's credit default (`apps/erp/src/app/ap/invoices/[id]/page.tsx:59-62`) never fires.
- **Why it blocks T-361.** Once T-361 enforces the rule in the domain, the recurring-expense job's credit drafts would
  be refused every day (T-361 Q1). Ian chose (a): build terms editing first (row 249).

## The four-step method (bible §1.2d)
1. **What v1 does.** v1 has no credit-terms concept that anything acts on.
   - `paymentOptions` is a free-text list. It is written by `ERP-rebuild/src/app/financial/suppliers/supplier-editor.tsx:28-31,64`
     and printed by one details page (`[id]/supplier-details-client.tsx:370`).
   - `lastCreditDueDays` (`ERP-rebuild/src/types/index.ts:437`) is a "learned" default due date. Its only numeric
     writer is `financial/ap/due-date-modal.tsx:70-74`, which uses `?? 7` at `:47`. **That modal has no importer
     anywhere in v1's `src`** (planner grep, 2026-09-29), so it is dead code. The only live writer sets `null`
     (`lib/financial/commissary/mirror-supplier.ts:71`).
   - v1's only real credit check is "a supplier is selected" (T-266 §5, `docs/tasks/266-money-lines.md:241-243`).
2. **The goal.** Say once, per supplier, whether they extend credit and on what terms. Every money form then offers
   Credit (AP) only where it is real, and pre-selects it where it is the norm (row 247).
3. **The live data.** This is T-188's read-only probe of 129 v1 suppliers (`docs/tasks/188-supplier-master-data.md:60,63,239`):
   - `paymentOptions`: 2 of 129 filled, both `"Cash"`.
   - `lastCreditDueDays`: 4 of 129 (3.1%), all historic.
   - `outstandingBalance`: 52.7% filled, about 68 of 129. That is the **evidence of need**: roughly half of v1's
     suppliers have carried AP.
   - **There is no v1 value to port.** `packages/etl` has no supplier mapping at all (its corpus is expenses and
     sales only). `suppliers` is `keep_shell` (`packages/db/src/cutover/classification.ts:632-643`).
     `credit_terms_days` is not in `clearColumns`, so terms set in v2 survive cutover. That is correct, because
     terms are identity, not activity.
4. **v2's design.** One nullable integer. It is already built and CHECKed (T-266 §5), and it needs a writer, a
   screen and an audit trail. Staff enter terms by hand. About 68 suppliers is a one-sitting job, and no ETL is
   specified.

## Rulings (planner, 2026-09-29)

- **R1: NULL means cash-on-delivery, and 0 to 365 means credit.** This is already the column's contract
  (`suppliers.ts:128-139`, `0141:6-10`), and the domain keeps it exactly.
  - **0 is legal** and means "on credit, due on the invoice date". The CHECK allows it (`0141:47-48`). A domain range
    narrower than the database would be a second definition of one rule.
  - Because 0 is credit, **"no credit" is never typed as a number.** The screen makes the choice explicit (R4), so a
    person cannot type `0` meaning "no credit" and switch credit ON.
  - **The upper bound is 365**, the CHECK's typo guard. The domain refuses 366 or more first, with a sentence; the
    CHECK stays as the backstop (RULES §6.3).
- **R2: the domain parses a RAW value, after `authorize`** (the DEF-478 / T-352 / T-360 shape).
  - `CreateSupplierInput.creditTermsDays?: number | string | null`. `EditSupplierInput` inherits it, and `undefined`
    means "leave it alone" (`:93-102`'s rule).
  - A module-private `parseCreditTermsDays(raw, fn)` in `ap/index.ts` works like this:
    - `null` → `null`.
    - A `number`: accepted when `Number.isInteger(raw) && raw >= 0 && raw <= 365`; otherwise refused as malformed,
      with `String(raw)`.
    - A `string`: trim it to `t`. If `t === ''`, refuse with `TERMS_BLANK`. Otherwise it must match `/^\d+$/` and the
      number must be 0 to 365; if not, refuse with `termsMalformed(t)`.
    - Refusals go through `refuse(\`${fn}: credit terms ${JSON.stringify(t)} …\`, <sentence>)`. They are never raw
      throws: `packages/domain/src/ap` stays at 0 (`tests/unit/t343-throw-ratchet.test.ts:67`).
  - The sentences use the words of the existing refusal, *"Set payment terms on the supplier…"*
    (`packages/domain/src/shared/money-lines.ts:398-400`):
    - `TERMS_BLANK` = `Enter how many days of credit this supplier gives (0 to 365), or choose Cash on delivery.`
    - `termsMalformed(v)` = `` `Payment terms — "${v}" is not a whole number of days from 0 to 365.` ``
  - **Order in `editSupplier`:** `authorize` → the existence check (`gone`) → name → **terms** → the other fields →
    `updateSupplier`.
  - **Order in `createSupplier`:** `authorize` → name → **terms** → `insertSupplier`.
  - The terms parse always follows the name check, so a form that is bad in both places still shows the name
    sentence it shows today.
- **R3: a change is audited, in the table that already exists.** There is no history table.
  - `audit_log` is append-only and org-scoped. Its INSERT policy checks that the actor belongs to the org
    (`0167_t350_audit_log_org_scope.sql:70-77`).
  - The precedent is `setChannelPayoutDestination` (`packages/domain/src/channel-settlements/index.ts:738-757`):
    same transaction, and only on a real change.
  - In `editSupplier`, after `updateSupplier` (`ap/index.ts:202`), and only when
    `parsed !== undefined && parsed !== existing.creditTermsDays`, call
    `auditLogRepo.append(trx, actor.orgId, { actorPersonId: actor.personId, action: 'set_supplier_credit_terms', entity: 'suppliers', entityId: supplier id, before: { creditTermsDays: existing.creditTermsDays }, after: { creditTermsDays: parsed }, source: 'web' })`.
    - `source: 'web'` carries the same comment as the precedent (`:734-737`): the ERP screen is the only caller, and
      a second front-end must thread its own source through.
  - **Create is not audited.** The first audit row's `before` preserves the initial value, and a supplier with no
    audit row still carries its creation value. The history can be rebuilt either way.
  - **Why audit this field.** It decides whether AP credit may be booked against a supplier. It is a control, and
    T-361 turns it into the domain's gate.
- **R4: the screen offers an explicit choice, not a bare number box.** This is familiar (T-188's form, reused) but
  upgraded (R1's 0-vs-no-credit trap is closed).
  - The form has a `<select name="termsMode">` with two options:
    - `cod`: "Cash on delivery (no credit)"
    - `credit`: "On credit (AP)"
  - It also has `<input type="number" name="creditTermsDays" min="0" max="365" step="1">`, labelled "Days to pay".
  - It is plain server-rendered HTML, with no client JS. The page is a server component today.
  - **The action judges nothing. It only maps the fields:**
    - `termsMode` absent → `undefined` (the form did not render it, the same idea as `issuesOfficialReceiptPresent`,
      `actions.ts:39-45`);
    - `'cod'` → `null`, so a leftover days value is ignored;
    - `'credit'` → the raw `creditTermsDays` string;
    - any other value → that raw string, which the domain then refuses as malformed. An unknown mode is never
      silently read as COD.
  - **The hint promises only what is true today.** Cash on delivery means Credit (AP) cannot be used. On credit means
    Credit is allowed, and is pre-selected when a bill is recorded against a verified invoice.
    - ⛔ It does NOT promise a due date. T-266 §5's "`invoice_date + N` pre-fills the due date" was never built.
      `recordInvoice` takes `dueDate: input.dueDate ?? null` (`ap/index.ts:336`). See Out of scope.
- **R5: the gate is `approve_supplier`, unchanged.** No new capability, and no matrix edit.
  - The gate is: super ✅ admin ✅ manager ✅ staff ✗ (`docs/decisions/CAPABILITY-MATRIX.md:99`;
    `packages/auth/src/capabilities.ts:831`).
  - T-188's reason holds (`ap/index.ts:150-154`). A field-specific stronger gate would sit beside a bank account
    number, which is the riskier field and is edited under the same gate. ⚠️ Ian may rule otherwise (Q1).
- **R6: no migration.**
  - The column exists (`0141:42`), and so does the CHECK (`0141:47-48`).
  - `audit_log` and its policies exist (0167).
  - The Drizzle schema does not mirror the CHECK (`suppliers.ts:174-189` lists four others). That is a pre-existing
    doc gap, not a database gap. Adding a `check()` to the schema is **out of scope** here: it is a schema-file edit
    with no SQL, and ADR-012 §5 reserves schema edits for migration tasks. The orchestrator logs it.
- **R7: ETL.** No mapping, because v1 has no value to map (method step 3). Nothing in `packages/etl` changes.

## BUILDER items
1. **B1. `packages/db/src/repo/ap.ts`.**
   - `insertSupplier` input (`:81-98`): add `creditTermsDays?: number | null;` under a `// ---- T-362` marker.
   - `updateSupplier` values (`:132-151`): add `creditTermsDays: number | null;`.
   - There is no other change. The column is already selected by `getSupplierById` and `listSuppliers`.
2. **B2. `packages/domain/src/ap/index.ts`.**
   - Add `auditLogRepo` to the `@shareat/db` import (`:31-39`).
   - `CreateSupplierInput` (`:69-90`): add `creditTermsDays?: number | string | null`, with a JSDoc covering R1, and
     noting that the value is raw and parsed after `authorize` (R2).
   - Add `parseCreditTermsDays`, `TERMS_BLANK` and `termsMalformed` beside `orNull` (`:108-112`), per R2.
   - `createSupplier` (`:114-143`): parse after the name check (`:122`), and pass `creditTermsDays: parsed ?? null` to
     `insertSupplier`.
   - `editSupplier` (`:161-206`):
     - parse after the name block (`:176-179`), when `input.creditTermsDays !== undefined`;
     - set `values.creditTermsDays`;
     - after `updateSupplier` (`:202`), append the R3 audit row, only on a change.
   - Add one sentence to the `editSupplier` JSDoc (`:145-160`) naming T-362 and the audit.
3. **B3. `apps/erp/src/app/ap/actions.ts`.**
   - In `supplierFieldsFrom` (`:46-61`), add `creditTermsDays: creditTermsFrom(fd)`, with R4's mapping in a small
     module-private helper.
   - Its comment says the value is passed raw and judged in the domain after `authorize` (T-362 / DEF-495).
   - No other change: both actions already spread `supplierFieldsFrom` (`:84`, `:103`).
4. **B4. `apps/erp/src/app/ap/suppliers/[id]/page.tsx`.**
   - Between the Official Receipt label (ends `:144`) and the "Where payment goes" fieldset (`:146`), add a fieldset
     with the legend **"Payment terms"**.
   - It holds R4's select, whose `defaultValue` is `supplier.creditTermsDays === null ? 'cod' : 'credit'`.
   - It holds the days input, whose `defaultValue` is `supplier.creditTermsDays ?? ''`.
   - It carries R4's hint.
   - Reuse the page's `INPUT` class and its label markup (`:98-106`).
5. **B5. `apps/erp/src/app/ap/page.tsx`.**
   - In the create form (`:108-119`), before the submit button, add a `Field label="Payment terms"` with the select
     (`defaultValue="cod"`) and a `Field label="Days to pay" hint="Only for On credit. 0 to 365."`.
6. **B6. `apps/erp/src/app/ap/suppliers/page.tsx`.**
   - Add a **Terms** column after **OR** (header `:104-111`, cell after `:136-139`). It shows `Cash on delivery` when
     null, and `` `${n} days` `` otherwise.
   - Widen `min-w-[52rem]` if the table needs it.

**BUILDER paths:** `packages/db/src/repo/ap.ts`, `packages/domain/src/ap/index.ts`, `apps/erp/src/app/ap/actions.ts`,
`apps/erp/src/app/ap/suppliers/[id]/page.tsx`, `apps/erp/src/app/ap/suppliers/page.tsx`, `apps/erp/src/app/ap/page.tsx`.

⛔ **Off limits to the builder:**
- `packages/db/schema/**` and `packages/db/migrations/**` (R6).
- `packages/etl/**` (R7).
- `money-lines.ts`, `MoneyLines.tsx`, `expenses/**` and `recurring-expenses/**`, which are T-361's.
- `CAPABILITY-MATRIX.md` and `capabilities.ts` (R5).
- Every test file.
- If a BUILDER path is dirty from another lane at build time, STOP and report it.

## TESTER paths (disjoint from BUILDER)
- `packages/domain/tests/integration/t362-supplier-credit-terms.test.ts` (new, **integration**, real Postgres). Legs
  D1-D16.
  - Harness and fixture are copied from `supplier-master.test.ts:15-80`: the `_test` guard, `asOrg`, and
    `fixture()` with a manager and a staff member.
  - It adds an admin person for the R5 ✅ leg.
- `apps/erp/tests/integration/t362-supplier-terms-web.test.ts` (new, **integration**). Legs W1-W13.
  - The harness is copied from `t358-ap-invoice-expense-form.test.ts:23-72`: `RedirectSignal`, `ACTOR_HOLDER`,
    `SESSION_HOLDER`, the `@/lib/constraint-messages` forward, and the `Page` stub.
  - Also copied: `fixture`, `fund`, `receiptFile`, the `verifiedInvoice` helper (`:113-190`),
    `renderInvoicePage` (`:253-259`) and `expectRedirectTo` (`:353-361`).
  - Page renders use `renderToStaticMarkup`, the same as `renderInvoicePage`.
- `TEST_DATABASE_URL` points at **the lane's own `_test` DB**, with the name guard (RULES §2).
- **No existing test file is edited.**
- **"Nothing written"** means:
  - `credit_terms_days` equals its value before the call;
  - `select count(*) from audit_log where entity='suppliers' and entity_id=<id>` is unchanged;
  - for a create, no `suppliers` row with that name exists.
- **Baselines are never hard-coded.** A non-holder's refusal is compared with the same non-holder's refusal for the
  same call with a VALID value (T-351 W1 precedent).
- ⚠️ **Typecheck may be red ONLY in the tester's two new files, between RED and READY.** The typed legs pass
  `creditTermsDays`, which is not on today's input type (T-352 M3).

## Legs
Every leg asserts the TARGET. Record the raw red for each one.
- `B` means `TERMS_BLANK`.
- `M(v)` means `termsMalformed(v)`.
- `AUD(id)` means the audit rows for supplier `id`.

**Domain-direct** (manager unless stated):

| Id | Call | Target | Red today |
|---|---|---|---|
| D1 | `createSupplier`, `creditTermsDays: 30` | row has 30 | stored `null` (the key is ignored) |
| D2 | `createSupplier`, no key; and `creditTermsDays: null` | both rows `null` | green (guard) |
| D3 | `editSupplier` on a COD supplier, `creditTermsDays: 30` | row 30; exactly 1 `AUD` row: action `set_supplier_credit_terms`, entity `suppliers`, before `{creditTermsDays:null}`, after `{creditTermsDays:30}`, actor = manager, source `web` | stays null; 0 audit rows |
| D4 | `editSupplier` on a 30-day supplier (set by SQL), `creditTermsDays: null` | row null; 1 `AUD` row, before 30, after null | stays 30 |
| D5 | **positive control for "audit only on change."** 30-day supplier, `creditTermsDays: 30` | row 30; **0** `AUD` rows | green (guard) |
| D6 | **positive control for "absent means untouched."** 30-day supplier, `{ name: 'Renamed' }` only | row 30; name changed; 0 `AUD` rows | green (guard) |
| D7 | `creditTermsDays: ' 45 '` (raw string) | row 45 | stays null |
| D8 | `creditTermsDays: 0` | row **0**, not null (R1: 0 is credit) | stays null |
| D9 | `creditTermsDays: 365` | row 365 | stays null |
| D10 | refusals, each on a fresh COD supplier: `366`, `-1`, `30.5`, `Number.NaN`, `'abc'`, `'-5'`, `'1e2'`, `'366'` | each rejects with `userMessage` = `M(<value as given, trimmed>)`; nothing written | each resolves; nothing changes, so the absence of a sentence is the red |
| D11 | `creditTermsDays: '   '` | rejects with `B`; nothing written | resolves |
| D12 | **ordering: staff non-holder** (`approve_supplier` ✗), `editSupplier`, `creditTermsDays: 'abc'` | the message equals the same staff member's message for `creditTermsDays: 30`; ⛔ no "Payment terms"; nothing written | green (guard); stays green |
| D13 | **✗ fires (R5):** staff, `editSupplier`, `creditTermsDays: 30` | `AuthorizationError`; nothing written; 0 `AUD` rows | green (guard) |
| D14 | **✗ fires on create:** staff, `createSupplier`, `creditTermsDays: 30` | `AuthorizationError`; no supplier row | green (guard) |
| D15 | **✅ for admin:** admin, `editSupplier`, `creditTermsDays: 15` | row 15; 1 `AUD` row with actor = admin | stays null |
| D16 | **order guard (R2):** manager, `{ name: '   ', creditTermsDays: 'abc' }` | the name sentence (`A supplier needs a name…`), not `M('abc')`; nothing written | green (guard) |

**Database backstop:** raw `update suppliers set credit_terms_days = 366` raises SQLSTATE 23514 on
`suppliers_credit_terms_days_check`. This is a guard, green today, and it proves R1's upper bound is the database's
too.

**Compile pin** (in the domain test file, never called):
- `createSupplier(null, a, { name: 'x', creditTermsDays: '30' })` compiles.
- A `@ts-expect-error` on `creditTermsDays: true`.
- Red today: the first does not compile.

**Web** (`apps/erp/src/app/ap/actions.ts`, admin unless stated):

| Id | Action | Fields | Target | Red today |
|---|---|---|---|---|
| W1 | `editSupplierAction` on a COD supplier | the full edit form + `termsMode=credit`, `creditTermsDays=30` | redirect `ok=Supplier updated.`; row 30; 1 `AUD` row | row null |
| W2 | `editSupplierAction` on a 30-day supplier | `termsMode=cod`, `creditTermsDays=30` (a leftover) | row null (the leftover is ignored) | row 30 |
| W3 | `editSupplierAction` on a 30-day supplier | the full edit form **without** `termsMode` | row 30 (absent means untouched) | green (guard) |
| W4 | `editSupplierAction` | `termsMode=credit`, `creditTermsDays=` | redirect `error` = `B`; nothing written | `ok` |
| W5 | `editSupplierAction` | `termsMode=credit`, `creditTermsDays=400` | `error` = `M('400')`; nothing written | `ok` |
| W6 | `editSupplierAction` | `termsMode=bogus` | `error` = `M('bogus')`; nothing written | `ok` |
| W7 | **ordering: staff** | `termsMode=credit`, `creditTermsDays=abc` | `error` equals the same staff member's `error` for `creditTermsDays=30`; ⛔ no "Payment terms" | green (guard) |
| W8 | `createSupplierAction` | `name`, `termsMode=credit`, `creditTermsDays=15` | redirect to `/ap` with `ok`; new row has 15 | row null |
| W9 | `createSupplierAction` | `name` only | new row null | green (guard) |
| W10 | **row 249's purpose, end to end:** W1 on the supplier, then `renderInvoicePage` for its verified invoice | line 0 is credit, pre-selected, amount = remaining (t358 C1 assertions, `:316-332`) | line 0 is cash (the COD render) |
| W11 | the same supplier after W1: `recordExpenseForInvoiceAction` with a credit line (t358 `:428` shape) | redirects to `/expenses/<uuid>`; posted; one credit payment | `error` = the "…is cash-on-delivery…" sentence |
| W12 | **render:** `/ap/suppliers/[id]` page for a 30-day supplier and for a COD supplier | 30-day: `termsMode` has `credit` selected and `creditTermsDays` value 30. COD: `cod` selected and days empty | both names are absent |
| W13 | **render:** `/ap/suppliers` list with one supplier of each kind | a `Terms` header; cells `30 days` and `Cash on delivery` | absent |

**Proving the ordering and audit legs are not vacuous.** At READY the auditor makes throwaway mutants in a worktree
and records the reds. Nothing about the mutants is committed.
1. The terms parse moved above `authorize` in `editSupplier`: D12 and W7 must go red.
2. The audit append removed: D3, D4, D15 and W1 must go red.
3. The audit made unconditional: D5 must go red.
4. The parse moved above the name check: D16 must go red.

**Must stay green UNCHANGED.** Record each file's pass count in the TESTER report:
- `packages/domain/tests/integration/`: `supplier-master`, `ap`, `supplier-returns`, `t350-channel-payout-change`
  (the other `audit_log` writer), and the `t350-s3`…`t350-s6` domain files that read `audit_log`;
- `apps/erp/tests/integration/t358-ap-invoice-expense-form.test.ts`;
- `apps/erp/tests/t343-s1-action-guard.test.ts` (it mocks `editSupplier`/`createSupplier`);
- `packages/domain/tests/unit/money-lines.test.ts`;
- `tests/unit/t343-throw-ratchet.test.ts`, `tests/unit/production-caller-ratchet.test.ts` and
  `tests/unit/capability-matrix.test.ts`;
- the full integration suite before push (RULES §2).
- ⚠️ If T-361 is running concurrently, a ratchet red may belong to the other lane (T-360 A1 note).

## §9.4
Smoketest on **9008**, per `docs/SMOKETEST.md`, signed in as admin:
1. `/ap`: record a supplier with "On credit (AP)" and 30 days. Screenshot the `/ap/suppliers` list showing
   `30 days`.
2. `/ap/suppliers/<id>` for a COD supplier: open "Edit this supplier" and screenshot the "Payment terms" fieldset
   showing Cash on delivery.
   - Set On credit with days left blank, and screenshot the `B` banner.
   - Set 30 and screenshot `Supplier updated.`.
3. Log and verify an invoice for that supplier. On `/ap/invoices/<id>`, screenshot the expense form with **Credit
   pre-selected** and the remaining amount filled in. That is row 247 firing for the first time in a real render.
4. Set the supplier back to Cash on delivery. Reload the invoice page and screenshot Credit showing "— no terms set".
5. On the lane DB, paste
   `select action, before, after, source from audit_log where entity='suppliers' and entity_id='<id>' order by occurred_at`,
   which should show 2 rows.
- A staff session is refused at the page before the form. Rely on D12, D13 and W7 for the ordering and the ✗, and
  say so.

## Out of scope
- **A due-date default from terms.** T-266 §5 promised "`invoice_date + N` pre-fills the due date", and it was never
  built (`ap/index.ts:336`). The orchestrator logs it as a new DEF row.
- **Auditing the other supplier fields.** `editSupplier` rewrites the bank account number (`:194-201`), and a bank
  account decides where money goes, yet it is written with no `audit_log` row. The orchestrator logs this as a new
  DEF row. It is the same R3 pattern and its own small task.
- The Drizzle schema not mirroring `suppliers_credit_terms_days_check` (R6). The orchestrator logs it.
- Any bulk or ETL backfill of terms (R7). About 68 suppliers are set by hand.
- T-361's domain rule, the recurring job's no-account credit default, and `MoneyLines`.
- The stale comment at `t358-ap-invoice-expense-form.test.ts:166-169` ("No domain entry point sets
  credit_terms_days"). It is a test file, and T-361's fixture edits may replace the raw SQL with `editSupplier`.

## Done when
- D1, D3, D4, D7-D11, D15, W1, W2, W4-W6 and W8-W13, plus the compile pin, go red→green.
- D2, D5, D6, D12-D14, D16, W3, W7, W9 and the database backstop are green before and after.
- The four mutant proofs are recorded.
- The must-stay-green list passes with no existing test edited.
- Typecheck is clean at READY, and `packages/domain/src/ap` has 0 raw throws.
- §9.4 screenshots and the audit query output are pasted.
- The builder edited only the BUILDER paths.
- **Orchestrator:**
  - DEF-495 → `fixed (T-362, <commit>)`.
  - Log the three out-of-scope findings as new rows.
  - Add a GLOSSARY entry: "payment terms / cash-on-delivery = `suppliers.credit_terms_days` NULL; 0 = credit, due on
    the invoice date".
  - Unblock T-361.

## Questions for Ian
> **Answered — Ian, 2026-09-29 (bible §13 row 250):** *"managers and admins is fine"* — terms are gated by `approve_supplier` (super/admin/manager ✅, staff ✗), as written. No new capability.
**Q1 (does not block the build; the default is written above).** Who may change a supplier's payment terms? The
spec keeps the gate that already covers editing a supplier, including its bank account: **admins and managers**
(`approve_supplier`). After T-361, terms decide whether a manager may book a bill on credit against that supplier.
- **(a) Default:** managers and admins, the same as every other supplier field.
- **(b)** Admins only for terms. This needs a new capability and a matrix row, and it would then be stricter than
  the bank account.

## Amendment A1 — spec audit (2026-09-29, orchestrator; auditor findings adopted; overrides the text above where they differ)
1. **Mutant 5:** the `input.creditTermsDays !== undefined` guard in `editSupplier` (B2) — make the parse run
   unconditionally; **D6 and W3 must red** (an unrelated supplier edit must never null the terms).
2. **0-day credit is exercised, not just stored.** (a) New render leg: a supplier with terms 0 → Credit offered and
   pre-selected, not "— no terms set". (b) B6's Terms cell uses `creditTermsDays === null` for "Cash on delivery"
   (never truthiness); W13 gains a third row with 0 days that must read as credit, 0 days. (c) `MoneyLines.tsx:334-335`
   renders "On account — 0 day terms" — out of this builder's scope; logged as DEF-501.
3. **Row 247 is not firing "for the first time":** `t358:316-332` already proves the default against SQL-set terms.
   What T-362 makes new is that a PERSON can set the terms that trigger it. Read l.246 and §9.4 step 3 that way; the
   smoketester expects the existing default to appear for a supplier whose terms were set on the new screen.
4. **W10 arranges its own terms** (no dependency on W1 having run).
