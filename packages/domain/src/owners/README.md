# Owners
## Overview
Owner equity (T-127): capital in, drawings out, recovery of owner receivables, and a monthly drawing-close. Every figure is summed from the ledger by party; nothing is stored as a total.

## Interface
- `index.ts`: `CAPITAL_CODE` (3100), `DRAWINGS_CODE` (3200), `EMPLOYEE_ADVANCE_CODE` (1230), `DUE_FROM_OWNER_CODE` (re-export), `monthOf`, `nextMonthOf`, `createOwner`, `recordContribution`, `judgeDrawingLimit`, `recordDrawing`, `repayFromOwner`, `recoverFromPay`, `writeOffReceivable`, `previewDrawingClose`, `closeDrawingMonth`, `reverseOwnerEntry`, types `CreateOwnerInput`, `DrawingLimitVerdict`, `ClosePreview`.

## Invariants
- Posting shapes: contribution DR money account / CR 3100 (party = owner); drawing DR 3200 / CR money account (party = owner).
- `3200` is debit-normal: a drawing debits it to increase it, which reduces equity.
- No stored totals (DEF-072): all figures come from the ledger by party.
- Drawing limits (monthly and total) are both measured from the ledger. The monthly window keys on the drawing's own date, not today, so back-dating cannot slip past a cap. Comparison is in integer centavos, never `Number` (DEF-541).
- `monthOf`/`nextMonthOf` are string maths on purpose (no `Date`, no timezone).
- `DUE_FROM_OWNER_CODE` has one definition (in `routing.ts`); do not redeclare it (barrel collision).
- Authorizes `manage_chart_of_accounts` (`createOwner`), `transfer_funds` (contribution, drawing, repay, close preview, reversal) and `approve_expense` (`recoverFromPay`, `writeOffReceivable`, `closeDrawingMonth`), all at the owner's store.

## Side Effects
- Writes owners and owner-register rows via repos; posts and reverses journal entries (`postEntry`/`reverseEntry`).
- Opens a transaction via `transaction(...)` when `tx` is `null`.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
