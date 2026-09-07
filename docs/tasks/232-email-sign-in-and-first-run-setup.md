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

---

## Slice 2 — contract

> **Status**: 📝 **SPEC — lane B, 2026-09-07. Written before any code. Awaiting APPROVED.**
>
> ⛔ **Decision 3 as written cannot be built: the database refuses the second role row.** §2.1 is
> the report (RULES §3.4a — *"report a spec defect; never silently work around it"*). §2.2 is the
> replacement, and it is an **exact capability equivalence**, not a downgrade — proven by a test,
> with one residual consequence named in full.

### 2.0 Goal

`/setup` — the first-run screen. Reachable **only** when the request carries a verified Firebase
identity that has no credential row **and** `organizations` holds zero rows. It creates the
organisation, its chart and categories, the first person, that person's role and capabilities, the
first store, its default room, that person's store scope, a `firebase` credential bound to the
verified uid, and a terminal PIN — **in one transaction** — then issues the session and lands on
`/`. One composed domain function does all of it, and `scripts/bootstrap-org.ts` calls the *same*
function, so the CLI and the screen cannot drift.

---

### 2.1 ⛔ SPEC DEFECT — decision 3's "both rows" is refused by the database

Decision 3 says the first person gets **both** an `admin` and a `super_admin` role row. Three
independent places say that cannot exist:

| Where | What it says |
|---|---|
| `packages/db/schema/access.ts:80` | `uniqueIndex('person_roles_active_person_org_unique').on(personId, orgId).where(revokedAt is null)` — **at most one ACTIVE role per (person, org)** |
| `packages/db/src/repo/access.ts:37-38` | *"The person's currently ACTIVE role in this org, if any. **At most one exists per (person, org) by the partial unique index.**"* |
| `packages/auth/src/authorize.ts:99` | `authorize` resolves **one** role — `activeRoleForPerson(...)`, `.limit(1)` — and evaluates the matrix against that single value |

So the second `insertRole` raises `23505`, which **aborts the whole transaction** (the same
abort-semantics `createOrganization`'s own comment describes). The slice-2 row says *"Migration:
none expected"*; making two role rows legal is not a migration, it is a re-architecture of the role
axis — a new index, a rewrite of `activeRoleForPerson`, of `authorize`'s single-role read, of
`revokeActiveRole`'s *"whichever role is currently active"* semantics, and of `activeAdminPersonIds`.
That is a task, not a slice, and it is not this one.

**Not reported as a blocker, because the decision's two stated REASONS can both be satisfied
without it.** They are: (a) store access comes from the fan-out to `admin` roles, and (b) the owner
needs the four powers only `super_admin` holds.

---

### 2.2 The resolution — role `admin`, plus the four capabilities as explicit grant rows

The first person gets:

- **one role row: `admin`**, `granted_by` NULL — exactly what `createFirstAdmin` writes today,
  unchanged; and
- **four `person_grants` rows**, `granted_by` NULL, for the capabilities `super_admin` holds and
  `admin` does not.

**⭐ This is an exact equivalence, and it is provable rather than asserted.** In
`packages/auth/src/capabilities.ts` there is **no** capability where `admin: true` and
`super_admin: false` (verified: zero matches). The set where `super_admin: true, admin: false` has
**exactly four** members — `approve_item` (:666), `post_journal_entry` (:685), `cross_org_access`
(:757), `view_franchise_sales` (:758). Therefore

> `admin` + those four grants authorizes **precisely** the set `super_admin` authorizes.

`authorize` honours it directly: `matrixAllows || personHasActiveGrant(...)`
(`packages/auth/src/authorize.ts:110`). The two platform-scoped members work too — axis 1 (org
match) is skipped for `platform` scope, and axis 3a only needs *an* active role, which `admin` is.

**⛔ The set is DERIVED, never hand-listed** — the same discipline, and the same reason, as
`ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` (`capabilities.ts:777`): *"computed from the matrix above so
the two can never silently drift apart."* It is derived inside
`packages/domain/src/organizations/index.ts` from `CAPABILITIES` and `CAPABILITY_MATRIX`, both
already exported by `@shareat/auth`'s barrel — **no edit to `capabilities.ts`, which is out of
bounds for both lanes.**

```ts
const SUPER_ADMIN_ONLY: readonly Capability[] =
  CAPABILITIES.filter((c) => CAPABILITY_MATRIX[c].super_admin && !CAPABILITY_MATRIX[c].admin);
```

#### Why not the other two shapes

| Shape | Why not |
|---|---|
| role `super_admin` **only** | `activeAdminPersonIds` filters `role = 'admin'` (`repo/access.ts:212-224`), so §C.2's fan-out grants scope to **nobody**. Ian's **second** store — the very next thing the ops doc tells him to create (`docs/ops/README.md:150-152`) — would be invisible to him. DEF-200's shape, next day, silent. And `hasActiveAdmin(orgId)` would be **false**, firing bible row 115's adminless-manager elevated-grant fallback for every manager appointed later |
| role `admin`, then revoke and re-insert as `super_admin` in the same transaction | Fabricates a role history — an `admin` granted and revoked in the same millisecond. `createFirstAdmin`'s own header: *"a fabricated authority is worse than an absent one, because it reads as evidence."* And it still leaves both defects above |

#### ⚠️ The one residual consequence, stated in full

`packages/auth/src/roles.ts:218-226` gates assigning `admin` or `super_admin` on the actor's role
**as a literal**, not on a capability:

```ts
if (input.role === 'admin' || input.role === 'super_admin') {
  const actorRole = await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId);
  if (actorRole?.role !== 'super_admin') throw new AuthorizationError(...);
}
```

A grant row cannot satisfy a role-literal check. **So the first person cannot appoint a second
admin through `/admin/users`.** They can appoint managers and staff; `admin` and `super_admin` are
refused with *"assigning 'admin' requires super_admin"*.

- **Impact today: none.** One-person org, one owner, and Ian is not appointing an admin today.
- **It is not a lock-out**: `scripts/bootstrap-org.ts`' database posture still reaches everything,
  and the fix is small.
- **Proposed follow-up, NOT in this slice** (it touches `roles.ts`, in neither lane's scope): widen
  that check to *"holds the `super_admin` role **or** an active grant for every capability
  `super_admin` holds that `admin` does not"*, i.e. the same derived set. One condition, one test.
  Logged for the orchestrator to schedule; slice 2 does not touch `roles.ts`.

**If the orchestrator prefers the role-literal check widened INSIDE this slice, say so on approval
and add `packages/auth/src/roles.ts` to scope** — it is ~6 lines and one test. I have left it out
because it is a change to the authority chain and that is the orchestrator's call, not a lane's.

---

### 2.3 The composed function — `bootstrapOrganization`

`packages/domain/src/organizations/index.ts`, beside `createOrganization` / `createFirstAdmin`.
**The one function both `scripts/bootstrap-org.ts` and `/setup` call.**

```ts
export interface BootstrapOrganizationInput {
  readonly code: string;               // organisation code — unique, permanent
  readonly name: string;
  readonly adminDisplayName: string;   // a REAL name — persons.display_name is ledger attribution
  readonly storeCode: string;
  readonly storeName: string;
  readonly pin: string;                // 6 digits, validated before anything is written
  /** The VERIFIED Firebase uid. Present from /setup, absent from the CLI. */
  readonly firebaseUid?: string | null;
}

export interface BootstrapOrganizationResult {
  readonly orgId: string;
  readonly accountsSeeded: number;
  readonly categoriesSeeded: number;
  readonly personId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly scopedAdminIds: readonly string[];
  readonly pinCredentialId: string;
  readonly firebaseCredentialId: string | null;
  readonly grantedCapabilities: readonly Capability[];
}

export async function bootstrapOrganization(
  tx: Tx,
  input: BootstrapOrganizationInput,
): Promise<BootstrapOrganizationResult>;
```

**⛔ It takes no `Actor`, for the reason the module header already gives**: there is no principal
before the organization exists — *"not 'does not yet', but cannot. Do not 'fix' this by adding
one."* The gate is the caller: the CLI is unreachable from a request handler, and `/setup`'s gate
is §2.4 + the zero-org refusal below.

**The order, all in the caller's transaction:**

1. `lockFirstRun(tx)` — see §2.3.1.
2. **Refuse if any organization exists.** §2.3.2.
3. `isValidPinFormat(input.pin)` — refused **before** anything is written. The CLI already learned
   this: *"finding that out after creating an organization is a bad time to learn it."*
4. `createOrganization` → org + chart of accounts + expense categories.
5. `createFirstAdmin` → the person, the `admin` role (`granted_by` NULL) **and the four grants**
   (`granted_by` NULL). §2.3.3.
6. `createStore(tx, { personId, orgId }, { code, name })` → the store, **§C.2's fan-out** (which
   writes the `person_store_scope` row), and the default room. Unchanged, T-222's tested path.
7. `setPin(tx, { personId, storeId, pin })` — possible only now, because the PIN is hashed per
   store.
8. **If `firebaseUid` is given**: `sessionsRepo.insertCredential(tx, { personId, kind: 'firebase',
   externalId: firebaseUid })`.

#### 2.3.1 ⭐ `pg_advisory_xact_lock` — because there is nothing to lock

Two concurrent `/setup` submissions with **different** org codes would both pass a zero-org check
and both insert: `organizations.code`'s unique index stops a duplicate code, not a second
organisation. The codebase's usual answer — lock the parent row — has no parent here, and
`packages/db/src/repo/employment.ts:131-132` already wrote the reason down: *"a store's first hire
has no employment rows to lock, and `for update` over an empty set locks nothing at all."* On an
empty database **every** table is that empty set.

So: one transaction-scoped advisory lock on a fixed key, taken first, released at commit or
rollback — the same `SET LOCAL` philosophy as `rls/principal.ts`. Boring and standard (RULES §4).

#### 2.3.2 The zero-organization refusal, and what actually guarantees it

```
bootstrapOrganization: this system already has an organization, so first-run setup is closed.
Add people through /admin/users and stores through /admin/stores.
```

**⚠️ Read this honestly: the check buys a sentence, the lock buys the guarantee.** Same posture as
`createOrganization`'s duplicate-code pre-check — *"Checking first only buys a sentence a human can
act on... the UNIQUE constraint remains the actual guarantee."*

**⛔ And it is a cross-org read with no principal, which this repo has ruled on once already.**
`apps/erp/src/app/expenses/lib.ts:62-66` (T-231 slice 3 / DEF-214, Ian's call) deleted `listOrgs()`
for being exactly that, and set the condition for its return: *"If a platform-level screen ever
needs one it comes back as an explicit system-principal read WITH a caller."* This one satisfies
that condition — it is explicit, it has two named callers, and it returns a **boolean**, never org
rows. That is narrower than the read DEF-214 refused.

**⚠️ RLS landmine, and the reason production must be probed before this is trusted.**
`organizations` carries `FORCE ROW LEVEL SECURITY` with `USING (id = app_current_org())`
(`packages/db/migrations/0011_row_level_security.sql:114-118`). Under a principal-less transaction
`app_current_org()` is NULL, so a non-bypassing role **sees zero rows and cannot INSERT** — the
`WITH CHECK` fails. Everything here works today only because the connecting role bypasses RLS
(migration 0011's own warning: *"Running the app as `postgres` disables every policy below while
all the tests still pass"*; `.env.example:20` connects as `postgres`).

⭐ **The screen therefore inherits the CLI's database posture exactly — if `npm run bootstrap-org`
can write on production, `/setup` can, and if it cannot, neither can.** They open the same kind of
transaction on the same `DATABASE_URL`. That is a deliberate property of sharing one function, and
it is why this is not a new production risk. It is still **verified, not assumed**, in
§2.10's smoketest, because the failure direction under a non-bypassing role is a refused INSERT
(loud), never a silent second org.

#### 2.3.3 `createFirstAdmin` gains the grants

The grants go **inside `createFirstAdmin`**, not inside `bootstrapOrganization`, so the CLI gets
them without the CLI knowing they exist — and so *"the first admin of an organization, the base
case of the authority chain"* stays the one place a `granted_by NULL` authority is minted. Its
existing `orgHasAnyRole` refusal is unchanged and still what makes it *first*.

Its result gains `grantedCapabilities: readonly Capability[]`.

#### 2.3.4 The Firebase credential

`sessionsRepo.insertCredential` already takes `kind` and `externalId`, so **no new function in
`packages/auth/src/sessions.ts` and no change to `packages/db/src/repo/sessions.ts`** — the doc's
scope allowed for a `linkFirebaseCredential` *"if none exists — check `sessionsRepo` first"*, and
the check says one is not needed. **Scope narrowed, not widened.** Linking a Firebase credential
does no crypto, so it does not owe `packages/auth` a wrapper.

The row is `{ personId, kind: 'firebase', externalId: uid }` and nothing else —
`person_credentials_shape_check` (`packages/db/schema/sessions.ts:106`) refuses a `firebase` row
carrying a `secret_hash` or a `lookup_hash`, and `person_credentials_external_id_unique` (:94)
refuses a uid already linked. **Neither can fire here** (zero orgs ⇒ zero persons ⇒ zero
credentials), which is exactly why they are left to the database rather than re-checked in
TypeScript (RULES §6 item 3).

---

### 2.4 ⭐ The `SetupIdentity` seam — the shape lane E builds to

**This is the contract §Slices asks both specs to agree before either builds.** Lane E issues, lane
B consumes. Every name below is exact.

#### Where it lives

`apps/erp/src/lib/session.ts` — **lane E's file**, beside the session cookie, because it is the same
kind of object and the doc already nominated that file. Lane B imports; lane B does not write it.

```ts
/** The 10-minute window in which a verified-but-unknown Firebase identity may create the org. */
export const SETUP_IDENTITY_TTL_MS = 10 * 60 * 1000;

export interface SetupIdentity {
  /** The Firebase uid, ALREADY verified by `verifyIdToken`. Never an unverified assertion. */
  readonly uid: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly expiresAt: Date;
}

/** Lane E calls this after verifying the ID token, finding no credential row, and finding zero orgs. */
export async function setSetupIdentityCookie(
  identity: { uid: string; email: string | null; displayName: string | null },
): Promise<void>;

/** Lane B calls this. Returns null for absent, expired, malformed OR tampered — all four the same. */
export async function readSetupIdentity(): Promise<SetupIdentity | null>;

export async function clearSetupIdentityCookie(): Promise<void>;
```

#### What it is, physically

A cookie named **`shareat_setup`**: `httpOnly`, `sameSite: 'lax'`, `secure` in production only,
`path: '/'`, `Max-Age` 600 — the same options object shape and the same reasons already documented
at `apps/erp/src/lib/session.ts:26-36`.

Its value is `base64url(JSON payload) + '.' + base64url(HMAC-SHA256)` over `{ uid, email,
displayName, exp }`, signed with a key derived from `SESSION_SECRET` under a **new domain-separation
label `'setup-identity'`** in `packages/auth/src/credentials.ts`'s `derivedKey` (:50) — *"One
secret, several purposes, and they must not be interchangeable. The label is what keeps them
apart."* ⛔ Not a bare `SESSION_SECRET` HMAC in the app layer: credential crypto lives in
`packages/auth`.

**Why a signed cookie and not server-side state:** a table means a migration, and both slices are
"migration: none". An in-process `Map` dies on redeploy and is wrong the moment there is more than
one worker. A signed cookie is stateless, survives a deploy mid-setup, and carries no secret — the
uid is not a credential, it is a name that `verifyIdToken` already vouched for. The doc's §Slices
permits exactly this (*"a short-lived signed cookie **or** server-side one-time token"*).

#### How single-use is enforced — and what actually guarantees it

1. `/setup/actions.ts` calls `clearSetupIdentityCookie()` **before** opening the transaction.
2. ⭐ **The guarantee is the database, not the cookie.** A cookie can be copied; a replay reaches
   `bootstrapOrganization`, which takes the advisory lock and refuses because an organization now
   exists. **The token can only ever create the first organisation, and there is only ever one.**
   Deleting the cookie is hygiene; §2.3.1–§2.3.2 is the control. Stated this way deliberately —
   the same shape as *"the UNIQUE constraint remains the actual guarantee."*

#### On expiry, absence, tampering, or a bad signature

All four are **one answer**, because they need one action — the flat-refusal idiom `signInWithPin`
already uses (*"Both branches say the same thing. The shape of the check is deliberately flat"*):

> redirect to `/sign-in?error=Your setup window has closed. Sign in again to continue.`

Both the page and the action do this independently. The page's check is presentation; **the
action's is the control** — a screen hidden without its write being gated is DEF-051.

#### ⚠️ Build-order dependency

Lane B cannot compile `/setup` until `readSetupIdentity` exists. **Requested: the orchestrator
pre-wires the four exports above (and the `'setup-identity'` label) as stubs before either lane
builds**, the way barrels and capabilities were pre-wired for earlier parallel lanes. Otherwise
sequence lane E's seam first. Lane B reports BLOCKED rather than writing into lane E's file.

---

### 2.5 The screen — `apps/erp/src/app/setup/{page.tsx,actions.ts,lib.ts}`

**`page.tsx`** (server, `force-dynamic`). In order:

1. `currentSession()` — already signed in? → `redirect('/')`. Setup is not a page you revisit.
2. `readSetupIdentity()` → null? → the §2.4 refusal.
3. Zero-org check → false? → `redirect('/sign-in?error=This system is already set up.')`.
4. Render one form, prefilled and explained. Fields: organisation code, organisation name, **your
   name** (prefilled from `displayName ?? email`, editable — it is `persons.display_name`, the
   ledger's attribution, not a login), first store code, first store name, **a 6-digit PIN**.
   The verified email is shown as read-only text so Ian can see *which* account is about to become
   the owner.
5. `?error=` renders in the same red panel `sign-in/page.tsx:53-57` uses.

Presentation follows `/sign-in` — `mx-auto max-w-md`, touch-first targets, the numeric PIN input
copied from `sign-in/page.tsx:79-90` (phone portrait is the canvas).

**`actions.ts`** — `createFirstRunAction(formData)`, `'use server'`:

1. `readSetupIdentity()` → null → the §2.4 refusal. **The control, re-checked here.**
2. `clearSetupIdentityCookie()`.
3. `transaction((tx) => bootstrapOrganization(tx, {...}))` — a plain transaction, no principal,
   §2.3.2. Fields read from the form; **the uid is read from the cookie, never from the form**
   (`tests/unit/no-client-supplied-actor.test.ts` is repo-wide law).
4. `signInWithFirebase(tx, { verifiedUid })` — in a **second** transaction, after the first commits,
   so the credential it resolves is really there. `setSessionCookie(token, expiresAt)`.
5. `redirect('/')`.
6. On failure: `redirect('/setup?error=' + errorMessage(err))` using
   `apps/erp/src/lib/constraint-messages.ts`, exactly as `settings/organization/actions.ts` does.
   The cookie is already cleared, so a failed attempt sends Ian back through sign-in — correct: the
   transaction rolled back, the system is still un-set-up, and slice 1 will hand him a fresh token.

**⚠️ Deviation from decision 4, raised once and then built (RULES §4 / bible §0.4).** Decision 4
says the PIN is *"printed once on the success screen, the same rule as the CLI."* **The screen asks
Ian to choose his PIN instead, and never echoes it back.** The CLI's print-once rule exists only
because the CLI *generates* the value; a screen can simply ask. Echoing a live credential into an
HTML response puts it in the browser's cache, its back-button history and any screenshot — and
carrying it to a success page needs either a credential in a URL (⛔ never) or `useActionState`,
a pattern this app does not use anywhere. A mistyped PIN is recoverable: `/staff` already sets one
(`apps/erp/src/app/staff/actions.ts:197`). **Overrule this on approval and I will generate-and-print
instead** — it costs a client component and a success route.

**`lib.ts`** — server-only reads: the zero-org boolean and the `SetupIdentity` view model the page
renders. No writes.

---

### 2.6 Invariants

1. **All or nothing.** Org, chart, categories, person, role, four grants, store, room, store scope,
   PIN credential and Firebase credential land in ONE transaction, or none do. *Proven by an
   injected failure after the store, not by inspection.*
2. **The CLI and the screen cannot drift** — one function, two callers. Adding a step to either is
   adding it to both.
3. **Exactly one organisation can ever be created this way**, even under concurrency (§2.3.1).
4. **The first person's capability set is exactly `super_admin`'s** (§2.2), and the set is derived
   from the matrix, never listed.
5. **The uid is never read from client input** — only from the signed cookie lane E issued after
   `verifyIdToken`.
6. **`/setup` is closed forever once an organisation exists** — from the page, from the action, and
   from the domain function, independently.
7. **No PIN, and no session token, ever appears in a URL, a log line, or a rendered page.**

### 2.7 Tests — `packages/domain/tests/integration/first-run-setup.test.ts`

Real Postgres, lane DB, written and failing for the right reason before the code exists.
Fixture truncates as `organizations.test.ts:41-46` does — these tests **create** the org, so the
fixture starts from genuinely nothing.

| # | Case |
|---|---|
| 1 | ⭐ **Written first — the whole chain.** `bootstrapOrganization` with a `firebaseUid` on an empty DB → org, chart, categories, person, `admin` role, four grants, store, room, store scope, PIN credential, firebase credential. Then **`signInWithFirebase` with that uid returns a session for that person** — the seam slice 1 depends on |
| 2 | ⭐ **Rollback, by injected failure after the store.** A stubbed `setPin` failure → **zero** rows in every one of the eleven places case 1 counted. An untested rollback is a claim with nothing executable behind it |
| 3 | Refuses when **any** organization exists — including one with a *different* code, which the unique index would not catch |
| 4 | The person holds `admin`, and `personHasActiveGrant` is true for all four; **and `authorize` grants every capability `super_admin` holds** — asserted by iterating `CAPABILITIES`, so it fails the day the matrix changes |
| 5 | ⛔ **The negative control for case 4**: a plain `admin` created without the grants is **refused** `post_journal_entry`. Without this, case 4 could pass against a matrix that gave admin everything (memory: *a sweep needs a non-zero control*) |
| 6 | **The CLI path** — `bootstrapOrganization` with **no** `firebaseUid` → everything above except the firebase credential, and `signInWithPin` still returns a session. T-228's guarantee, unbroken |
| 7 | Second call with a duplicate org code → refused, nothing written |
| 8 | A malformed PIN is refused **before** the organisation is created (zero orgs after) |

Also re-run, because §2.3.3 changes a function they cover: `organizations.test.ts`, `stores.test.ts`,
`org-store-identity.test.ts`, and `tests/unit/` (`app-boundaries`, `no-client-supplied-actor`).

### 2.8 Scope — amendments requested

**In the slice-2 list already:** `apps/erp/src/app/setup/{page.tsx,actions.ts,lib.ts}` (create),
`packages/domain/tests/integration/first-run-setup.test.ts` (create),
`packages/domain/src/organizations/index.ts`, `scripts/bootstrap-org.ts`,
`docs/ops/README.md` §"Standing up an organization".

**Requested additions — lane B:**

| Path | Why | Size |
|---|---|---|
| `packages/db/src/repo/organizations.ts` | `anyOrganizationExists(tx)` and `lockFirstRun(tx)`. Both are SQL, and SQL lives in a repo; §2.3.1–§2.3.2 need them and nothing else does | ~14 lines |

**Requested additions — lane E** (mine to declare because slice 2 consumes them; lane E's to build):

| Path | Why |
|---|---|
| `packages/auth/src/credentials.ts` | the `'setup-identity'` `derivedKey` label + `signSetupIdentity` / `verifySetupIdentity` |
| `packages/auth/src/index.ts` | export those two |

**Dropped from the slice-2 list, deliberately (§2.3.4):** `packages/auth/src/sessions.ts` and
`packages/db/src/repo/sessions.ts` — `sessionsRepo.insertCredential` already does it.

**No migration.** No edit to `capabilities.ts`, `nav.tsx`, `CAPABILITY-MATRIX.md`, the bible, the
roadmap, the defects register, the PIN sign-in path, or lane E's and lane D's files.

### 2.9 Out of scope

Linking a Firebase account to a person once an org exists (that is `/admin/users`, a follow-up —
decision 5). Widening `roles.ts:218` (§2.2, proposed, not taken). A second store, sales channels,
items, opening balances (`/cutover` owns those). Password reset, email verification, or anything
about the Firebase account itself — that is v1's project and v1's console. Rate-limiting `/setup`
(it is closed after one success and gated by a verified identity before that).

### 2.10 Done when

typecheck clean · unit tests pass · the eight cases above plus the four re-run suites green on the
lane database · **smoketested in the running app on 9008 against a genuinely empty database** —
sign in, land on `/setup`, create the org, land on `/`, then confirm `/setup` now refuses and the
same email signs straight in · `npm run bootstrap-org --confirm` still works end-to-end on a second
empty database (the CLI must not drift) · `npm run build` with the dev server stopped ·
self-reviewed line by line · **`FOR IAN` block in the READY report.**

⚠️ **Not verified by lane B and stated as such:** anything requiring v1's Firebase project or the
production droplet. Slice 2 is testable end-to-end without a Firebase token — `bootstrapOrganization`
takes a uid string, and the integration tests pass one. The *verification* of that uid is slice 1's.

### FOR IAN — slice 2

- **One thing changed from the plan, and it is worth knowing.** The plan said your first account
  would hold two roles at once — `admin` and `super_admin`. The database only allows one, by an
  index that exists on purpose. So you get the `admin` role **plus the four extra powers
  `super_admin` has, written as four explicit rows**. You end up able to do exactly what a
  super-admin could do — a test proves that, capability by capability — and the fan-out that gives
  you access to every store you create later keeps working, which it would **not** have done under
  a pure super_admin.
- **The one thing you will not be able to do:** appoint a *second* admin from `/admin/users`. That
  check looks at the role name, not at what you can do. Managers and staff are fine. It is a
  six-line fix in a file this slice does not own — say the word and it goes in the next task.
- **You will type your own 6-digit PIN on the setup screen** rather than being shown a generated
  one. Choose it before you start. You can change it later from `/staff`.
- **Nothing new for you to set up for slice 2.** The three GitHub Secrets in the block above are
  slice 1's; this slice needs nothing from you until the screen is live.
