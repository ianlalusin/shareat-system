# T-248 — DEF-237: an elevated manager's grants end when an administrator arrives

> **Status: SPEC — awaiting APPROVED.** Lane D, re-spec in plan mode after the block was accepted
> and migration slot **140** was allocated. Sent as `[D] SPEC`; nothing below is built yet.

## Ian decided the shape. This builds it.

**Bible §13 row 188 (corrected), Ian, 2026-09-09 — Option 1: revoke the elevated set when an
organisation gains an active administrator.** The blocked report found the real prerequisite the
row's original estimate missed: `person_grants` cannot tell an auto-elevated grant apart from a
hand-granted one. That correction is now in row 188 itself. This spec builds the schema change
the mechanism needs, plus the mechanism.

## Goal

When an organisation gains an active administrator (an `admin` or `super_admin` appointment),
revoke every `person_grants` row that exists *because* the grant-time fallback (bible row 115)
stood in for a missing administrator — and only those rows. A hand-granted capability, or the
founding owner's equivalence grant, must never be touched by this.

## Scope

1. `packages/db/migrations/0140_t248_def237_grant_provenance_and_revoke_reason.sql` — new
2. `packages/db/schema/access.ts` — two new columns + two CHECK constraints on `personGrants`
3. `packages/db/src/repo/access.ts` — `grantCapability`/`revokeGrantById` signatures, new
   `revokeElevationGrantsForOrg`, new `GrantSource` type
4. `packages/auth/src/roles.ts` — every `grantCapability` call site, `AssignRoleResult`, the
   revocation call inside `assignRole`
5. `packages/domain/src/organizations/index.ts` — `createFirstAdmin`'s one grant-source line
6. `apps/erp/src/app/admin/users/actions.ts` — the revoke-branch reason string, the success
   message addition
7. `packages/auth/tests/integration/roles.test.ts`, `packages/auth/tests/integration/authorize.test.ts`
8. `docs/tasks/248-def-237-revoke-elevated-grants-on-admin-arrival.md` — this file

**Not mine:** `docs/DEFECTS-REGISTER.md`, `PROJECT_BIBLE.md`, the roadmap, the board — the
orchestrator's, per standing protocol.

## Contract

```sql
ALTER TABLE person_grants ADD COLUMN grant_source text;
ALTER TABLE person_grants ADD COLUMN revoke_reason text;
-- + two CHECK constraints, §1 below
```

```ts
// packages/db/src/repo/access.ts
export type GrantSource = 'elevation' | 'owner' | 'grant';

export async function grantCapability(
  tx: Tx,
  input: { personId: string; grantName: string; grantedBy: string | null; grantSource: GrantSource },
): Promise<{ id: string }>;

export async function revokeGrantById(tx: Tx, grantId: string, reason: string): Promise<void>;

export async function revokeElevationGrantsForOrg(
  tx: Tx,
  orgId: string,
  reason: string,
): Promise<{ personId: string; grantName: string }[]>;
```

```ts
// packages/auth/src/roles.ts — AssignRoleResult gains one field
readonly revokedElevatedGrants: readonly { personId: string; grantName: string }[];
```

## 1. The migration — mirroring T-239's `revoke_reason` precedent exactly

Read in full before writing this: `packages/db/migrations/0138_def229_credential_revoke_reason.sql`
and `packages/db/schema/sessions.ts:80-182`. Same shape, same reasoning, applied to the sibling
table it was never applied to.

```sql
-- 0140 — T-248 / DEF-237: person_grants records WHERE a grant came from and WHY it was revoked.
--
-- HAND-WRITTEN, per DEF-073/DEF-121/DEF-242 — drizzle-kit's snapshot chain has been dead since
-- 0019, and `db:generate` fails on a false rename question before reaching this table. Never
-- edited after apply.

ALTER TABLE "person_grants" ADD COLUMN "grant_source" text;--> statement-breakpoint

-- ⛔ Pre-existing ACTIVE grants get grant_source = NULL, deliberately, not backfilled by
-- inference. There is no reliable way to reconstruct whether a row predating this column was
-- auto-elevated or hand-granted (see the task spec §2 for the rejected alternative and why).
-- NULL says "predates this tracking," honestly; it is never eligible for the new revocation
-- (which matches only 'elevation'), so nothing is lost by leaving it unclassified.

ALTER TABLE "person_grants"
  ADD CONSTRAINT "person_grants_source_check" CHECK (
    "grant_source" IS NULL OR "grant_source" IN ('elevation', 'owner', 'grant')
  );--> statement-breakpoint

ALTER TABLE "person_grants" ADD COLUMN "revoke_reason" text;--> statement-breakpoint

UPDATE "person_grants"
   SET "revoke_reason" = 'Revoked before a reason was required — DEF-237.'
 WHERE "revoked_at" IS NOT NULL AND "revoke_reason" IS NULL;--> statement-breakpoint

ALTER TABLE "person_grants"
  ADD CONSTRAINT "person_grants_revoke_check" CHECK (
    ("revoked_at" IS NULL AND "revoke_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL AND btrim("revoke_reason") <> '')
  );
```

⚠️ **The `IS NOT NULL` before `btrim(...) <> ''` is load-bearing, not decoration** — T-239's own
migration proves why: a CHECK passes on NULL, so the naive form accepts a revoked row with a
missing reason. Copied verbatim rather than re-derived, for the same reason it was right the
first time.

Journal entry: `idx: 140`, `when: 1798169507084` (the prior entry, 139, is 1798083107084;
+86400000 matches the file's own 24h spacing convention), `tag:
"0140_t248_def237_grant_provenance_and_revoke_reason"`.

**Schema file**, `packages/db/schema/access.ts` — add both columns to `personGrants` and both
`check(...)` entries to its constraint list, same pattern `schema/sessions.ts` already uses for
`person_credentials_revoke_check`.

## 2. `grant_source` — the three real origins, measured

Every production call site of `accessRepo.grantCapability`, read directly:

| Caller | File | Source |
|---|---|---|
| `assignRole`'s fallback loop | `roles.ts:99-105` | `'elevation'` |
| `elevateManager` | `roles.ts:557-569` | `'elevation'` |
| `createFirstAdmin` | `organizations/index.ts:224` | `'owner'` |
| `grantCapabilityAsActor` | `roles.ts:521-546` | `'grant'` |

`'elevation'` covers **both** the automatic fallback and `elevateManager`'s manual "explicit
tick" (bible row 116) — they exist for the identical reason, a stand-in for a missing
administrator, differing only in *when* and *who* triggers them, not *what* they represent.
`elevateManager` has zero production callers today (confirmed by grep — only re-exported and
used in tests; the console action its own comment describes was never built), but its grants
must still be tagged correctly the day it is wired up, so it is updated now rather than left as
a second silent gap.

`'owner'` is never eligible for revocation: the person holding it already holds the `admin` role
themselves (`createFirstAdmin` sets both in the same call). There is no later "an administrator
arrived" event relative to their own grant — they *are* the administrator from the moment of
bootstrap.

## 3. The backfill decision — recommendation

Pre-existing active grants get `grant_source = NULL` and are **permanently out of scope of this
revocation** — not swept now, not swept later by inference.

**Rejected: treating unclassified as `'grant'`** (the orchestrator's "safe direction" option).
That asserts a specific, unverifiable provenance for a row we genuinely don't know the origin of
— a fabricated attribution, the exact shape T-239's own migration comment names as worse than an
absence ("a fabricated attribution is worse than an absent one, because it reads as evidence").
`NULL` is the honest statement: *predates this tracking*. Functionally the two options behave
identically here (neither gets swept, since the revocation only ever matches `'elevation'`), but
only one of them is true, and this codebase has already paid once (T-239, `revoked_by`) for
choosing the honest absence over the plausible guess.

**The cost, stated plainly:** a manager elevated before this ships keeps their grants until an
administrator notices and hand-revokes via `/admin/users`. Bounded — T-242's rank ladder already
makes this non-escalating, and DEF-237's own register row already logged today's exposure as
effectively zero (production holds few organisations, none multi-administrator).

## 4. Where the fix lives, and when it fires

`assignRole` (`roles.ts:92`) — unchanged conclusion from the blocked report's Q1: the only
production route to an admin/super_admin appointment is `assignRoleAsActor`, which ends by
calling this function, so placing the revocation here covers every real path by construction.
`createFirstAdmin` is confirmed a structural no-op for this defect (§ below) and is not wired.

**Trigger: unconditionally, whenever `input.role` is `'admin'` or `'super_admin'`** — not
conditioned on detecting a 0→1 transition in `hasActiveAdmin`. Reasoning:

- A sweep that matches nothing is a no-op by construction (see Q4 below) — cheaper to always run
  than to first prove "did this org lack an admin a moment ago."
- It self-heals a case a 0→1 check would miss: a manager who was auto-elevated earlier and is
  now *themselves* being appointed admin still has a stale `'elevation'` row on their own person,
  now redundant (their new role grants `manage_users` etc. directly). The unconditional sweep
  clears it with no special case; a 0→1-only check would leave it, since the org already had "an
  admin" the instant before (arguably — this exact appointment *is* the arrival).

```ts
// inside assignRole, after accessRepo.insertRole for the new role
let revokedElevatedGrants: readonly { personId: string; grantName: string }[] = [];
if (input.role === 'admin' || input.role === 'super_admin') {
  revokedElevatedGrants = await accessRepo.revokeElevationGrantsForOrg(
    tx,
    input.orgId,
    'Automatically revoked — this organisation gained an active administrator, so the grant-time ' +
      'fallback that created this row no longer applies (bible row 188, DEF-237).',
  );
}
```

`revokeElevationGrantsForOrg` scopes explicitly by org (repository-layer filtering, RLS as
backstop — bible §7 rule 4), joining `person_grants` to `persons` since the grants table carries
no `org_id` of its own:

```sql
UPDATE person_grants
   SET revoked_at = now(), revoke_reason = $reason
 WHERE grant_source = 'elevation'
   AND revoked_at IS NULL
   AND person_id IN (SELECT id FROM persons WHERE org_id = $orgId)
RETURNING person_id, grant_name;
```

## 5. `createFirstAdmin` — confirmed no-op, not wired, one comment added

Unchanged from the blocked report: `createFirstAdmin` calls `accessRepo.insertRole` directly,
bypassing `assignRole` entirely, and is guarded by `organizationsRepo.orgHasAnyRole` — refuses if
*any* role, even revoked, has ever existed in this org. For it to fire, no manager can ever have
held a role in this org before, so none could ever have been elevated. A comment is added at the
call site (§ Scope item 5) so a future maintainer doesn't "helpfully" wire a dead revocation call
in here.

## 6. The `revokeGrantById` reason — the pragmatic answer, not the full feature

`revokeGrantById` gains a required `reason: string`. Its one production caller
(`setCapabilityGrantAction`'s revoke branch) has no free-text reason field on the screen today.
Per the orchestrator's own framing, a real reason field is "strictly larger than this task" — so
this spec passes a **fixed, honest** system sentence from that call site:

```
'Revoked via /admin/users. No reason was captured on this screen — DEF-237 follow-up.'
```

This is not a fabricated attribution (§3's standard) — it states exactly what is known: a manual
revoke, through this screen, with no free-text reason field to capture more. **Flagged as a
follow-up finding for the register** (a real reason input, mirroring the credential-unlink
form's existing pattern), not built here.

The two direct test calls to `revokeGrantById` in `authorize.test.ts` (`:558`, `:576`) get a
short literal reason string each.

## 7. The message — the side effect made visible

`assignRoleAction` (`apps/erp/src/app/admin/users/actions.ts:117-139`) already reports
`materialisedStoreIds` and `elevatedGrants` rather than letting either be an invisible side
effect (T-219). This adds the third:

```ts
if (result.revokedElevatedGrants.length > 0) {
  const affected = new Set(result.revokedElevatedGrants.map((g) => g.personId)).size;
  extras.push(
    `revoked ${result.revokedElevatedGrants.length} temporary grant(s) from ${affected} ` +
      `manager(s), now that this org has an administrator`,
  );
}
```

## 8. Q4 — idempotence and ordering (carried forward, reasoned through)

- **Two administrators arriving in one transaction.** Cannot happen via the only production
  path — `assignRoleAsActor` takes one `{ personId, role }` per call, and
  `accessRepo.lockOrgAccess` already serialises concurrent transactions on one org.
- **Arrival in an org with no elevated managers.** The `UPDATE ... WHERE grant_source =
  'elevation' AND revoked_at IS NULL` matches zero rows — no-op by construction, proven by a
  test asserting `revokedElevatedGrants` is `[]` and no row anywhere changes.
- **An arrival immediately followed by that admin's own removal.** The revocation already
  happened at arrival; demoting the new admin afterward does not restore what was stripped from
  anyone else. Follows directly from row 188's accepted cost; stated so it reads as intentional.
- **Repeat arrivals (a second admin appointed later).** Second run matches nothing (first run
  already revoked everything eligible) — idempotent by the same no-op-on-empty-match reasoning.

## 9. Q5 — the mid-shift cost, made concrete (carried forward)

Row 188's accepted cost, restated precisely: every server action calls `authorize()` fresh, so
there is no grandfathered in-flight request. The next action a newly-demoted manager submits
that needs the revoked capability is refused with the screen's ordinary denial sentence. The
sharpest real case: a multi-step admin flow (onboarding a new hire across several screens) where
earlier steps that already committed stay committed, and a later step can be refused mid-flow,
leaving partial state behind. No grace period is being added — that would be a different
decision than the one Ian made.

## Tests — red first

`packages/auth/tests/integration/roles.test.ts` / `authorize.test.ts`, lane DB
`shareat_test_t216b`, migrated to `0140` before running.

| # | Case | Proves |
|---|---|---|
| 1 | A manager auto-elevated in an adminless org (`grant_source = 'elevation'` on the row) loses those grants the moment an `admin` is appointed | The defect, closed — red before the fix (grants stay active), green after |
| 2 | Same, but the arrival is a `super_admin` appointment | `input.role === 'super_admin'` also triggers it |
| 3 | An arrival in an org with **no** elevated managers | No-op — `revokedElevatedGrants` is `[]`, zero rows change |
| 4 | A hand-granted capability (`grant_source = 'grant'`) on a manager, in an org that then gains an admin | **Untouched** — the trap this whole task exists to avoid |
| 5 | `createFirstAdmin`'s owner grants (`grant_source = 'owner'`) | Untouched by any later arrival in the same org |
| 6 | A grant with `grant_source = NULL` (simulating a pre-existing row) | Untouched — confirms the backfill decision holds at the mechanism level, not just in the migration |
| 7 | `elevateManager`'s grants (`grant_source = 'elevation'`, no role auto-elevation involved) | Revoked identically to the automatic path — same reason, same eligibility |
| 8 | A repeat arrival (second admin appointed later) | Idempotent — second call finds nothing |
| 9 | The revoked rows carry the fixed `revoke_reason` sentence | `revoke_reason` is populated, not left null under the new CHECK |
| 10 | `revokeGrantById` without a `reason` fails to compile / the two updated test calls pass one | Signature change is real, not decorative |
| 11 | The success message names the count when grants are revoked | `assignRoleAction`'s extras array, asserted at the action layer if reachable from an integration test, else reasoned through in review |

## Out of scope, and why

- **A free-text reason field on the manual revoke-grant screen.** §6 — real UI work, flagged as
  a follow-up finding, not this task's.
- **Reclassifying pre-existing `NULL`-source grants.** §3 — the rejected inference.
- **`hasActiveAdmin`'s own semantics.** Already fixed (T-244); not touched here.
- **Any change to `assignRoleAsActor`'s authority checks, the rank ladder, or the lockout
  guard.** Untouched — this task only adds a side effect after a role write already succeeded.

## 10. Lane D follow-up — the read-only review, and what it changed

Lane D reviewed commit `ae8262e` cold, read-only, per the orchestrator's brief. Five findings;
two became real changes here, three were ruled on without a code change.

**Fix 1 — built.** `grantCapability`'s idempotent (already-active) branch never re-wrote
`grantSource`, and `grant_capability` is itself `{ admin: true, manager: false }` — inside
`ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` — so an auto-elevated manager holds it. That opened an
end-to-end path the task's own Goal line rules out: adminless org, managers M1 and M2 both
auto-elevated (both hold `grant_capability` as `'elevation'`), M1 deliberately hand-grants M2 a
capability M2 already held as `'elevation'` (`grantCapabilityAsActor`'s self-check allows this —
it only refuses granting to yourself), the idempotent branch kept the stale `'elevation'` tag,
and the next admin arrival swept a grant an administrator-authorised actor had just deliberately
made. `packages/db/src/repo/access.ts` now ranks `grantSource` by how eligible it is for the
sweep (`elevation`/`NULL` = 0, `grant`/`owner` = 1) and re-tags the existing row on the idempotent
branch **only when the incoming source strictly outranks the stored one** — a monotone upgrade,
never a downgrade, so finding #3 (the general "idempotent doesn't rewrite" behaviour is correct
for everything else) stays true. `NULL → 'grant'`/`'owner'` upgrades too: a deliberate act today
is real evidence over "predates tracking," and the direction is still downward on the rank.

**Fix 2 — proven, not changed.** `revokeElevationGrantsForOrg`'s org-scoping was already correct
(explicit `exists(...)` correlation through `persons`), but every existing T-248 test ran one org
at a time under RLS, so a regression to an uncorrelated subquery would have passed unnoticed — RLS
would have refused the cross-org write on the application code's behalf, masking the bug. Case 13
runs with **no org principal** (the base connection role, no `set local role shareat_app`, no
`app.org_id`) so RLS is not in play, proving the application code's own correlation. Verified the
test actually catches a regression: temporarily replaced the correlated `exists(...)` with an
uncorrelated one, watched case 13 fail (and only case 13 — 415/416 still passed), reverted, all
457 green again. `git diff` confirmed clean before committing — no trace of the temporary break.

**Tests added** (`packages/auth/tests/integration/authorize.test.ts`, inside the existing T-248
`describe` block): case 12 (the hand-grant-on-idempotent-branch hole, red before Fix 1 / green
after) and case 13 (the two-org scoping proof, red against a deliberately uncorrelated subquery /
green against the real one).

**Finding #3 (ruled — no change).** `roles.ts:149-155`'s claim that the unconditional sweep
"cleans up a stray elevation grant on the appointee's own person" is real but reachable only
through the ungated `assignRole` (CLI/seed) — not through `assignRoleAsActor`, since promoting an
already-elevated manager to admin needs an actor with super-admin authority, which means the org
already had one, so the sweep would have fired earlier. Comment softened to say so; no test added
for a path `assignRoleAsActor` cannot reach.

**Finding #4 (ruled — orchestrator's to fix).** Only two of the three message extras in
`apps/erp/src/app/admin/users/actions.ts` can ever co-fire (`elevatedGrants` needs
`role==='manager'`; the other two need admin/super_admin), confirmed in the browser: *"Role
updated, and granted store scope for 4 store(s), and revoked 1 temporary grant(s) from 1
manager(s), now that this org has an administrator."* Grammatical as written. `actions.ts` is
outside this lane's scope — the orchestrator owns the comment fix there.

**Finding #5 (ruled — register, not this task).** `grantsForPerson` (`access.ts`) selects neither
`grantSource` nor `revokeReason`, so `/admin/users` cannot show a person why a grant is gone. Real
gap, logged by the orchestrator alongside the §6 reason-field follow-up — not built here.

## Done when

Migration applies cleanly on a lane database, verified against `pg_constraint`/`information_schema`
rather than trusted from the migrator's exit code · every database this lane can reach (`shareat_dev`,
`shareat_test`, `shareat_test_t216b`) queried for pre-existing revoked `person_grants` rows before
trusting the `revoke_reason` backfill is a no-op, real counts reported · the 11 cases in §Tests
green on `shareat_test_t216b` via `it.mjs` · full `roles.test.ts` + `authorize.test.ts` green ·
`npm run typecheck -- --incremental false` clean · self-reviewed line by line · full `npm run
test:integration` **not** run (shared DB) · the orchestrator's build, smoketest on 9008, and a
browser pass on `/admin/users` appointing a manager into an admin-less org and then an admin,
watching the message and the grant list — the same "browser is the half a lane cannot verify"
standard T-239/T-242 already held themselves to.

---

### FOR IAN

This builds what you decided. Three things worth your eye:

1. **Grants written before today can't be swept up.** They carry no record of where they came
   from, so I'm leaving them alone rather than guessing — the guess would sometimes be wrong, and
   wrong here means stripping someone's deliberately-given authority. The residue is small and
   already non-escalating (T-242).
2. **The other gap I found — grants couldn't say why they were revoked, at all — is fixed for
   every grant, not just this task's.** One migration does both, cheaper than two.
3. **The existing manual "revoke a grant" button still has no reason box.** I gave it a fixed
   system sentence so the new rule (every revocation states why) doesn't break that screen, but a
   real text field is a small follow-up, not done here.

---

### Model

Spec on Opus (plan mode). ⚠️ Build is Sonnet-able: a hand-authored migration following an exact
precedent, four call-site edits with no new judgement in them, one new repo function, one new
result field, and eleven test cases whose shape is fully specified above. All the judgement —
the backfill decision, the trigger condition, the scope line on the reason field — is resolved
here in writing.
