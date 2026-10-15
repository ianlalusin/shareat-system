# T-412 — `ConfirmDestructive`: two tiers, and the admin PIN is checked on the server

**Status:** SPEC 2026-10-15, Opus. Work list item 7 (`docs/plans/2026-10-14-ian-answers-worklist.md`); bible row 329
(Ian Q11 "a"), row 196 (adminless fallback), §2 rule 7 / RULES §1.7 (no client-only authorization). Builds on T-302/T-303/
T-395 (org-scoped PIN lookup, `pinAttemptsRepo` throttle). **No migration** (reuses `pin_attempt_throttle` and
`sign_in_attempts`; the new audit action is a TS catalogue entry). Size M-L.
**Model: SONNET** for every slice (auth + money). **Tests first**, confirmed red for the right reason; **one mutant per
invariant**; a **fresh Sonnet audit** (no context from the build) after S1 and again after S3. Spec slices in plan mode.

## The two tiers (row 329)
- **Tier R — retype the name.** Retire / deactivate / revoke / unlink / remove-from-use. The person types the record's
  name; the server compares it with the name it loads from the database.
- **Tier P — an administrator's PIN.** Void or reverse anything posted, delete, cutover, separation. Someone who is an
  administrator types **their own** 6-digit PIN into the form; the server re-verifies it.
- **Not guarded (tier —).** Workflow steps on unposted documents (reject, decline, withdraw, cancel, discard) and
  client-only "remove line" buttons. See Question 2.

## How the server verifies a Tier P action (the exact contract — no client flag is ever trusted)
NEW `packages/auth/src/admin-approval.ts`, exported from the package index:
`verifyAdminApproval(tx: Tx | null, input: { actor: Actor; storeId: string; pin: string; capability: Capability;
deviceId?: string }): Promise<{ approverPersonId: string }>`.
1. **Inputs.** `pin` is the ONLY value taken from the form (field `adminPin`). `storeId` is the store of the RECORD,
   loaded by the action in its own read — never a form field. `actor` comes from `resolveActor`. Nothing named
   `confirmed`, `approved`, `pinOk`, `verified` or a token is read from `formData` anywhere (census guard, below).
2. **Charge first, committed on its own** — exactly `signInWithPin`'s shape (`sessions.ts:93-162`): `chargeAttempt`
   under `withOrgPrincipal(actor.orgId)` in its own transaction, `refuseIfCharged` (stopped / paused sentences unchanged).
   A wrong approval PIN is a `miss` on the store's budget like a wrong sign-in PIN. Factor the charge/note/refuse/refund
   sequence out of `signInWithPin` into one internal helper used by both; **sign-in tests stay green, unedited**.
3. **Lookup** `sessionsRepo.findActiveCredentialByLookupHash(tx, pinLookupHash(actor.orgId, pin))` under
   `withOrgPrincipal`; no row / not `kind='pin'` -> `verifyPin(pin, DUMMY_SCRYPT_HASH)` then refuse. Bad format -> refuse
   (after the charge). Exactly one scrypt on every path.
4. **Authority of the PIN's owner P** (`credential.personId`) — computed in full on every path, no short-circuit:
   `isAdmin` = P holds an unrevoked `person_roles` row with role `admin` or `super_admin` in `actor.orgId` (export the
   existing `isAdministrative` test from `roles.ts`; add `accessRepo.personIsActiveAdmin(tx, orgId, personId)` beside
   `hasActiveAdmin`). `adminless` = `!accessRepo.hasActiveAdmin(tx, orgId)`. `fallback` = `adminless &&
   can(tx, {personId: P, orgId}, capability, {storeId})` — row 196: in an org with no administrator, the elevated
   manager who holds the capability is whose PIN counts. Allowed iff `verified && (isAdmin || fallback)`.
5. **Refusal** is ONE sentence for every failure (unknown PIN, wrong PIN, not an admin, other org, revoked role):
   `ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.'` The miss stays charged.
6. **Success** -> `refundOnSuccess`, return `{ approverPersonId: P }`. The approver may be the actor.
7. **The action, in this order:** authorize the actor as today (unchanged) -> load the record (store, name) -> call
   `verifyAdminApproval` -> open the mutation transaction -> domain call -> in the SAME transaction append audit
   `destructive.approved` `{ capability, entityType, entityId, actorPersonId, approverPersonId }`. A rollback removes the
   audit row with the mutation. Register `def('destructive.approved', 'security', 'high', 'store', <entity table>,
   'T-412', { actor: 'either' })` in `packages/db/src/audit/catalogue.ts` (T-402 pattern).

## How the server verifies a Tier R action
NEW `apps/erp/src/lib/retype.ts`: `retypeMatches(typed: unknown, expected: string): boolean` — string only; NFC,
trim, collapse inner whitespace, case-insensitive; empty never matches. The action loads the name from the database in
its own read and refuses with `"Type the name exactly — '<name>' — to confirm."` before any mutation. Field `confirmName`.

## UI — NEW `apps/erp/src/components/ui/ConfirmDestructive.tsx` (`'use client'`)
Props `{ tier: 'retype' | 'admin-pin'; label: string; consequence: string; expectedName?: string }`. Rendered INSIDE the
existing `<form action={…}>`, replacing its danger `<Button>`. A first danger button reveals the panel (no
`window.confirm`): `consequence` text, then `Input name="confirmName"` (labelled "Type <name> to confirm") or
`Input name="adminPin" type="password" inputMode="numeric" autoComplete="off" maxLength={6}` (labelled
"Administrator PIN"), then the real submit `<Button variant="danger">{label}</Button>`. The retype submit is disabled
until it matches — a convenience only; the server check is the gate. Export from `components/ui/index.ts`.

## Census — 60 `variant="danger"` buttons in 47 files + 3 non-danger (counted at `76ba502`, paths under `apps/erp/src/app/`)
**Tier P (35)** — ap/invoices/[id] :466 Void payment, :548 Void · attendance/[dayId] :394 Void · channel-settlements
:506 Void · commissary/orders/[id] :386 Void dispatch · customers/[customerId] :353 Write off as bad debt, :366 Void
charge · cutover/opening :371 Remove, **:394 Post the opening balances** (primary) · expenses/[id] :283 Delete draft,
:302 Void · expenses/recurring :247 Delete · fixed-assets/[id] :374 Dispose · inventory/pos-usage :331 Void this pull ·
inventory/production/[id] :93 Void · inventory/returns :246 Void · inventory/transfers :184 Void · inventory/usage/[id]
:110 Delete draft, :147 Void · liabilities/[id] :219 Reverse · loans/[id] :217 Reverse · money-transfers :276 Reverse ·
payroll :438 Void · payroll/separations :225 Void, **:193 Post separation** (primary) · payroll/thirteenth-month :200
Void · prepaid/[id] :215 Reverse, :285 Write it off · remittance :524 Reverse · sales-days/[id] :514 Void ·
staff/[employmentId] :220 End employment · statutory-discounts :187 Void · trade/orders/[id] :308 Void order ·
trade/returns :253 Void · wastage/[id] :190 Reverse.
**Tier R (14)** — admin/access-defaults/grid.tsx :157 Retire, :350 Retire · admin/users/[personId] :210 Revoke, :378
Unlink · attendance/terminals :159 Revoke · budgets :212 Remove cap · commissary/catalogue :314 Remove · items/[id] :372
Retire · menu :135 Retire · money-accounts :167 Retire · settings/pos-link :261 Unlink, :431 Retire ·
staff/[employmentId]/credentials :111 Revoke · **inventory/locations :196 Deactivate** (secondary today).
**Tier — (10 workflow)** — attendance/lane :418 Discard · cash-requests/[id] :259 Withdraw · commissary/orders/[id]
:373 Withdraw/Cancel, :473 Reject, :577 Remove, :651 Decline · inventory/counts/[id] :252 Cancel count · items :174
Reject · menu/requests :142 Reject · sales-days/[id] :497 Withdraw day.
**Exempt, client-only (4)** — inventory/deliveries/NewDeliveryForm.tsx :267, inventory/usage/NewUsageForm.tsx :174,
trade/orders/NewOrderForm.tsx :205, `components/money/MoneyLines.tsx` :416 (remove a line in an unsaved form).
For each P/R row the builder follows the form's `action=` to its server action and wires the check there.

## Slices
- **S1 (Sonnet, auth)** — `admin-approval.ts`, the shared charge helper, `personIsActiveAdmin`, catalogue entry, tests
  I1-I9. Then fresh audit.
- **S2 (Sonnet)** — `ConfirmDestructive.tsx`, `retype.ts` + unit tests, census test (red until S3/S4).
- **S3 (Sonnet, money)** — the 35 Tier P actions, batched by area (AP/expenses · inventory · payroll/staff · ledger
  reversals · cutover/sales-days); I10 per batch. Then fresh audit.
- **S4 (Sonnet; Haiku allowed one file each, Sonnet reviews)** — the 14 Tier R actions.

## Tests (write first)
**Integration, real Postgres** — NEW `packages/auth/tests/integration/t412-admin-approval.test.ts`:
I1 admin's own correct PIN approves, returns the admin's id · I2 wrong PIN refused with `ADMIN_PIN_REFUSED`, and the
`sign_in_attempts` miss row SURVIVES (committed although the call threw) · I3 a manager's correct PIN in an org that has
an admin -> refused, same sentence · I4 org with no admin: elevated manager holding the capability -> approved; a manager
without it -> refused · I5 an admin's PIN from ANOTHER org -> refused · I6 store stopped for the day -> stopped sentence,
no lookup · I7 admin whose role was revoked -> refused · I8 malformed PIN -> refused and charged · I9 a correct PIN
refunds the charge (store not paused after 10 correct approvals).
NEW `apps/erp/tests/integration/t412-destructive-actions.test.ts` — I10, for one action per S3 batch (e.g.
`voidExpense`, a transfer void, `postSeparation`, a loan reversal, `postOpeningBalances`): no `adminPin` -> refused,
nothing changed; a non-admin's PIN -> refused, nothing changed; admin PIN -> done, and `destructive.approved` names actor
and approver; a forced domain failure after approval leaves NO audit row. One Tier R action: wrong name -> nothing changed.
**Unit** — `apps/erp/src/lib/retype.test.ts` (case/space/NFC match; `''`, `null`, number, prefix never match).
**Census** — NEW `apps/erp/tests/t412-destructive-census.test.ts`: the literal map above; every `variant="danger"` in
`apps/erp/src` is in it (exactly 60 — a new one must be classified); each P/R page renders `<ConfirmDestructive
tier=…>` for its row; each P action's source calls `verifyAdminApproval(` before its domain call and each R action
`retypeMatches(`; no file under `apps/erp/src/app` reads `formData.get('confirmed'|'approved'|'pinOk'|'verified')`.

## Invariants and mutants (each red, then reverted)
- **V1 server is the gate** — M1 make `verifyAdminApproval` return early when `pin === ''` -> I10 red.
- **V2 only an admin's PIN** — M2 drop the `isAdmin` term (any valid PIN) -> I3 red.
- **V3 row-196 fallback only when adminless** — M3 drop `adminless &&` -> I3 red; M4 drop `fallback` -> I4 red.
- **V4 org-bound** — M5 hash with a constant instead of `actor.orgId` -> I5 red.
- **V5 misses count and survive** — M6 charge inside the action's transaction -> I2 red; M7 skip `refuseIfCharged` -> I6 red.
- **V6 store from the record** — M8 read `storeId` from `formData` in one action -> census red.
- **V7 audit atomic** — M9 append the audit row before/outside the mutation transaction -> I10 rollback case red.
- **V8 retype from the DB name** — M10 compare to a form-supplied name -> I10 Tier R case red.
- **V9 every danger button classified** — M11 add a `variant="danger"` button anywhere -> census red.

## Done when
`npm run typecheck` clean; the files above green; `npm test` and the full integration suite green (CI PR, row 296);
M1-M11 shown red then reverted; both fresh audits closed; screenshots of `/expenses/[id]` void (PIN panel) and
`/items/[id]` retire (retype panel) at 390 and 1280; `CAPABILITY-MATRIX.md` unchanged (no capability added).

## Questions for Ian (Open Questions page)
1. **Admins with no PIN.** An admin who signs in only by email may have no PIN (PINs are issued on an employment page).
   Options: (a) let Staff issue a PIN to any admin — recommended, one rule, no new sign-in path; (b) accept a fresh email +
   password re-sign-in instead — a second verifier through Firebase. Until answered, S1 builds PIN only.
2. **Draft deletes and workflow steps.** Your ruling puts "delete" in the PIN tier, so deleting an unposted draft
   (expense, usage) needs an admin PIN. Recommended: keep that literal; leave the 10 reject/decline/withdraw/cancel
   steps unguarded (nothing is posted or lost). Alternative: give those the retype tier.
