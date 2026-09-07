# T-232 — Sign in with the v1 email and password, and set the organisation up from inside

> **Status**: 📝 **RESERVED by the orchestrator 2026-09-07 — two lanes fill the contracts.**
> Slice 1 (email sign-in) and slice 2 (first-run setup) are specced by their lanes below this
> header, approved by the orchestrator, then built. **Ian's goal for today, verbatim in spirit:**
> *"I must be able to log in today with my email and password — the one I use in v1 as admin —
> and I must see the app and use it. The org I will set up once I am logged in."*
>
> Discovery: bible §7.1 (one `persons` spine; a Firebase account is a credential row referencing a
> person, never a parallel universe) · `packages/auth/src/sessions.ts` `signInWithFirebase`
> (already exists: takes a **verified** uid, refuses an unknown one — *"a login is not an
> introduction"*) · T-228 `createOrganization` / `createFirstAdmin` (the atomic bootstrap, today
> a CLI) · `docs/ops/README.md` §"Standing up an organization".

---

## Goal

**Ian opens `/sign-in` on production, signs in with the email and password he uses in v1, and —
because no organisation exists yet — is taken to a first-run screen that creates the organisation,
his person, his roles, the first store and his sign-in link in one transaction, then lands him in
the app.** After that, the same email signs him straight in.

## The decisions already made (orchestrator, 2026-09-07 — say so if a lane finds one wrong)

1. **Identity provider is v1's Firebase project** — `studio-7300228488-a394e` (ERP-rebuild's
   `src/firebase/config.ts`). That is where Ian's email and password live. v2's local `.env.local`
   has `FIREBASE_PROJECT_ID` and the `NEXT_PUBLIC_FIREBASE_*` values EMPTY; production's are
   GitHub Secrets Ian set — they must point at that project. ⚠️ v2's STORAGE bucket is a different
   project (`shareat-hub-v2`); identity and storage are separate on purpose (`.env.example:30`).
2. **Token verification needs no service account.** `firebase-admin`'s `verifyIdToken` validates
   against Google's public keys and needs only `projectId`. The auth admin app is initialised with
   `FIREBASE_PROJECT_ID` alone; the storage driver's app is left untouched.
3. **The first person gets BOTH `admin` and `super_admin`.** `admin` because store access is
   granted by the fan-out to admin roles (a super_admin created first is scoped to no store and
   lands nowhere — DEF-200's shape); `super_admin` because the owner needs the four powers only it
   holds (`approve_item`, `post_journal_entry`, `cross_org_access`, `view_franchise_sales`) and
   `createFirstAdmin` is the one place a role may be minted with no grantor. Both rows, `granted_by`
   NULL, in the same transaction.
4. **The first-run screen is the CLI's transaction with a Firebase credential instead of a PIN.**
   One composed domain function that both `scripts/bootstrap-org.ts` and `/setup` call, so the
   two paths cannot drift. A PIN is still issued to the first admin (the store's terminal needs one)
   — printed once on the success screen, the same rule as the CLI.
5. **`/setup` is reachable only when the request carries a verified Firebase identity that has no
   credential row AND `organizations` holds zero rows.** Any org existing → the ordinary
   *"this account is not linked to a person"* refusal; linking a later person to an email is
   `/admin/users`' job (a follow-up, not this task).
6. **The PIN sign-in stays exactly as it is.** The email form sits beside it on `/sign-in`.

## Slices

| # | What | Lane | Migration |
|---|---|---|---|
| 1 | Email + password sign-in: client Firebase sign-in → ID token → server verification → `signInWithFirebase` → session cookie. Unknown uid with zero orgs → `/setup`; otherwise refused with a sentence | E | none |
| 2 | `/setup`: the first-run screen and the composed bootstrap function it shares with the CLI; first person = admin + super_admin + firebase credential + PIN | B | none expected — `person_credentials` already has `kind = 'firebase'` and `external_id` |

Slice 1 and slice 2 meet at ONE seam: slice 1 redirects to `/setup?…` carrying the verified
identity (uid, email, display name) in a short-lived signed cookie or server-side one-time token
— **slice 1 owns issuing it, slice 2 owns consuming it; the shape is agreed in both specs before
either builds** (name it `SetupIdentity`, 10-minute TTL, single use).

## Scope — the exact files each lane may create or modify

### Slice 1 — lane E
**Create** `apps/erp/src/lib/firebase-auth-admin.ts` (server: `verifyIdToken` on an admin app
initialised with `FIREBASE_PROJECT_ID` only), `apps/erp/src/app/sign-in/EmailSignInForm.tsx`
(client component: `signInWithEmailAndPassword` via the existing `firebase` client init in
`apps/erp/src/lib/terminal/firebase.ts` or a sibling; posts the ID token to the action).
**Modify** `apps/erp/src/app/sign-in/page.tsx`, `apps/erp/src/app/sign-in/actions.ts`
(`signInWithEmailAction`), `apps/erp/src/lib/session.ts` only if the setup-identity cookie lives
there, `packages/core/src/env.ts` if `FIREBASE_PROJECT_ID`/`NEXT_PUBLIC_FIREBASE_*` need to become
required-in-production, `.env.example` comments, and a new integration test for the server action's
branches (verified uid with credential → session; without credential and zero orgs → setup token;
without credential and an org → refusal).

### Slice 2 — lane B
**Create** `apps/erp/src/app/setup/{page.tsx,actions.ts,lib.ts}`,
`packages/domain/tests/integration/first-run-setup.test.ts`.
**Modify** `packages/domain/src/organizations/index.ts` (the composed function; `createFirstAdmin`
gains the second role), `packages/auth/src/sessions.ts` (a `linkFirebaseCredential` if none exists
— check `sessionsRepo` first), `packages/db/src/repo/sessions.ts` if an insert for kind `firebase`
is missing, `scripts/bootstrap-org.ts` (calls the composed function — the CLI must not drift),
`docs/ops/README.md` §"Standing up an organization" (the screen is now the primary path; the CLI is
the fallback).

### ⛔ Out of bounds in both slices
`PROJECT_BIBLE.md` · `docs/ROADMAP.html` · `docs/DEFECTS-REGISTER.md` · `CAPABILITY-MATRIX.md` ·
`capabilities.ts` · `nav.tsx` · the PIN sign-in path's behaviour · each other's files ·
lane D's T-216 files · anything under `ERP-rebuild` (read v1's `login-form.tsx`,
`non-blocking-login.tsx`, `api/auth/session/route.ts` and `lib/server/session.ts` as REQUIREMENTS).

## FOR IAN — what only you can do, and it gates today

- The three GitHub Secrets `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (and `NEXT_PUBLIC_FIREBASE_APP_ID`) must be v1's project:
  the values in `ERP-rebuild/src/firebase/config.ts`. And on the droplet,
  `/srv/shareat-shared/.env.local` must carry `FIREBASE_PROJECT_ID=studio-7300228488-a394e`.
  Lane E states the exact key names it reads in its READY; you set them; the next deploy carries
  them. Nothing else on your side until the screen exists.
