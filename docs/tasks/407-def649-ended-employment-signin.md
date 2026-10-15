# T-407: Ended employment stops sign-in and ends live sessions (DEF-649, DEF-650)

**Status:** SPEC DRAFT 2026-10-15 (Opus planner). Not built. **No migration.** ≈2.5 lane-days, four slices.
Three questions for Ian below; the recommended option is what gets built.

## Goal

When someone stops working for us, they stop getting in: the email (Firebase) door refuses them, the PIN door
refuses them, and any session they already hold ends **in the same transaction** that ends the employment.
The rule is derived from the employment and role records themselves, never from a second flag someone must
remember to flip. Fixes the sibling defect DEF-650 (two "end sessions" helpers silently end 0 rows) on the way,
because this task needs a working end-sessions path.

## Source

- `docs/DEFECTS-REGISTER.md` DEF-649 🔴 and DEF-650 🔸 (both reported 2026-10-14 by the T-402 S2 tester).
- T-402 "S2 audit rulings" A1 (outbox: a security event never holds a second connection, never blocks or changes
  the caller), A4 (an unrecorded change is refused, not skipped), A7 (DEF-649's fix writes `auth.signin_refused`
  with reason `employment_ended` / `credential_revoked`).
- Code read 2026-10-15: `packages/auth/src/sessions.ts` (`runFirebaseSignIn` ~381, `runPinSignIn` ~269,
  `runResolve` ~520, `endShift` ~590, `endAllForDevice` ~628; both fall back to `transaction()` at ~615 / ~665);
  `packages/db/src/repo/sessions.ts` (`findActiveCredentialByExternalId`, `findLiveByTokenHash` "hot path",
  `endAllForPerson`); `packages/db/src/repo/access.ts:404` `personMaySignInAtStore`;
  `packages/db/src/repo/stores.ts:316` `countActiveCredentials` (must agree with the PIN gate);
  `packages/domain/src/people/index.ts:286` `endEmployment`; `packages/auth/src/credentials-admin.ts:241`
  (unlink already ends sessions); `packages/auth/src/security-events.ts:108` `enqueueSigninRefused`;
  `packages/db/schema/access.ts` (`person_roles`: one active role per person per org, `super_admin > admin >
  manager > staff`); `packages/db/schema/employment.ts` (`employments.ended_on`, indexes
  `employments_person_id_idx`, `employments_open_person_store_unique`).
- `docs/decisions/CAPABILITY-MATRIX.md:21` and `docs/tasks/398-padre-garcia-franchise-org.md` Q1: a franchise owner
  is a `manager` **with no employment row**.

## Research (bible §1.2d: study v1, write its goal, count, design v2 to beat it)

**v1's method.** Email users carry `status` and `isActive` on their profile, checked in a client hook
(`ERP-rebuild/src/hooks/useAccess.ts:11`). PIN ("local") users get `isActive: false` when archived
(`src/lib/actions/local-user.actions.ts:282`, "blocks login while archived"). Neither is tied to separation:
ending someone's work is an HR record, and cutting access is a separate manual flip. Nothing revokes a live
Firebase session (no `revokeRefreshTokens` anywhere in v1).
**v1's goal.** A person who no longer works for us cannot get in.
**Where v1 misses its own goal.** Two records that must agree by hand (HR status and the access flag), and a live
session that outlives both.
**Industry pattern (offboarding).** Deny at authentication AND revoke live sessions at the moment of
termination, driven by the HR system of record (SCIM-style deprovisioning). Two ways to catch an existing session:
(1) revoke on the event, or (2) re-validate eligibility on every request.
**Count.** Today v2 never writes `persons.is_active` (every row is `true`), and `endEmployment` has never ended a
session. Browser sessions live **7 days** (`BROWSER_SESSION_TTL_MS`), PIN sessions 12 hours: a missed revocation is
a week of access, not minutes.
**v2 design that beats it.** One derived rule (no flag), checked at both doors, plus revoke-on-event inside the
same transaction as the event. Per-request re-validation is rejected (see R5 for the numbers).

## Rulings (planner; binding unless Ian answers otherwise)

- **R1. Who may sign in to an org** (new `accessRepo.personMaySignInToOrg(tx, personId, orgId)`, ONE statement,
  three `exists`, every leg index-backed): **(a)** an open employment (`ended_on is null`) at ANY store of the org,
  **or (b)** an active (`revoked_at is null`) `admin` or `super_admin` role in the org, **or (c)** an active `manager`
  role AND **no employment row, open or ended, ever** in the org (the franchise owner, Q1). Leg (c) is why an
  ended manager is refused: once employed, the employment record is the truth. Staff with no employment: refused.
- **R2. Both doors use R1.** Firebase: after the terminal check, `!personMaySignInToOrg` refuses. PIN:
  `personMaySignInAtStore` becomes `(scope here OR open employment here) AND R1`, still ONE round trip (the
  T-302 timing residual stays one indexed read). `countActiveCredentials` gains the same R1 clause in the same
  statement so readiness never disagrees with the gate (the lockstep its own comment demands).
- **R3. Refusal events.** Ended person: `enqueueSigninRefused(org, person, 'employment_ended')` and the sentence
  `NO_ACCESS = 'Sign-in failed: this account no longer has access. Ask an admin if this is wrong.'` (the uid is
  Firebase-verified, so the person is talking about themselves; no oracle). Revoked credential: when the active
  lookup misses, ONE more read, `sessionsRepo.findLatestRevokedCredentialByExternalId` (most recent `revoked_at`,
  joined to `persons` for org), and if found `enqueueSigninRefused(..., 'credential_revoked')` with the existing
  `NOT_LINKED` sentence; if not found, today's single logger line. Failure-path only, so the extra read never runs
  on a success. PIN refusals stay `BAD_PIN` and write nothing new (`sign_in_attempts` is that log).
- **R4. `endEmployment` ends sessions in its own transaction.** After closing the employment and the scope
  clean-up: if `!personMaySignInToOrg` → `endAllForPerson(person, 'revoked')` (every session, browser and PIN);
  else if `!personMaySignInAtStore(person, endedStore)` → `endAllForPerson(person, 'revoked', endedStore)` (PIN
  sessions at that store only); else nothing. When `ended > 0`, one `session.ended_all` row (actor = the manager,
  entity = the person, `after: { reason: 'employment_ended', employmentId, storeId: <store or null>, ended }`).
  **Why the same transaction:** the change and the revocation commit or roll back together. After-commit would
  leave a window, and a crash in it leaves a live 7-day session behind a closed employment, silently. Inside,
  a failure to end sessions refuses the whole termination, visibly (A4's rule).
- **R5. No per-request re-validation.** `findLiveByTokenHash` is one unique-index lookup + a `persons` PK join, one
  round trip. Re-checking R1 would add 3 index probes per request (5 for PIN sessions, which also need the store
  leg): 0 extra round trips if folded into that statement, +1 if separate, on every page. What it buys is cover for
  revocation paths not wired to end sessions; today there is one (role demotion, Out of scope). Revoke-on-event
  covers the two real offboarding paths (end employment, unlink credential) at zero hot-path cost.
- **R6. Multi-store.** Ended at A, still open at B: R1 passes (leg a), so browser sessions live on; PIN sessions
  bound to A end only if they may no longer sign in at A (an admin's `manual` scope at A keeps them).
- **R7. Race closed with a row lock.** The open-employment legs of R1 / R2 read with `for share` on the matching
  `employments` rows. A sign-in that read "open" holds the lock, so `endEmployment`'s UPDATE waits for it to
  commit, and its later `endAllForPerson` statement (new READ COMMITTED snapshot) sees and ends the new session.
  If the end commits first, the sign-in re-checks the updated row and is refused.
- **R8. `persons.is_active` is not the gate and is not written.** A second flag is exactly v1's failure. Reads stay
  as-is (always true today, harmless); dropping the column is a later migration batch (Q3).
- **R9. DEF-650.** `endShift` / `endAllForDevice` with `tx = null`: resolve the org with ONE read in
  `authTransaction` (`authzDenialCountsRepo.orgIdOfPerson`; unknown person → `{ ended: 0 }`), then run the existing
  `run` under `withOrgPrincipal(orgId, …)`, so sessions are visible under RLS and the audit row stays in the same
  transaction (A4 intact, no outbox needed). The plain `transaction()` import leaves `sessions.ts` if unused.
- **R10. No new end reason.** `sessions.ended_reason` keeps its CHECK (`revoked` is used); the audit row carries
  `employment_ended`. So **no migration** and no clash with T-401 S6 over 0198.

## Contract

| Function | File | Change |
|---|---|---|
| `personMaySignInToOrg(tx, personId, orgId): Promise<boolean>` | `packages/db/src/repo/access.ts` | new, R1, explicit `org_id` filters (the auth door has no RLS principal) |
| `personMaySignInAtStore(tx, personId, storeId)` | same | R2: adds the R1 clause (org from `persons`), still one statement |
| `countActiveCredentials(tx, storeId)` | `packages/db/src/repo/stores.ts` | R2 lockstep |
| `findLatestRevokedCredentialByExternalId(tx, uid)` | `packages/db/src/repo/sessions.ts` | new, returns `{ personId, personOrgId }` or undefined |
| `runFirebaseSignIn` | `packages/auth/src/sessions.ts` | R1 + R3 |
| `endShift`, `endAllForDevice` | same | R9 (null path only; caller-tx path unchanged) |
| `enqueueSigninRefused` reason union | `packages/auth/src/security-events.ts` | + `'employment_ended' \| 'credential_revoked'` |
| `auth.signin_refused` comment | `packages/db/src/audit/catalogue.ts:158` | list the four written reasons |
| `endEmployment` | `packages/domain/src/people/index.ts` | R4 |

## Invariants (the tests prove each; a mutant named per leg)

**S1 (DEF-650)**
1. `endShift(null, …)` for a person with 2 live PIN sessions at store A ends exactly 2 and writes one
   `session.ended` in the same transaction. *Mutant: fallback restored to `transaction()` (ends 0).*
2. `endAllForDevice(null, …)` ends every live session on the device and writes one `session.ended_all`.
   *Mutant: same fallback.*
3. Forced audit-append failure in either null path leaves every session live. *Mutant: audit moved to the outbox.*

**S2 (email door)**
4. Ended person (only employment closed, role `manager`) with a linked credential → `AuthenticationError(NO_ACCESS)`,
   no session row, after flush one `auth.signin_refused` with `reason = 'employment_ended'`. *Mutant: R1 check removed.*
5. Admin with no employment signs in; super_admin with no employment signs in. *Mutant: leg (b) dropped.*
6. Never-employed manager (franchise owner) signs in; the same manager after one employment opened and ended is
   refused. *Mutants: leg (c) without the "never employed" clause; leg (c) dropped.*
7. Employed at B, ended at A → signs in. *Mutant: R1 reads only the most recent employment.*
8. Staff with no employment ever → refused. *Mutant: leg (c) accepts any role.*
9. Revoked credential → `NOT_LINKED`, one `auth.signin_refused` with `reason = 'credential_revoked'` for the right
   org; an unknown uid still writes no row. *Mutant: revoked lookup skipped.*
10. Another org's open employment does not admit the person to this org. *Mutant: `org_id` filter dropped.*

**S3 (PIN door + readiness)**
11. Manager with `manual` scope at A and no open employment anywhere → `BAD_PIN` at A. *Mutant: R1 clause removed
    from `personMaySignInAtStore`.*
12. Admin with `fan_out` scope and no employment → signs in by PIN. *Mutant: R1 without leg (b).*
13. `countActiveCredentials(A)` counts exactly the people invariants 11-12 admit (same fixtures, both answers
    asserted together). *Mutant: lockstep clause missing in `stores.ts`.*
14. `personMaySignInAtStore` is still one round trip (statement count spy = 1). *Mutant: split into two queries.*

**S4 (`endEmployment`)**
15. Ending a manager's only employment ends their browser session and PIN sessions at every store, writes one
    `session.ended_all` (`reason: 'employment_ended'`, `storeId: null`), and their next request fails `resolveActor`.
    *Mutant: no `endAllForPerson` call.*
16. Ended at A, open at B: browser session and PIN session at B survive; PIN session at A ends; the event has
    `storeId: A`. *Mutant: always end everything.*
17. Ended at A but holds `manual` scope at A and open at B: nothing ends, no event. *Mutant: end at A unconditionally.*
18. Forced failure of the session UPDATE (or of the audit append) rolls back the employment end. *Mutant: sessions
    ended in a separate transaction.*
19. Race (two connections): sign-in tx reads eligibility and pauses; `endEmployment` blocks; sign-in inserts its
    session and commits; `endEmployment` completes and that session is ended. *Mutant: `for share` removed (end
    completes at once, the new session survives).*
20. Ending the last admin's employment never locks the org out (admin stays eligible by leg b). *Mutant: R1 leg (b)
    requires an employment.*

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size | Depends on |
|---|---|---|---|---|---|
| **S1** | DEF-650: null-path org lookup + `withOrgPrincipal` (R9) | `packages/auth/tests/integration/t407-s1-end-sessions-null-tx.test.ts` | `packages/auth/src/sessions.ts` (`endShift`, `endAllForDevice` only) | 0.5 | — |
| **S2** | R1 repo function with `for share`, Firebase gate, refusal events, revoked lookup (R1, R3, R7 reader half) | `packages/auth/tests/integration/t407-s2-firebase-gate.test.ts` | `packages/db/src/repo/access.ts` (new function), `packages/db/src/repo/sessions.ts` (new lookup), `packages/auth/src/sessions.ts` (`runFirebaseSignIn`), `packages/auth/src/security-events.ts`, `packages/db/src/audit/catalogue.ts` (one comment) | 0.75 | S1 (same file) |
| **S3** | PIN gate + readiness lockstep (R2) | `packages/auth/tests/integration/t407-s3-pin-gate.test.ts`; adjusts `packages/auth/tests/integration/global-pin.test.ts:257-270` (the `scoped` fixture gets an active `manager` role and no employment, so it stays `true` for the stated reason) | `packages/db/src/repo/access.ts` (`personMaySignInAtStore`), `packages/db/src/repo/stores.ts` (`countActiveCredentials`) | 0.5 | S2 |
| **S4** | `endEmployment` ends sessions in-transaction; race test (R4, R6, R7) | `packages/domain/tests/integration/t407-s4-end-employment-sessions.test.ts` | `packages/domain/src/people/index.ts` (`endEmployment` only) | 0.75 | S2, S3 |

**Total ≈2.5.** One lane, in order (S1-S3 share `sessions.ts` / `access.ts`). S1 can start at once. Every slice:
tests first and red, then build; the builder greps its diff for the named mutants before hand-back. Sonnet lane
(auth / security code, bible row 184 and the Haiku-where-possible rule's money/auth exception).

## Out of scope (with reasons)

- **Role demotion / revoke does not end sessions** (`packages/auth/src/roles.ts` `assignRole`). An admin with no
  employment demoted to staff keeps a live browser session up to 7 days. Same family, different file and a
  delicate one (supersede and elevation logic). Orchestrator files it as a new DEF with this spec as the reference;
  the fix is "after a role change, if `!personMaySignInToOrg`, `endAllForPerson`".
- **Revoking credentials on employment end.** The gate refuses; keeping the link lets a rehire work without
  re-linking, and keeps the refusal logged as `employment_ended` rather than an unknown account.
- **Dropping `persons.is_active`** (needs a migration; R8, Q3).
- **Future-dated end dates** keep today's PIN behaviour: access ends when the end is recorded (Q2).
- Any UI. `endShift` / `endAllForDevice` still have no button (DEF-650 says so); this only makes them work.

## Done when

- S1-S4 merged; invariants 1-20 green with each named mutant shown red once in the lane log.
- Typecheck, lint, unit, and the full integration suite green on a fresh lane DB (auth gate change: full suite,
  not a subset); `tests/unit/auth-transaction-callers.test.ts` still green (only `sessions.ts` calls the door).
- The 7 existing test files that call `endEmployment` (grep) still green, unchanged except where an exact
  `audit_log` row count now includes `session.ended_all`; each such edit named in the hand-back.
- DEF-649 and DEF-650 marked closed in `docs/DEFECTS-REGISTER.md` by the orchestrator with the commit hash; the
  role-demotion follow-up DEF filed.

## Risks

- **`for share` needs UPDATE rights and passes RLS UPDATE policies.** The app role updates `employments` already
  (`closeEmployment`); the tester's invariant 19 runs as the app role, not the owner, to prove it.
- **PIN semantics narrow (S3).** A person with scope but no role, no open employment, not a never-employed manager,
  loses PIN sign-in. Before merge, the lane runs a read-only count on its lane DB of people who hold scope but fail
  R1 and reports it; in production the orchestrator runs the same count read-only before deploy. Non-zero means
  real people lose access: Ian sees the names first.
- **ETL'd people with no `person_roles` row** fail R1 unless employed. Same pre-deploy count covers it.
- **Revoked lookup has no index on revoked rows** (`person_credentials_external_id_unique` is partial). Table is
  small and the read is failure-path only; accepted.

## Questions for Ian (Open Questions page; the recommended option is built)

- **Q1. A manager who has never been an employee (a franchise owner, like Padre Garcia's owner): may they sign
  in?** (a) Yes, as long as they never had an employment; once they have one and it ends, they are out.
  (b) No: every manager needs an employment row, so the PG owner would need a placeholder employment.
  (c) Any manager may always sign in (leaves the hole open for ended managers). **Recommended (a)**: PG works as
  planned and an ex-employee manager is still locked out.
- **Q2. If you record an end date in the future (last day next Friday), when should access stop?** (a) The moment
  you record it, as PIN sign-in already does today. (b) On the end date, which needs a nightly job to end sessions
  then. **Recommended (a)**: simplest and safest; record the end on or after the last day.
- **Q3. `persons.is_active` (an "active" switch on each person that nothing ever sets):** (a) Leave it unused and
  drop it in a later database change. (b) Turn it into a manual "suspend this person" switch for admins (new
  feature, its own task). **Recommended (a)**: a second switch that can disagree with the employment record is the
  exact way v1 goes wrong.

**Answered by Ian 2026-10-15 (in chat): Q1 (a), Q2 (a), Q3 recommended (leave `is_active` unused, drop later). Build as specified.**
