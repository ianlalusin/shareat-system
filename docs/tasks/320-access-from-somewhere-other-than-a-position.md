# T-320 — access that does not come from a position, and the two places it hides

> ### **Status: NUMBER RESERVED — no spec yet. Opened 2026-09-17 by `system32-85` from two findings made during T-318 slice C and D.**
>
> ⛔ **This file reserves T-320 and nothing more.** It is a placeholder holding two findings together
> because they are one subject, written now so the reasoning is not lost between sessions.

## Why these two are one task

T-318 moved 21 everyday capabilities off the automatic `staff` role cell onto **position** grants, on
Ian's ruling that *"one careful setup per store, once"* should mean **what the screen shows is what
the person can do — one rule, one place to read it.**

⭐ **Both findings below are the same shape: a person holds one of the 21 for a reason that is NOT a
position, and nothing on the position screen says so.** Each on its own looks minor. Together they
are the re-emergence, one layer down, of the very thing option (b) was declined for in T-318 — *two
rules answer one question and disagree.*

## Finding 1 — `/admin/users` now offers all 21 as per-person checkboxes

Found by the slice D lane, 2026-09-17, reading `apps/erp/src/app/admin/users/lib.ts` read-only at the
orchestrator's request.

`grantableCapabilitiesFor(role)` is `CAPABILITIES.filter((c) => !CAPABILITY_MATRIX[c][role])` — it
offers whatever the matrix does **not** already grant. For `staff` that returned **75** before the
flip and returns **96** after it, so all 21 now appear as individually tickable in that screen's
`GrantPicker`, all landing in the store-scoped fieldset.

✅ **The half that would have been a real bug is NOT broken, and it was checked rather than assumed:**
`heldNames` is built from `activeGrants`, which includes `grant_source: 'position'` rows, so the
picker correctly excludes anything a position already grants — **nothing is double-counted** — and
`positionProvenanceLine` already labels held ones as *"held through &lt;position&gt; at &lt;store&gt;"*.

⚠️ **What IS wrong is that those 21 render identically to the other 75, with no cross-reference to
`/admin/access-defaults`.** An admin who does not know T-318 happened can tick one and create a stray
per-person override that bypasses the centralisation Ian asked for. ⛔ **This is not a defect — the
per-person grant override is bible rows 115–116 and predates T-318.** It is a screen that invites a
mistake it never used to invite, which is why it is a task rather than a register row.

## Finding 2 — slice D's disclosure cannot see a per-person grant

Slice D adds a line to `/admin/access-defaults`: when a capability is switched off for a position,
the screen says **how many of that position's holders still hold it through another position**,
because the multi-position ruling makes the union invisible otherwise.

⛔ **That count is precise and deliberately narrow, and there is a second way to keep the capability
it cannot see.** `grant_source` `'grant'` and `'owner'` rank **2**, above `'position'`'s **1**, and
`heldPositionGrantsForPersonAtStore` filters to position-sourced rows only — **so a directly-granted
row survives a position switch-off untouched and the disclosure says nothing.** The admin gets the
identical *"the switch did not work"* surprise with nothing on screen to explain it.

⚠️ **Slice D's wording must NOT be broadened to cover this** — *"through another position"* is true
of what it counts, and *"for another reason"* would overclaim a number that does not measure it.
The fix is a second signal, not a vaguer first one.

## ⭐ A verified premise both findings rest on — do not re-derive it

**A person holding two positions keeps the capability when one is switched off. Traced at source
2026-09-17, because the orchestrator expected it to be BROKEN and it is not.**

`reconcilePositionGrants` dedupes to one `person_grants` row per capability with one `source_ref`
(`wantedByCapability` keeps the first id it sees; `GRANT_SOURCE_RANK` transition 4 confirms one row,
one ref). If that ref points at the position being switched off, **step 4 revokes it** — and then
**step 5 re-grants it** from the other position's still-live default, because `existingActive` is
read *after* the revoke and so reads rank −1. Net effect inside one transaction: the person keeps it.
**The union holds.**

⚠️ **One consequence worth carrying:** that person is reported in **both** `revoked` and `granted`
for the same capability in the same reconcile, so an `affected` headcount can count somebody whose
access did not net change.

## Not yet decided

- Whether finding 1 wants a visual marker, a link to the position screen, a confirmation, or nothing
  at all beyond documentation. ⛔ **Removing the per-person override is NOT on the table** — it is a
  standing decision (bible rows 115–116) and predates this.
- Whether finding 2's second signal belongs on the same line, a separate line, or the toggle's
  hover/expanded state.
- Whether the `affected` double-count above is worth correcting or worth only a comment.
