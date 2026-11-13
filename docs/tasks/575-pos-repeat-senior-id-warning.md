# T-575 — POS: warn when a senior/PWD ID was already used (DEF-843, bible row 462)

Status: SPEC (BOSS, 2026-11-13). POS lane, Sonnet builder + auditor. No migration expected.

## Ruling
Ian, 13 Nov: warn on repeated use; never block; no manager PIN.
**Window — PENDING Ian (Open Questions `q-def843-window`). Build with (a) same store, same business day**, read
from a store setting so (b)/(c) need no code change: key `pos.senior_id_repeat_window` in the business-rule
registry (`registry.ts` pattern, read in `business-rules/pos-rules.ts`), values `store_day` (default) |
`org_day` | `store_7d`. Admin-editable like the other POS rules (no hard-coded business values).

## Where (verified on main)
- The ID is typed on the payment screen (`apps/erp/src/app/pos/.../PaymentPanel.tsx` ~:207) and sent in
  `sale.completed.seniors[]` (`inbox.ts` ~:166); stored in `statutory_discount_records`
  (`schema/statutory-discounts.ts:83`, index (org, store, business_date) :138). Today's only repeat check is
  per card per invoice (unique index :134).

## Behaviour
1. A read endpoint (or a field on `/api/pos/state`) answers "has this ID (trimmed, case-insensitive) been used in
   the window?" with the count and the last receipt number and time, never the holder's name.
2. On the payment screen, after the ID box loses focus, call it. If used, show a plain warning under the box:
   "This ID was already used today at this store (receipt 000123, 12:41). You can still continue." No block.
3. Offline: skip the lookup silently (the tablet cannot see other tablets' bills). Note it in the runbook.
4. On Finish, the server records the repeat as audit row `pos.senior_id_repeat` (catalogue it; ceilings +1) with
   this receipt and the earlier receipt ids. This is the manager's trail; the warning alone leaves none.
5. Compare against `statutory_discount_records` (which keeps the BIR ID), never `pos_events` (scrubbed by T-572).

## Tests
- Same store, same day: the second use warns; the first does not. Other store same day: no warning under `store_day`.
- Setting `org_day`: the other store warns.
- Finish still succeeds after a warning; one `pos.senior_id_repeat` row written.
- The endpoint never returns the holder name; it requires a paired till and a signed-in cashier of that store.

## Out of scope
- ID format validation (OSCA/PWD formats vary by LGU). Not ruled.
