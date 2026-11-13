# T-566: a refill carries one flavour, like v1 (audit P-007)

**Status:** SPEC 2026-11-11 (AUDIT). Number from the orchestrator. Ian's ruling, 11 Nov: "must function the same way as v1
POS/CUSTOMER". Source: `shareat-audits/OPEN/2026-11-09-pos-domain.md` P-007. **Stacked on T-557** (branch
`audit/t557-option-ids`, PR #225, migration 0249 adds `option_value_ids uuid[]` to `table_session_lines` and
`pos_sales_receipt_lines`). No new migration. Branch `audit/t566-refill-flavour`, worktree `wt-audit-t566`. Rebase or merge
onto main after #225 merges.

## 1. v1 behaviour to match (read-only references)

- One flavour per refill meat: POS `RefillPOSModal.tsx:585-598`, CUSTOMER `CustomerRefillModal.tsx:424-437`.
- The flavour is required when the meat has flavours (`requiresFlavor`: POS :284).
- The server refuses more than one flavour, a disabled flavour, or a flavour not allowed for the meat
  (CUSTOMER `refill-validate.ts:103-113`). The message is "That flavor is not available for X."
- The same meat cannot appear twice in one request (the cart is keyed by meat).
- The kitchen display shows "Pork - Bulgogi" (`kds-item-card.tsx:195-199`). v1 forgot the paper backup ticket; v2 MUST print
  it.

## 2. v2 today (origin/main + #225)

A refill line is `{lineId, menuItemId, qty, addedAtDevice}`:
- `packages/domain/src/pos/inbox.ts:90` `refillLineSpec`
- `order.ts:422-459` `requestRefill`, with replay check `sameRefill` :433
- `apps/erp/src/app/pos/refills/actions.ts:18`
- `_refills/payloads.ts:16-34`

It has no variant or flavour, and nothing validates one. Flavours are option values on the refill item's variants
(`menu.ts:210`; "required" = group `min_selections > 0`). The line path already validates options through `optionDelta`
(`order.ts:97`, T-552) and names a line `base + ' + options'` (`order.ts:167`). The outage print already resolves
`optionValueIds` through `lineName` (`_kitchen/outage-print.ts:71-108`).

## 3. Changes (reuse; no new UI pattern)

1. **Wire.** Add optional `optionValueIds: string[]` (at most 1) to the refill line in `refillLineSpec`, the refill event
   payload builder, and the refills server action input.
2. **Domain `requestRefill`.**
   - Refuse a request with the same `menuItemId` twice, in plain words, before any write.
   - For each line, validate the flavour with the same rules `optionDelta` applies: required group, allowed and enabled
     values, max. Reuse `optionDelta` if its signature fits a zero-price refill; otherwise extract the shared check.
   - Refuse more than one flavour value per refill line, with the v1 sentence shape: "That flavour is not available for
     <meat>." or "Choose one flavour for <meat>."
   - Store `option_value_ids`, and set `name` the same way `writeLines` does, so the board, the Served label and the print
     all show it. Keep the refill free (`unitPrice` 0) and independent of package hours.
3. **Replay.** `sameRefill` must also compare `optionValueIds`, as T-556 does for lines. A changed flavour under the same
   lineId is refused, not acknowledged.
4. **ERP tablet `/pos` refills screen** (`_refills/Refills.tsx`, `meats.ts`, `_kitchen/menu-meta.ts`): list each meat's
   allowed flavours from the cached menu. Selecting one replaces the previous choice, and tapping it again clears it. The
   send button is disabled while a meat that needs a flavour has none. Use the existing chip/radio components on that
   screen.
5. **Offline ticket.** The refill event line carries `optionValueIds` (and `variantId` if `lineName` needs it), so
   `outage-print.ts` prints the flavour. Check this with a test.
6. Customer app: v2 has no refill path. Nothing to do; say so in the hand-back.

## 4. Tests (first, red where behaviour changes)

Domain integration on the worktree's `_test` DB:
- Refill with a required-flavour meat and no flavour: refused, nothing written.
- Two flavours on one line: refused.
- A flavour not allowed for the meat: refused.
- The same meat twice in one request: refused.
- One valid flavour: stored in `option_value_ids`, and the name shows the flavour.
- Replay with the same flavour: acknowledged. Replay with a different flavour: refused.
- A meat with no flavours: works with none.

ERP unit tests:
- The refills screen picks and replaces one flavour.
- Send is blocked while a required flavour is missing.
- The outage refill slip prints the flavour.

## 5. Checks

New tests pass. Existing t524/t525/t529/t552/t556/t557 POS tests pass. Root typecheck is clean. Unit guard, census and caller
baseline pass; re-measure them with their own tools, never by hand. No CR or control bytes.

## 6. Acceptance

A refill behaves like v1: one valid flavour per meat, required when the meat has flavours, never the same meat twice in one
request. The flavour reaches the kitchen board and the paper ticket. P-007 closes after merge.
