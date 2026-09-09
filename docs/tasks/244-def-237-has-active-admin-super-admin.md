# T-244 — DEF-237's inner bug: a `super_admin`-only organisation is not "adminless"

> **Status: SPEC — awaiting APPROVED.** Lane D (`ianla-0a`), spec written in plan mode per the
> orchestrator's briefing (bible row 187). Sent as `[D] SPEC`; nothing below is built yet.
>
> ⛔ **This task is deliberately the SMALLER HALF of DEF-237.** The grant-lifecycle question —
> what happens to already-elevated managers — is **Ian's decision and is not built here.** §6
> below ends with the two options written up for him, not with one of them chosen.

## Goal

`hasActiveAdmin` (`packages/db/src/repo/access.ts:63-70`) matches the literal role `'admin'`, so
an organisation whose only administrator holds `super_admin` is wrongly treated as adminless. The
next manager appointed there receives the whole of `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER`
(`capabilities.ts:777`) — which includes `manage_users` (`capabilities.ts:688`) — as if the org
had nobody in charge, when it plainly does. Widen the check so `'admin'` and `'super_admin'` both
count as "this org has an administrator," at the one place that question is asked for this
purpose.

## Scope

Exactly the files the orchestrator granted, no others:

1. `packages/db/src/repo/access.ts` — `hasActiveAdmin`'s query and doc comment
2. `packages/auth/src/roles.ts` — comment only (§5 below)
3. `packages/auth/tests/integration/roles.test.ts` — DEF-234 case 5, rebuilt (§4)
4. `packages/auth/tests/integration/authorize.test.ts` — new regression test(s) (§3)
5. `docs/tasks/244-def-237-has-active-admin-super-admin.md` — this file

**Not mine:** `docs/DEFECTS-REGISTER.md` (DEF-237's disposition), `PROJECT_BIBLE.md` (any new
row), `CAPABILITY-MATRIX.md`, the roadmap, the board — the orchestrator's, per the briefing and
RULES rule 14. `packages/db/src/repo/organizations.ts` — read for §2's argument, not touched.
`packages/domain/**` — read for §2's regression check, not touched.

## Contract

```ts
// packages/db/src/repo/access.ts — signature unchanged, semantics widened
export async function hasActiveAdmin(tx: Tx, orgId: string): Promise<boolean>
```

Before: `true` iff an active `person_roles` row exists with `role = 'admin'`.
After: `true` iff an active `person_roles` row exists with `role IN ('admin', 'super_admin')`.

No new export, no new function, no schema change, no migration.

## 1. The fix

```ts
export async function hasActiveAdmin(tx: Tx, orgId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personRoles.id })
    .from(personRoles)
    .where(
      and(
        eq(personRoles.orgId, orgId),
        inArray(personRoles.role, ['admin', 'super_admin']),
        isNull(personRoles.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}
```

`inArray` is already imported in this file (used by `otherActiveRoleExists`, line 17), so this is
a zero-new-import change. The doc comment above the function (currently "Whether this org
currently has an ACTIVE admin. Drives the grant-time fallback...") gains one line stating the
widened semantics and citing DEF-237, mirroring how `hasOtherActiveAdminWhoCanSignIn`'s comment
already explains why *its* role set differs from `hasOtherActiveAdmin`'s.

## 2. The caller audit — measured, not assumed

The task stub requires finding every caller of `hasActiveAdmin` and stating, per caller, whether
"counts a `super_admin`" is the right reading there. Grepped the whole tree (not `git grep` on a
stale index — a live `Grep` over the working directory): every hit that is not this function's own
definition, a doc citation, or a test assertion is exactly **one** production caller:

| Caller | File:line | Question it asks | Right reading? |
|---|---|---|---|
| `assignRole`, manager-elevation branch | `packages/auth/src/roles.ts:97` | "Does this org have nobody in charge, so the manager I'm about to appoint should stand in?" | **Yes — this is the caller DEF-237 names.** An org run by a `super_admin` has somebody in charge; the fallback existing to cover a genuine leadership gap (bible row 115) must not fire for it. |

No other production code path calls `hasActiveAdmin`. Two adjacent functions ask *different*
questions and are deliberately left alone:

- **`organizations.ts:69`'s `orgHasAnyRole`** — "has this org ever had *any* role, revoked
  included?", used only by `createFirstAdmin`'s bootstrap refusal. Its own comment
  (`organizations.ts:63-67`) already explains why it must be broader than `hasActiveAdmin`: after
  the sole admin is demoted, `hasActiveAdmin` correctly says "no admin now," but the bootstrap must
  still refuse (an org that ever had an authority chain gets its next link from `/admin/users`, not
  from a second "first admin" with a null grantor). Confirmed by reading T-228's spec
  (`docs/tasks/228-organization-bootstrap.md:334-336`), which states this in almost the same words.
  Widening `hasActiveAdmin` changes nothing here — `orgHasAnyRole` doesn't call it.
- **`hasOtherActiveAdmin`** (`access.ts:81-83`) — a different function (takes `excludePersonId`,
  asks "is there *another*"), used by nothing today (superseded by
  `hasOtherActiveAdminWhoCanSignIn` when T-238 fixed DEF-232). Not this task's bug and not
  touched — flagged only so "another admin-counting helper" isn't mistaken for scope creep here.

**Two existing assertions expect `hasActiveAdmin` to return `false`**, per the stub's warning —
`authorize.test.ts:454` and `:511`, both inside the `describe('invariants 9-11 — the grant-time
fallback (bible rows 115-116)')` block. Read both fixtures rather than assuming:

- **Line 454** (`invariant 9`, `authorize.test.ts:450-475`): a brand-new org, one person inserted,
  **zero role rows exist at all** before the assertion. No `super_admin` role exists to be
  newly-counted. Unaffected — still `false`.
- **Line 511** (`invariant 10`, `authorize.test.ts:490-521`): the org's only role history is one
  `admin` row (later revoked via `accessRepo.revokeActiveRole`) and one `manager` row (elevated
  separately, by hand, via `elevateManager`). No `super_admin` role is ever inserted in this test.
  Unaffected — still `false`.

Neither assertion flips. This is stated here as a finding to be *proven* by the red/green run in
§7, not left as a claim from reading — the stub is explicit that a grep is not a reproduction, and
the same standard applies to reasoning about a test's fixture.

## 3. The regression this bug actually causes, reproduced

Reproduced through the real entry point, per the stub's third requirement, using
`packages/auth/tests/integration/roles.test.ts`'s own case 5 (`d234-manager-v-admin`,
lines 912-959) as the existing evidence rather than writing a throwaway script: that test already
constructs a `super_admin`-only org, appoints a manager through `assignRole`, and asserts
`elevated.elevatedGrants` contains `manage_users` (line 937) — **today, that assertion passes**,
which is DEF-237's inner bug executing exactly as the register describes. This is the proof that
the bug is live on the real path, not merely visible in the query.

**New test**, `authorize.test.ts`, added as a sibling to the existing "a manager appointed in an
org that DOES have an admin receives NO elevated grants" case (`:477-488`), same file, same
`describe` block:

```ts
it('a manager appointed in an org whose only administrator is a super_admin receives NO elevated grants — DEF-237', async () => {
  const org = await insertOrg('fallback-9c-super-admin-only');
  const superAdmin = await insertPerson(org, 'Only Super Admin');
  await insertRoleRaw(superAdmin, org, 'super_admin');

  expect(await asPerson(org, (tx) => accessRepo.hasActiveAdmin(tx, org))).toBe(true);

  const person = await insertPerson(org, 'Ordinary Manager');
  const result = await asPerson(org, (tx) =>
    assignRole(tx, { personId: person, orgId: org, role: 'manager', grantedBy: superAdmin }),
  );
  expect(result.elevatedGrants).toEqual([]);

  const actor: Actor = { personId: person, orgId: org };
  await expect(asPerson(org, (tx) => authorize(tx, actor, 'manage_users', {}))).rejects.toThrow(AuthorizationError);
});
```

Red today (elevatedGrants would contain the whole set; `hasActiveAdmin` would return `false`),
green after §1. This is the direct proof the fix works, independent of case 5's rebuild below.

## 4. The blast radius: case 5's SETUP relied on this exact bug

**Not named in the task stub, found while reproducing §3.** `roles.test.ts` case 5
(`⛔ case 5: a MANAGER holding manage_users by grant may not demote an ADMIN — but may demote
STAFF`, lines 912-959) does not merely observe DEF-237's bug — it **depends on it** as the
mechanism that gets a manager holding `manage_users` onto the board, so the rank ladder (T-242)
has something to refuse. Its own comment says so: *"Built the way it actually happens rather than
by hand-granting: the org's only administrator holds `super_admin`, so `hasActiveAdmin` — which
matches the literal `'admin'` — is FALSE, and `assignRole` hands the incoming manager every
capability admin has and manager does not."*

After §1, that setup step **no longer elevates the manager** — the org now correctly reads as
having an administrator. Left unchanged, case 5 would still pass, but for the wrong reason: the
manager would hold no `manage_users` grant at all, so `assignRoleAsActor`'s refusal at step 3 would
come from `authorize()` (no capability), never reaching the rank check the case exists to prove.
A green test that stopped testing its own subject is exactly what RULES §2's *"a test that only
ever passed proves nothing"* warns about, one layer worse: this one **would start** passing for
the wrong reason the moment this fix lands, silently, with no red anywhere to notice by.

**Fix: rebuild the setup to hand-grant `manage_users` directly**, the same technique case 4
already uses for the four `SUPER_ADMIN_ONLY_CAPABILITIES` (`grantRawHere`, defined at
`roles.test.ts:814-818`, "exactly these rows, no grant-time side effects"):

```ts
it('⛔ case 5: a MANAGER holding manage_users by grant may not demote an ADMIN — but may demote STAFF', async () => {
  /**
   * ⭐ The second door, and the reason this is a ladder rather than a super_admin check.
   *
   * ⛔ Before T-244, this state arose automatically: a super_admin-only org's `hasActiveAdmin`
   * read FALSE (the literal-'admin' bug), so `assignRole` elevated the next manager with the
   * whole admin-not-manager delta, `manage_users` included. T-244 closed that — see DEF-237 —
   * so a manager appointed into a super_admin-only org today receives no such grant.
   *
   * The case still needs to exist: the rank ladder must refuse a manager holding `manage_users`
   * BY WHATEVER MEANS from demoting an admin — hand-granted (bible row 116's "explicit tick" path,
   * `elevateManager`, is one real way this still happens today) or, before T-244, automatic. So
   * the grant is now constructed directly, the same way case 4 constructs the owner's four
   * super-admin-only grants, rather than through the closed automatic path.
   */
  expect(ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER).toContain('manage_users' as Capability);

  const org = await insertOrg('d234-manager-v-admin');
  const superAdmin = await insertPerson(org, 'Only Super');
  await insertRoleRaw(superAdmin, org, 'super_admin');
  await giveCredential(superAdmin);

  const manager = await insertPerson(org, 'Elevated Manager');
  await insertRoleRaw(manager, org, 'manager');
  await grantRawHere(manager, ['manage_users' as Capability]);

  const admin = await insertPerson(org, 'Later Admin');
  await insertRoleRaw(admin, org, 'admin');
  await giveCredential(admin);
  await padWithAdmins(org);

  await expect(
    asPerson(org, (tx) => assignRoleAsActor(tx, actorOf(manager, org), { personId: admin, role: 'staff' })),
  ).rejects.toThrow(AuthorizationError);
  expect((await roleOf(admin, org))?.role).toBe('admin');

  const junior = await insertPerson(org, 'A Staffer');
  await insertRoleRaw(junior, org, 'staff');
  await asPerson(org, (tx) =>
    assignRoleAsActor(tx, actorOf(manager, org), { personId: junior, role: 'manager' }),
  );
  expect((await roleOf(junior, org))?.role).toBe('manager');
});
```

⚠️ **Flagged loudly, per T-242's own precedent for editing another task's assertion** (§13.2 of
`docs/tasks/242-def-234-removal-requires-rank.md`, which moved a T-238 test's fixture rather than
rewriting its assertion, for the same reason: keep the test proving what it always proved). Here
the assertions themselves are **unchanged** — same refusal, same success, same roles asserted at
the end — only the four lines that get the manager onto the board change, plus the doc comment.
The case's subject (rank refuses a `manage_users`-holding manager against an admin, but not against
staff) is preserved exactly; only the no-longer-reproducible mechanism for reaching it is replaced.

Also updated: the two other comments in this file that narrate the bug as live —
`roles.test.ts:805-810` (the describe block's own header) and `:917` (case 5's inline comment,
folded into the block above) — both get a "closed by T-244" note rather than being left describing
current-tense behaviour the code no longer has.

## 5. `roles.ts` — one comment, no logic change

The block at `roles.ts:365-393` (attached to the T-242 rank check, explaining why a ladder beats a
narrow super_admin-target patch) narrates DEF-237's bug in the present tense: *"`hasActiveAdmin`
matches the literal `'admin'`, so a super_admin-only organisation counts as adminless."* After §1
that sentence describes behaviour the code no longer has — precisely the shape DEF-175 and this
file's own case-10 comment (`roles.test.ts:1054-1060`) warn against elsewhere in this codebase.

Rewritten to past tense with the closing task named, keeping the part that stays true: the rank
ladder is *independent* protection. It refuses a `manage_users`-holding manager from demoting an
admin regardless of how that manager came to hold the grant — automatically (closed by this task)
or by an explicit hand-grant (still real, e.g. `elevateManager`'s bible-row-116 "explicit tick"
path). No change to the check itself, `assignRoleAsActor`'s ordering, or any exported symbol.

## 6. What DEF-237 leaves open — Ian's decision, not built here

DEF-237's remaining question, unchanged by this task and explicitly not decided here:

- **Option 1 — revoke the elevated set when an organisation gains an active administrator.**
  Cost: a new write path (something has to run at the moment an admin is appointed or reappears,
  scanning for managers holding the elevated set and stripping it) and a decision about *which*
  admin-arrival counts — appointment via `assignRoleAsActor`, `createFirstAdmin`, or both. Breaks:
  a manager mid-shift who is relying on `manage_users` (or any of the other elevated capabilities —
  `manage_prepaid_items`, `run_amortisation`, `manage_chart_of_accounts` and others, per
  `capabilities.ts:777`'s derivation) loses it the instant the write commits, with no grace period;
  if they are mid-approval on something gated by one of those, the action they started may no
  longer be one they can finish. Needs no migration — it is a write against `person_grants`, a
  table that already exists.
- **Option 2 — mark those rows conditional at grant time; `authorize` ignores them once the
  condition lapses.** `authorize.ts:105`'s `matrixAllows || personHasActiveGrant` would need a
  third clause, or `personHasActiveGrant` itself would need to re-check "is the org still
  adminless" on every call that reaches it — turning a row lookup into a row lookup plus a second
  query, on a function everything gates through. Costs a schema change (a way to mark a
  `person_grants` row as *conditional* — a new column, or a distinct grant-reason value) — a real
  migration, unlike Option 1. Breaks nothing mid-shift: the capability lapses only at the moment an
  admin actually exists, not at an arbitrary later sweep, so there is no window where a grant looks
  active but has already been revoked underneath a manager mid-task — but the row itself becomes a
  standing lie the instant an admin appears ("active" until the moment something actually reads it
  and thinks to check), which is a source-of-truth quality Option 1 does not share.

**Recommendation:** Option 1. Option 2's central appeal — no mid-task interruption — is smaller
than it looks, because bible row 115 already commits this project to grants "evaluated once, at
appointment, never at check time" specifically to avoid a fuzzy, re-derived predicate governing
authority (row 115's own reasoning: *"'has an admin' is a fuzzy predicate... auditing would require
the org's admin population as it stood on the day in question"*). Option 2 reintroduces exactly
that fuzziness one layer down — a grant whose validity is re-evaluated at check time is the same
species of problem row 115 already rejected once, wearing a different table. Option 1 costs a
write path Option 2 also needs in a different shape (something still has to notice "an admin just
arrived" either way), and it keeps `person_grants` meaning what its own doctrine
(`access.ts:344-345`) says it means: "these rows are the current truth," full stop, not "current
truth, conditionally." The mid-shift interruption is real but bounded and rare — production holds
one org today, T-242 already makes the exposure non-escalating, and this defect is explicitly not
urgent (per the stub and DEF-237's own register row).

## 7. Tests — full list, red first

`packages/auth/tests/integration/authorize.test.ts` and `roles.test.ts`, lane DB
`shareat_test_t216b` (already migrated to head, `0138` — no migration in this task, so no refresh
needed), via `node ~/.claude/skills/orchestrator/tools/it.mjs shareat_test_t216b <files>`.

| # | Case | File | Why it is not redundant |
|---|---|---|---|
| 1 | `hasActiveAdmin` returns `true` for a `super_admin`-only org | new, §3 | The direct proof of the fix at the function level |
| 2 | A manager appointed into a `super_admin`-only org receives NO elevated grants, and cannot `manage_users` | new, §3 | The real-entry-point proof; red today per the reproduction in §3 |
| 3 | Invariant 9 — genuinely adminless org still elevates | existing, unchanged | Proves the fix does not overcorrect: a real leadership gap still fires the fallback |
| 4 | Invariant 9b — org with an active `admin` elevates nothing | existing, unchanged | Sibling to case 2's new super_admin version; both must hold together |
| 5 | Invariant 10 — revoking the only `admin` (no `super_admin` exists) leaves prior grants untouched, `hasActiveAdmin` still `false` | existing, unchanged | The stub's second flagged assertion; proven not to flip |
| 6 | Invariant 11 — revoked grant stops authorising, stays queryable | existing, unchanged | Unrelated to this bug; must stay green |
| 7 | DEF-234 case 5, rebuilt — manager holding `manage_users` by direct grant still refused by rank against an admin, still permitted against staff | rebuilt, §4 | The blast-radius fix; must fail for the OLD reason before rebuild (setup no longer elevates) and pass for the RIGHT reason after |
| 8 | DEF-234 cases 1-4, 6-10 | existing, unchanged | None construct their scenario through the automatic-elevation path (all use `insertRoleRaw` / `grantRawHere` directly) — confirmed by reading each, must stay green untouched |

⚠️ **Red-first discipline for case 7 specifically:** before the setup is rebuilt, running it
against the post-§1 `hasActiveAdmin` will show the manager's `assignRole` call returning
`elevatedGrants: []` — a different failure shape than "the rank check let the demotion through,"
and worth capturing in the READY report as the "right red" T-242's own protocol asks for.

## Out of scope, and why

- **DEF-237's grant-lifecycle question.** §6 — Ian's decision, not a defect in the sense this
  half is; written up, not built.
- **`hasOtherActiveAdmin`.** §2 — a different function, zero callers, not this bug.
- **Renaming `hasActiveAdmin`.** Considered and rejected: the name already reads correctly for the
  fixed semantics ("has an active administrator"), a rename would touch every doc/comment
  reference outside this task's Scope (DEFECTS-REGISTER.md, PROJECT_BIBLE.md rows 186/DEF-234,
  T-242's own spec) for no behavioural gain, and those historical references are dated entries
  describing the code as it was when written — accurate as history either way.
- **Widening `organizations.ts`'s `orgHasAnyRole`.** §2 — answers a different question on purpose;
  the task stub itself says not to unify without an argument, and reading its own comment supplies
  the argument against.

## Done when

Typecheck exit 0 · the 8 cases in §7 green on `shareat_test_t216b` via `it.mjs` · the whole of
`roles.test.ts` and `authorize.test.ts` green (both touch these paths, same standard T-242 held
itself to) · self-reviewed line by line · then the orchestrator's build, smoketest on 9008 (no
screen surfaces this directly — the manager-elevation path has no UI of its own yet, so this is a
statement that nothing else broke, verified by the wider `npm run build`) · full `npm run
test:integration` **not** run by this lane (shared DB, per RULES row 94 and the briefing).

---

### FOR IAN

DEF-237 had two problems tangled together: a bug nobody had to decide anything about, and a real
lifecycle decision. This task is the bug only.

1. **The bug: an organisation run by a `super_admin` was being treated as if it had nobody in
   charge.** The next manager appointed there was quietly handed the powers of a missing admin —
   including managing other people's access — because the code was checking for the literal word
   "admin" and missing "super_admin." Fixed by widening that one check.
2. **A test had grown a dependency on this exact bug**, using it as a shortcut to set up an
   unrelated scenario. Fixing the bug broke that shortcut; the test is rebuilt to set up the same
   scenario directly rather than through the now-closed hole, and I flagged it rather than quietly
   editing an assertion.
3. **The real question — what to do about managers already elevated this way — is yours**, per §6:
   revoke their extra powers automatically when an admin shows up, or let the powers be granted
   conditionally and lapse on their own. I recommend the first, for the reason bible row 115
   already gave once: this project explicitly chose to evaluate this fallback at one clear moment
   rather than re-derive it continuously, and the conditional option reintroduces the thing that
   was rejected. Not urgent — T-242's rank ladder already makes the exposure non-escalating, and
   production holds one org today.

---

### Model

Spec on **Opus** (lane D, plan mode, per bible row 187 / `opusplan`). ⚠️ **The build is
Sonnet-able and should be Sonnet**: one widened predicate, one doc comment, one rebuilt test setup,
two new test cases. All the judgement — the caller audit, the blast-radius finding on case 5, the
options writeup — is resolved here in writing. Ian's `/model` keystroke in this terminal switches
it; the session cannot switch itself.
