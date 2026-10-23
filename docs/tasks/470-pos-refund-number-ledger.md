# T-470: POS v2 — refund receipt numbers go through the sale ledger (DEF-731)

**Status:** spec written 2026-10-23 (Opus planner, POS v2 session). Ready to build.
**Model:** Sonnet tester (slice T) -> Sonnet builder (slice B) -> Sonnet auditor (A). Money-adjacent: never Haiku.
**Migration:** none. No `packages/**` change. No server change.
**Authority:** DEF-731 · T-425 Ruling 1 ("every number a tablet hands out is explained") · bible rows 272, 276, 351 ·
release audit of PR #47 (22 Oct, finding 3).
**Numbers:** from this session's block (T-470..474, DEF-750..759, rows 390..394; orchestrator, 22 Oct).

## Goal, in plain words
Every receipt number a tablet uses has a row in the tablet's own sale ledger saying what happened to it. Today a
refund takes its number straight from the counter (`reserveNext()`) and keeps it only in screen memory. If the
dialog closes or the tablet reloads before the server answers, that number is gone with no explanation. After this
task a refund number is written to the ledger first, then sent; a later reconcile pass marks it **acknowledged**
(the server has it) or **skipped** (the refund never reached the server, so the number carries no money).

## Facts verified at `69dca6c`
- `apps/pos/src/components/receipts/RefundReceiptDialog.tsx:97-99`: `reserveNext()` → `reserved.current = {key, number, terminalNo, terminalSeq}`; reused while the request `key` is unchanged; cleared on 409.
- `apps/pos/src/lib/outbox/ledger.ts:14` `LedgerKind = 'sale' | 'void' | 'skipped'`; `reserveOnlineEvent` (`:221`) writes number + a `reserved` row (no ops) in ONE IndexedDB transaction; `markAcknowledged` / `markSkipped` (`:363`, `:369`).
- `reserve()` (`:185-212`) runs the `sale-intent` pointer check only for `kind === 'sale'`.
- `apps/pos/src/lib/outbox/reconcile.ts:88-107`: every `reserved` row is checked with `getDocFromServer(receiptPath(ev))` = `stores/{storeId}/receipts/{receiptId}`; a thrown read leaves it reserved; else acknowledged if `receiptNumber` matches, otherwise skipped.
- Server `apps/pos/src/server/pos2/refunds.ts:95,213`: the refund writes `stores/{storeId}/receiptNumbers/{receiptNumber}` = `{receiptId: refundId, terminalNo, terminalSeq}` in the same transaction as the refund receipt; a replay of the same request returns the same refund (`:103-109`). The refund receipt id is chosen by the server, so the tablet cannot know `receipts/{id}` in advance.
- `unsentCount` / `unsentTotalCentavos` count only `unsent`/`stuck` (and `sale` for the total); a `reserved` row never counts as unsent money.
- `OutboxSection.tsx:99` "Review after outage" lists `void` rows and to-check tenders.

## Rulings
1. **New ledger kind `'refund'`.** `LedgerKind = 'sale' | 'void' | 'refund' | 'skipped'`. A refund row stores
   `receiptId` = the PARENT receipt id (what the tablet knows), `totalCentavos` = the refund amount the dialog shows,
   `tenders` = `[{method: chosenTender, centavos: refundCentavos, toCheck: false, reference: null}]`, `linesHash` =
   `computeLinesHash(asked)` from `@/lib/outbox/linesHash` (the existing helper; do not invent a second one).
2. **The dialog reserves through the ledger.** Replace `reserveNext()` in `RefundReceiptDialog.tsx` with
   `reserveOnlineEvent({ kind: 'refund', ... })`. Keep the existing `reserved.current` reuse rule (same request
   key → same number) and the store check (`r.storeId !== receipt.storeId` → refuse, unchanged message).
3. **After the server answers.** Success (including the server's replay answer) → `markAcknowledged`. A 409 →
   leave the row `reserved` and clear `reserved.current` (as today); reconcile decides from server truth. Any other
   error → leave `reserved`. Never `markSkipped` from the dialog: only reconcile, which reads the server, may say
   a number carries no money. Ledger write failures after success are logged, never shown as "Refund not done".
4. **Reconcile checks the number document for refunds.** In `reconcile.ts` step 1, a `refund` row is checked with
   `getDocFromServer(stores/{storeId}/receiptNumbers/{receiptNumber})`: exists AND its `terminalSeq` equals the
   row's → acknowledged; does not exist → skipped with reason `"The refund did not reach the server, so this number
   carries no money."`; exists with a different `terminalSeq` → leave `reserved` and set `lastError` (a conflict
   for a person, never auto-resolved). A thrown read → stays reserved (same as sales).
5. **No other behaviour changes.** No refund is ever saved offline (row 356 unchanged). `unsentCount`,
   `unsentTotalCentavos`, the update gate, the ₱50k banner and the X-slip ignore refund rows (they are never
   `unsent`). The sale-intent pointer check stays sale-only. Firestore wire format unchanged (T-423 hard
   constraint): the tablet writes nothing new to Firestore.
6. **Shown to the manager.** `OutboxSection` "Review after outage" is unchanged. A `skipped` refund row appears in
   the existing skipped/explained list the same way a skipped sale does (no new screen).

## Slices
- **T (tester, red first):** `apps/pos/src/lib/outbox/ledger.test.ts` (refund kind reserves number + row in one
  transaction; no sale-intent check for refunds; refund rows never counted as unsent), `reconcile.test.ts`
  (refund acknowledged by number doc with matching seq; skipped when absent; left reserved + lastError on seq
  mismatch; left reserved on thrown read), a dialog-wiring test beside the dialog (reserves via
  `reserveOnlineEvent` kind refund, not `reserveNext`; same key reuses the number; 409 clears it; success
  acknowledges; dialog never calls `markSkipped`), and a guard in `tests/unit/pos-v2-offline-guards.test.ts` that
  `RefundReceiptDialog.tsx` does not import `reserveNext`. Each test must fail on today's code for the stated reason.
- **B (builder):** `ledger.ts`, `reconcile.ts`, `RefundReceiptDialog.tsx` only. Nothing else.
- **A (auditor):** contract check against this spec; mutant check (revert each ruling, a test must fail).

## Acceptance
1. `npm test -w @shareat/pos` all pass; `npx tsc -p apps/pos/tsconfig.json --noEmit` clean.
2. Every new test fails against `69dca6c` (shown in the tester's report).
3. `git diff` touches only the files named in the slices plus this doc, `docs/DEFECTS-REGISTER.md` (DEF-731
   closed with the commit) and `apps/pos/V1-COPY.md` (hand-edit list).

## Out of scope
Server-side numbering, the `pos2-audit` script, refunds offline, any receipt print change.
