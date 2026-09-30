# T-364: authorise before validating — expenses form (DEF-496) and recordAdjustment (DEF-497)

**Status:** **DONE 2026-09-30 (`61ea2e0`, DEF-496/497 fixed)** — APPROVED 2026-09-30 (orchestrator, after independent Opus review). Spec: Opus planner, 2026-09-30. **Model:** Sonnet, tester then
builder, one slice at a time.
**Migration:** **none.** Both slices change action or domain code only. No table, column, CHECK or policy is touched,
so there is no `classification.ts` or `rls/registry.ts` entry.
**Slices:** 2, disjoint in every path. **S1** = DEF-496 (web action). **S2** = DEF-497 (domain). Either may go first.
**Line numbers** were checked at HEAD `3ed900f`. None of the BUILDER paths is dirty at that HEAD (the dirty files are
`apps/erp/next-env.d.ts` and `docs/tasks/348-*.md`).

## Why

Both are the DEF-478 / T-352 ordering shape: a caller who may not act learns something before being refused.

### DEF-496 (register row DEF-496), verified at source

`apps/erp/src/app/expenses/actions.ts`: `createExpenseAction` (`:194-223`) and `recordExpenseForInvoiceAction`
(`:232-260`) both call `parseExpenseForm` (`:97-180`) BEFORE the domain call that holds the gate
(`createExpense` → `authorize(…'create_expense'…)`, `packages/domain/src/expenses/create.ts:115`).
`parseExpenseForm` does four things ahead of any gate:
1. **Reads a supplier invoice by a posted id** (`:137-143`). A missing one throws
   `Supplier invoice ${id} does not exist.` (`:141`). A real one passes silently. **That is an invoice-id oracle.**
2. **Loads the store's money sources** (`loadMoneyLines`, `:153`): every account, every balance, every open float
   with its holder's name and outstanding amount.
3. **Reads the supplier by a posted id** (`:154-156`).
4. **Judges the lines** (`validateMoneyLines`, `:157-169`) and throws the first issue. Three of those sentences carry
   DATA, not only form feedback (`packages/domain/src/shared/money-lines.ts`):
   - `:382` `` `${source.holderName}'s float holds ${outstanding} — this line asks for more.` `` → a named person's
     float balance, at a store the caller may have no right to.
   - `:408` / `:312-314` `cashOnDeliverySentence(supplierName)` → the NAME of any supplier id, and its terms status.
   - `:351` the amount sentence (form feedback only; still the T-352 defect class).

So a person with no `create_expense` at the store (staff, CAPABILITY-MATRIX `:46`; or a manager of ANOTHER store)
can read float balances and supplier names by hand-posting the form. The register row is **correct**, and
understates it: it names the ordering and the supplier read, not the float-balance and invoice-id disclosures.

### DEF-497 (register row DEF-497), verified at source — ⚠️ the row's line numbers are stale

`packages/domain/src/attendance/adjustments.ts`, `recordAdjustment` (`:105`):
- `:110-111` `getEmployment`, then `throw new AdjustmentError(\`No employment ${input.employmentId}\`)`;
- `:113-116` `authorize(tx, actor, 'manage_attendance', { storeId: employment.storeId, orgId: employment.orgId })`.

The register cites `:81-82` and `:84`. Those were right before T-360 (DEF-488) added `parseShiftDayInput` above
`recordAdjustment`; the substance is unchanged. The orchestrator corrects the line numbers when closing the row.

The oracle is wider than the row says. A non-holder can tell a real id from a fake one in **three** ways, not one:
1. **Fake id** → `No employment <id>` (a raw `AdjustmentError`, not presentable; `errorMessage` renders the stripped
   raw text, `apps/erp/src/lib/constraint-messages.ts:323`).
2. **Real id, role non-holder** (staff) → `authorize`'s `roleMayNot` sentence (`packages/auth/src/authorize.ts:163-177`).
3. **Real id, holder of `manage_attendance` at ANOTHER store** (a manager of store A, or a staff member with a position
   grant elsewhere) → `notAssignedToStore(capability, store)` (`:202-210`) or `jobIsElsewhere(…, here, …)`
   (`:163-176`). **Both NAME the employment's store.** So the probe also reveals WHICH store a person works at.
4. **Real id in another org, no RLS** (a domain caller on the owner connection) → axis 1's `otherOrg` sentence
   (`:117-123`) vs `No employment` for a fake. Under the app's RLS path (`withOrgPrincipal`) the foreign row is
   invisible and both read `No employment`, so this one is domain-layer only (§15.11: RLS must not be the only layer).

Sibling shapes, **not fixed here** (orchestrator logs one new DEF row for them, see Out of scope):
`packages/domain/src/people/index.ts:231-233` (`endEmployment`) and `:277-279` (`setEmploymentPositions`) are the same
lookup-then-authorize oracle on `enrol_staff`.

## Rulings (planner, 2026-09-30)

### S1 — DEF-496

- **R1: the ACTION authorises first, with the domain's own capabilities; the domain gate stays.**
  - Bible §7 rule 1 (`PROJECT_BIBLE.md:991-993`): *"Every server action's first statement is `await authorize(…)`."*
    `parseExpenseForm` is a read surface (an invoice, a store's money sources, a supplier), and row 199's rule is that
    reads are gated on the server, not only mutations.
  - **Why not T-352 R1's mechanism (move the parse into the domain).** There the parse was flat strings the domain
    could own. Here the validation needs `loadMoneyLines` (`apps/erp/src/lib/money-lines/load.ts:94`), an app module
    the domain may not import (RULES §1 rule 13, ADR-004). Moving the loader into a package would refactor a loader
    shared with two page renders (`expenses/new/page.tsx:38`, `ap/invoices/[id]/page.tsx:46`). Disproportionate for an
    ordering fix.
  - **Why this is not T-352's "second source of truth".** The domain's `authorize` is untouched and still decides
    (§15.11: no layer is the only one). The action gate can only be STRICTER than the domain if it names a capability
    the domain does not check. It names exactly the ones the domain checks, in the domain's order, and leg E10 is the
    positive control that proves it does not over-refuse. Precedent: `commissary/discrepancies/actions.ts:36-42`,
    `admin/users/actions.ts:105`.
  - `createExpenseAction` → `authorize(tx, actor, 'create_expense', { storeId })`.
  - `recordExpenseForInvoiceAction` → `create_expense` then `approve_expense`, both `{ storeId }`. The domain requires
    both (`packages/domain/src/ap/index.ts:746-751`: *"Requiring BOTH `create_expense` and `approve_expense`"*), but
    checks `approve_expense` only inside `approveExpense`, AFTER `createExpense` has validated. Checking both up front
    in the action is what makes a create-only holder see the refusal on this form (leg E9).
- **R2: order, and the one check that stays ahead of the gate.**
  - New order in `parseExpenseForm`: `storeId` blank → `Choose a store.` → **the gate** → everything else in TODAY's
    order (`Choose a supplier invoice.` → the invoice lookup → `loadMoneyLines` → the supplier read →
    `validateMoneyLines`).
  - **`Choose a store.` stays ahead of the gate** because the store is the gate's subject: a store-scoped `authorize`
    with no `storeId` can only throw `storeRequired` (`authorize.ts:188-191`), which would replace today's sentence
    for holders too. It reads nothing and reveals nothing (the same shape T-352 kept for `getEmployment`).
  - The line-reading loop (`:119-133`) never throws; the builder may leave it where it is or move it below the gate.
- **R3: every holder sentence is byte-identical**, including the error-redirect URL shape (`returnTo`, `qs`). The
  gate's refusal goes through the SAME `catch` → `redirect(\`${returnTo}?${qs}&error=…\`)` path as today's parse
  failures, so a non-holder's malformed submission and a non-holder's valid submission produce the same URL.
- **R4: one transaction for the gate, opened with `withOrgPrincipal`** (the file's existing helper, `:28`), so RLS is
  armed while `authorize` reads. It is a separate transaction from the domain call, as today's reads already are.
  The race (a grant revoked between the two) is harmless: the domain re-authorises.
- **R5: no raw throw is added.** `parseExpenseForm` already throws `new Error(...)` in an app file; the throw ratchet
  counts `packages/*` directories only. The gate rethrows `authorize`'s own `AuthorizationError`, unchanged.

### S2 — DEF-497

- **R6: one uniform refusal for "not found" and "not yours" — the 404-for-both pattern.**
  - When the employment is not visible (`!employment || employment.orgId !== actor.orgId`), OR `authorize` refuses,
    `recordAdjustment` throws ONE error:
    `new AuthorizationError(<raw>, 'manage_attendance', EMPLOYMENT_OUT_OF_REACH)` with
    `EMPLOYMENT_OUT_OF_REACH = 'That employment does not exist, or it is not at a store where you manage attendance.'`
  - Raw messages keep the diagnosis for logs, never the screen: `recordAdjustment: no employment ${id} in org
    ${actor.orgId}`, or `recordAdjustment: ${err.message}` wrapping the original authorize refusal.
  - **Why collapse, rather than distinguish.** Oracle routes 2 and 3 above both come from `authorize`'s own
    sentences, which name the store (route 3) or differ from the not-found text (route 2). No sentence that names the
    store can be produced for a fake id, so the only uniform answer is one sentence that names neither. It is the
    standard pattern (a private resource answers "not found or not yours" identically).
  - **The cost, stated.** On this one function, staff and scoped-out managers lose `authorize`'s more specific
    sentences (`roleMayNot`, `jobIsElsewhere`, `notAssignedToStore`, `noActiveRole`). The day screen is already gated,
    so a person reaches this refusal only by hand-posting or with a stale page. See Q1 for the alternative.
  - **Why `AuthorizationError`, not `gone()`.** Every existing non-holder assertion on this function expects an
    `AuthorizationError` or only `toThrow()` (`attendance-adjustments.test.ts:264-266`; T-352 W9-W11 and T-360 compare
    against a computed baseline). The class keeps `err.capability === 'manage_attendance'`, and `errorMessage` renders
    its `userMessage` (it is presentable, `constraint-messages.ts:301-303`).
- **R7: order.** `getEmployment` → visibility check → `authorize` (wrapped) → everything after `:117` unchanged
  (T-352's minute parse, T-360's shift-day parse, self-adjudication, frozen, verify). A holder sees exactly today's
  sentences for every field.
- **R8: the org check is explicit.** `getEmployment` (`packages/db/src/repo/employment.ts:214-217`) takes no `orgId`
  and relies on RLS. `employment.orgId !== actor.orgId` is treated as not visible, so the uniform refusal holds on a
  connection without RLS too (§15.11, bible row 181). `authorize` keeps receiving `orgId: employment.orgId`.
- **R9: only `AuthorizationError` is wrapped.** Any other error from `authorize` (a dropped connection) propagates
  unchanged. `AdjustmentError` stays exported and is still used at `:142`, `:160`, `:170`.
- **R10: the ratchet does not rise.** The not-found `throw new AdjustmentError(` at `:111` is removed and nothing
  replaces it with a raw `throw new Error(`. `packages/domain/src/attendance` stays ≤ 1
  (`tests/unit/t343-throw-ratchet.test.ts:69`).

## Slice S1 — DEF-496, the expenses form

### BUILDER
1. `apps/erp/src/app/expenses/actions.ts`:
   - Import `authorize` and `type Actor, type Capability` from `'@shareat/auth'`.
   - `parseExpenseForm` gains a parameter `capabilities: readonly Capability[]`, and `actor` widens to `Actor`
     (`requireActor()` already returns one, `apps/erp/src/lib/session.ts:94-96`).
   - Move `if (!storeId) throw new Error('Choose a store.');` (`:135`) to directly after `storeId` is read (`:102`).
     Directly after it: `await withOrgPrincipal(actor.orgId, async (tx) => { for (const c of capabilities) await
     authorize(tx, actor, c, { storeId }); });`
   - Everything else in `parseExpenseForm` keeps its order and its sentences (R2, R3).
   - `createExpenseAction` passes `['create_expense']`. `recordExpenseForInvoiceAction` passes
     `['create_expense', 'approve_expense']`.
   - Update the `parseExpenseForm` JSDoc (`:91-96`) and the file header (`:3-14`) with one sentence each: the form is
     authorised before any field is judged or any row is read (T-364 / DEF-496, bible §7 rule 1); the domain gate is
     unchanged.

**BUILDER paths (S1):** `apps/erp/src/app/expenses/actions.ts`.
⛔ Not the builder's: `packages/domain/**`, `apps/erp/src/lib/money-lines/**`, `MoneyLines.tsx`, every test file,
`CAPABILITY-MATRIX.md`.

### TESTER
**TESTER paths (S1):** `apps/erp/tests/integration/t364-expense-form-authorise-first.test.ts` (new, integration,
real Postgres, the lane's own `_test` DB with the name guard).
- Harness copied from `t361-cod-credit-web-parity.test.ts:16-170`: `RedirectSignal`, `ACTOR_HOLDER`,
  `SESSION_HOLDER`, the `@/lib/money-lines/load` and `MoneyLines` forwards, `asOrg`, `fixture`, `pendingInvoice`,
  `verifiedInvoice`, `expectRedirectTo`, `errorOf`, `emittedNames`, `expenseCountForInvoice`. Build form data with
  `emittedNames`, never hard-coded field names (P1's shape, `:172-199`).
- The fixture adds:
  - **`staff`**: `person_roles.role='staff'`, `person_store_scope` on the store, and NO position or person grant
    (CAPABILITY-MATRIX `:46,:50`: ✗ for both).
  - **`otherManager`**: role `manager`, scoped to a SECOND store only.
  - **`creator`**: role `staff`, scoped to the store, plus one `person_grants` row `grant_name='create_expense'`
    (store-agnostic; `personHasActiveGrant`, `packages/db/src/repo/access.ts:889-901`). Holds `create_expense`, not
    `approve_expense`.
  - **An open float** at the store: holder display name `Float Holder <uid>`, outstanding ₱100.00. Copy the opening
    from `packages/domain/tests/integration/expenses-staff-float.test.ts` or `t343-s5-5s-followups.test.ts`.
- **Baselines are computed, never hard-coded** (T-351 W1): each non-holder leg compares with the SAME person's `error`
  for the SAME action and a VALID form (cash line from the store's account, a real pending/verified invoice). Every
  leg first asserts that baseline is non-null (T-352 audit F7).
- **"Nothing written"** = `expenseCountForInvoice(invoiceId)` unchanged.
- No existing test file is edited.

### Legs (S1)
Every leg asserts the TARGET (bible row 233). Record each raw red. `BASE(p, action)` = person `p`'s `error` for a valid
form on that action.

| Id | Who · action | Form | Target | Red today |
|---|---|---|---|---|
| E1 | staff · `createExpenseAction` | a float line, amount `500.00` (over the ₱100.00 outstanding) | `error` === `BASE(staff, create)`; ⛔ contains neither `Float Holder` nor `100.00`; nothing written | `Float Holder …'s float holds 100.00 — this line asks for more.` |
| E2 | staff · create | a credit line against the COD supplier, supplierId posted | `error` === BASE; ⛔ no supplier name, no `cash-on-delivery` | `<COD name> is cash-on-delivery. Set payment terms…` |
| E3 | staff · create | amount `1,5` | `error` === BASE; ⛔ no `not a valid amount` | `"1,5" is not a valid amount. Use at most two decimal places.` |
| E4 | staff · create | `supplierId` blank, `supplierInvoiceId` = a fresh random uuid | `error` === BASE | the rendered `Supplier invoice … does not exist.` (record it; the sanitiser may rewrite the uuid) |
| E5 | staff · create, **oracle pair** | `supplierId` blank; (a) a REAL invoice id of the store, (b) a random uuid | `error(a) === error(b)`, both === BASE | (a) ≠ (b) |
| E6 | otherManager · create (cross-store) | E1's float line, `storeId` = the fixture store | `error` === `BASE(otherManager, create)`; ⛔ no `Float Holder` | the float sentence |
| E7 | staff · `recordExpenseForInvoiceAction` | E1's float line, a verified invoice | `error` === `BASE(staff, record)`; ⛔ no `Float Holder` | the float sentence |
| E8 | staff · record | E2's credit line | as E7; ⛔ no supplier name | the COD sentence |
| E9 | **creator · record** (holds create, not approve) | E1's float line | `error` === `BASE(creator, record)`, and BASE is the `approve_expense` refusal (record its text); ⛔ no `Float Holder` | the float sentence (validation runs, `approve_expense` is only checked after it) |
| E10 | **positive control for E9 — creator · create** | E1's float line | `error` === the float sentence, byte for byte (the gate did not over-refuse a holder) | green (guard) |
| E11 | **positive control — admin · create** | E1, E2, E3 and E4's forms, each in turn | the float, COD, amount and invoice-missing sentences exactly as recorded in the red column | green (guard) |
| E12 | **positive control — admin · record** | E1's form, then a valid form | the float sentence; then a redirect to `/expenses/<uuid>` and the expense posted | green (guard) |
| E13 | **order guard (R2)** — staff · create | `storeId` blank | `error` === `Choose a store.` (the one pre-gate check) | green (guard) |
| E14 | **order guard (R2)** — admin · create | `storeId` blank + E3's amount | `Choose a store.` | green (guard) |
| E15 | **oracle pair, holder at ANOTHER store** — otherManager · create, `storeId` = otherManager's OWN store A (so the gate passes) | `supplierId` blank; (a) the fixture store B's REAL invoice id, (b) a random uuid; a valid cash line from store A's account | `error(a) === error(b)`; ⛔ neither names store B's supplier or invoice. Record both texts. If (a) instead SAVES an expense at store A against B's invoice, that is DEF-508 (T-367's): record it, mark E15 `todo` citing DEF-508, and do not fix it here | (a) passes the lookup and reaches validation or the domain, (b) `Supplier invoice … does not exist.` |

**Mutant proofs** (auditor, a throwaway worktree, nothing committed; record each red):
1. Gate moved back below `validateMoneyLines`: E1-E9 red.
2. `approve_expense` dropped from `recordExpenseForInvoiceAction`'s list: E9 red.
3. `approve_expense` added to `createExpenseAction`'s list: E10 red.
4. The gate given `{}` instead of `{ storeId }`: E11-E12 red (`storeRequired` for everyone).
- ⚠️ E15 is NOT closed by S1's gate: otherManager legitimately holds `create_expense` at store A, and the invoice
  lookup (`actions.ts:137-143`) is org-scoped, not store-scoped. E15 records how far the oracle reaches; the fix
  belongs with DEF-508.

**Must stay green UNCHANGED** (record each file's pass count):
`apps/erp/tests/integration/t361-cod-credit-web-parity.test.ts`, `t358-ap-invoice-expense-form.test.ts`,
`t343-s5-5s-followups.test.ts`; every other `apps/erp/tests/integration/*expense*` file;
`apps/erp/tests/t342-no-null-tx-from-actions.test.ts`; `tests/unit/no-client-supplied-actor.test.ts`,
`tests/unit/client-bundle-boundary.test.ts`, `tests/unit/t343-throw-ratchet.test.ts`; the full integration suite
before push (RULES §2).

### §9.4 (S1)
Smoketest on **http://localhost:9008**, per `docs/SMOKETEST.md`:
1. As admin, `/expenses/new`: pick a store and a pending invoice, enter `1,5` as the amount, submit. Screenshot the
   same amount sentence as before.
2. Same form, a valid cash line: it saves and lands on `/expenses/<uuid>`. Screenshot.
3. As admin, `/ap/invoices/<id>` for a verified invoice: record with a valid line. Screenshot the posted expense.
4. A staff session cannot reach the form (the page is gated). Say so, and rely on E1-E9 for the non-holder path.

## Slice S2 — DEF-497, recordAdjustment

### BUILDER
1. `packages/domain/src/attendance/adjustments.ts`:
   - Import `AuthorizationError` from `'@shareat/auth'` beside `authorize` (`:6`).
   - Add module-private `const EMPLOYMENT_OUT_OF_REACH = 'That employment does not exist, or it is not at a store
     where you manage attendance.';` beside `SHIFT_DAY_MISSING` (`:72`), with a comment naming T-364 / DEF-497 and R6.
   - Replace `:110-116` with R6-R9:
     - `const employment = await employmentRepo.getEmployment(tx, input.employmentId);`
     - if `!employment || employment.orgId !== actor.orgId`: `throw new AuthorizationError(\`recordAdjustment: no
       employment ${input.employmentId} in org ${actor.orgId}\`, 'manage_attendance', EMPLOYMENT_OUT_OF_REACH);`
     - `try { await authorize(tx, actor, 'manage_attendance', { storeId: employment.storeId, orgId: employment.orgId }); }
       catch (err) { if (err instanceof AuthorizationError) throw new AuthorizationError(\`recordAdjustment:
       ${err.message}\`, 'manage_attendance', EMPLOYMENT_OUT_OF_REACH); throw err; }`
   - One comment above it: why the two outcomes are one sentence (R6, the oracle routes), and that the lookup stays
     first because it supplies the gate's store.
   - Nothing below the gate moves.

**BUILDER paths (S2):** `packages/domain/src/attendance/adjustments.ts`.
⛔ Not the builder's: `packages/auth/**` (no new auth sentence or helper), `people/index.ts`, `credentials.ts`,
`adjudicate.ts`, `apps/erp/src/app/attendance/**` (the action already renders `errorMessage`), every test file.

### TESTER
**TESTER paths (S2):**
- `packages/domain/tests/integration/t364-adjustment-employment-reach.test.ts` (new, integration). Legs A1-A9.
  Fixture and helpers copied from `attendance-adjustments.test.ts` (`cleanDay`, `makeSession`, `adjust`, `minuteOf`,
  and the staff-cashier shape at `:255-266`). Adds: a second store with its own employment; `otherManager` scoped to
  the second store only; a second org with its own employment.
- `apps/erp/tests/integration/t364-adjustment-reach-web.test.ts` (new, integration). Legs W1-W3. Harness copied from
  `t352-attendance-auth-before-parse.test.ts` (its `dayFormData`, `attendanceFixture`, `expectRedirectTo`, `errorOf`
  and the session mocks), overriding `employmentId` in the form.
- `O` below = `EMPLOYMENT_OUT_OF_REACH`, written as a literal in the test (it is the target, row 233).
- **"Nothing written"** = the live `attendance_adjustments` count for (employment, day, kind) is unchanged
  (`adjustmentCountFor`, `t343-s5-5t-followups.test.ts:145-151`).
- **Fake id** = a fresh random uuid (never all-zeros, so no test depends on a special value).
- No existing test file is edited.

### Legs (S2)

| Id | Who · employmentId | Target | Red today |
|---|---|---|---|
| A1 | **oracle pair, role non-holder**: staff (no grant) · (a) a real employment at the store, (b) a fake id | both reject with `AuthorizationError`, `capability === 'manage_attendance'`, `userMessage === O`; `(a).userMessage === (b).userMessage` | (a) `roleMayNot`, (b) `AdjustmentError` `No employment …` |
| A2 | **oracle pair, scoped-out holder**: otherManager · (a) the real employment at the fixture store, (b) a fake id | as A1; ⛔ `(a).userMessage` does not contain the fixture store's name or code | (a) names the store, (b) `No employment`. ⚠️ The recorded RED for (a) must CONTAIN the exact store name or code the green leg asserts absent; if it does not, the ⛔ assertion is vacuous — STOP and report |
| A3 | **grant elsewhere**: staff with a `person_grants` `manage_attendance` row whose `store_id` = the SECOND store · the fixture store's real employment vs a fake id | as A1; ⛔ no store name | (a) names a store, (b) `No employment`. ⚠️ As A2: the recorded red must contain the exact name/code asserted absent. If this grant shape cannot reach `jobIsElsewhere` (a store-specific `person_grants` row gives `roleMayNot`), record that, DROP the ⛔ store-name assertion from A3, and keep it as a uniformity leg only |
| A4 | **cross-org, owner connection** (no `set role`): admin of org A · org B's real employment vs a fake id | both `userMessage === O` | (a) `otherOrg`, (b) `No employment` |
| A5 | **positive control, the not-found for a holder**: admin of the store · a fake id | rejects `AuthorizationError`, `userMessage === O`; nothing written | `No employment …` |
| A6 | **positive control, the gate still admits**: admin · the real in-store employment, a valid `start_anchor` | saves; returns the adjustment; count +1 | green (guard) |
| A7 | **positive control, a holder still sees field sentences**: admin · real id, `chosenAnchorMinute: ''` | `userMessage` === `The paid-from minute — enter a whole number of minutes (0 to 99999).` (T-352 D8, unchanged) | green (guard) |
| A8 | **positive control, a granted deputy is still admitted**: A3's person with a `person_grants` row at the FIXTURE store (or store-agnostic) · real id | saves (`attendance-adjustments.test.ts:268-277`'s shape) | green (guard) |
| A10 | **R9, optional (cheap)**: `vi.spyOn` on `@shareat/auth`'s `authorize` (or a module mock) throwing `new Error('boom')`, admin · real id | rejects with that SAME `Error` instance (`toBe`), not an `AuthorizationError`, no `userMessage` | green (guard) |
| A9 | **the raw keeps the diagnosis**: A1(b) and A2(a) | `err.message` starts with `recordAdjustment:`; A2(a)'s raw contains authorize's own raw text | (b) `No employment …`; (a) authorize's raw unprefixed |

**Web** (`apps/erp/src/app/attendance/[dayId]/actions.ts`, `setStartAnchorAction` with a valid minute):

| Id | Who · form `employmentId` | Target | Red today |
|---|---|---|---|
| W1 | staff session · (a) the real employment, (b) a fake uuid | `errorOf(a) === errorOf(b) === O` | two different sentences |
| W2 | otherManager session · (a) real at the fixture store, (b) fake | as W1; ⛔ no fixture store name | (a) names the store. ⚠️ The recorded red must contain the exact name/code asserted absent (as A2) |
| W3 | **positive control** · admin · the real employment | redirect with no `error`; the adjustment saved | green (guard) |

**Mutant proofs** (auditor, throwaway worktree; record each red):
1. The visibility branch restored to `throw new AdjustmentError('No employment …')`: A1, A2, A4, A5, W1, W2 red.
2. The `try/catch` around `authorize` removed: A1(a), A2(a), A3, W1, W2 red.
3. `employment.orgId !== actor.orgId` removed: A4 red.
4. The catch widened to rethrow EVERY error as `O`: A10 reds (if A10 was written); otherwise record that R9 is
   guarded only by review.

**Must stay green UNCHANGED** (record each pass count): `packages/domain/tests/integration/attendance-adjustments`,
`attendance-review`, `attendance-adjudication`, `payroll`, `t352-attendance-parse-in-domain`,
`t360-attendance-shiftday-parse`; `apps/erp/tests/integration/t352-attendance-auth-before-parse`,
`t360-attendance-shiftday-web`, `t343-s5-5t-followups`; `tests/unit/t343-throw-ratchet.test.ts`;
`packages/domain/src/attendance/prerequisite-refusal-classification.test.ts` (it scans `credentials.ts` only, so it
must not move); the full integration suite before push.

### §9.4 (S2)
Smoketest on **http://localhost:9008**, signed in as admin:
1. `/attendance/<dayId>`: set a start anchor with a valid minute. Screenshot the saved decision.
2. Same page: in devtools, change the hidden `employmentId` input to a random uuid, submit. Screenshot the `O` banner.
3. Same page: `chosenAnchorMinute` blank. Screenshot the DEF-471 minutes sentence (unchanged).
4. A staff session cannot reach the day screen. Say so, and rely on A1-A3 and W1-W2.

## Out of scope
- **The sibling oracles** `endEmployment` (`people/index.ts:231-233`) and `setEmploymentPositions` (`:277-279`), same
  shape on `enrol_staff`. The orchestrator logs ONE new DEF row for both; the fix is S2's pattern.
- A malformed (non-uuid) `employmentId` reaching Postgres as 22P02. It reveals nothing about any record (every
  malformed id fails identically) and is not an oracle.
- Moving `loadMoneyLines` or `validateMoneyLines` into the domain (R1).
- `recordExpenseForInvoice`'s in-domain order (it checks `approve_expense` after `createExpense` validates). The action
  gate closes it for the only caller; a second caller would need the same up-front check. The orchestrator may log it.
- Any change to `authorize`'s sentences.
- **DEF-508** (logged; owned by T-367): an expense can be recorded at one store against another store's supplier
  invoice. E15 observes it; S1 does not fix it.

## Done when
- S1: E1-E9 go red→green; E10-E14 are green before and after; E15's texts are recorded (green, or `todo` citing
  DEF-508); the four S1 mutant proofs are recorded.
- S2: A1-A5, A9, W1 and W2 go red→green; A6-A8, W3 (and A10 if written) are green before and after; the S2 mutant proofs are recorded.
- The must-stay-green lists pass with no existing test edited; typecheck is clean at READY (the new test files may be
  red only between RED and READY, T-352 M3); `packages/domain/src/attendance` raw throws ≤ 1.
- §9.4 screenshots for both slices are pasted.
- Each builder edited only its slice's BUILDER path.
- **Orchestrator:** DEF-496 and DEF-497 → `fixed (T-364 S1/S2, <commit>)`; correct DEF-497's line numbers
  (`:110-111`, `:113`); log the sibling-oracle row.

## Questions for Ian
**Q1 — RULED (a) by Ian, 2026-09-30 — one uniform sentence.** Build R6 as written. Switching to (b) later is a
change to one function (`recordAdjustment`'s gate block) plus A1-A3's expected sentences; nothing else depends on it.
 When someone who may not manage attendance at a store posts an attendance
decision for an employment there (only possible by hand or from a stale page), what do they see?
- **(a) Default:** one sentence for every case: *"That employment does not exist, or it is not at a store where you
  manage attendance."* Nobody can use the reply to find out who works where.
- **(b)** Keep today's more specific sentences ("staff may not…", "you are not assigned to Store X") for people with
  no attendance right anywhere, and use (a) only for managers of other stores. Friendlier for staff, more code, and it
  still leaks for the rare staff member holding the right at another store.
