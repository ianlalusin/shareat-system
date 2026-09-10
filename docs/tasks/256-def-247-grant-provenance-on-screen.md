# T-256 — DEF-247: show *why* a capability is gone

> **Status: SHIPPED `0a984eb`, 2026-09-10 — lane E.** ⚠️ **This header said "SPEC — awaiting
> APPROVED … nothing below is built" until the evening of 2026-09-10, while the work had been on
> `main` for hours — and `docs/ROADMAP.html` carried the same lie in its own entry.** Corrected by
> the next orchestrator, which had no reason to doubt either and checked anyway. The wrap-up commit
> that claimed to fix three stale spec headers missed this one in both places at once. ⭐ **A
> shipped task whose spec still reads "nothing is built" is how the same work gets done twice.**
> ORIGINAL STATUS: written outside plan mode (this terminal is fixed-Sonnet); flagged to the
> orchestrator as bible row 184's deliberate compromise, not an oversight.

T-248 (migration `0140`) added `grant_source` and `revoke_reason` to `person_grants`, and
`/admin/users` can display neither: `accessRepo.grantsForPerson`
(`packages/db/src/repo/access.ts`) selects neither column.

So the revocation is announced **once**, in the success message of the appointment that caused
it (T-219's standard), and then becomes unreadable to anyone who was not looking at that screen
at that moment — which is exactly when someone asks *"why did this manager lose that
capability?"*

---

## Verified before writing this spec

- `person_grants.grant_source` (`packages/db/schema/access.ts:152`) is `text`, CHECK'd to
  `NULL | 'elevation' | 'owner' | 'grant'` (migration `0140`, line 51). `NULL` means "written
  before this column existed" — **deliberately never backfilled** (migration `0140`'s own
  comment, lines 16-23): a guessed provenance is worse than an absent one.
- `person_grants.revoke_reason` (`schema/access.ts:159`) is `text`, CHECK'd
  (`person_grants_revoke_check`) so that whenever `revoked_at IS NOT NULL`, `revoke_reason` is
  **always** non-null and non-blank — either a real reason or, for rows revoked before this
  column existed, the migration's backfilled placeholder: *"Revoked before a reason was required
  — DEF-237."* So the read side never has to render "reason not recorded"; only `grant_source`
  has a true NULL/unknown case.
- `accessRepo.grantsForPerson` (`packages/db/src/repo/access.ts:525`) selects six columns —
  `id, personId, grantName, grantedBy, grantedAt, revokedAt` — and neither new one.
  `GrantRow` (`access.ts:367`) matches that shape exactly.
- `apps/erp/src/app/admin/users/[personId]/page.tsx` renders `activeGrants` (:165-178, name +
  revoke button) and `revokedGrants` (:206-218, name + revoked date only) from that same shape.
- `apps/erp/src/app/admin/users/actions.ts`'s `setCapabilityGrantAction` (:177-215) revoke branch
  (:195-208) already calls `authorize(tx, actor, 'grant_capability', {})` then
  `accessRepo.revokeGrantById(tx, grantId, '<hardcoded sentence>')` — literally: *"Revoked via
  /admin/users. No reason was captured on this screen — DEF-237 follow-up."* That sentence is
  this task's own citation of the gap it closes.
- Precedent for a required reason field on this exact page already exists and is the pattern to
  match: `unlinkCredentialAction`'s form (`page.tsx:276-291`) has
  `<input name="reason" required placeholder="Reason to unlink" className={`${INPUT} w-44`} />`,
  and its domain function `unlinkCredential` (`packages/auth/src/credentials-admin.ts:187-192`)
  trims and refuses a blank one: *"Unlinking a sign-in account needs a reason — a revoked
  credential nobody can explain is not an audit trail."* Grant-writes are gated in THIS app's
  layer already, not in `packages/auth` (`actions.ts`'s own header comment, lines 10-15: *"Scope
  and grant writes are gated here because they have no equivalent orchestration layer and
  `accessRepo` deliberately holds no capability knowledge"*) — so the new validation belongs in
  `apps/erp`, mirroring the wording, not in `packages/auth`.
- `GrantRow` is already re-exported from the `@shareat/db` barrel
  (`packages/db/src/index.ts:222`). `GrantSource` is not. **This spec does not need the barrel
  touched**: every consumer types the new field via `GrantRow['grantSource']`, never by importing
  `GrantSource` directly — the T-251a lesson (barrels are the orchestrator's) applied without
  needing to ask.

---

## Goal

`person_grants.grant_source` and `.revoke_reason` reach the `/admin/users` person-detail screen,
for every grant, active or revoked — and the one write path that currently manufactures a reason
instead of capturing one (the manual revoke button) captures a real one instead, refusing a blank
submission the same way `unlinkCredentialAction` already does one section up on the same page.

---

## Scope — exact files

| File | Change |
|---|---|
| `packages/db/src/repo/access.ts` | `GrantRow` gains `grantSource: GrantSource \| null` and `revokeReason: string \| null`; `grantsForPerson`'s select adds both columns |
| `apps/erp/src/app/admin/users/lib.ts` | **new** exported `grantSourceLabel(source: GrantRow['grantSource']): string`; **new** exported `requireRevokeReason(raw: string): string` |
| `apps/erp/src/app/admin/users/[personId]/page.tsx` | active-grants list shows the source label; revoked-grants list shows the source label AND `revokeReason`; the per-grant revoke form gains a required `reason` input, same shape as `unlinkCredentialAction`'s |
| `apps/erp/src/app/admin/users/actions.ts` | `setCapabilityGrantAction`'s revoke branch calls `requireRevokeReason(str(formData, 'reason'))` and passes the result to `revokeGrantById` instead of the hardcoded sentence |
| `docs/tasks/256-*.md` | this file |
| `apps/erp/tests/admin-users-lib.test.ts` | **new** — unit tests for both new `lib.ts` functions |
| `packages/auth/tests/integration/authorize.test.ts` | extended — `grantsForPerson` round-trips `grantSource`/`revokeReason`, including the legacy-NULL case |

**Not touched**: any migration (`0140` already has both columns) · `grant_source`'s write-time
logic (`grantCapability`, `grantCapabilityAsActor`, `revokeElevationGrantsForOrg` — already
correct since T-248, none of this task's business) · `packages/db/src/index.ts` (no barrel touch
needed, see above) · `apps/erp/src/lib/constraint-messages.ts`, `packages/domain/src/shared/**`,
`packages/domain/src/index.ts` (lane D live) · `PROJECT_BIBLE.md`, the registers, `ROADMAP.html`.

---

## Contract

### 1. Read side — `grantsForPerson` selects what already exists

```ts
// packages/db/src/repo/access.ts

export interface GrantRow {
  id: string;
  personId: string;
  grantName: string;
  grantedBy: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  grantSource: GrantSource | null;
  revokeReason: string | null;
}

export async function grantsForPerson(tx: Tx, personId: string): Promise<GrantRow[]> {
  const rows = await tx
    .select({
      id: personGrants.id,
      personId: personGrants.personId,
      grantName: personGrants.grantName,
      grantedBy: personGrants.grantedBy,
      grantedAt: personGrants.grantedAt,
      revokedAt: personGrants.revokedAt,
      grantSource: personGrants.grantSource,
      revokeReason: personGrants.revokeReason,
    })
    .from(personGrants)
    .where(eq(personGrants.personId, personId));
  return rows as GrantRow[];
}
```

No other function in `access.ts` changes. `GrantSource` (already exported from this file) is now
also reachable through `GrantRow['grantSource']` for any consumer that does not want to import it
by name.

### 2. Display — honest labels, never a guess

```ts
// apps/erp/src/app/admin/users/lib.ts

/**
 * `grantSource` in one word an administrator reads without opening the bible. `null` renders as
 * "not recorded" and ONLY that — never defaulted to any of the three known values (DEF-237's
 * residue, migration 0140: a fabricated attribution is worse than an absent one).
 */
export function grantSourceLabel(source: GrantRow['grantSource']): string {
  switch (source) {
    case 'elevation':
      return 'auto-elevated — clears when this org gains an active administrator';
    case 'owner':
      return 'owner-equivalent grant';
    case 'grant':
      return 'hand-granted';
    case null:
      return 'source not recorded';
  }
}
```

`page.tsx` renders this next to every grant, active or revoked:

```tsx
// active grants (:165-178 today)
<span className="font-mono text-xs">{g.grantName}</span>
<span className="text-xs text-neutral-500 dark:text-neutral-400">{grantSourceLabel(g.grantSource)}</span>
{/* existing revoke form, extended in Contract 3 */}

// revoked grants (:206-218 today)
<span className="font-mono">{g.grantName}</span> — revoked {g.revokedAt?.toLocaleDateString('en-PH', MANILA)}
<span className="block text-neutral-500 dark:text-neutral-400">
  {grantSourceLabel(g.grantSource)} · {g.revokeReason}
</span>
```

`g.revokeReason` is rendered directly, real or backfilled placeholder alike — invariant 3 below is
what makes that safe to do without special-casing.

### 3. Write side — the revoke form captures a real reason

```ts
// apps/erp/src/app/admin/users/lib.ts

/** Mirrors `unlinkCredential`'s own check (`packages/auth/src/credentials-admin.ts:187-192`) so
 *  the two revoke forms on this page read as one system. Grant writes are gated in THIS file's
 *  layer, not `packages/auth` — this page's own actions.ts header already says why. */
export function requireRevokeReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) {
    throw new Error('Revoking a grant needs a reason — a revoked grant nobody can explain is not an audit trail.');
  }
  return reason;
}
```

```tsx
// page.tsx — the existing per-grant revoke form, :168-175 today, gains one input:
<form action={setCapabilityGrantAction}>
  <input type="hidden" name="personId" value={personId} />
  <input type="hidden" name="grantId" value={g.id} />
  <input type="hidden" name="granted" value="false" />
  <input name="reason" required placeholder="Reason to revoke" className={`${INPUT} w-40`} />
  <button type="submit" className={LINK_BTN}>Revoke</button>
</form>
```

```ts
// actions.ts — setCapabilityGrantAction's revoke branch
} else {
  await authorize(tx, actor, 'grant_capability', {});
  const reason = requireRevokeReason(str(formData, 'reason'));
  await accessRepo.revokeGrantById(tx, grantId, reason);
}
```

Order matches `unlinkCredential`: `authorize()` first, reason validation second, write third. A
blank submission throws inside the same `try` the action already has, surfacing through the
existing `backToUser(personId, { error: errorMessage(err) })` path — no new error-handling shape.

---

## Invariants

1. **`grant_source` is never written or modified by this task.** `revokeGrantById`'s signature and
   body are untouched; Contract 3 only ever sets `revoked_at`/`revoke_reason`. Bible §13 row 188's
   monotone rule (a stored `grant_source` may only move toward less revocable, never more) is
   therefore not merely respected — it is unreachable from any code this task adds.
2. **A `NULL` `grant_source` always renders as "source not recorded."** Never inferred from
   `revoke_reason`'s text, never defaulted to `'grant'` or any other value. This is DEF-237's
   residue and it is permanent — Ian has already accepted it (migration `0140`); this task's job
   is to display that honestly, not to soften or hide it.
3. **`revoke_reason` is rendered as stored, without judging whether it is real or backfilled.**
   The DB's own `person_grants_revoke_check` already guarantees it is non-null and non-blank
   whenever `revoked_at` is set (verified above) — there is no "reason not recorded" case to
   invent on the read side, only on the source side (invariant 2).
4. **The revoke form's reason is validated server-side, not only via the HTML `required`
   attribute.** `requireRevokeReason` throws on blank/whitespace-only input before
   `revokeGrantById` is ever called, matching `unlinkCredential`'s own defense-in-depth reasoning.

---

## Tests

| Test | Must show |
|---|---|
| `apps/erp/tests/admin-users-lib.test.ts` (new) — `grantSourceLabel` | maps `'elevation'`/`'owner'`/`'grant'`/`null` to the four distinct strings above; `null` is asserted to say "not recorded", never one of the three known labels |
| same file — `requireRevokeReason` | throws on `''` and on whitespace-only (`'   '`); returns the trimmed string for `'  because reasons  '` → `'because reasons'` |
| `packages/auth/tests/integration/authorize.test.ts` (extended) — `grantsForPerson` round-trips provenance | after `grantCapability(..., grantSource: 'grant')`, `grantsForPerson` returns that row with `grantSource: 'grant'` and `revokeReason: null`; after `revokeGrantById(id, 'a real reason')`, the SAME row now has `revokeReason: 'a real reason'` and an unchanged `grantSource` (proves invariant 1 empirically, not just by code inspection) |
| same file — the legacy-NULL case | a row inserted directly with no `grant_source` (raw SQL, simulating a pre-`0140` grant) round-trips through `grantsForPerson` as `grantSource: null` — never coerced to a string, never thrown on |
| `npm run typecheck` | clean |
| `npm run test` (unit) | green |

No shape-based guard test proposed for this task — DEF-258's guard is a different, already-filed
problem (a repeated same-digit CSS pattern across many files); this task adds one small, already
fully-specified read path with no analogous population to sweep.

---

## Out of scope

| Not doing | Why |
|---|---|
| Backfilling `grant_source` for legacy rows | Impossible without guessing (DEF-237's residue, migration `0140`'s own reasoning) — Ian has accepted this permanently |
| Any migration | `0140` already added both columns; this task only reads and writes within the existing shape |
| Touching `grant_source`'s write-time assignment (`grantCapability`, `grantCapabilityAsActor`, `revokeElevationGrantsForOrg`) | Already correct since T-248; this task is read-and-manual-revoke only |
| A `revoked_by` column on `person_grants` | Migration `0140`'s own header (lines 27-29) already scoped this out as "a decision of its own, not folded in silently" — unaffected by this task |
| A shape-based sweep/guard test | Not asked for here and no repeated-pattern population exists for this specific gap (unlike DEF-258) |

---

## Done when

- `grantsForPerson` selects and returns `grantSource` and `revokeReason` for every row.
- `/admin/users/[personId]` shows the source label for every active AND revoked grant, and the
  revoke reason for every revoked grant — never guessing a `NULL` source.
- The manual-revoke form requires a reason and refuses a blank one server-side.
- New unit tests (`admin-users-lib.test.ts`) and the extended integration test pass.
- `npm run typecheck` clean, `npm run test` green.
- No file changed outside the Scope table; no migration; `grant_source`'s write path untouched.
- Report ends with a `FOR IAN` block.
