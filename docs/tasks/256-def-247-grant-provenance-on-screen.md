# T-256 — DEF-247: show *why* a capability is gone

> **Status: RESERVED by the orchestrator, 2026-09-10. Assigned to lane E. Awaiting a SPEC.**
> Number reserved so no peer takes it. Nothing below is built.

T-248 (migration `0140`) added `grant_source` and `revoke_reason` to `person_grants`, and
`/admin/users` can display neither: `accessRepo.grantsForPerson`
(`packages/db/src/repo/access.ts`) selects neither column.

So the revocation is announced **once**, in the success message of the appointment that caused it,
and then becomes unreadable to anyone who was not looking at that screen at that moment — which is
exactly when someone asks *"why did this manager lose that capability?"*

- ⭐ **Two halves, and the register says to group them.** The read side (surface `grant_source` and
  `revoke_reason` on the screen) **and** the write side: the manual revoke button still has no
  reason box, so a human revocation records nothing to display either. Shipping only the read half
  leaves the new column empty for every manual revoke.
- ⚠️ **DEF-237's residue is permanent and in scope to DISPLAY correctly, not to fix:** grants
  written before `grant_source` existed are NULL for ever. The screen must render that honestly —
  "not recorded" — never guess, and never imply a provenance it does not have.
- ⚠️ Bible §13 row 188's monotone rule holds: a stored `grant_source` may only ever move toward
  being LESS revocable. Displaying it must not offer any path that weakens it.

See `docs/DEFECTS-REGISTER.md` DEF-247 and **PROJECT_BIBLE.md §13 row 188**. Found 2026-09-09 by
lane D in the T-248 fresh-eyes review.
