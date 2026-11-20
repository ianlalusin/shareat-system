# T-612: every staff member's ERP account has a status (Pending, Active, Suspended, Ended)

**Owner:** builder (Sonnet). Auth code, so a Sonnet auditor reviews it before merge. **Spec:** BOSS (Opus), 19 Nov 2026.

**Ian, 19 Nov 2026** (relayed by UI UX, then answered to BOSS):
- "Every staff member gets their own ERP user. When a new staff member is hired, a user must be created automatically and linked to that staff record. It starts INACTIVE and waits for an admin or manager to activate it. The same admin or manager can also suspend it or terminate the access later."
- Asked to replace two earlier rulings, he answered **"yes approve"**:
  - bible **row 340** / T-407 Q3: `persons.is_active` stays unused;
  - T-609's "Out: no separate suspend switch".
- Suspend design, he answered **"A"**: suspended people **keep** their role, store access and rights, paused; reinstating restores them exactly.
- **New bible row** (planner writes it at wrap-up): supersedes row 340 and T-609's non-goal. One account status per person, kept in step with employment by the domain.

**Migration 0268** (reserve on the board). Hand-authored per ADR-012 §5. The full suite on a fresh gate DB is the gate.

## Facts this builds on (main 683fa97)

- **There is no user table.** `persons` (`packages/db/schema/persons.ts:21`) is the user (bible row 322: one person, one id). Hiring (`hireAction`, `apps/erp/src/app/staff/actions.ts:106`) already creates the `persons` row, a `staff` role, store scope (`source='employment'`) and position grants (`packages/domain/src/people/index.ts:86-173`). **So the user is already "created automatically and linked"**; what's missing is a status that starts off.
- A PIN is set later (`issuePinAction`, `staff/actions.ts:261`). Email login is linked by an admin on `/admin/users/[personId]` (`linkFirebaseAction`).
- **Sign-in gates:**
  - `personMaySignInToOrg` (`packages/db/src/repo/access.ts:506`) and `personMaySignInAtStore` (`:448`), used by PIN, email and POS sign-in and by the POS snapshot (`buildPosSnapshot`, so tablets drop verifiers).
  - `authorize()` refuses anyone with no active role (`packages/auth/src/authorize.ts:179-196`).
  - `resolveActor` (`sessions.ts:694`) trusts a live session, so **sessions must be ended explicitly**.
- `persons.is_active` exists, is never written, and is read at `access.ts:159,623`, `pos-v2.ts:912`, `pos-preflight.ts:42`, `employment.ts:239`, `packages/domain/sync/publisher.ts:121`.
- T-609 (`endEmployment`): ending the last open job revokes everything and ends sessions; a rank rule and the last-admin guard protect authority.

## The status

- Migration 0268 adds `persons.account_status text NOT NULL`, CHECK in (`pending`, `active`, `suspended`, `ended`), default `pending`.
  - **Backfill:** `active` where `is_active` is true, `suspended` where it is false. Every current person keeps working on deploy; nobody is locked out.
  - `kind='terminal'` persons are always `active` (CHECK: `kind <> 'terminal' OR account_status = 'active'`).
  - Every `is_active` reader moves to `account_status = 'active'`. `is_active` stays in the table, unread, with a comment pointing here (dropped in a later task).
- **What each status means:**

| Status | Sign-in | Rights, role, scope | How it is reached |
|---|---|---|---|
| `pending` | refused: "Your account isn't active yet. Ask your manager." | kept (granted at hire) | a new person is hired; a person whose account was `ended` is re-hired |
| `active` | allowed (as today) | as today | Activate (from pending) or Reinstate (from suspended) |
| `suspended` | refused: "Your account is suspended. Ask your manager."; **all sessions ended at once** | **kept, paused** (Ian "A") | Suspend (from active) |
| `ended` | refused | revoked by T-609 | T-609 ends the person's **last** open employment |

- **Gates:**
  - `personMaySignInToOrg` and `personMaySignInAtStore` add `account_status = 'active'` (read `for share`, like the employment check, so a racing sign-in serialises against a suspend).
  - `authorize()` also refuses a non-active person, so paused rights can't be used through any path.
  - The POS snapshot follows automatically, because it uses `personMaySignInAtStore`. Tablets drop the person's PIN at the next sync (T-609's verifier expiry).
- **Keeping status and employment in step** (no disagreement, row 340's worry):
  - `createEmployment` for a person with **no other open employment** whose status is `ended` sets it to `pending`. A brand-new person starts `pending` by default. A person with another open job keeps their status.
  - `endEmployment` (T-609), when it ends the **last** open employment, sets `ended` in the same transaction.
  - An **invariant test** proves: no `active`, `pending` or `suspended` person without an open employment, unless they are an admin, super_admin or the existing no-employment manager case (`personMaySignInToOrg`'s own exceptions). No `ended` person has an open employment.

## Actions (one place: the staff record `/staff/[employmentId]`; also shown on `/admin/users/[personId]`)

- **Activate** (pending → active).
  - Allowed with or without a PIN set. Without one, the page says "Set a PIN so they can sign in."
- **Suspend** (active → suspended).
  - Needs a reason. T-412 tier: **retype the person's name** (bible row 329), like deactivate.
  - In the same transaction it ends all the person's sessions (`endAllForPerson`), with T-407's `for share` pattern.
- **Reinstate** (suspended → active).
- **Ended** shows "Access ended. Hire again to restore." There is no button; it is the T-609 End employment action.
- **Who:**
  - A target whose role is `staff`: `enrol_staff` at that employment's store, so managers can.
  - A target who is a manager, admin or super_admin: `manage_users` (admins), plus T-609's rank rule (`isStoreManagerOrAbove`, `roles.ts:306`): nobody acts on someone who outranks them.
  - Nobody suspends themself.
  - The **last-admin guard** (`hasOtherActiveAdminWhoCanSignIn`) refuses suspending the last active admin who can sign in.
  - Take `lockOrgAccess` before reading the role (as T-609's fix #5).
- **Audit:** `account.activated`, `account.suspended` (with the reason), `account.reinstated`, plus T-609's existing rows. Raise both catalogue ceilings honestly.
- **Status badge** on both pages: Pending / Active / Suspended / Ended.
- **Coordination:** UI UX is redesigning `/admin/users/[personId]` (branch `ui/admin-user-detail`). If that hasn't merged, put the status row and buttons on `/staff/[employmentId]` only and leave the user page to a follow-up. Do not edit their branch.

## Tests (integration on any `_test` DB, each with a mutant that goes red)

1. Hiring a new person → `pending`; PIN sign-in refused with the pending sentence; `authorize` refused.
2. Activate → PIN sign-in works.
3. Suspend → existing sessions are ended in the same transaction, sign-in is refused, rights and role rows are unchanged, and the POS snapshot no longer lists the person.
4. Reinstate → sign-in works with the same rights and no re-setup.
5. A manager suspends staff at their own store: OK. At another store: refused. A manager suspends another manager: refused. An admin suspends a manager: OK. Suspending yourself: refused. The last admin: refused.
6. T-609 ending the last job → `ended`. Re-hire → `pending`. Ending one of two jobs → status unchanged.
7. The backfill: an existing `is_active=true` person is `active` after the migration, and a terminal person is `active`.
8. The invariant test over a seeded mix.
9. A racing sign-in vs suspend serialises (two connections), as in T-407.

- **Mutants:** gate without the status check → red; suspend without ending sessions → red; rank check dropped → red; re-hire leaving `ended` → red.
- **Pins:** capability and auth census, the T-412 destructive census (suspend is the retype tier), t343, domain-actions-have-callers, the production-caller ratchet, audit catalogue ceilings, and every existing sign-in, session, t407, t609 and t525 snapshot test.

## Out (with reasons)

- **A separate users table:** row 322.
- **Auto-creating an email (Firebase) login at hire:** staff sign in with PINs (`personMayUseEmailSignIn` is managers and up). Email stays a manual link for managers.
- **Dropping `persons.is_active`:** a later clean-up task, once nothing reads it.
- **Auto-activating on first PIN set:** Ian asked that an admin or manager activates.
