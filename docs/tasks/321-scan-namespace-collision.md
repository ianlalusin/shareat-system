# T-321 — a scanned value can never resolve to the wrong person

> ### **Status: SPEC — written 2026-09-17 by `system32-85` (Opus planner). NOT BUILT. Reserves T-321 and migration `0153`. Closes DEF-363 and DEF-362.**
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
| `clock/page.tsx:242-243` | `credentialKind: credential.kind, credentialRef: value` — **the guessed kind goes into the punch** |
| `packages/domain/src/attendance/credentials.ts:90-108` | `resolveCredentialAt` **is** correctly kind-scoped — and trusts the client-sent kind, which `resolveScan` already corrupted |

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
- `packages/db/schema/attendance-credentials.ts`
- `apps/erp/src/lib/terminal/lane.ts` — `resolveScan` **and its false comment**
- `packages/domain/src/attendance/credentials.ts` — `enrolFingerprint`'s catch, `enrolCard`'s message
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
5. **`enrolCard`'s refusal message stops assuming the collision partner is a card.** After (1) the
   partner can be a fingerprint token, and the current wording would be wrong.
6. ⛔ **`resolveScan`'s doc comment must stop claiming it decides only what to show.** Replace it
   with what is true: its output sets `credentialKind` on the punch (`clock/page.tsx:242`) and
   therefore selects which column the server resolves against.

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
   deliberately on a scratch database, the way `0152`'s own suite does it.
8. **Smoketest, in Chrome, against the Firebase emulator** — see below.

## Smoketest — and the pre-flight has already been done for you

⭐ **The clock terminal CAN be driven on this machine, unlike `/sign-in`.** It has its own Firebase
client (`apps/erp/src/lib/terminal/firebase.ts`) which reads `process.env.NEXT_PUBLIC_*` **directly
with `'emulator'` fallbacks** and honours `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST` (line 71, wired at
101-108) — ⛔ **it never calls `publicEnv()`, which is why it does not hit DEF-368's wall.** Emulator
ports are `auth 9198` / `firestore 8182` (`firebase/firebase.json`). T-200 was verified this way.

**What to drive:** a normal scan still identifies the right person and records a punch. ⚠️ **The
collision case cannot be produced through the UI once Contract 1 lands — that is the point** — so
the browser pass is a **regression check that ordinary scanning still works**, and the tester should
say so rather than implying it exercised the fix.

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
