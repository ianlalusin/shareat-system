# T-438 — Hire by last/first/middle name; staff sign in by PIN only

**Status:** LIVE 2026-10-17 (PR #35, migration 0207). Hire by last/first/middle name; staff PIN-only.

## Goal, in plain words

1. The Hire screen asks for **Last name, First name, Middle name** (middle optional). If nobody was picked from
   the search, saving creates the person from those boxes. The "Create new person named" radio goes. Every other
   screen keeps reading `display_name`, which for these people reads **`Last, First M.`**.
2. A person whose role is **staff** (or who has no role) can no longer sign in with email/password, even if an
   email account is linked. They sign in with their PIN. Manager, admin and super-admin keep both.

## Rulings

**N1 — `display_name` stays a plain column, written by the domain. Not a generated column.** A generated column
cannot hold a name for a row with no parts, and five writers create persons with one string only (table N6).
Instead a **CHECK ties them together**: when the parts are set, `display_name` must equal the formatted parts. The
domain formats; the database refuses any drift. One formatter in TypeScript, one expression in the CHECK; test D2
proves they agree.

**N2 — Format.** `last + ', ' + first`, then, when there is a middle name, `' ' + UPPER(first letter of middle) + '.'`.
Each part is trimmed and inner runs of spaces collapsed to one before storing. Last `Dela Cruz`, first `Juan
Miguel`, middle `santos` → `Dela Cruz, Juan Miguel S.`. An empty middle (after trim) is stored as NULL, never `''`.

**N3 — Existing rows are NOT split. Parts stay NULL, `display_name` untouched.** Production has a handful of
people (Ian, the Lipa hires, the v1 master-data load). Guessing which word is the surname in a Filipino name
("Maria Dela Cruz Santos") is wrong often enough to corrupt names silently, and a wrong guess would then be
*locked in* by the CHECK. Terminals and the usage system author are not people and must never get parts. A legacy
name is fixed by retyping it once on the staff page (slice S2b), which writes the three parts and the new
`display_name` together. Nothing reads the parts for display, so NULL parts break nothing.

**N4 — Duplicate guard (keeps T-154 invariant 8).** Searching still never creates anyone. On save with typed parts,
the domain looks for persons of kind `person` in the org whose **name key** equals the new one. Name key =
lowercase, punctuation removed, split on spaces, **one-letter words dropped** (a middle initial does not count),
words sorted, joined. Built from last + first for the new person, from `display_name` for existing rows — so
legacy `Maria Santos`, new-style `Santos, Maria C.` and a typed `Santos` / `Maria` all collide. On a match the save
is refused: *"Someone named Santos, Maria C. is already in the system. Search for them and pick them, or tick 'This
is a different person with the same name'."* The form shows that checkbox (`sameNameConfirmed`); ticked, the create
goes ahead and the audit row records `sameNameConfirmed: true`. Candidates are narrowed in SQL (`display_name ilike
%<last>%` OR `lower(last_name) = lower(<last>)`, kind `person`, this org), then keyed in TypeScript.

**N5 — Picked AND typed is refused, not guessed.** A search-result radio picked and a name also typed:
*"You picked Santos, Maria and also typed a new name. Keep only one."* Neither: *"Pick a person from the search, or
type their last and first name."* Last without first, or the reverse: *"A new person needs both a last name and a
first name."* The radios lose `required`; the server decides.

**N6 — Every person-creating path, and what it passes after this task.**

| Caller | Today | After T-438 |
|---|---|---|
| `apps/erp/src/app/staff/actions.ts` `hireAction` → `createPerson` | `displayName` | `{ name: { lastName, firstName, middleName? }, sameNameConfirmed }` |
| `scripts/lib/master-data-apply.ts:486` → `createPerson` | v1 `fullName` | unchanged `{ displayName }`, parts NULL. Its S4 same-person sheet is its duplicate guard; N4 does not run on this path |
| `packages/domain/src/organizations/index.ts:259` `createFirstAdmin` → `insertPerson` | `displayName` | unchanged, parts NULL |
| `scripts/provision-terminal.ts:232` → `insertPerson` (`kind: 'terminal'`) | `Terminal — <store>` | unchanged, parts NULL |
| `packages/db/src/repo/stock-usage.ts:497` usage system author (`terminal`) | constant | unchanged, parts NULL |
| `scripts/dev-seed.ts:102`, `scripts/smoke-pin-throttle.ts` (raw SQL) | `display_name` | unchanged (the CHECK allows all-NULL parts) |
| CUSTOMER diners as persons (rows 347-350), POS | no writer exists yet | nothing to change |

`createPerson` input becomes a union: `{ storeId, name: { lastName, firstName, middleName? }, sameNameConfirmed? }`
or `{ storeId, displayName }`. `insertPerson` gains optional `name`; when given it computes `displayName` itself
with the shared formatter, so no caller can pass a mismatching pair.

**N7 — Search matches any part, in any order.** `searchPersons` splits the query on spaces; **every** word must
match (`ilike %word%`) at least one of `display_name`, `last_name`, `first_name`, `middle_name`. "maria santos",
"santos maria" and a full middle name all find `Santos, Maria C.`. The `kind = 'person'` filter and the T-435
elsewhere-only shape stay as they are. Empty query behaves as today.

**N8 — Email sign-in needs a manager-or-higher role (row 361).** New repo read
`accessRepo.personMayUseEmailSignIn(tx, personId, orgId)`: an active (`revoked_at is null`) `person_roles` row in
that org with role in (`manager`, `admin`, `super_admin`). Called in `runFirebaseSignIn`
(`packages/auth/src/sessions.ts`) **after** the existing `personMaySignInToOrg` check, refusing with
`'Sign-in failed: staff sign in with their PIN. Ask an admin if this is wrong.'` (same shape as `NO_ACCESS`) and
`enqueueSigninRefused(..., 'pin_only_role')`.
- ⛔ **Do NOT change `personMaySignInToOrg`.** It also gates PIN approvals (`admin-approval.ts:60`,
  `pos-approval.ts:65`); folding the rule in would lock staff out of their PIN paths.
- **No role at all** (a fresh hire before anyone sets a role) is refused too: email is a privilege of the three
  named roles, not a default. `authorize()` already gives an unroled person nothing.
- **"Staff at one store, manager at another" cannot happen:** a role is per ORG (one active role per person per
  org, partial unique index); stores are scope rows. A manager anywhere in the org keeps email. A staff person with
  a position-granted capability (e.g. a payroll clerk) is still PIN-only: capabilities are not roles.
- **Sessions already open:** `resolveActor` does not re-check per request, and a query on every request is not
  worth it for a handful of people. Email sessions opened before deploy run out at the 7-day TTL. Smoke step 6
  counts them on production; if any exist, Ian ends them through the existing credential revoke.

**N9 — Positions on the Hire screen (only DishWasher / Panda / Server, no Cashier).** `listPositions`
(`packages/db/src/repo/employment.ts:121`) is correct: org-wide or this store's, active only. `DishWasher` and
`Panda` are not canonical spellings, so these are v1-imported store positions, and the six canonical ones
(`Cashier, Cook, Server, Dishwasher, Slicer, Inventory Staff`) look **never seeded** for the production org (it
predates T-335's seeding at org creation; the domain `seedCanonicalPositions` has no production caller).
`scripts/backfill-canonical-positions.ts` exists for exactly this. No code bug found. **Data question, Ian is
checking separately; out of scope.**

## Migration 0207 — `0207_t438_person_name_parts.sql` (hand-authored, ADR-012 §5)

```sql
-- T-438 (bible row 360): a person's name is last/first/middle; display_name is derived "Last, First M.".
-- Existing rows keep display_name and NULL parts (spec N3). No backfill, no data step.
ALTER TABLE "persons" ADD COLUMN "last_name" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "first_name" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "middle_name" text;
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_name_parts_check" CHECK (
  (last_name IS NULL AND first_name IS NULL AND middle_name IS NULL)
  OR (
    last_name IS NOT NULL AND first_name IS NOT NULL
    AND last_name <> '' AND first_name <> ''
    AND last_name = btrim(last_name) AND first_name = btrim(first_name)
    AND (middle_name IS NULL OR (middle_name <> '' AND middle_name = btrim(middle_name)))
    AND kind = 'person'
    AND display_name = last_name || ', ' || first_name
        || coalesce(' ' || upper(left(middle_name, 1)) || '.', '')
  )
);
```
- No new table → **no change** to `cutover/classification.ts` or `rls/registry.ts`; `persons` RLS unchanged.
- `UPDATE` on `persons` is already granted (`setSignatureFileId` updates it); builder confirms, adds no grant.
- Journal entry on the grid (§5 step 5). Schema mirror in `packages/db/schema/persons.ts`: three `text` columns and
  the same `check(...)` in the builder (Drizzle can express it, so it lives in both, §5 step 3).
- Additive and nullable: safe on production. Prove it on a scratch DB (§5 step 8).

## Slices

| Slice | What | Depends on |
|---|---|---|
| **S1 — PIN only for staff** | N8: repo read, sign-in check, refusal reason | nothing (no migration) |
| **S2a — names on hire** | 0207, schema, formatter, `insertPerson` / `createPerson` / `searchPersons`, N4, N5, N7, Hire screen + action | — |
| **S2b — rename** | `renamePerson` + a "Name" form on `/staff/[employmentId]` | S2a |

**S2b detail.** `renamePerson(tx, actor, { employmentId, lastName, firstName, middleName? })`: loads the employment,
`authorize(enrol_staff, { storeId: employment.storeId })` (same capability as hiring), refuses a `terminal` person,
writes the three parts and `display_name` together with `updated_at = now()`, appends audit `person.renamed` with
before/after `displayName` only (row 353: nothing else). N4 does **not** run on rename (same person). The form shows
the current parts, or empty boxes with the current `display_name` as a hint when parts are NULL.

## BUILDER paths (source only)

S1: `packages/db/src/repo/access.ts` · `packages/auth/src/sessions.ts` · `packages/auth/src/security-events.ts`
(add `'pin_only_role'` to the reason union).

S2: `packages/db/migrations/0207_t438_person_name_parts.sql` · `packages/db/migrations/meta/_journal.json` ·
`packages/db/schema/persons.ts` · `packages/db/src/repo/persons.ts` · `packages/domain/src/people/person-name.ts`
(new: `formatDisplayName`, `normaliseNamePart`, `nameKey`) · `packages/domain/src/people/index.ts` ·
`packages/domain/src/index.ts` (exports only) · `apps/erp/src/app/staff/actions.ts` ·
`apps/erp/src/app/staff/hire/page.tsx` · `apps/erp/src/app/staff/[employmentId]/page.tsx` ·
`apps/erp/src/app/staff/lib.ts` (detail loader returns the parts) · `docs/GLOSSARY.md` (one entry: `display_name`
is derived when parts are set; legacy rows have NULL parts).

Not touched: `scripts/lib/master-data-apply.ts`, `createFirstAdmin`, `provision-terminal.ts`, `stock-usage.ts` — they
keep compiling because the `{ displayName }` form stays. Anything else: stop and report.

## TESTER paths (tests only, disjoint)

`packages/domain/tests/unit/t438-person-name.test.ts` · `packages/db/tests/integration/t438-person-name-check.test.ts`
· `packages/domain/tests/integration/t438-hire-by-name-parts.test.ts` ·
`packages/auth/tests/integration/t438-email-signin-by-role.test.ts`. Fixtures run on any `_test` DB (no lane DB name).

## Cases (each names the mutant it kills)

**Unit (formatter, key)**
- U1 `Santos` / `Maria` / `clara` → `Santos, Maria C.`. *Kills: initial not uppercased; full middle printed; no period.*
- U2 no middle, and middle `'   '` → `Santos, Maria`, middle NULL. *Kills: trailing `" ."`; `''` stored.*
- U3 `'  Dela   Cruz '` → `Dela Cruz`. *Kills: no trim / no collapse.*
- U4 `nameKey('Santos, Maria C.')` = `nameKey('Maria Santos')` = key of last `santos`, first `MARIA`.
  *Kills: initial not dropped; order-sensitive key; case-sensitive key.*

**DB CHECK (0207)**
- D1 Parts with a non-matching `display_name` → 23514. *Kills: CHECK missing the equality leg.*
- D2 For the U1-U3 inputs, insert `formatDisplayName(...)` with the parts → accepted. *Kills: TS and SQL formats drifting.*
- D3 Last set, first NULL → refused; all three NULL with any `display_name` → accepted. *Kills: all-or-nothing leg.*
- D4 Parts on a `kind = 'terminal'` row → refused. *Kills: missing `kind = 'person'`.*
- D5 Middle `''` → refused. *Kills: empty-string middle allowed.*

**Domain (hire, S2a)**
- H1 `createPerson` with parts → row has the parts and `Last, First M.`. *Kills: parts dropped; displayName not derived.*
- H2 Existing legacy `Maria Santos`; create `Santos` / `Maria` → refused with the N4 sentence naming the existing
  person; no row written. *Kills: guard compares raw strings; guard skipped for legacy rows.*
- H3 As H2 with `sameNameConfirmed: true` → created; audit carries `sameNameConfirmed: true`.
  *Kills: no override; override unrecorded.*
- H4 A same-name **terminal**, and a same-name person in **another org** → not a match. *Kills: kind / org filter.*
- H5 `createPerson({ displayName })` (master-data form) with a same-name row present → created, parts NULL.
  *Kills: N4 applied to the single-name path, which would break the v1 load.*
- H6 `searchPersons('maria santos')`, `('santos maria')`, `('clara')` each find `Santos, Maria C.`;
  `('maria pedro')` does not. *Kills: OR across words instead of AND; middle_name not searched.*
- H7 Actor without `enrol_staff` at the store → refused, nothing written. *Kills: authorize dropped in the refactor.*
- H8 The action's input parse (export it as a pure helper from a non-`'use server'` module if needed): picked +
  typed, neither, last only → the three N5 sentences. *Kills: silent preference for one input.*

**Domain (rename, S2b)**
- R1 Rename a NULL-parts person → parts set, `display_name` reformatted, audit `person.renamed` with before/after
  displayName and no other field. *Kills: display_name not rewritten; audit leaks columns.*
- R2 Actor with `enrol_staff` only at another store → refused. *Kills: authorize on the wrong store.*
- R3 Rename to a name another person already has → allowed. *Kills: N4 wrongly on rename.*

**Auth (S1) — every ✗ proven**
- A1 Staff-role person, open employment, linked Firebase credential → `signInWithFirebase` throws the N8 sentence;
  no session row; refusal event reason `pin_only_role`. *Kills: check missing, or placed after `issue`.*
- A2 Open employment and **no role** → refused the same way. *Kills: check written as `role <> 'staff'`.*
- A3 Manager, admin, super_admin (each) → session issued. *Kills: role list too narrow.*
- A4 Manager role **revoked**, re-granted as staff → refused. *Kills: `revoked_at is null` missing.*
- A5 Manager role in **another org** only → refused in this org. *Kills: org filter missing.*
- A6 The A1 person signs in with their **PIN** → succeeds; a PIN admin-approval by a manager still works.
  *Kills: rule folded into `personMaySignInToOrg`.*
- A7 An ended-employment staff person still gets the existing `NO_ACCESS` sentence, not the new one.
  *Kills: new check placed before the employment check.*

## Smoke (§9.4) — the Hire screen, port 9008, then production after deploy

1. `/staff/hire`: no "Create new person" radio; three boxes Last / First / Middle (middle marked optional).
2. Type `Test` / `Person` / `quinto`, save → the new staff page shows `Test, Person Q.`; the staff list shows the same.
3. Hire again with `Test` / `Person` → the N4 refusal; tick the same-name box → hires.
4. Search `person test` → finds both. Pick one AND type a name → the N5 refusal.
5. Staff page → Name form: retype a legacy name into parts → the list shows `Last, First M.`.
6. Sign-in: a staff-role account by email → the refusal sentence; the same person by PIN → in; a manager by email →
   in. On production, read-only: count live `firebase` sessions whose person has no active manager / admin /
   super_admin role in the org; report the number to Ian (expected 0).
Screenshots of steps 1, 2, 3 and the step-6 refusal.

## Out of scope

- Splitting existing names automatically (N3).
- Ending a person's email sessions when they are demoted to staff, or re-checking the role per request (N8) —
  follow-up; today a demoted person keeps an open email session up to 7 days.
- The missing canonical positions on production (N9) — Ian's data check.
- Master-data drift: once someone is renamed to `Santos, Maria`, a later v1 load may list them as name drift (R13
  reports, never writes). Expected; no change.
- Name parts for diners (CUSTOMER), POS, or any sign-in screen wording beyond the one refusal sentence.
