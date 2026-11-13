# T-575 — POS: warn when a senior/PWD ID was already used (DEF-843, bible row 462)

Status: SPEC (BOSS, 2026-11-13). POS lane, Sonnet builder + auditor. No migration expected.

## Ruling
Ian, 13 Nov: warn on repeated use; never block; no manager PIN.
**Window — RULED (a) same store, same business day (Ian, 13 Nov).** Built, read
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

## Follow-up (AUDIT, 2026-11-14): two tills, one new card, same moment — the trail must still be written

Source: Codex audit 14 Nov 2026, `shareat-audits/OPEN/audit-2026-11-14-senior-repeat-concurrency.md` F1 (P2). No new task
number, no migration, no bible row: this is a correction inside behaviour 4 above.

**Defect (verified on main 327891a).** `completeSale` (`packages/domain/src/pos/sale.ts` ~:262-277) inserts the diner's
`statutory_discount_records` row, then asks `earlierUsesOfCard`. Under READ COMMITTED two sales of DIFFERENT tables that
use the same not-yet-seen card cannot see each other's uncommitted row; both answer "no earlier use"; both commit; the
register holds two uses and `audit_log` holds no `pos.senior_id_repeat` row. The table-session lock covers one table only.

**Fix (exact files).**
1. `packages/db/src/repo/advisory-locks.ts`: add namespace `575001` and
   `lockSeniorCard(tx, orgId, storeId, idNumber)` = `pg_advisory_xact_lock(575001::int4, hashtext(org || ':' || store || ':' || lower(btrim(idNumber))))`
   (the same normalisation as `listPriorIdUses`). Add 575001 to the header list of namespaces.
2. `packages/domain/src/pos/sale.ts`: immediately BEFORE the loop that writes the statutory rows (step 5), take
   `lockSeniorCard` once per DISTINCT card of the sale, in SORTED order of `idNumber.trim().toLowerCase()` (so two
   multi-card sales cannot deadlock). Nothing else moves: the lock is transaction-scoped, the later sale waits for the
   earlier one's commit, then its existing `earlierUsesOfCard` read sees the committed row and writes the trail.
3. No change to `checkSeniorIdRepeat` (read-only blur lookup), to the audit payload, or to any refusal. Both sales still succeed.

**Tests (written first, red before the fix)** in `packages/domain/tests/integration/t575-senior-id-repeat.test.ts`:
- (c1) Two connections. Sale A (table 1) runs `completeSale` inside an open transaction and is held before commit; sale B
  (table 2, same store, same never-used card, different case/padding) is started. Assert B has NOT finished while A is
  open (it is waiting on the lock); commit A; B finishes; both receipts exist; exactly ONE `pos.senior_id_repeat` row,
  on B's receipt, naming A's receipt. Without the lock B finishes early and there are zero rows.
- (c2) Two different cards never wait on the CARD lock (zero advisory waiters while B is blocked) and leave no trail.
  Note found while building: finished sales of one store already queue on the `pos_stores` row (`bumpStateVersion` at the
  end of `completeSale`), so B cannot finish while A is open either way; the defect was that B had already READ the
  register before that wait. (c1) therefore asserts B waits on the card lock (one advisory waiter in `pg_locks`), not timing.
- (c3) Rollback: A is rolled back instead of committed; B then finishes with NO trail (the lock is released, no phantom repeat).
Existing T-575 cases stay green unchanged.
