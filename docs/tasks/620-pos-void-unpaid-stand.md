# T-620: void an unpaid stand from the POS till

**Owner:** builder (Sonnet), laptop (needs a `_test` database). Auditor: Sonnet (POS money path).
**Spec:** BOSS (Opus), 21 Nov 2026. **No migration. No new capability. No Ian decision** (bible rows 356, 431 already decide it).

## Why

Bible row 431 puts "void an unpaid stand (manager/admin)" in the first Lipa release (go-live 7 Dec). The server side is
built and tested: inbox kind `session.voided` (`packages/domain/src/pos/inbox.ts:150`) runs `voidUnpaidSession`
(`packages/domain/src/pos/sale.ts:54`), and the device outbox already allows the kind
(`apps/erp/src/lib/pos-device/outbox.ts:45`). **Nothing on the till builds the event**, so a wrongly seated or walked-out
stand can't be cleared. `/pos` today has only line cancel (`apps/erp/src/app/pos/_orders/OrderDialogs.tsx:176`).

## What to build (client only)

1. **Event builder** `voidSessionEvent` in `apps/erp/src/app/pos/_orders/payloads.ts`, beside `cancelLineEvent`:
   payload `{ sessionId, reason, voidedAtDevice, offline, approval?: { pin } }`. Exactly the server's spec at inbox.ts:152.
2. **A "Void table" action** on an open, UNPAID stand in the Orders view (where line cancel is reached, `Orders.tsx` ~309).
   Not shown on a paid stand or a take-out already settled. Placed as a secondary/destructive action, never the primary.
3. **`VoidStandDialog`** in `OrderDialogs.tsx`, modelled on `CancelLineDialog`: stand name, reason (same
   `CANCEL_REASON_MIN` rule), manager PIN field when needed, plain confirm wording ("Void table 4? Its unsent kitchen
   lines are cancelled. This cannot be undone.").
4. **Who may void, exactly as the server decides** (sale.ts:65-74, row 356):
   - Signed-in person holds `approve_pos_correction` at the store → no PIN; works online and offline (offline sends
     `offline: true`; the server marks it `voidedOffline`).
   - Otherwise, online → ask for a manager PIN, sent as `approval.pin` with the event (submit straight away, never queued).
   - Otherwise, offline → the action is shown disabled with "A manager must approve voiding a table, and that needs the
     internet." Do not queue it.
   - Find how the till already knows the signed-in person's rights (`ordersAccess` in `payloads.ts`, the snapshot). If
     `approve_pos_correction` is not there, add one boolean to what the server already sends; do not add a new endpoint.
5. **Local projection** (`apps/erp/src/app/pos/_orders/project.ts` ~215): a queued `session.voided` removes the stand
   from the open list at once (offline too), the same way `sale.completed` does. The stand becomes free to seat again.
6. **Refused void** (wrong PIN, stand already paid on the other tablet): show the server's sentence in the dialog; the
   stand stays.

## Tests (each with a mutant that goes red)

1. Unit `payloads`: `voidSessionEvent` output matches the server spec field for field (mutant: drop `offline` → red).
2. Unit projection: a queued void frees the stand (mutant: skip the new branch → red).
3. Unit dialog/access: manager signed in → no PIN field; cashier online → PIN field required; cashier offline → disabled
   with the sentence (mutant: treat offline cashier like online → red).
4. Integration (existing `packages/domain/tests/integration` POS inbox tests): an event built by `voidSessionEvent` and sent
   through the inbox voids the session and writes `pos.session_voided` (proves client and server agree).

- **Pins to re-measure** with `npm run census:write`: action-link-sweep, touch-target baseline, T-343 ratchet.
- **Browser check** before handing back: open `/pos` on a test store, seat a stand, void it as cashier+PIN and as manager.
  Screenshot both. The dialog's Close and confirm buttons are 44px.
