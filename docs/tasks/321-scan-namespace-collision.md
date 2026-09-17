# T-321 — a scanned value can never resolve to the wrong person

> ### **Status: ⭐ SHIPPED 2026-09-17, in TWO releases. CI green on both. Closes DEF-363 and DEF-362.**
>
> | | |
> |---|---|
> | **Release N** `9066147` | the tolerant collision catch — matches Postgres code `23505` + `constraint_name` against the new name **and both legacy ones**. No migration. Deployed to production before N+1 was written. Closes **DEF-362** (the asymmetry: `enrolCard` caught, `enrolFingerprint` had no catch at all). |
> | **Release N+1** `37d9011` | migration `0153` — the generated column and the one cross-column index, net **−1**; `resolveScan` refuses ambiguity instead of guessing; the false doc comment replaced. Closes **DEF-363**. |
> | `b58d0c0` | ⛔ the red-`main` fix — `0153`'s existence broke `0152`'s own proof test, which filtered migrations by FILENAME. See the commit; the same latent bug was in this task's own test 7. |
>
> ⚠️ **§9.4 (the screen gate) — see the Smoketest section.** Sign-in is unusable on a dev machine
> for a reason deeper than DEF-368 records (**DEF-371**), so the terminal was driven via a minted
> pairing token instead. **Read what that route does and does not prove before citing it.**
>
> ⭐ **T-322 carries the removal of the two legacy constraint names**, on a mechanical trigger:
> `0153` confirmed applied in production **plus three deploys since release N**, because the
> rollback window keeps three releases.
>
> **Ian, 2026-09-17: *"start with DEF-363."*** Research is in —
> `docs/discovery/36-def-363-scan-namespace.md` — and it changed three things about the register's
> framing. Read it before this file.
>
> ⛔ **DEF-362 IS IN THIS TASK, NOT A SEPARATE ONE.** The research established that adding the
> constraint alone makes DEF-362 **worse before better**: `enrolFingerprint` has no collision catch
> at all today, so a colliding enrolment would go from *silently permitted* to **a raw Postgres
> violation escaping the domain with no `CredentialError`** — exactly the failure shape
> `enrolCard`'s catch exists to prevent. They ship together or the release is a regression.
>
> ### ⛔⛔ AMENDED 2026-09-17 — *"they ship together"* IS TOO STRONG, AND IT FORBIDS THE SAFE ORDER
>
> **Read precisely, the argument above is not for shipping together — it is for never shipping the
> constraint BEFORE the catch.** Those are different rules and only the second follows from the
> evidence. The bundle satisfied it by accident; **sequencing catch-first satisfies it on purpose,
> and is strictly safer.** T-321 therefore ships as TWO releases:
>
> | | |
> |---|---|
> | **Release N** | the exported constant + **both tolerant catches**. No migration, no index change, no `resolveScan` change. |
> | **Release N+1** | `0153`, `resolveScan`, the schema NOTE and index removal, the comment corrections. |
> | *(later, no hazard)* | drop the legacy literals from the catch's known set — rides any pass that next touches the file. |
>
> ⭐ **Why, and it is this project's own doctrine — bible §15.5 Expand/contract:** *"Never a
> destructive schema change in one step."* T-321 as originally specced does ADD COLUMN + DROP two
> indexes + rename the code depending on those names **in one deploy**. ⛔ **The hazard that creates
> is ROLLBACK, not a failed migration.** `deploy.yml:129-154` already makes code-without-migration
> unreachable (`set -euo pipefail`; the migrate at `:150` is three lines above the symlink swap at
> `:152-153`), so a refused `0153` never activates the new code. **But `:157` keeps the last three
> releases so the app CAN be rolled back** — and rolling back after `0153` has applied leaves the NEW
> schema running OLD code, whose catch matches index names that no longer exist. A catch hardened in
> N+1 sits in the release you just rolled off; only a catch already live in N helps.
>
> ⭐ **Release N is worth shipping on its own merits:** `enrolFingerprint` has **no catch at all** in
> production today — that *is* DEF-362 — so N closes it with no migration, code-only, trivially
> revertible.
>
> ⛔⛔ **AND THE SPLIT SPLITS THE SUITE, WHICH IS THE PART THAT BITES.** Release N ships no migration,
> so four Contract-1 tests **cannot** pass in it, by design: constant-matches-`pg_indexes`, the
> two-old-indexes-are-gone test, the cross-column `enrolFingerprint` test, and spec test 3. **CI runs
> the full integration suite on every push and a red `main` blocks every deploy** — so those land
> WITH N+1, never before. ⭐ And because N's own claim (it closes DEF-362) had **no test proving
> it**, N carries a new same-column test: two fingerprints in one org minting the same token violate
> the *existing* `attendance_credentials_token_live_unique`, which the tolerant catch must turn into
> a `CredentialError`. ⚠️ It asserts the `prerequisite_refusals` row
> (`reason_code = 'attendance.credential.already_enrolled_elsewhere'`) rather than the exception
> type — `CredentialError` is also raised for empty templates and for exceeding `MAX_TEMPLATES`, so
> `toBeInstanceOf` alone could go green **from the wrong branch**, and the missing audit row is the
> silent half of a catch that fails open. ⚠️ It must NOT hard-code a constraint name: the same pair
> raises the legacy name in N and the new one in N+1.

## Why this exists

`resolveScan` (`apps/erp/src/lib/terminal/lane.ts:165-171`) matches a scanned string against card
ids **and** fingerprint tokens as one flat namespace:

```ts
return credentials.find((c) => c.cardId === value || c.matchToken === value) ?? null;
```

The two uniqueness guarantees behind those columns are **independent** —
`attendance_credentials_card_live_unique` and `attendance_credentials_token_live_unique` each
constrain only their own column — so **nothing prevents one employment's card id from equalling a
different employment's match token.** When that happens, **array order decides who you are.**

⭐ **Demonstrated, not theorised:** `lane.fingerprint-seam.test.ts:34-54` sets the two to the same
string on two employments and shows that swapping the array order changes which person an identical
scan resolves to. ⛔ **That test is GREEN today** — it characterises the real behaviour rather than
asserting a safe invariant. **Inverting it is this task's central test change.**

### ⛔⛔ The severity is higher than DEF-363 records, and the function's own comment is why nobody noticed

`resolveScan`'s doc comment says:

> *"⚠️ **This decides what to SHOW, and nothing else.** The punch still carries the credential,
> never the employment."*

**The first sentence is false.** Verified at source 2026-09-17:

| Line | What actually happens |
|---|---|
| `clock/page.tsx:220` | `const method = credential.kind === 'card' ? 'qr' : 'fingerprint';` — derived from the **guessed** kind |
| `clock/page.tsx:245-246` | `credentialKind: credential.kind, credentialRef: value` — **the guessed kind goes into the punch** |
| `packages/db/src/repo/attendance-credentials.ts:90-108` | `resolveCredentialAt` **is** correctly kind-scoped (`column = input.kind === 'card' ? card_id : match_token`, then `where kind = ${input.kind} and ${column} = ${input.ref}`) — and trusts the client-sent kind, which `resolveScan` already corrupted |

> ⛔ **Both citations above were WRONG in the first draft of this spec and were corrected by the
> tester on 2026-09-17, before a line was written.** The first said `:242-243`, which is `db,` and
> `deviceId:` — an off-by-three inside the `writePunch` object. The second named
> `packages/domain/src/attendance/credentials.ts`, and `resolveCredentialAt` **is not in that file at
> all** — it is the repo layer, `packages/db/src/repo/attendance-credentials.ts`, exactly as the
> discovery document had it. ⭐ **The orchestrator took a bare filename out of a message and guessed
> the path.** Bible §13 row 208 in the same week it was written. **The substance of the finding was
> right in both cases; only the pointers were wrong — which is precisely how a wrong pointer
> survives, because the claim around it reads as true.**

⛔ **So the server's correct-looking, kind-scoped query lands on the wrong employment. The
misattribution reaches the punch, and attendance feeds payroll.** The second half of the comment is
true (the punch carries the credential, not the employment) and it is what makes the first half
*sound* safe — bible §13 row 206: a plausible wrong reason is worse than none.

⚠️ **A second consequence nobody has named.** `clock/page.tsx:221-224` refuses when the guessed kind
is `card` and the store has `credentialNfc` off. **So a collision can also cause a WRONG REFUSAL** —
a fingerprint turned away as a disabled card, at a store that never enabled cards.

### Exposure today, stated honestly

⚠️ **Near zero, for a measured reason:** T-314 counted **703 real sessions over 35 days with card,
QR and passcode usage at exactly zero**, and `shareat_dev` holds 1 live card, 1 live fingerprint and
**0 collisions**. ⛔ **That is the mitigation's reason to be calm, not the defect's reason to be
absent.** It goes live the day badges are issued — a decision somebody will make without remembering
this code. **Production cannot be counted from here; do not estimate it.**

## Scope — split by role, and the two sets are disjoint by construction

**BUILDER — source only. You may not edit a single test file.**
- `packages/db/migrations/0153_*.sql` — hand-authored per ADR-012 §5. ⛔ **`when` must exceed
  `1799206307084` (0152's) and be re-derived from `packages/db/migrations/README.md` at build time,
  never copied from this document** (DEF-039).
- `packages/db/migrations/meta/_journal.json`
- `packages/db/schema/attendance-credentials.ts` — the index, **and the exported constant holding
  its name** (Contract 6)
- `apps/erp/src/lib/terminal/lane.ts` — `resolveScan` **and its false comment**
- `packages/domain/src/attendance/credentials.ts` — `enrolFingerprint`'s **new** catch, and
  `enrolCard`'s **catch condition AND message** — ⛔ **both, not just the message** (Contract 5)
- `apps/erp/src/app/clock/page.tsx` — **only** if the refusal needs its own message; report first

**TESTER — tests only. You may not edit a single source file.**
- `apps/erp/src/lib/terminal/lane.fingerprint-seam.test.ts` — ⛔ **the inversion; see Tests**
- `apps/erp/src/lib/terminal/lane.test.ts` or a new sibling unit test for `resolveScan`
- `packages/db/tests/integration/**` — the constraint's own cases
- `packages/domain/tests/integration/**` — the two enrolment paths

**AUDITOR — nothing. Read-only.**

⛔ **Out of scope and orchestrator-owned:** `PROJECT_BIBLE.md` · `docs/ROADMAP.html` ·
`docs/DEFECTS-REGISTER.md` · every other `docs/tasks/*.md`.

## Contract

1. **The database makes the collision unrepresentable.** A value live as a `card_id` in an
   organisation may not also be live as a `match_token` in that organisation.
   ⭐ **The cheap shape, found by the research — do not reach for a trigger.**
   `attendance_credentials_shape_check` already guarantees **exactly one** of `card_id` /
   `match_token` is non-null per row. Therefore a stored generated column
   `coalesce(card_id, match_token)` plus **ONE** partial unique index on `(org_id, <that column>)
   where revoked_at is null` **replaces both existing indexes** — any violation of either old index
   is a violation of the new one. ⚠️ **Net index count goes DOWN by one. If your migration adds a
   third index, you have the wrong design — stop and report.**

   > ### ⭐ THIS DESIGN WAS RUN, NOT ONLY REASONED — orchestrator, 2026-09-17
   >
   > The paragraph above came out of a research pass that deliberately wrote no SQL, so it was a
   > hypothesis. **Bible §13 row 212: a static census only nominates; running settles it.** Built on
   > a scratch table on a lane database (**PostgreSQL 18.6**), with the real shape check and exactly
   > one partial unique index, all five cases behaved as Contract 1 requires:
   >
   > | Case | Result |
   > |---|---|
   > | live `card_id` = live `match_token`, one org | **rejected** by the new index |
   > | same value in a **different** org | accepted — the index is org-scoped |
   > | re-enrol a value whose row is **revoked** | accepted — the index is partial |
   > | two live cards sharing an id | **rejected** by the new index |
   > | two live tokens sharing a value | **rejected** by the new index |
   >
   > ⭐ **The last two are the ones that matter for the migration's safety**, and they are the reason
   > dropping two indexes and adding one is not a loss of coverage: the single index absorbed both
   > old indexes' own jobs, so **net −1 is correct rather than merely cheaper.** ⚠️ This settles the
   > *shape*. It does not settle the migration — Contract 2's refusal on pre-existing colliding rows
   > is still unwritten, and a scratch table has no production data in it.
2. **The migration REFUSES rather than failing obscurely** if live colliding rows already exist,
   naming the offending organisations and staff codes. ⭐ **This is `0152`'s pattern and it earned
   its keep on its first real run** — an index creation that just errors tells an operator nothing.
   ⚠️ Dev has zero collisions; production is unknown, which is exactly why the refusal must exist.
3. **`resolveScan` refuses ambiguity instead of guessing.** When a scanned value matches **more than
   one** credential it returns `null` — the same "not recognised" outcome as an unknown badge, never
   the first match. ⛔ **It must not pick, rank, or prefer a kind.**
4. **`enrolFingerprint` translates a uniqueness violation into a `CredentialError`**, as `enrolCard`
   already does for its own constraint. ⛔ **A raw Postgres violation must never escape the domain**
   (DEF-362).
5. ⛔⛔ **`enrolCard`'s CATCH CONDITION changes, not only its message — and getting this wrong
   re-creates DEF-362 on the one path that currently does it right.** Found by the auditor
   2026-09-17 **before any code was written**, and the first draft of this spec said only
   *"`enrolCard`'s message"*, which invites exactly the narrow reading that breaks it.
   `credentials.ts:161` is `if (String(error).includes('attendance_credentials_card_live_unique'))`
   — **a literal match on an index name Contract 1 DELETES.** Reword the sentence and leave that
   condition alone, and after the migration the `if` never fires, execution falls through to
   `throw error`, and **`enrolCard` starts leaking a raw Postgres violation on every card
   collision.** ⭐ **It would not be silent** —
   `packages/domain/tests/integration/attendance-credentials.test.ts:169-173` asserts
   `.rejects.toBeInstanceOf(CredentialError)` and would fail — **but only if the builder runs it**,
   which is why it is pinned here rather than left to chance.
   Also: the refusal wording stops assuming the partner is a card, because after (1) it can be a
   fingerprint token.
6. ⭐⭐ **THE NEW CONSTRAINT'S NAME IS DEFINED ONCE, IN CODE, AND IMPORTED — NEVER TYPED TWICE.**
   **Its name is `attendance_credentials_scan_value_live_unique`.** Two catch blocks must match it
   (`enrolCard`'s, updated; `enrolFingerprint`'s, new) and the migration must create it. ⛔ **Three
   hand-typed copies of one string is the drift T-317 invariant 6 exists to stop**, and a typo in any
   one of them fails open — the catch simply never matches and the raw error escapes.
   **Export the name as a constant from `packages/db/schema/attendance-credentials.ts`** beside the
   index that declares it, and have both catches import it. ⚠️ **If the SQL cannot import the
   constant, the migration is the one place the literal may appear — and a test must assert the
   constant equals what the database actually created**, so the two cannot drift silently.
7. ⛔ **`resolveScan`'s doc comment must stop claiming it decides only what to show.** Replace it
   with what is true: its output sets `credentialKind` on the punch (`clock/page.tsx:245-246`) and
   therefore selects which column the server resolves against.
   ⛔⛔ **CORRECTED 2026-09-17 BY THE AUDITOR — THIS CONTRACT CARRIED THE OFF-BY-THREE THE SPEC'S OWN
   CALLOUT ABOVE SAYS WAS FIXED.** It cited `clock/page.tsx:242`. **`:242` is `db,`.** The real lines
   are `:245` `credentialKind: credential.kind` and `:246` `credentialRef: value`, verified at source.
   The tester caught this pointer yesterday and it was corrected in the "Why this exists" table while
   **the stale copy survived here** — so one document carried the right pointer and the wrong one
   simultaneously. ⭐ **And this instance had teeth the first one did not:** Contract 7 orders the
   builder to REWRITE `resolveScan`'s doc comment, and that new comment is supposed to cite where the
   kind lands. A builder following this contract literally would have baked `:242` into the
   replacement — **a fresh false pointer, written into the very comment this task exists to correct,
   in a task whose thesis is that a plausible wrong reason is worse than none.**

## Invariants, with citations

1. **No layer may be the only one for a given risk** — bible §15.11. ⭐ **But name the second layer
   honestly.** The research established that *"kind-aware `resolveScan`"* as normally meant — the
   device knowing which reader it heard from — **is not buildable**: a badge reader, a QR scanner and
   the fingerprint reader all **type into one generic text input**, so the device only ever has the
   string. Contract 3 is therefore a **second detector** for a state Contract 1 makes unreachable,
   **not an independently sufficient second lock.** ⛔ Do not describe it as one.
2. **Every schema change is a migration, hand-authored** — RULES §1 rule 9, ADR-012 §5.
   `npm run db:generate` is retired and fails closed.
3. **An applied migration is never edited** — RULES §1 rule 9. `0152` is applied in production.
4. **The database enforces the rules** — RULES §6 item 3. This is the case that rule is *for*: a
   cross-row, cross-column invariant that no service-layer check can hold, because a second writer
   would simply not call it.
5. **Tests before implementation, failing for the right reason** — RULES §3.2, and see below.

## Tests — the tester writes these and watches them go RED before any source changes

⛔⛔ **THE CENTRAL ONE IS AN INVERSION, NOT AN ADDITION, AND IT IS THE HARDEST KIND TO GET RIGHT.**
`lane.fingerprint-seam.test.ts:34-54` **passes today** while demonstrating the defect — it asserts
that array order decides. **A test that documents broken behaviour and is green is not a red
control.** The tester must turn it into an assertion that the collision cannot resolve at all, and
must be able to say what the file asserted before and after.

1. **`resolveScan` returns `null` when a value matches more than one credential.** Both orders. ⭐
   **Assert the order-independence explicitly** — the old test's whole point was that order decided,
   so the new one must fail if anyone reintroduces a `find`.
2. **`resolveScan` still resolves a unique card and a unique token**, unchanged. ⛔ Without this the
   refusal could be over-broad and every other test would still pass.
3. **The database refuses** a live `match_token` equal to a live `card_id` in the same organisation.
4. ⭐ **Two ORGANISATIONS may hold the same value** — the index is org-scoped, and a constraint that
   is accidentally global would break a real multi-tenant case nobody would notice until it bit.
5. ⭐ **A REVOKED row does not collide** — the index is partial on `revoked_at is null`. Enrol,
   revoke, re-enrol the same value: must succeed.
6. **`enrolFingerprint` raises `CredentialError`**, not a raw constraint violation, on a collision.
7. **The migration refuses on pre-existing colliding data**, naming the offenders — seeded
   deliberately on a scratch database, the way `0152`'s own suite does it. ⚠️ **Structurally blocked
   until `0153` exists**, because it must read the real SQL file to exclude-then-apply it; write it
   the moment the file lands rather than something that fails for file-not-found.
8. ⛔ **`enrolCard` still raises `CredentialError` AFTER the rename.** The existing
   `attendance-credentials.test.ts:169-173` already covers it — ⚠️ **but it is in the tester's scope
   and must be RUN and reported by name**, because it is the one test standing between Contract 5's
   trap and a silent regression. If it is not in the tester's RED report, it was not checked.
9. ⭐ **The constant matches reality.** Assert that the exported constraint name
   (Contract 6) equals the name the database actually created — query `pg_indexes` or
   `pg_constraint` on the lane DB. **A constant that drifts from the migration fails open**: the
   catch never matches and the raw error escapes, which is the defect this task exists to close.
10. **Smoketest, in Chrome, against the Firebase emulator** — see below.

## Smoketest — and the pre-flight has already been done for you

⛔⛔ **AMENDED 2026-09-17 — THE PRE-FLIGHT BELOW WAS WRONG AND THE ORCHESTRATOR MEASURED IT (DEF-369).**
This section previously said *"the clock terminal CAN be driven on this machine, unlike `/sign-in`"*,
because its Firebase client reads `process.env.NEXT_PUBLIC_*` **directly with `'emulator'` fallbacks**
and never calls `publicEnv()`. **Every one of those facts is true and the conclusion was still false:
nobody checked whether the fallback fires.** It does not — the fallbacks are `??`, this machine's
`.env.local` holds those values as the **empty string** rather than unset, and `getAuth()`
(`firebase.ts:99`) throws `auth/invalid-api-key` before `connectAuthEmulator` (`:106`) is reached.
`/clock` dropped to the error boundary exactly like `/sign-in`.

⭐ **WHAT THE TESTER ACTUALLY GETS, verified by loading both screens today:** the orchestrator's dev
server on **9008** is started with every `NEXT_PUBLIC_FIREBASE_*` identity value set to a non-empty
placeholder and `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=localhost:8182`, against the emulator suite
(`auth 9198` / `firestore 8182`, `firebase/firebase.json`). With that, **`/clock` renders *"Pair this
terminal"* and `/sign-in` renders both forms, consoles clean** — so the screen gate is reachable and
`/sign-in` is reachable too, which this spec previously assumed it was not. T-200 was verified this
way. ⚠️ **`/clock` still needs a pairing token minted from `/attendance/terminals`, which is behind
sign-in** — the tester reports what it could and could not reach rather than working around it.

**What to drive:** a normal scan still identifies the right person and records a punch. ⚠️ **The
collision case cannot be produced through the UI once Contract 1 lands — that is the point** — so
the browser pass is a **regression check that ordinary scanning still works**, and the tester should
say so rather than implying it exercised the fix.

## ⛔ A DATABASE THAT RAN THIS SUITE BEFORE `0153` CANNOT BE MIGRATED UNTIL IT IS CLEANED

⚠️ **Found 2026-09-17 on three lane databases, and it will happen on every developer machine.**
Two tests in this task deliberately construct a cross-kind collision — `FIXED_TOKEN` in
`attendance-credentials-fingerprint-collision.test.ts`, and `uid('shared')` in
`attendance-credentials-scan-collision.test.ts:109`. ⛔ **Pre-`0153` the colliding insert SUCCEEDS**
— that is the defect they exist to prove — so their `.rejects` assertion fails and **the live pair
is left behind. One pair per run, by construction.**

**So `0153` will refuse on any database where this suite ran before it.** Revoke one side of each
pair and re-run, or recreate the database (DEF-364's disposition, and the cheaper option for a lane
DB). ⚠️ **Grep for BOTH values** — a cleanup that looks for only one literal misses the other.

⛔⛔ **AND THE TRAP IS THE MESSAGE, NOT THE REFUSAL.** Contract 2 names the offending organisations
and staff codes — real ones, because the fixtures build real rows — so the first person to hit this
will reasonably conclude they have found a **genuine data problem in their data**. They have found
their own fixtures. **Contract 2's message cannot distinguish the two, and nothing in it will tell
them.** That is the cost of the refusal being good at its job.

⭐ **A corollary worth stating, because the orchestrator got it wrong and the auditor caught it
before it reached a commit message:** these collisions are **not** evidence that production may hold
any. They are self-inflicted by our own tests. ⛔ Contract 2's justification is, and always was,
that **production is not queryable from here and therefore cannot be estimated** — an argument from
ignorance, which is sound. Replacing it with an argument from evidence our own fixtures generated
would have been unsound *and* would have read as reassurance.

## Out of scope

- Any change to how the terminal reads its input, or to T-304's two-layer sign-in.
- `resolveCredentialAt`'s trust in the client-sent kind. ⚠️ **Named deliberately:** after Contract 1
  the corrupted-kind path is unreachable, so hardening it is defence nobody can currently justify.
  **Report it as a candidate row; do not build it.**
- DEF-357, T-320, and anything on the remittance path.

## Done when

- A colliding pair cannot be stored, and the migration says who is in the way if one already exists.
- `resolveScan` refuses ambiguity; the seam test asserts the refusal instead of documenting the bug.
- `enrolFingerprint` fails like `enrolCard` does, and `enrolCard`'s message no longer assumes a card.
- The index count went **down**.
- Typecheck · unit · integration on the lane DBs · `npm run build` with the dev server stopped ·
  the Chrome regression pass · **`/code-review` clean or its findings dispositioned** · the bible row
  reported to the planner.

## Needs from Ian

**Nothing.** ⚠️ **One thing to tell him at the end:** this closes the last unblocked security item on
the attendance path, and it closes it **before** badges are issued rather than after — which was the
whole argument for doing it while the exposure is still zero.
