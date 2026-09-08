# T-242 — DEF-234: removing a role requires rank, not only granting one

> **BUILT — see §13 "As built".** Lane D (migration lane, Opus 5). Approved 2026-09-08.
> §1a was taken: the bible row carries the concrete peer sentence and the slogan is dropped.
> §1-§12 are the spec **as approved**, left unedited so plan and outcome can be compared.
> The two things that needed deciding are settled: **§1a** — the slogan and the rule are not the same
> system, and the peer rule won; **§3** — a second way into this defect the register row does not
> name, now reproduced through the real entry point (§13.1) and closed by the same ladder.
> **No migration.** The slot was held and not used (§8).

## Goal

Bible row 116 gates *appointing* an administrator and is silent on *removing* one. The gate at
`packages/auth/src/roles.ts:296` fires on `input.role` — the role being **granted** — so
`assignRoleAsActor(actor = an admin, { personId: theSuperAdmin, role: 'staff' })` passes every check
in the function. The authority to appoint is gated; the authority to unmake is not, and removal is
therefore the first move of a promotion.

Ian's answer, relayed 2026-09-08: **peer removal**, and the departed-super-admin case is his. He
accepted out loud that this makes a **third** action depending on him personally (row 116 records two
as accepted), choosing it over junior-only because junior-only *"turns one rare dependency into a
routine one — two admins and no super_admin would mean neither could ever remove the other."*

---

## 1. The rule, stated so it can be built

| Actor's effective rank | May demote / remove a target whose CURRENT role is |
|---|---|
| `super_admin`, **or** `admin` + every `SUPER_ADMIN_ONLY_CAPABILITIES` grant | anyone, including a `super_admin` |
| `admin` | `admin`, `manager`, `staff` — **not** `super_admin` |
| `manager` holding `manage_users` by grant (§3) | `manager`, `staff` — **not** `admin`, not `super_admin` |

Rank: `staff` 0 · `manager` 1 · `admin` 2 · `super_admin` 3. The rule is
`effectiveActorRank >= rank(target's CURRENT role)`.

"Effective" carries one existing subtlety and no new ones: `holdsSuperAdminAuthority`
(`roles.ts:176`) already treats *`admin` + the four super-admin-only grants* as super-admin
authority, because an organisation's first person **cannot** hold a `super_admin` role row (T-232
§2.2). Reusing it means the owner of a new organisation can remove a `super_admin` they appointed.
A separate rank ladder that did not know this would lock them out of their own organisation, and the
symptom would arrive months later.

### 1a. ⛔ The slogan and the rule are not the same system — and the slogan is the one that is wrong

The mnemonic in the register row, which I wrote, is *"the authority to UNMAKE a role is the authority
to MAKE it — one rule, both directions."* **Built literally, that forbids what Ian just said is
allowed.** Making an `admin` requires super-admin authority (row 116). So under the slogan, unmaking
an `admin` would require super-admin authority too — and **an admin could not demote a peer admin**,
which is precisely the outcome Ian rejected when he rejected junior-only.

The concrete sentence in the same row is the correct one and is what this spec builds: *"an actor may
not remove or demote a role **senior** to their own; a **peer** may."* Ian's own reasoning confirms
which he meant — *"two admins and no super_admin would mean neither could ever remove the other"* is
only an argument if admin-demotes-admin is meant to work.

**→ Recommendation for the bible row the orchestrator is writing: use the peer sentence, and do not
carry the slogan.** A mnemonic that contradicts the rule beneath it is worse than no mnemonic — the
next person to derive this will reach for the memorable line, not the table. If the slogan is kept
for its shape, it needs *"…for roles senior to yours"* attached, at which point it has stopped being
short and may as well be the rule.

⚠️ If I have misread Ian and he does mean the slogan literally — an admin may **not** demote a peer
admin — say so and this becomes a two-line change instead: reuse `holdsSuperAdminAuthority` for every
administrative target and delete the rank ladder. It is the smaller build. I am not recommending it,
because it contradicts the sentence he gave his reasoning for.

---

## 2. Where the check goes, and what fires first

Today's order in `assignRoleAsActor`, with the new check as **5b**:

| # | Check | Question it answers |
|---|---|---|
| 1 | `authorize(manage_users)` | may this actor manage users at all? |
| 2 | `lockOrgAccess` (advisory, org-keyed) | T-238 — serialise the read-then-write |
| 3 | self | nobody changes their own role |
| 4 | target is in this org | DEF-183 |
| 5 | §C.1 — **appointment** authority, on `input.role` | may they *make* this role? |
| **5b** | **NEW — removal authority, on the target's CURRENT role** | may they *unmake* the role this person holds? |
| 6 | last-administrator lockout (T-238) | would the org be left with nobody? |

**5b goes immediately after 5, and before 6 — the ordering is the design, not a detail.**

- **Symmetry.** 5 and 5b are the same question in the two directions, and reading them together is
  what stops the next person patching one and not the other. They are also both **authority**
  questions, and this file already puts authority before state: the self check's own comment says
  it is *"checked before the target's level so the message names the real reason."*
- **The message.** An ordinary admin demoting an org's only `super_admin` violates both 5b and 6.
  5b's refusal — *"this person outranks you; a super-admin has to do it"* — is the one they can act
  on. 6's — *"appoint another admin first"* — sends them to appoint an admin, which is real work
  that will not help, and then a second refusal. **Wrong-first-refusal is a loop**, and T-238 already
  learned this once: the `/only active admin/` sentence had to name both halves for exactly this
  reason.

**No double-refusal and no gap.** They cover different failures: 5b asks about the actor's standing
relative to the target, 6 asks about the organisation's floor. Neither implies the other. A
`super_admin` demoting the last `admin` passes 5b and is correctly stopped by 6; an `admin` demoting
a `super_admin` while three other admins exist fails 5b and would never have reached 6.

⚠️ **One read moves.** `targetRole` is fetched at `roles.ts:331`, below the lockout guard's comment.
5b needs it, so the read moves up to just after check 4 and **both** call sites use the one result.
It stays inside the advisory lock (taken at check 2), so the critical section is unchanged. Moving it
is required, not cosmetic: a second `activeRoleForPerson` call would be a second read of a value the
guard depends on, inside the transaction the lock exists to protect.

---

## 3. ⛔ The second door — and it is on the ACTOR side, which the register row does not name

The register row (mine) analysed one shape: an `admin` removing a `super_admin`. There is another,
and it is reachable without anyone being an admin at all.

`ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` is derived as *every capability `admin` holds and `manager`
does not* (`capabilities.ts:777`). `manage_users` is `{ admin: true, manager: false }`
(`capabilities.ts:688`), **so `manage_users` is in that set.** `assignRole` applies the whole set
automatically to any manager appointed while the org has no active admin (`roles.ts:96-108`), as
**grant rows that nothing ever revokes** when an admin returns.

And `hasActiveAdmin` matches the literal `'admin'` only (`repo/access.ts:63-70`) — **a `super_admin`
does not count.** So:

1. An organisation's administrator holds `super_admin` and no `admin` row exists.
2. A manager is appointed. `hasActiveAdmin` is false, so they receive `manage_users` by grant.
3. An `admin` is appointed later. The manager keeps the grant.
4. That **manager** now passes check 1 and can demote the `admin` — a junior removing a senior,
   through the same unguarded door, with no admin actor anywhere in the story.

⚠️ Today step 4 is often stopped by the T-238 lockout guard, but only when the target is the last
administrator who can sign in. With two administrators standing, nothing refuses it.

**The rank rule closes this for free** — a `manager` is rank 1 and cannot touch rank 2 — which is an
argument *for* the rank ladder over a narrower "is the target a super_admin?" patch. A narrow patch
would close the case the register names and leave this one open, and the next person would derive it
a third time. ⚠️ It also means the tests cannot be written only from the register row: §10 case 5
covers this path, and it is the one I would most expect an implementer to skip.

⭐ **Not fixed here, logged in passing (§13 row 164):** that the elevated grants outlive the condition
that justified them is its own defect — the elevation is for an adminless org, and nothing revokes it
when the org stops being adminless. Rank makes it non-escalating, so it is no longer urgent, but
"a manager permanently holding admin capabilities because of a state that ended in March" is a real
finding for the register. **The orchestrator writes the row; I do not touch the register.**

---

## 4. Self-demotion — already closed, and this rule opens no door beside it

Check 3 refuses **every** self role change (`roles.ts:268-273`), regardless of role or rank:
*"an actor may not change their own role — ask another admin, so a mistake here cannot lock the org
out."* So:

- A `super_admin` may **not** demote themselves through this path — not because of rank, but because
  nobody may. The "what if they are the last one" question never arises, because the first question
  never gets past check 3.
- 5b needs **no** self-exception, and must not acquire one. It sits below check 3 and is unreachable
  for `actor.personId === input.personId`.
- The lockout guard (6) is therefore not the thing covering self-demotion either — check 3 is, and it
  is stricter, since it refuses even when the org has ten other admins.

⚠️ **The honest consequence, which belongs in the FOR IAN block:** a super-admin who wants to step
down needs a peer super-admin to do it, and if there is none, that is Ian — the same dependency he
just accepted for removal, arriving from the other side. It is not a new one; it is the same one.

---

## 5. The message, and ⛔ the mapping it will collide with

The refusal has to name **who can**, per the orchestrator's item 3. Proposed:

> `assignRoleAsActor: refusing to demote a 'super_admin' — that role outranks you. A super-admin has`
> `to make this change: the role itself, or an admin holding every capability super_admin has and`
> `admin does not. If this organisation has no super-admin left, only the system owner can do it.`

⛔ **The phrase `requires super_admin` must NOT appear in it.** `apps/erp/src/app/admin/users/actions.ts:48`
matches `/requires super_admin/` and returns *"Only a super-admin can **appoint** an admin"* — so a
message reusing that phrase would tell someone who tried to **remove** a role that they cannot
appoint one. Green build, green tests, a sentence that answers a question nobody asked. This is the
DEF-177 shape and it is one grep away from being shipped by accident.

The new mapping (`outranks you`) therefore needs its own branch, and it must be placed **before** the
`/requires super_admin/` branch is reached — placing it after is only safe while the two phrases stay
disjoint, and relying on that is how the collision comes back. ⚠️ The existing `/only active admin/`
contract is untouched; extending around it is safe, removing it is not.

The screen's role picker offers **every** role for **every** person
(`admin/users/[personId]/page.tsx:96`), so an ordinary admin genuinely sees "staff" as an option
against a super-admin's row and will click it. The message is the entire UX of this rule. ⚠️ Not
proposed here: hiding or disabling the options the actor may not use. That is a real improvement and
a real scope increase (the page would need the actor's effective rank), and a rule enforced only by a
disabled `<option>` is not enforced at all. Logged as out of scope (§11), not forgotten.

---

## 6. Every door to this transition — grepped, not assumed

| Path | Gated? | Reachable by a request? |
|---|---|---|
| `assignRoleAsActor` (`roles.ts:245`) | **yes** — the one gated entry point | yes: `admin/users/actions.ts:110` |
| `assignRole` (`roles.ts:92`) — the ungated primitive | no, deliberately (T-121) | ⚠️ **exported from the barrel** (`auth/src/index.ts:22`). No production caller outside `assignRoleAsActor`; every other caller is a test |
| `accessRepo.revokeActiveRole` | no, deliberately | one production caller: inside `assignRole`. Also called by `authorize.test.ts:510` |
| `accessRepo.revokeRoleById` | no | ⛔ **ZERO callers anywhere** — see below |
| `accessRepo.insertRole` | no | inside `assignRole`, and `createFirstAdmin` (`domain/organizations/index.ts:210`), which has no actor by construction |
| `elevateManager` (`roles.ts:446`) | no — its own comment makes the caller responsible | ⛔ **ZERO callers.** Grants capabilities; cannot change a role, so it is not a door to *this* transition |

⛔ **`revokeRoleById` has no callers and no guard watching that fact.** It removes a role row by id,
outside `assignRoleAsActor` entirely, and it is exactly the *"remove this person's role entirely"*
path the register row warned would need to inherit the rule rather than re-derive it. It is not a
live hole — nothing calls it — but it is a loaded one, and lane C has already reported that neither
caller-existence guard covers `packages/db/src/repo/*`, so nothing will ever tell us when it acquires
a first caller.

**→ Recommendation: leave the function, add the warning to it.** A comment saying *"⛔ if you wire
this up, the rank rule in `assignRoleAsActor` does not apply to it — bring the caller through the
gated entry point instead"* costs one paragraph and is the only thing that will be read by the person
who wires it up. Deleting it is the alternative and I am not proposing it: it is a reasonable
primitive, and deleting code to prevent misuse is how the next person writes a worse version inline.
⚠️ This is a **doc change to a file outside §9's list** — named here so it is approved rather than
smuggled.

`assignRole` being exported from the barrel is the same shape one level up, and already carries the
comment that says so (`roles.ts:54`). No change proposed.

---

## 7. What this does NOT change

- **Appointment.** Check 5 stays exactly as it is. T-232 §2.2's widening is correct and stays.
- **The lockout guard.** T-238's guard, its counting of `super_admin`, and its "who can sign in"
  semantics are untouched. Only its `targetRole` read moves earlier (§2).
- **`manage_users` itself.** The capability answers *"may you manage users"* and must not learn to
  answer *"to whom"* — `CAPABILITY-MATRIX.md` §C.1's own rule, and the reason this check lives at the
  call site rather than in the matrix.
- **The elevated-grant set.** §3's finding is logged, not fixed here.

---

## 8. No migration

No schema change: the rule is a comparison between two values already stored. I hold the migration
slot and will **not** use it for this task — worth saying explicitly, because "the migration lane has
a task" reads as "a migration is coming".

---

## 9. The exact files I may touch

1. `packages/auth/src/roles.ts` — the rank helper, check 5b, the moved `targetRole` read
2. `apps/erp/src/app/admin/users/actions.ts` — the new `errorMessage` branch (§5)
3. `packages/auth/tests/integration/roles.test.ts` — §10
4. `packages/db/src/repo/access.ts` — **comment only**, the warning on `revokeRoleById` (§6)
5. `docs/tasks/242-def-234-removal-requires-rank.md` — this file, gaining "As built"

**Not mine:** `docs/DEFECTS-REGISTER.md` (both DEF-234's disposition and §3's new row),
`PROJECT_BIBLE.md` (the row carrying Ian's answer), `CAPABILITY-MATRIX.md`, the roadmap, the board.
⚠️ `apps/erp/src/app/admin/users/[personId]/page.tsx` is **not** on this list — §5 explains why the
screen is deliberately unchanged, and lane B is sweeping that tree for T-240.

---

## 10. Tests — red first, and each one failing for its own reason

`packages/auth/tests/integration/roles.test.ts`, which already has the fixtures (`insertRoleRaw`,
`giveCredential`, `actorOf`, `asPerson`).

| # | Case | Why it is not redundant |
|---|---|---|
| 1 | ⛔ an `admin` may NOT demote a `super_admin` **while two other admins stand** | The defect itself. The standing admins are load-bearing: without them the T-238 guard refuses first and the case would pass for the wrong reason |
| 2 | ⭐ an `admin` MAY demote a peer `admin` | Ian's rule, and the guard against building §1a's slogan by mistake. **This is the case that fails if someone "simplifies" 5b into `holdsSuperAdminAuthority`** |
| 3 | a `super_admin` may demote a `super_admin` | Peer removal upward |
| 4 | ⭐ an `admin` + all four `SUPER_ADMIN_ONLY_CAPABILITIES` grants may demote a `super_admin` | The new organisation's owner. Fails if the rank ladder is built without `holdsSuperAdminAuthority` |
| 5 | ⛔ a `manager` holding `manage_users` **by grant** may not demote an `admin`, but may demote a `staff` | §3's second door, both halves. The one an implementer working only from the register row will not write |
| 6 | ⛔ the refusal message names who can, and does NOT contain `requires super_admin` | §5's mapping collision, asserted as a string — the only thing that catches it |
| 7 | ⭐ **ordering**: an `admin` demoting an org's only `super_admin` gets the RANK refusal, not the lockout one | §2. Both conditions are true; the assertion is which sentence comes back |
| 8 | a `super_admin` demoting the last administrator is still refused by the lockout guard | T-238 unbroken — 5b passes, 6 fires |
| 9 | self-demotion by a `super_admin` is still refused by check 3, with check 3's message | §4 — proves 5b did not quietly take over a case that was already covered |

⚠️ Cases 2, 4 and 5 are the three that distinguish this rule from every simpler thing it could be
mistaken for. If only one set survives review, it is those.

⚠️ **Lane DB:** `shareat_test_t216b`, at `0138`. No migration, so no refresh is needed beyond what is
already applied.

---

## 11. Out of scope, and why

- **Hiding role options the actor may not use.** §5 — a real improvement, a real scope increase, and
  never a substitute for the server check.
- **Revoking the elevated grants when an org stops being adminless.** §3 — logged for the register.
- **Deleting `revokeRoleById`.** §6 — a comment, not a deletion.
- **A general "rank" concept in the capability matrix.** The matrix answers *what*, never *to whom*
  (§C.1). Rank belongs at this call site, which is where the target is known.

---

## 12. Done when

Typecheck exit 0 · unit green · the nine cases green on `shareat_test_t216b` via `it.mjs` · the whole
of `roles.test.ts` and `authorize.test.ts` green (both touch these paths) · self-reviewed line by
line · then the orchestrator's build, smoketest on 9008, and a browser pass on `/admin/users/[personId]`
attempting the refused demotion so the mapped sentence is **seen**, not inferred (§5 is a string
contract, and T-239's own lesson is that the browser half is the half a lane cannot verify).

---

### FOR IAN

You answered the question about who may remove an administrator: **you may remove an equal, never
someone senior.** This builds that. Three things worth your eye, none of them urgent:

1. **The catchphrase in the register contradicts your answer, so I am dropping it.** It said *"the
   authority to unmake a role is the authority to make it."* Taken literally that would stop one
   admin from demoting another admin — since making an admin needs a super-admin — which is the exact
   thing you said you did not want. Your actual sentence is the one being built.
2. **There is a second way in that nobody had spotted, and your rule closes it anyway.** When an
   organisation has no admin, a manager appointed at that moment is automatically given the admin's
   powers — including managing users — and nothing takes them back when an admin is appointed later.
   So a manager could remove an admin. Ranking fixes it without any extra work. Separately, those
   powers outliving the situation that granted them is worth its own small job later; I have flagged
   it rather than widening this one.
3. **Stepping down is the same dependency, from the other side.** Nobody can change their own role —
   that rule already exists and stops a mis-click locking everyone out. So a super-admin who wants to
   hand over needs another super-admin to do it, and if there is none, that is you. Same dependency
   you already accepted, not a new one.

---

### Model

Spec on **Opus 5** (lane D). ⚠️ The build is **Sonnet-able and should be Sonnet**: one comparison, one
moved read, one error branch, nine named test cases. The judgement is all in §1a and §3, and it is
resolved here in writing. Ian would need to `/model sonnet` this terminal — a session cannot switch
itself.

---

## 13. As built (lane D, 2026-09-08)

Approved with §1a's call taken: the bible row gets the **concrete peer sentence** and the slogan is
dropped, not softened. The orchestrator confirmed the reading and told Ian the mnemonic was its own
and wrong.

### 13.1 The second door, reproduced through the real entry point before it was closed

§3 was an argument from three greps. It is now an executed fact: with the rank check absent, case 5's
manager — elevated automatically, never hand-granted — **successfully demoted an admin**, and the
test failed with *"promise resolved instead of rejecting"*. The chain runs exactly as specified:
`manage_users` is in `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` → `hasActiveAdmin` matches the literal
`'admin'` so a super_admin-only org is "adminless" → `assignRole` grants the set → nothing revokes it
when an admin arrives. This is the case that would have survived a narrow super_admin-target patch.

### 13.2 ⛔ One test from T-238 had to change, and it is another task's assertion

`⛔ REFUSES demoting a SUPER_ADMIN when nobody able to sign in is left` went red: its actor is an
`admin` and its target the org's only `super_admin`, so the new rank check now refuses **first** —
which is precisely case 7's assertion.

**Not rewritten to match the new behaviour. Its fixture moved so it keeps testing its own subject.**
That test exists to prove the *lockout guard* covers a `super_admin` TARGET (before T-238 the branch
read `targetRole?.role === 'admin'` and skipped it). Asserting the rank message there would have
quietly retired that proof. So the actor became a `super_admin` — a peer, so rank passes and the
lockout guard is again the thing that fires — and **its assertion is unchanged**. The admin-actor
version of the fixture now lives in case 7, which owns the rank message.

⚠️ Flagged loudly because it is an edit to an assertion another task wrote deliberately. The file was
already in §9's list, so it is not a file-list deviation; it is a judgement worth a second pair of
eyes in review.

### 13.3 ⭐ A tenth case, and it corrected the implementation's own comment

`actorRank` returns `-1` for an actor with no active role, and I wrote a comment claiming somebody
could reach it that way holding `manage_users` as a bare grant. **Case 10 proved that false**:
`authorize` refuses a roleless actor outright — *"has no active role in org"* — before rank is ever
consulted. The -1 is defence in depth, not a live path.

The comment now says so, and case 10 asserts *`authorize`* is the refuser, so the day the capability
layer starts admitting a bare grant-holder the case says so instead of passing quietly. A comment
describing behaviour the code does not have is the DEF-175 shape this very file warns about; it was
one self-review from shipping.

Case 10's second half is the live one and is the boundary of the whole rule: **appointing a person
who holds no role must still work.** Nothing is being unmade, so the check must not fire — a ladder
that refused this would have turned a removal rule into an appointment rule and broken every first
appointment in an organisation.

⚠️ Beyond the nine approved cases. Added because it covers a branch I introduced that nothing else
reached, which is exactly what self-review is for.

### 13.4 Considered and deliberately not done

`holdsSuperAdminAuthority` runs twice when the assignment is an appointment to admin/super_admin AND
the target already holds a role — once in check 5, once inside `actorRank`. Left alone, with a
comment saying so: it is a few indexed reads on the rarest path through this function, and caching it
would put a stale-by-construction variable in the middle of the one place where every read must be
the locked transaction's own.

### 13.5 Evidence

| Gate | Result |
|---|---|
| Red first, and the right red | cases **1, 5, 6, 7** failed; **2, 3, 4, 8, 9 passed before the change** — correct, they assert behaviour that must be *preserved*, and they are the guard against over-tightening. Case 5 failed as "promise resolved instead of rejecting" — the defect, executed |
| `roles.test.ts` | **41 passed** (nine spec cases + case 10 + the 31 pre-existing) |
| The adjacent sweep | **536 passed (9 files)** — `authorize`, `credentials-admin`, `sessions`, `first-run-setup`, `organizations`, `stores`, `money-accounts-access`, `prepaid`, `email-sign-in` |
| Unit | **77 files, 1163 passed / 1 skipped** |
| Typecheck | **clean — exit 0, zero errors project-wide.** The two peer files that were red during T-239 have since landed |
| Migration | none, as specified — the slot was not used |

⚠️ **Not run by this lane, by protocol:** `npm run build`, the dev server, the browser, and full
`npm run test:integration`. The browser pass matters here: §5's mapped sentence — *"You cannot change
the role of somebody senior to you…"* — is a **string contract** between `roles.ts` and
`actions.ts`, and case 6 proves only that the two halves cannot silently diverge. That the sentence
actually reaches the screen has **not been seen**.
