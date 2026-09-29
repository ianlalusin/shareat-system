# T-365: audit every supplier bank-account change (DEF-498) and never wipe unsent supplier fields (DEF-506)

**Status:** APPROVED 2026-09-30 (orchestrator, after independent Opus review). Spec: Opus planner, 2026-09-30. **Model:** Sonnet, tester then
builder.
**Migration:** **none.** `audit_log` and its policies exist (0167); `suppliers.bank_name`, `bank_account_name` and
`bank_account_number` exist (`packages/db/schema/suppliers.ts:156-158`). No new table, so no `classification.ts` or
`rls/registry.ts` entry.
**Slices:** 2, in one lane, S1 then S2. **S1** = DEF-498 (the audit row). **S2** = DEF-506 (the edit action
clears fields its form did not send).
**Line numbers** were checked at HEAD `3ed900f`. The BUILDER path is not dirty at that HEAD. T-364 touches no path
here; the two may run in parallel lanes on separate lane DBs.

## Why
DEF-498 (register row DEF-498), verified at source. The row is **correct**.
- `editSupplier` (`packages/domain/src/ap/index.ts:223-291`) writes the three bank fields at `:262-268`, then
  `apRepo.updateSupplier` (`:270`). The only `audit_log` append in the function is T-362's, and it fires only when
  `creditTermsDays` changes (`:275-287`).
- So a change to where supplier payments go leaves no record of who made it, when, or what the account was before.
  The old number is simply overwritten. A redirected payee cannot be traced.
- The function's own JSDoc names the stakes (`:211-214`): *"A name and a bank account number are the two fields that
  decide where money goes."*
- Bible §7 rule 7 (`PROJECT_BIBLE.md:1011-1012`): *"Every mutation writes an audit row: actor, action, entity,
  before/after, timestamp, source."* Row 238 applied it to a channel's payout account (the same "where money goes"
  fact) and T-362 R3 to supplier credit terms.
- **Writers census** (grep of `bank_account|bankAccount` over `packages/{db,domain,etl}/src`, `apps/erp/src`,
  `scripts`): `createSupplier` (`:194-196`), `editSupplier` (`:262-268`), `apRepo.insertSupplier` / `updateSupplier`
  (`packages/db/src/repo/ap.ts:95-97`, `:150-152`). No ETL mapping, no script, no other service. `editSupplier`'s only
  web caller is `editSupplierAction` via `supplierFieldsFrom` (`apps/erp/src/app/ap/actions.ts:47-63`).

## Rulings (planner, 2026-09-30)

- **R1: one audit row per edit that changes the payee, in the table that exists.**
  - `auditLogRepo.append(trx, actor.orgId, { actorPersonId: actor.personId, action: 'set_supplier_bank_account',
    entity: 'suppliers', entityId: input.supplierId, before, after, source: 'web' })`.
  - `before` and `after` each carry the FULL triple `{ bankName, bankAccountName, bankAccountNumber }`, even when only
    one field changed. A row then reads on its own: "paid to X at bank Y, now paid to Z". `before` is the stored row
    (`existing`); `after` is what was written, with untouched fields carried from `existing`.
  - Same transaction, after `updateSupplier`, and after T-362's terms append (so an edit changing both writes the
    terms row first, then the bank row). Precedent: `setChannelPayoutDestination`
    (`packages/domain/src/channel-settlements/index.ts:738-757`).
  - `source: 'web'`, with the precedent's comment: the ERP screen is the only caller; a second front-end threads its
    own source.
- **R2: only on a real change, judged on the WRITTEN value.**
  - The comparison is the normalised value `editSupplier` writes (`orNull(...) ?? null`, `:132-135`) against
    `existing`, per field, for the keys present on `input`. So `' 1234 '` over a stored `'1234'` is no change, and
    `''` over a stored value is a change to `null` (a clear is audited).
  - Absent keys (`undefined`) never count as a change: a name-only edit writes no bank row.
  - Why this matters on the web path: the edit form always posts all three fields (`suppliers/[id]/page.tsx:183-185`,
    and `supplierFieldsFrom` maps them unconditionally), so an unconditional append would log a row on every save.
- **R3: full values, not masked.** The point of the row is to trace a redirected payment, which needs the old and new
  numbers exactly. It widens nothing: `audit_log`'s read policy is org-scoped (`0167:65-66`), the same readers who can
  already read `suppliers.bank_account_number`. No screen reads supplier audit rows today.
- **R4: create is not audited** (T-362 R3's rule, kept for consistency). A new supplier's bank details carry
  `suppliers.created_by`; the first edit's `before` preserves the initial values.
- **R5: the gate is unchanged**, `approve_supplier` (bible row 250: managers and admins, the gate that already covers
  the bank account). No capability or matrix edit.
- **R6: the ordering is unchanged.** `authorize` → `gone` → name → terms → other fields → `updateSupplier` → terms
  audit → **bank audit**. A refusal anywhere earlier writes nothing, because it is one transaction.
- **R7: no raw throw.** The change adds none; `packages/domain/src/ap` stays at 0
  (`tests/unit/t343-throw-ratchet.test.ts:67`).

## Slice S1 — DEF-498

## BUILDER (S1)
1. `packages/domain/src/ap/index.ts`, `editSupplier` only:
   - Before `updateSupplier` (`:270`), compute the three normalised values for the present keys (reuse the values
     already placed on `values` at `:262-268`; do not normalise twice differently).
   - Build `before = { bankName: existing.bankName, bankAccountName: existing.bankAccountName, bankAccountNumber:
     existing.bankAccountNumber }` and `after` = `before` overlaid with the present, normalised keys.
   - After T-362's append (`:275-287`), append R1's row only when any of the three differs between `before` and
     `after` (R2).
   - Extend the JSDoc (`:220-221`) with one sentence: a real change to the bank fields is audited too (T-365 /
     DEF-498), same transaction, full before/after triple.

**BUILDER paths (S1):** `packages/domain/src/ap/index.ts`.
⛔ Not the builder's: `packages/db/**` (the repo already exposes `existing`'s bank fields, `ap.ts:69-71`, and
`auditLogRepo.append`), `apps/erp/**` (S1 changes no screen or action; S2 owns `ap/actions.ts`), `createSupplier`, `CAPABILITY-MATRIX.md`, every test file.
If the path is dirty from another lane at build time, STOP and report it.

## TESTER (S1)
**TESTER paths (S1, disjoint from BUILDER):**
- `packages/domain/tests/integration/t365-supplier-bank-audit.test.ts` (new, integration, real Postgres). Legs D1-D13.
  Harness and fixture copied from `t362-supplier-credit-terms.test.ts:20-90` (the `_test` guard, `asOrg`, `fixture`
  with manager, staff and admin, `creditTermsOf`).
- `apps/erp/tests/integration/t365-supplier-bank-audit-web.test.ts` (new, integration). Legs W1-W4. Harness copied from
  `t362-supplier-terms-web.test.ts:14-200` (`RedirectSignal`, `ACTOR_HOLDER`, `SESSION_HOLDER`, `fixture`,
  `expectRedirectTo`, `editFormData`).
- `TEST_DATABASE_URL` is the lane's own `_test` DB, with the name guard (RULES §2).
- `BANK(id)` = `select before, after, actor_person_id, source, action from audit_log where entity='suppliers' and
  entity_id=<id> and action='set_supplier_bank_account' order by occurred_at`.
- **"Nothing written"** = the three bank columns equal their values before the call, and `BANK(id)` is unchanged.
- A supplier "with bank" is set up by `editSupplier` as admin, THEN the baseline `BANK(id)` count is read (after
  T-365 that setup itself writes one row; legs compare against the count after setup, never an absolute zero).
- ⚠️ **Web forms post the FULL edit form**, all three bank fields included. `supplierFieldsFrom` maps an absent bank
  field to `null` (`actions.ts:47,58-60`), i.e. a clear. `editFormData` alone sends only `supplierId` and `name`.
- No existing test file is edited.

## Legs
Every leg asserts the TARGET (bible row 233). Record each raw red. Manager unless stated. `T(n, an, no)` =
`{ bankName: n, bankAccountName: an, bankAccountNumber: no }`.

**Domain-direct:**

| Id | Call | Target | Red today |
|---|---|---|---|
| D1 | supplier with bank `T('BDO','Acme Inc','1111')`; `editSupplier { bankAccountNumber: '2222' }` | row updated; `BANK` +1: `before` `T('BDO','Acme Inc','1111')`, `after` `T('BDO','Acme Inc','2222')`, `actor_person_id` = manager, `source` `web` | 0 rows |
| D2 | supplier with no bank; all three set | +1: `before` `T(null,null,null)`, `after` the three | 0 rows |
| D3 | supplier with bank; `bankAccountNumber: ''` | column null; +1, `after.bankAccountNumber` null, other two carried | 0 rows |
| D4 | **positive control, "only on change"**: with bank; the same three values | `BANK` unchanged | green (guard) |
| D5 | **normalisation**: with bank `'1111'`; `bankAccountNumber: ' 1111 '` | column `'1111'`; `BANK` unchanged | green (guard) |
| D6 | **absent keys**: with bank; `{ name: 'Renamed' }` only | name changed; bank untouched; `BANK` unchanged | green (guard) |
| D7 | **both controls in one edit**: with bank, COD; `{ creditTermsDays: 30, bankAccountNumber: '2222' }` | exactly one new `set_supplier_credit_terms` row and one new `BANK` row | only the terms row |
| D8 | **T-362 unaffected**: with bank; `{ creditTermsDays: 30 }` | one terms row; `BANK` unchanged | green (guard) |
| D9 | **✗ fires**: staff; `{ bankAccountNumber: '9999' }` | `AuthorizationError`; nothing written | green (guard) |
| D10 | **✅ admin**: admin; `{ bankAccountNumber: '3333' }` | +1 with `actor_person_id` = admin | 0 rows |
| D11 | **atomic**: `{ name: '   ', bankAccountNumber: '4444' }` | the name sentence; nothing written | green (guard) |
| D12 | **create not audited (R4)**: `createSupplier` with all three bank fields | `BANK` = 0 for the new id | green (guard) |
| D13 | **the chain**: two edits `'2222'` then `'3333'` | 2 rows; row 2's `before.bankAccountNumber` = row 1's `after` (`'2222'`) | 0 rows |

**Web** (`editSupplierAction`, admin unless stated; full edit form each time):

| Id | Form | Target | Red today |
|---|---|---|---|
| W1 | with bank; account number changed to `2222` | redirect `ok=Supplier updated.`; +1 `BANK` row, `after.bankAccountNumber` `'2222'` | 0 rows |
| W2 | **positive control**: with bank; the form re-posted with its current values | `ok`; `BANK` unchanged (the always-posted fields do not log a no-op) | green (guard) |
| W3 | with bank; account number blank | +1, `after.bankAccountNumber` null | 0 rows |
| W4 | staff session; account number changed | refused; nothing written | green (guard) |

**Mutant proofs** (auditor, throwaway worktree, nothing committed; record each red):
1. The append removed: D1-D3, D7, D10, D13, W1, W3 red.
2. The append made unconditional: D4-D6, D8, W2 red.
3. Compared on the raw input instead of the written value: D5 red.
4. `before` taken from `input` instead of `existing`: D1 and D13 red.

**Must stay green UNCHANGED** (record each pass count):
- `packages/domain/tests/integration/t362-supplier-credit-terms.test.ts` and
  `apps/erp/tests/integration/t362-supplier-terms-web.test.ts`. ⚠️ Their audit counts filter by `entity` and
  `entity_id`, not `action` (e.g. web `auditCountFor`, `:151-155`). They stay green only because their suppliers carry
  no bank data. If one reds, STOP and report which leg; do not edit it.
- Every t362 web leg built on `editFormData` (`t362-supplier-terms-web.test.ts:181-187`, which sends only `supplierId`
  and `name`) is EXPECTED to stay green through S1 and S2: its suppliers carry no bank data, so S1 adds no row, and S2
  only stops those legs from nulling fields that were already null. A changed audit count there is a defect to
  report, not an expected shift.
- `supplier-master`, `ap`, `supplier-returns`, `t350-channel-payout-change` and the `t350-s3`…`t350-s6` files that
  read `audit_log`; `apps/erp/tests/t343-s1-action-guard.test.ts`; `tests/unit/t343-throw-ratchet.test.ts`; the full
  integration suite before push.

## §9.4
Smoketest on **http://localhost:9008**, per `docs/SMOKETEST.md`, signed in as admin:
1. `/ap/suppliers/<id>` → "Edit this supplier": change the account number, save. Screenshot `Supplier updated.`.
2. Save again without changing anything. Screenshot.
3. On the lane DB, paste the output of
   `select action, before, after, source from audit_log where entity='suppliers' and entity_id='<id>' order by
   occurred_at` — exactly one `set_supplier_bank_account` row, with the old and new numbers.
- A staff session is refused at the page. Rely on D9 and W4 and say so.

## Slice S2 — DEF-506, the edit action clears fields its form did not send

### Why
`supplierFieldsFrom` (`apps/erp/src/app/ap/actions.ts:47-63`) maps every key with `str(fd, k) || null`, so a key the
form did not send becomes `null`, which `editSupplier` writes as a clear (`index.ts:253-268`: only `undefined` means
"leave alone"). Any edit form that renders a subset of fields wipes the rest. Today's only edit form renders them all;
`editFormData`-shaped posts (name only) already null the bank fields, email, representative name, TIN and
classification.

### Ruling
- **R8: absent means untouched; sent-blank means clear.** For `email`, `representativeName`, `tin`, `classification`,
  `bankName`, `bankAccountName`, `bankAccountNumber`: `fd.has(k) ? (str(fd, k) || null) : undefined`. This is the rule
  `issuesOfficialReceipt` (`:55-57`) and `creditTermsFrom` (`fd.has('termsMode')`) already follow.
- `createSupplierAction` spreads the same helper; `createSupplier` maps `undefined` to `null` (`index.ts:189-196`), so
  create is unaffected (leg C1).
- The action still judges nothing (RULES §6 item 3); no domain change.

### BUILDER (S2)
1. `apps/erp/src/app/ap/actions.ts`, `supplierFieldsFrom` only: apply R8 to the seven keys, and one comment line
   naming T-365 S2 / DEF-506 and why absent must not clear.

**BUILDER paths (S2):** `apps/erp/src/app/ap/actions.ts`.
⛔ Not the builder's: `packages/**`, the supplier pages, every test file.

### TESTER (S2)
**TESTER paths (S2):** `apps/erp/tests/integration/t365-supplier-bank-audit-web.test.ts` (the S1 file; S2 adds legs
to the file its own lane created, so no pre-existing test is edited).

| Id | Form | Target | Red today |
|---|---|---|---|
| W5 | admin; supplier with bank `T('BDO','Acme Inc','1111')`, email and TIN set; `editSupplierAction` with `supplierId` + `name` only | redirect `ok=Supplier updated.`; all three bank columns, email and TIN unchanged; `BANK(id)` unchanged | bank, email and TIN become null; after S1 also a `BANK` row with `after` `T(null,null,null)` |
| W3 | (S1's leg, re-run) bank inputs PRESENT but blank | cleared; +1 `BANK` row — the positive control that sent-blank still clears | green (guard) |
| C1 | admin; `createSupplierAction` with `name` only | new row, all seven fields null, `issues_official_receipt` true; redirect `ok` | green (guard) |

**Mutant proof:** `fd.has(k) ? … : undefined` reverted to `str(fd, k) || null`: W5 red.

### §9.4 (S2)
On 9008 as admin: `/ap/suppliers/<id>` with bank, email and TIN set; save the edit form unchanged; screenshot the
values still present. (The page cannot omit fields, so W5 is the proof of the absent-key rule; say so.)

## Out of scope
- **Auditing the other supplier fields**, the name above all (the JSDoc pairs it with the account number). The
  register row names bank fields; the orchestrator may log a row for the name.
- **A "last changed by" line on the supplier page** (the T-350 G2 `latestForEntity` pattern). A UX addition, not the
  defect.
- Auditing `createSupplier` (R4).

## Done when
- S1: D1-D3, D7, D10, D13, W1 and W3 go red→green; D4-D6, D8, D9, D11, D12, W2 and W4 are green before and after.
- S2: W5 goes red→green; W3 and C1 are green before and after; the S2 mutant is recorded.
- The four mutant proofs are recorded.
- The must-stay-green list passes with no existing test edited; typecheck clean at READY; `packages/domain/src/ap` has
  0 raw throws.
- §9.4 screenshots and the audit query output are pasted.
- Each builder edited only its slice's BUILDER path.
- **Orchestrator:** DEF-498 → `fixed (T-365 S1, <commit>)`; DEF-506 → `fixed (T-365 S2, <commit>)`; add a GLOSSARY line: supplier bank changes are audited as
  `set_supplier_bank_account`, full before/after triple.

## Questions for Ian
None. The gate is his (row 250), the audit rule is §7 rule 7, and no sentence changes.
