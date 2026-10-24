# T-474 — Audit 23 Oct follow-ups on T-470/T-471: a refund number is closed on the server before it is called unused; four Z-reading fixes

**Status:** spec written 2026-10-24 (Opus planner, AUDIT session). Source: Codex read-only audits 2026-10-23
(`C:\Users\ianla\shareat-audits\2026-10-23`, findings 5-8), re-verified against `claude/pos-v2-t470` 51b5b4f.
Branch `audit/t474-pos-refund-z` off 51b5b4f, for merge into `claude/pos-v2-t470` (PR #54). Defects DEF-756..759.
This spec CORRECTS T-470 Ruling 4 and T-471 Correction 3 (see "Spec corrections"); recorded as bible §13
row 393 (Ian asked for it, 2026-10-24).

## Finding 5 — DEF-756 (P2 → treated P1, money record): an in-flight refund can be called "carries no money" for ever

Verified: `apps/pos/src/lib/outbox/reconcile.ts:128-149` `resolveReservedRefund` marks a reserved refund `skipped`
when `receiptNumbers/{number}` is absent and the row is ≥ 10 min old (`REFUND_SKIP_MIN_AGE_MS`, `:125`).
Absence is not a final outcome: the refund request (`RefundReceiptDialog.tsx` → `POST /api/pos2/refunds`) may still
commit later (server retry, slow approval, a request retried after the age passed), and once the row is `skipped`
no pass looks at it again (`doPass` lists only `reserved` and `unsent`). The refund then exists on the server while
the tablet's ledger says the number carried no money. This is T-470 Ruling 4 as written: a SPEC defect.

**Rule (industry pattern: a fence / tombstone).** A number may be called unused only after the server has CLOSED
it, atomically, so no refund can ever commit with it afterwards.

1. **New server route `POST /api/pos2/refund-numbers/release`** (`server/pos2/refund-number-release.ts` +
   `app/api/pos2/refund-numbers/release/route.ts`, the same `runPos2Route`/`guarded`/`authenticate` shape as
   `refunds.ts`). Body: `{ storeId, deviceId, terminalNo, terminalSeq, receiptNumber }`. Roles admin/manager/cashier;
   no PIN (moves no money). Store from the verified token. Validates terminalNo 1-99, terminalSeq 1-999999, and
   `receiptNumber === formatTerminalReceiptNumber(storeCode, terminalNo, terminalSeq)` (400 otherwise, as refunds).
   ONE transaction on `stores/{s}/receiptNumbers/{receiptNumber}`:
   - absent → `tx.create` `{ released: true, kind: 'refund-number-released', terminalNo, terminalSeq,
     releasedBy: { uid, role }, createdAt: serverTimestamp() }` → `200 { ok: true, state: 'released', terminalSeq }`;
   - present with `released === true` → `200 { ok: true, state: 'released', terminalSeq: <stored> }` (idempotent);
   - present otherwise → `200 { ok: true, state: 'used', terminalSeq: <stored>, receiptId: <stored|null> }`.
   A create lost to a racing refund is retried by the transaction and then answers `used`.
2. **The refund transaction already refuses a closed number**: `refunds.ts:103-111` reads `receiptNumbers/{n}` and,
   with no matching `receiptId`/`requestHash`, refuses 409 "already used"; its `tx.create` of the same doc makes the
   race serializable. A test must prove: release first → a later refund with that number is refused and writes no
   receipt; refund first → release answers `used`.
3. **Reconcile** (`resolveReservedRefund`):
   - number doc present with `released === true` and the row's `terminalSeq` → `markSkipped` (reason
     `"The refund did not reach the server; its number was closed on the server, so it carries no money."`);
     NEVER `markAcknowledged` a released number;
   - present, not released, same `terminalSeq` → acknowledged (unchanged); different `terminalSeq` → reserved +
     `lastError` (unchanged);
   - absent and younger than `REFUND_SKIP_MIN_AGE_MS` → stays reserved (unchanged);
   - absent and old enough → call `deps.releaseRefundNumber(ev)`. `released` with the row's seq → `markSkipped`
     (reason above); `used` with the row's seq → `markAcknowledged`; `used`/`released` with another seq → reserved +
     `lastError` (a person decides); a throw, non-2xx, or no `releaseRefundNumber` dep → stays reserved. Absence
     alone never marks a row skipped.
   - `ReconcileDeps` gains `releaseRefundNumber?(ev): Promise<{ state: 'released' | 'used'; terminalSeq: number }>`;
     `OutboxSync.tsx` wires it with the existing `postPos2` client (`lib/pos2/client.ts`).
4. Nothing else changes: the dialog still never marks skipped; sales' reserved rows unchanged; v1 never reads
   `receiptNumbers` (checked); `lib/terminal/claim.ts` counts a closed number as used, which is correct (a number is
   never reissued).

## Finding 6 — DEF-757 (P1, money): a Z can close with its end before the previous Z's end

Verified: `server/pos2/z-readings.ts:90` takes `nowMs` before `record()`'s transaction (`:92-107`), and the
transaction (including Firestore's automatic retries) reads the latest Z and builds `zWindow({ lastZToMs, nowMs })`
(`lib/cash/z-reading.ts:58-62`), which accepts `lastZToMs > nowMs`. Two overlapping requests: B commits Z10 ending
18:01; A (clock 18:00) then commits Z11 with window [18:01, 18:00), and Z12 starts at 18:00, counting 18:00-18:01
sales already on Z10.

Rule: inside the transaction, after reading the latest Z, if `last.toMs >= nowMs` throw `Refusal(409, RACE)`
(existing message "Another tablet just closed the day…"); nothing is written. The X-reading is unchanged.
Test: a fake whose latest Z ends after the handler's `nowMs` → 409, no `zReadings`/slot doc written; equal ends →
409; the existing sequential and arrival-race tests still pass.

## Finding 7 — DEF-758 (P2, money): a receipt that arrives more than seven days late is on no Z

Verified: `z-readings.ts:22-23,35-37` queries receipts by SALE time `createdAtClientMs >= window.fromMs - 7 days`.
A sale kept unsent on a tablet for more than 7 days (unsent ledger rows are never pruned) uploads after the cutoff
and is never read by any later Z. T-471 Ruling 5 promises it on the NEXT Z, listed late, with no time limit.

Rule: a Z reads receipts two ways and merges them by document id:
- in-window: `createdAtClientMs` in `[window.fromMs, nowMs)` (as now, without the lookback);
- late arrivals (only when a previous Z exists): server arrival `createdAt >= new Date(last.printedAtMs)`; of these,
  only receipts sold before `window.fromMs` are late candidates.
Counted-once check: `countedReceiptIds` = the `receiptIds` of every Z whose `createdAt` (its commit time) is
`>= new Date(last.printedAtMs)` — any Z that could have read a receipt arriving after the last Z's clock committed
after it. Remove `LATE_LOOKBACK_MS` and the `toMs >= receiptsFrom` prior-Z query. `computeZReading`'s late rule is
unchanged (sold before window, arrived at/after last printed, id not counted). The X-reading uses the same reads.
Tests: a receipt sold 8 days before the last Z and arriving after it is counted and listed late on the next Z; a
receipt the last Z already counted (arrival race) is not counted again; a receipt arriving before the last Z
printed and sold before it is not late.

## Finding 8 — DEF-759 (P2): manual cash adjustments change expected cash but are on no printed line

Verified: `lib/cash/z-reading.ts:153,156-159` adds `manualCashAdjustment` into expected cash but `cash` (`:172`)
does not return it, and `lib/printing/zSlipFormatter.ts:68-69` prints no line for it, so the printed cash lines do
not add up to "Expected cash" (T-471 Fix B's promise). Example: start ₱100, +₱20 approved adjustment → expected
₱120, lines total ₱100.

Rule: `ZReading.cash.manualAdjustmentCentavos` (signed integer centavos, the sum used in expected cash). The slip
prints `Manual adjustments` (signed) after `Convert net`, before `Less deductions`. A stored Z document without the
field (printed before this fix) prints no such line on reprint. Property test: for random days, starting + (cash
sales − kept) + kept + convert + manual − deductions − refunds = expected. Golden text updated for the new line only.

## Spec corrections (planner)
- **T-470 Ruling 4** now reads: absent → after `REFUND_SKIP_MIN_AGE_MS`, the tablet asks the server to close the
  number; only a closed number (`released: true`) is marked skipped. Appended to `docs/tasks/470-…md` Corrections.
- **T-471 Correction 3** ("arrived within `LATE_LOOKBACK_MS`") is withdrawn: late arrival is by server arrival
  since the last Z, with no time limit. Appended to `docs/tasks/471-…md`.

## Files
`apps/pos/src/server/pos2/refund-number-release.ts` (new), `apps/pos/src/app/api/pos2/refund-numbers/release/route.ts`
(new), `apps/pos/src/server/__tests__/refund-number-release.test.ts` (new), `apps/pos/src/server/__tests__/refunds.test.ts`,
`apps/pos/src/lib/outbox/reconcile.ts`, `apps/pos/src/lib/outbox/reconcile.test.ts` (or its existing test file),
`apps/pos/src/components/OutboxSync.tsx` (wherever `runReconcilePass` deps are built), `apps/pos/src/lib/pos2/client.ts`
(only if a helper is needed), `apps/pos/src/server/pos2/z-readings.ts`, `apps/pos/src/server/__tests__/z-readings.test.ts`,
`apps/pos/src/lib/cash/z-reading.ts`, `apps/pos/src/lib/cash/z-reading.test.ts`, `apps/pos/src/lib/printing/zSlipFormatter.ts`,
its test, any test fake that must learn a `createdAt` range query, `apps/pos/V1-COPY.md` (one line per hand edit),
`docs/tasks/470-…md`, `docs/tasks/471-…md`, `docs/DEFECTS-REGISTER.md` (section E, DEF-756..759), the POS caller
baseline/guard files only if a guard requires it. Nothing else.

## Acceptance
Each new test red on 51b5b4f for the stated reason, then green. POS suite (`npm test -w @shareat/pos` or the repo's
POS vitest project) green, POS typecheck clean, guards `tests/unit/pos-v2-*` and `app-boundaries` green. No live
Firebase, no TEST store on live, no emulator writes outside a local emulator. Release gates of PR #54 unchanged.

> **Follow-up (2026-10-24):** the release route was bound to the caller's registered terminal and a plausible sequence window by [T-477](./477-refund-number-release-binding.md) (DEF-771).
