# T-479 — Shrinking a waiting party cannot leave more discount claims than diners

**Status:** spec written 2026-10-25 (Opus planner, AUDIT session). Source: Codex audit eighth pass (2026-10-25,
`C:\Users\ianla\shareat-audits\OPEN\audit-2026-10-25-eighth-pass.md`, finding 12, P2), re-verified on
`lane/t455-customer-lobby` f5aff6a (migration then numbered 0217; renumbered 0215 by the orchestrator at 23eb7ae, 25 Oct — this fix is rebased onto 23eb7ae). Stacked PR into that branch (owner: orchestrator), never into main directly.
Defect DEF-774. Numbers from the AUDIT block.

## Finding — DEF-774 (P2, data invariant)
T-455 §2.2 promises "max claims per entry = `party_size` (trigger)". Migration
`packages/db/migrations/0215_t455_lobby_tables.sql` enforces it only on `BEFORE INSERT ON lobby_discount_claims`
(`lobby_discount_claims_cap`, :303-318, trigger :334). `lobby_entries_forward_only` (:218-250) lets `party_size` change
while the entry is `waiting`/`called`, and the CHECK only says 1..30. So: party of 3, three pending claims, then
`UPDATE lobby_entries SET party_size = 1` succeeds and leaves three live claims for one diner; they can then be
approved with no further check (approval is an UPDATE of the claim, not an INSERT).

## Rulings
1. **The cap is checked on both sides.** Add a SEPARATE trigger function `lobby_entries_party_size_cap()` and trigger
   `lobby_entries_party_size_cap BEFORE UPDATE OF party_size ON lobby_entries FOR EACH ROW
   WHEN (NEW.party_size < OLD.party_size)`. It counts `lobby_discount_claims` with
   `org_id = NEW.org_id AND entry_id = NEW.id AND status IN ('pending','approved')`; if that count is greater than
   `NEW.party_size` it raises `check_violation` with a plain message (no claim details). Growing a party, or any update
   that does not lower `party_size`, is untouched.
2. **Do not put the count in `lobby_entries_forward_only`.** That function is a `history_guard` that decides from
   OLD/NEW only (trigger registry rule R1). The new one counts other rows: register it in
   `packages/db/src/triggers/registry.ts` as `kind: 'validator'`, `mode: 'origin'`, like `lobby_discount_claims_cap`.
   `REVOKE EXECUTE ... FROM PUBLIC` and `SET search_path = public, pg_temp`, as the other four.
3. **Concurrency is the existing lock protocol.** A claim insert locks the entry row `FOR UPDATE` before counting; the
   shrink UPDATE holds the same row lock. Whichever goes second sees the other's committed result (the trigger's
   count runs in a fresh READ COMMITTED snapshot; `FOR UPDATE` returns the latest row). No new lock is needed.
4. **Where the SQL goes.** 0215 is unmerged and applied only on throwaway lane/test databases (none of the seven shared
   databases, ADR-012 §5.6), so the trigger is added to 0215 itself (header comment + function + REVOKE + trigger),
   not a new migration — 0218 belongs to the orchestrator's block (0216 is POS T-472, 0217 is T-475 S3) and migrations must reach main in number order
   (board rule 4c). Any lane database that already applied 0215 must be rebuilt from zero (board rule 2). If 0215 has
   reached main by the time this is merged, stop: this becomes a new migration with the next free number.
5. History is kept: existing claims are never changed by the trigger; staff reject or expire claims first, then
   shrink the party.

## Tests (red first) — `packages/db/tests/integration/t455-s1-lobby-schema.test.ts`, real PostgreSQL
On a dedicated database `shareat_audit_t479_test` (never `shareat_test` / `shareat_dev`):
- party 3 with three pending claims → `UPDATE party_size = 1` refused (23514), row unchanged;
- party 3 with two pending + one rejected → shrink to 2 allowed, to 1 refused (only pending/approved count);
- approved claims count the same as pending;
- growing the party (3 → 5) and an update that leaves `party_size` alone are allowed with claims at the cap;
- concurrency: tx A inserts the 3rd claim (holds the entry lock), tx B tries `party_size = 2` and blocks; A commits →
  B is refused. And the reverse order: B shrinks to 2 first, A's 3rd claim insert is refused.
- trigger-registry / class census tests stay green with the new entry.

## Files
`packages/db/migrations/0215_t455_lobby_tables.sql`, `packages/db/src/triggers/registry.ts`,
`packages/db/tests/integration/t455-s1-lobby-schema.test.ts`, `docs/tasks/455-customer-lobby.md` (one line in §2.2
pointing here), `docs/DEFECTS-REGISTER.md` (DEF-774). Nothing else.

## Acceptance
New tests red on f5aff6a for the stated reason, then green; typecheck clean; the whole T-455 schema file green;
the FULL integration suite green on a fresh `shareat_audit_t479_test` (memory rule: a trigger migration is gated on the
full suite); `tests/unit/*guard*`, `*census*`, `app-boundaries`, migration-journal and trigger-registry tests green.
