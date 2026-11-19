# T-609: ending an employment switches off ALL ERP and POS access, from one place

**Owner:** builder (Sonnet). **Spec:** BOSS (Opus), 19 Nov 2026.

**Ian, 19 Nov 2026:**
- "terminating a staff employment must deactivate all its erp and pos access immediately"
- "the switch is in one place: staff record page. one switch, switches all on and off"

**Risk:** auth. The auditor is Sonnet. No migration expected; if one turns out to be needed, stop and report.

## Today (main 39357855, `packages/domain/src/people/index.ts:355` `endEmployment`)

Already done, in one transaction:
- position-sourced grants are revoked for that store (`reconcilePositionGrants`);
- the hire-time store scope (`source='employment'`) is deleted;
- sessions are ended when the person can no longer sign in to the org or the store (T-407 R4).

**Gaps:**
1. The PIN credential (`person_credentials`, kind `pin`) is never revoked.
2. `person_roles` stays active. `personMaySignInToOrg` (`packages/db/src/repo/access.ts:531`) still lets an active `admin`, `super_admin` or a no-employment `manager` sign in.
3. Manual store scopes (`source='manual'`) and manual capability grants (`person_grants` not from a position) survive. T-336 kept them on purpose; **Ian's rule overrides that** when the person has no open employment left.
4. **POS offline:** tablets keep PIN verifiers in IndexedDB (`apps/erp/src/lib/pos-device/verifier-store.ts`, T-526/T-530a). A terminated cashier can still sign in offline until the tablet refreshes its verifiers. The same applies to the attendance clock terminals, if they cache verifiers (check `/clock` and `attendance/terminals`).
5. POS terminal links: a `pos_terminal_links` row or an active terminal person (`posV2Repo.getActiveTerminalPersonId`) may still name the person.

## The rule

The **single switch** is the existing End employment action on `/staff/[employmentId]` (`apps/erp/src/app/staff/actions.ts:202`, `endEmploymentAction`, admin PIN). No new page or toggle elsewhere.

**When an employment ends:**
- **The person has another open employment in the org** (another store): revoke everything tied to **this store**. That means position grants (already done), the store scope of **any** source, manual grants scoped to this store, and sessions at this store (already done). Keep the PIN and role; they still work at the other store.
- **No open employment remains in the org:**
  - revoke **all** store scopes;
  - revoke all non-position grants in the org;
  - revoke the active `person_roles` row (any role, including manager and admin);
  - revoke the PIN credential;
  - end all sessions;
  - mark the person's verifiers revoked (below).
- **Last-admin guard:** if revoking the role would leave the org with no active admin who can sign in, refuse the whole end with a plain sentence. Reuse `hasOtherActiveAdminWhoCanSignIn` (access.ts ~218). Nothing changes in that case.
- **One audit row** listing what was switched off (counts per kind), e.g. `employment.access_revoked`, plus the existing `employment.ended`.
- **The screen:**
  - The End employment dialog says it plainly before confirming: "This signs them out everywhere and removes their PIN, role and all access at [store] / everywhere."
  - After it ends, the record page shows "Access: off".

**"Switch back on" = re-hire.** Hiring or reopening an employment through the existing hire flow gives back position-sourced grants and the employment scope, as hiring does today. A new PIN is issued by the existing Set PIN action. Manual extras are **not** brought back automatically; an admin grants them again. The page says so.

**POS and clock offline revocation:**
- The tablet's verifier sync must drop the verifiers of people who can no longer sign in at that store. Find where verifiers are delivered (snapshot or pairing sync) and make delivery respect `personMaySignInAtStore`.
- The device must **delete** verifiers missing from the latest delivery. If it only adds, that's the bug.
- **Immediate, as far as possible:** the tablet refreshes verifiers whenever it is online. State the refresh interval in the PR. Offline revocation can't be instant; the next sync is the limit, so write that down in the PR.
- The same goes for clock terminals if they cache verifiers.

## Tests (integration on any `_test` DB, plus unit for device sync; each with a mutant that goes red)

1. A cashier with one employment and a manual grant and a manual scope at the store. After the end: no grants, no scopes, the role revoked, the PIN revoked, sessions ended, a PIN sign-in refused.
2. A two-store person ends the store A job. Store A access is gone (including a manual scope at A); store B access, the PIN and the role are kept; sign-in at B works and at A is refused.
3. Ending the last admin is refused and nothing changes.
4. A manager with a role and an employment: after the end, the role is revoked and sign-in is refused.
5. Device verifier sync: a person removed from the delivery is deleted from the local store (unit, fake IndexedDB as the T-530a tests do).
   - **Mutant:** add-only sync → red.
6. The audit row lists the counts.
7. Re-hire restores position grants and the employment scope but not manual extras; the PIN must be set again.

Pins: capability or auth census tests, t343 throw ratchet, domain-actions-have-callers, the T-412 destructive census (`apps/erp/tests/t412-destructive-census.test.ts`).

## Out (with reasons)

- **A separate "suspend access without ending employment" switch:** Ian asked for one switch.
- **Deleting the person or their history:** records stay; only access goes.
- **Instant revocation on an offline tablet:** impossible without a network; the next sync is the limit.
