# T-563 — POS device: bind the outbox to the pairing it was made under (audit P-004)

> Written in plan mode by the POS design lane (Opus planner), 12 Nov 2026. Lands as `docs/tasks/563-pos-pairing-boundary.md`.
> **Authority:** audit P-004 (`shareat-audits/OPEN/2026-11-09-pos-domain.md` ~line 54), BOSS 11 Nov. It must be done before the 28 Nov soak (row 457).
> **Migration:** none. **Risk:** HIGH, because it is money: an event posted under the wrong store books a sale to the wrong branch.
> **Builder:** Sonnet. **Auditor:** Sonnet, money and auth.

## Context

The tablet keeps its unsent events in IndexedDB `shareat-pos-v2` (`apps/erp/src/lib/pos-device/db.ts`). None of the records says which pairing or store it was made under. `PosEvent` = {seq, kind, personId, occurredAtDevice, payload} (`types.ts:23`).

The server takes store and pairing ONLY from the cookie at send time. That happens in `apps/erp/src/app/api/pos/events/route.ts` → `applyPosEvents({ pairing })` in `packages/domain/src/pos/inbox.ts`.

Re-pairing (`settings/pos-tablet/actions.ts:34`) sets a new cookie and leaves IndexedDB alone. One live pairing per store is allowed, so pairing a new tablet revokes the old pairing (`pos-tablet-pairings.ts:7,42`).

**The failures today:**
- A browser re-paired to store B drains store A's pending sales under B. That is wrong-branch money.
- A tablet whose pairing was revoked by a replacement keeps sales it can never send.

**Goal:**
- Every event is sent under the pairing it was made on, or it is held.
- No event is ever silently dropped.
- No event is ever posted under a different store.

## Design (smallest complete)

**R1 — Tag at enqueue (device).**
- `meta` gains `app.pairingId`, the bound pairing. `refreshSnapshot` (`apps/erp/src/app/pos/_shell/snapshot-sync.ts:46`) writes it from `snapshot.device.pairingId` on every successful refresh.
- `enqueue` (`outbox.ts:~100`) stamps `pairingId` from `meta` onto the stored row, inside the same transaction.
- Refusal if no pairing is bound yet (no snapshot ever arrived). The till cannot sell before its first snapshot anyway.
- `PosEvent` gets `pairingId: string`.
- An existing row with no `pairingId` is a pre-T-563 row (dev and test devices only; v2 is not live). Treat it as held, and never send it unlabelled.

**R2 — Drain per origin (device).**
- `drain` groups pending rows by `pairingId`, oldest first.
- It POSTs one batch per origin as `{ pairingId, events }` (`drain-send.ts:4`). The per-event payload is unchanged, and pairing/store ids inside payloads stay refused (`outbox.ts:82`).
- Counters stay as they are: `nextSeq` is monotonic across pairings, and the server key is (pairing_id, seq), so seqs never collide. `resumeAbove` still only raises.

**R3 — Server rule (route + one repo read).** In `api/pos/events/route.ts`, `body.pairingId` is required. With `cur` = the cookie pairing:
- `pairingId === cur.pairingId` → as today.
- Different id, but `getPairingOfStore(tx, orgId, cur.storeId, pairingId)` finds it (live or revoked) in the **same org and same store** → **carry-over**:
  - call `applyPosEvents({ pairing: { pairingId: origin, orgId, storeId } })`;
  - that keeps UNIQUE(pairing_id, seq) dedupe, the PIN-session check (`checkPerson`, inbox.ts:~279, which looks for the PIN on the tablet the sale was made on) and the handlers' `pairingId` all consistent with no inbox change;
  - write one audit row per batch: `pos_events.carried_over` {fromPairingId, toPairingId, count}.
- Otherwise → **409** `POS_PAIRING_MISMATCH` with this sentence, and nothing is applied: "These sales were made on this tablet when it was paired to another store. Pair it back to that store to send them."
- The new repo function goes in `packages/db/src/repo/pos-v2.ts`. `getLivePairing` at :122 is the model, with no revoked filter.
- ⚠️ **Builder must verify:** any handler that resolves the till via `getTerminalForPairing(origin)` (pos-v2.ts:705). A carried-over `sale.completed` whose till has since been re-linked to the new pairing (`setTillPairing`, :830) must still post. If it doesn't, resolve the terminal from the origin pairing's history or from the receipt's terminal. Pin it with a test. Report what you found before you change it.

**R4 — Device reaction to 409 / a new pairing (device + shell).**
- Rows whose origin got 409 stay in the outbox, marked held in memory only, with no delete.
- When `snapshot.device.pairingId` ≠ a pending row's `pairingId` and the server answered 409 for it, the POS shell shows a persistent banner: "N sales from another store are waiting on this tablet. Pair it back to that store to send them, or ask a manager."
- Selling continues under the new pairing.
- Same-store carry-over needs no banner; it just drains.

**R5 — Refuse re-pair while money events are pending (settings page).**
- `/settings/pos-tablet`: a client check reads the outbox count, and only counts rows whose origin ≠ the pairing being created. The simplest version: any pending row. If any are pending, it disables Pair / Unpair and shows: "This tablet still has N unsent sales. Connect it to the internet and open the POS until they send, then pair again."
- Money events = all 10 kinds (`outbox.ts:31-42`). Order and stand events change sessions that sales close, so all are counted.
- This is the friendly guard. R3 is the backstop, because the server cannot see IndexedDB.

**Snapshot cache:** a snapshot for a new pairing simply replaces `snapshot['current']`, which is correct, since the menu and store belong to the new store. Nothing else is cleared. IndexedDB is never wiped.

## Out of scope

| Out | Why |
|---|---|
| Exporting held events to a file / ERP import | Pair-back plus same-store carry-over covers every case without it. Ask Ian only if a store is ever closed with held sales |
| Changing the event payload or the inbox parser | The pairing travels at batch level; per-event parsing stays as it is |
| Server-side blocking of a re-pair that revokes a tablet holding sales | The server cannot know the device's queue. Carry-over makes the old tablet recoverable by pairing it back |

## Critical files

- `apps/erp/src/lib/pos-device/{types,outbox,meta,db}.ts`
- `apps/erp/src/app/pos/_shell/{snapshot-sync,drain-send,use-device-sync}.ts` plus the shell banner
- `apps/erp/src/app/api/pos/events/route.ts`; `packages/domain/src/pos/inbox.ts` (`parsePosEvents` accepts `pairingId` at batch level only)
- `packages/db/src/repo/pos-v2.ts` (`getPairingOfStore`)
- `packages/db/src/audit/catalogue.ts` (1 action; raise the t402-s1b and t453 ceilings 262 → 263)
- `apps/erp/src/app/settings/pos-tablet/*` (R5 guard)

## Tests (first, red, then green)

Unit tests use the custom `apps/erp/tests/helpers/fake-idb.ts`. Integration tests extend `t525-pos-routes` / `t526-pos-paired-store`.
1. `enqueue` stamps the bound `pairingId`; it is refused with none bound; a legacy row with no pairing is held and never sent.
2. Drain sends one batch per origin, oldest first, each with its `pairingId`.
3. **Same-store replace:** pending `stand.opened` + `lines.added` + `sale.completed` made on pairing P1. Re-pair the same store to P2, revoking P1. They drain via P2's cookie, are stored with pairing_id = P1, the sale posts to store A, and one audit row is written.
   - Replay of the same batch → `duplicate`, never a double sale.
   - A PIN session only on P2, not P1 → refused as today. This proves the check uses the origin pairing.
4. **Cross-store re-pair:** pending sale and stand events from store A, cookie now store B → 409, zero rows in `pos_events`, nothing applied to B, the events still in the outbox, and the banner shown. Pairing back to A → they drain to A.
5. A forged `pairingId` (another org, or unknown) → 409, nothing applied.
6. R5: the pair button is disabled with the sentence while the outbox has rows, and enabled when it is empty.
7. R3 terminal case: a carried-over `sale.completed` after the till was re-linked to P2 still posts.

Mutant check: drop the same-store condition in R3 → test 4 must go red.

## Verification

- Typecheck.
- Unit pos-device plus shell tests.
- Integration t525, t526, t524, the new t563 file, and `t371` / glossary / action-link-sweep / audit catalogue ceilings.
- Run on the lane's own `_test` DB and its own `npm ci`. Never print `.env.local`.
- Hand-check in a browser: pair to store A, go offline, ring one sale, re-pair to B. You see the banner, and the sale is not in B. Pair back to A and the sale posts.
