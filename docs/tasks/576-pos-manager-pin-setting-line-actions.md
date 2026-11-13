# T-576 — POS store setting: manager PIN to cancel a line or give a line discount (DEF-833, bible row 460)

Status: SPEC (BOSS, 2026-11-13). POS lane, Sonnet builder + auditor (auth). No migration expected.

## Ruling
Ian, 13 Nov: cashiers may cancel, mark free and discount by design. Build a **store setting, off by default**,
that makes those actions need the manager PIN.

## Today (verified on main)
- Whole unpaid table void: already `approve_pos_correction` or manager PIN, online only (`packages/domain/src/pos/sale.ts:49-82`).
- Line cancel (`order.ts:541-552`, queued lines only) and line discount add/remove (`discounts.ts:84-176`, "no PIN,
  row 440"): `record_sale` only. "Mark free" is a 100% custom discount.

## Build
1. Business rule `pos.require_pin_line_actions` (boolean, default false), per store, editable on the ERP POS
   settings screen with its capability and an audit row (same path as the other POS rules).
2. When ON: `cancelLine`, `addLineDiscount` (custom and preset) and `removeLineDiscount` reuse the void gate:
   allowed if the actor holds `approve_pos_correction`, else `input.approval.pin` verified by
   `verifyPosManagerApproval` (`sale.ts:67-77`). Add `approval: {pin}` to the inbox specs for `line.cancelled`,
   `discount.added`, `discount.removed`, like `session.voided`. The PIN is never stored (the inbox scrub covers /pin/i).
3. UI: the discount sheet and the cancel dialog ask for the manager PIN only when the store's rule is on (the rule
   travels in the snapshot).
4. **Offline — PENDING Ian, recommended:** with the rule ON and the till offline, the action is ALLOWED, marked
   "needs manager review", and the server writes `pos.line_action_unapproved` on drain. Refusing offline would stop
   the floor during an outage; the PIN verifier is online-only (rows 355/356).
5. Rule OFF: exactly today's behaviour.

## Tests
- Rule off: cashier cancels/discounts with no PIN (regression).
- Rule on, online: no PIN refused; wrong PIN refused; manager PIN applied with the approver recorded; actor
  holding approve_pos_correction applied with no PIN.
- Rule on, offline drain: applied, one `pos.line_action_unapproved` row.
- Audit actions catalogued; ceilings raised by the count added.
