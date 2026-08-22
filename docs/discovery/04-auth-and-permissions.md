# 04 — Authentication, Roles, Permissions & Security Rules

Discovery document for the relational rebuild. Scope: identity model, role
taxonomy, permission gates, Firestore/Storage rules semantics, session
handling, multi-store isolation, and known gaps. Source repo:
`C:\Users\ianla\webapps\ERP-rebuild`. Every claim below cites `file:LINE`.
Anything not directly verified in source is marked **UNVERIFIED**.

---

## 1. Identity model

There are **four distinct identity systems** in this app, only loosely linked:

### 1.1 Firebase Auth user (`users/{uid}`)
The base identity. Created via email/password or Google sign-in
(`src/components/auth/signup-form.tsx:61-91`, `:93-120`;
`src/components/auth/login-form.tsx:105-132`). On first sign-in the client
calls `getOrCreateUserProfileClient` which creates the Firestore profile doc
directly from the browser (not a server action):
`src/lib/user-profile.ts:19-45`. The doc is created with hardcoded
non-privileged defaults — `role: 'staff'`, `status: 'pending'`,
`storeAccess: []` (`src/lib/user-profile.ts:33-36`) — and this exact shape is
also pinned server-side as the only self-create path the rules allow
(`firestore.rules:80-86`). Fields: `src/types/index.ts:9-24` (`UserProfile`
interface: `uid`, `role: UserRole`, `status: UserStatus`, `storeAccess: string[]`,
`isActive`, plus per-user grant flags described in §3).

`UserRole = 'admin' | 'manager' | 'staff'` (`src/types/index.ts:6`).
`UserStatus = 'pending' | 'approved' | 'rejected' | 'deactivated'`
(`src/types/index.ts:7`).

### 1.2 Local user (`stores/{storeId}/localUsers/{id}`)
A store-scoped PIN-login credential, independent of Firebase Auth, used for
shared-terminal / POS-style sign-in (cashier, cook, server, etc.).
Structure: `src/types/local-user.ts:1-49` — `pinHash` (bcrypt),
`passcodeLookupHash` (HMAC, for clock-in lookup), `nfcCardId`, `assignId`,
`position`/`positions[]`, optional `linkedStaffId` (1:1 link to a Staff
record, `src/types/local-user.ts:47-48`). Created by a manager
(`createLocalUserAction`, `src/lib/actions/local-user.actions.ts:115-178`) or
by self-registration pending manager activation
(`createLocalUserSelfAction`, `:351-413`, sets `isActive:false`, line 396).
PIN verified server-side by `verifyLocalUserPinAction`
(`src/lib/actions/local-user.actions.ts:472-561`) with bcrypt compare
(`src/lib/auth/pin.ts:13-15`), 5-attempt lockout / 5-minute lock
(`local-user.actions.ts:13-14`, `503-524`).

**Critically, a "local user session" is a client-only construct.** After PIN
verification succeeds, the browser builds a `LocalUserSession` object and
persists it to `localStorage` via Zustand (`src/lib/store/useLocalUserStore.ts:25-30,45-66`),
valid 8 hours (`:23`). No server-issued token backs this session — it is not
a cookie, not a JWT, nothing the server can independently verify on a later
call. Every server action that needs to know "who is acting" accepts a
client-supplied `LocalActor` object (`localUserId`, `position`,
`positions[]` — `src/types/local-user.ts:94-100`) as a plain parameter and
only re-derives the position from Firestore (`resolveLocalPositions`,
`src/lib/policies/server-context.ts:152-164`) — it does **not** verify that
the calling browser ever actually entered that local user's PIN. See §7 gap #1.

### 1.3 Kiosk / store identity
Not a separate identity system — a **store attribute** (`store.storeKind ===
'kiosk'`, `src/components/shell/AppShell.tsx:21`) that swaps the UI shell and
constrains which routes are reachable (`src/lib/kiosk/kiosk-access.ts`), but
carries no additional server-side authorization of its own (see §6, §7).

### 1.4 Staff record (`stores/{storeId}/staff/{staffId}`)
The HR/payroll identity (pay rate, position, attendance/payroll linkage).
Linked to a Firebase user via `staff.linkedUserUid` (used by
`listLinkableAccountsAction`, `src/lib/actions/user.actions.ts:286-305`, and
by `requireAttendanceAdjudicator`, `src/lib/policies/attendance-access.ts:42-49`)
and/or to a local user via `staff.linkedLocalUserId` /
`localUser.linkedStaffId`. A person can exist in **any subset** of these four
systems simultaneously — e.g. a floor cashier may have only a `localUsers`
doc and a `staff` doc with no Firebase Auth account at all (never signs in
with email/password, only clocks in via PIN/NFC/fingerprint/face at a shared
terminal using a manager's or a dedicated device's Firebase session).
Cross-store aggregation for salary-advance uses a fifth, global doc,
`staffIdentities/{id}` (`src/lib/actions/staff-identity.actions.ts:15-88`,
type at `src/types/staff-identity.ts`), manually admin-linked, not
automatically derived.

### 1.5 Approval lifecycle
New Firebase users land in `status:'pending'`
(`src/lib/user-profile.ts:34`), see the `/pending` page
(`src/app/pending/page.tsx:12-77`) until an admin approves via
`updateUserProfileAction` (`src/lib/actions/user.actions.ts:32-99`, sets
`status:'approved'`) or rejects/deactivates
(`applyUserStatusTransition`, `:101-172`). A "last active admin" guard blocks
demoting/deactivating/deleting the only approved admin
(`user.actions.ts:51-61`, `126-135`, `204-213`).

---

## 2. Role taxonomy

### 2.1 Firebase roles (the only roles security rules know about)
`admin`, `manager`, `staff` — `src/types/index.ts:6`. Source of truth:
`users/{uid}.role`, read directly by Firestore rules via
`userDoc(uid).data.role` (`firestore.rules:21-31`) and by the server policy
context via a fresh Firestore read every call (`src/lib/policies/server-context.ts:76-103`,
never trusts a client-supplied role).

Precedence: `isAdmin()` implies `isManager()` implies `isStaff()` everywhere
this is checked server-side (`server-context.ts:89-93`: `isManager: role
=== 'admin' || role === 'manager'`; `isStaff: ['admin','manager','staff'].includes(role)`).
Admin is the universal bypass: `hasStoreAccess()` short-circuits true for
admins regardless of `storeAccess` (`server-context.ts:123-127`), and every
Firestore rule of the form `isAdmin() || X` gives admins org-wide access
without a store-membership check (e.g. `firestore.rules:119,141,145,149...`
— the pattern repeats on nearly every collection rule in the file).

### 2.2 Per-user manager grants (finer than role, coarser than a real
permission system)
Four boolean flags on `users/{uid}`, admin-settable only, each with an
admin-implicit bypass baked into both the client and server policy context:

- `canAccessFinancialReports` — gates financial-report **UI visibility only**
  (`src/hooks/useAccess.ts:17-23`); does not gate the underlying financial
  collections' Firestore reads (see §7 gap #2).
- `canAdjustInventory` — `useAccess.ts:26-30`, mirrored server-side
  `server-context.ts:98`.
- `canVoidRecords` — `useAccess.ts:33-34`, `server-context.ts:99`, enforced in
  `deliveryPolicy` (`src/lib/policies/policy.ts:157-165`).
- `canChargeStaff` — `useAccess.ts:37-38`, `server-context.ts:100`.

### 2.3 Local-user "positions" (operational roles, NOT Firebase roles)
Canonical vocabulary: `Cashier, Cook, Server, Dishwasher, Slicer, Inventory
Staff` (`src/types/position.ts:73`), plus store-defined extras
(`PositionPlain`, `:17-28`). Explicitly documented as a separate vocabulary
from Firebase roles: *"Admin, Manager, Staff are Firebase auth roles — not
local user positions"* (`src/types/position.ts:15`). A local user can hold
multiple positions (`positions: string[]`), and permission checks read the
union (`hasLocalPosition`, `src/lib/policies/context.ts:28-34`). Default
fallback position for an unset local user is `'Server'` — deliberately the
least-privileged canonical position (`src/types/position.ts:58-64`).
Position-gated example: cashiers get a 48-hour self-edit window on expenses
they created (`src/lib/policies/policy.ts:80-90`).

### 2.4 Attendance-manager grant
A fifth, narrower admin-only grant, `localUser.attendanceManager` (admin-set,
`src/lib/actions/local-user.actions.ts:200-205`), lets a non-manager local
user adjudicate flagged attendance (late/early-out/pending OT) —
`src/lib/policies/attendance-access.ts:9-26`. `attendanceManager` is
meaningless for managers/admins (they always pass, `attendance-access.ts:38`).

### 2.5 Full role/flag inventory
| Name | Kind | Source of truth | Bypass |
|---|---|---|---|
| `admin` | Firebase role | `users/{uid}.role` | — (top of hierarchy) |
| `manager` | Firebase role | `users/{uid}.role` | bypassed by admin |
| `staff` | Firebase role | `users/{uid}.role` | bypassed by manager/admin |
| `canAccessFinancialReports` | per-user grant | `users/{uid}` | admin always true |
| `canAdjustInventory` | per-user grant | `users/{uid}` | admin always true |
| `canVoidRecords` | per-user grant | `users/{uid}` | admin always true |
| `canChargeStaff` | per-user grant | `users/{uid}` | admin always true |
| `canAcceptRemittance` | per-user grant (type only, `src/types/index.ts:19`) | `users/{uid}` | **UNVERIFIED** enforcement site not located in this pass |
| `attendanceManager` | per-local-user grant | `localUsers/{id}.attendanceManager` | manager/admin always true |
| Cashier/Cook/Server/Dishwasher/Slicer/Inventory Staff (+store extras) | local-user position | `localUsers/{id}.position(s)` or linked `staff.positions` | manager (`isManager` bypass, e.g. `policy.ts:81,170`) |

---

## 3. Permission gates — where checks live, and where they DON'T

Three layers exist: client UI (nav/section hiding), server action
(`buildServerPolicyContext` + policy engine), and Firestore/Storage rules.
**These three layers are maintained independently and are not generated from
one source** — that is the central risk this section documents.

### 3.1 Client-side (UX only, not a security boundary)
- `src/hooks/useAccess.ts:1-53` — the single client hook exposing
  `isAdmin/isManager/isStaff` + the four grant booleans, read straight off
  the live-synced `profile` (no server round-trip).
- `src/components/auth/RequireAccess.tsx:8-58` — gates only "signed in +
  approved", not role. Redirects unauthenticated → `/login`, unapproved →
  `/pending` (`:18-37`).
- `src/hooks/useRequireRole.ts:9-28` — role gate; used by exactly **one**
  layout in the whole app: `src/app/admin/layout.tsx:1-9` (`admin` only).
  There is **no** layout-level role gate for `/manager/**`, `/operation/**`,
  `/accounting/**`, or `/cashier/**` — confirmed: only 1 of 36 `page.tsx`
  files under `src/app/manager/**` calls `useRequireRole`/`useAccess` at all
  (checked directly against the file tree during this review). Individual
  pages under `/manager` (e.g. `src/app/manager/settings/page.tsx:1-19`,
  `src/app/manager/staff-hub/page.tsx:1-17`) render unconditionally — no
  role check — they are link-hub pages, but a `staff`-role signed-in user
  with store access can navigate to them directly.
  `src/app/manager/staff/[id]/staff-details-client.tsx` DOES self-gate
  sensitive fields inline (`isManager || isAdmin` before showing the pay
  "Rate" row, line 592; a broader per-page visibility condition at line 304),
  but this is ad hoc per-page discipline, not a systematic gate.
- `src/components/store/RequireStoreSelected.tsx:12-42` and
  `src/components/store/RequireStoreKind.tsx` — UX guards ("pick a store
  first" / "wrong store kind"), **not access checks** — they don't verify the
  user actually has access to the selected store.
- `src/lib/kiosk/kiosk-access.ts:144-149` (`isKioskPathAllowed`) +
  `KioskRouteGuard` (`src/components/shell/KioskShell.tsx:26-39`) — path
  allowlist for the kiosk shell, explicitly documented as UX only: *"Path-
  based UX gate (the feature's own page/action guards remain the security
  boundary)"* (`KioskShell.tsx:22-24`). A route omitted from `KIOSK_NAV` is
  silently unreachable from the kiosk shell even if the underlying page/action
  would otherwise allow it.
- `src/components/shell/sidebar-nav.tsx:330-335,390` — nav item visibility
  keyed on `isAdmin`/`isManager`/`isStaff` plus `staffPositions` arrays
  (`:114,155,177,188,206,220`) — hides links, does not block navigation.

### 3.2 Server action layer (the real authorization boundary for mutations)
- `buildServerPolicyContext(actorUid)` (`src/lib/policies/server-context.ts:39-103`)
  is the identity+role choke point for every Server Action. It resolves the
  uid from the verified `__session` cookie (never trusts the client-passed
  `actorUid` except as a same-uid assertion check, `:44-47`), throws
  `Unauthorized` if the profile is missing or not `approved`/active
  (`:78-83`), and returns a `PolicyContext` with role, storeAccess and grant
  flags freshly read from Firestore every call.
- `hasStoreAccess(ctx, storeId)` (`server-context.ts:123-127`) — the
  multi-store isolation check every store-scoped action must call explicitly
  (it is not automatic — see §6).
- The policy engine (`src/lib/policies/policy.ts`) encodes per-resource,
  per-status, per-role transition rules (cash requests, expenses, receipts,
  deliveries) — e.g. a requester can never approve their own cash request
  even as a manager, only an admin can override (`policy.ts:52-58`); a voided
  record is terminal everywhere (`:23-25,76-77,106-109,150-151`).
- `resolveLocalPositions` (`server-context.ts:152-164`) re-derives position
  from Firestore by id, but as noted in §1.2/§7, the id itself is
  client-asserted with no proof of a live PIN-verified session.

### 3.3 Firestore/Storage rules layer (data-level enforcement)
See §4. Rules are the last line of defense against a client bypassing the
Server Action layer entirely (raw SDK / devtools calls) — but per §4.4, most
store subcollections are readable by **any** store member regardless of
Firebase role, so rules do not enforce role-based read restrictions within a
store; they only enforce store *membership*.

### 3.4 Places a check exists on only ONE layer (confirmed)
- **Manager/admin section pages** (§3.1): rules-layer read access is broad
  (any store member), and there is no client route gate — so page *content*
  for e.g. staff pay rates is protected only by inline per-field client
  checks (easy to omit on a new page), while the underlying Firestore
  document is fully readable by any store member via the SDK (§7 gap #2).
- **`localActorId`/`LocalActor` position claims** (§1.2, §7 gap #1): trusted
  by the server action layer with no independent verification; the
  underlying Firestore rule layer doesn't apply at all (these are Server
  Action parameters, not rule-checked reads).
- **`staffPerfMonth` "published" gate**: enforced identically in rules
  (`firestore.rules:343-346`) and in the page's own branch logic — the code
  comment notes the page-side check used to be the *only* enforcement before
  the rule was added (`firestore.rules:335-337`, OC-24/25) — i.e. this one has
  since been fixed to exist on both layers.
- **KIOSK_NAV omission**: a route missing from `KIOSK_NAV` is blocked only in
  the kiosk shell's client guard; if the same route is reachable from a
  non-kiosk shell path or a bookmarked URL, only the page/action's own checks
  apply (`KioskShell.tsx:22-24`).

---

## 4. Security-rules semantics

### 4.1 Structure and helpers (`firestore.rules`)
- `isSignedIn()` — `request.auth != null` (`firestore.rules:5-7`).
- `hasUserDoc(uid)` / `userDoc(uid)` — existence + `get()` on `users/{uid}`
  (`:9-19`). Guards every role check against a **missing** user doc (see §7
  gap #3 for the historical version of this bug class).
- `isAdmin()` / `isManager()` — signed-in AND user doc exists AND
  `role == 'admin'|'manager'` (`:21-31`).
- `assignedStoreIds()` / `userHasStoreAccess(storeId)` — reads
  `storeAccess` list off the user doc, defaults to `[]` if not a list
  (`:33-43`).
- `isProvisionedMember()` — admin/manager, OR any staff with at least one
  granted store (`:62-70`). Gates the user directory and global collections
  (`recipes`, `productionRecipes`, `staffIdentities`) so a not-yet-approved
  self-signup (role `staff`, empty `storeAccess`) cannot enumerate the org.
- `performanceIsPublished(storeId)` — `firestore.get()` lookup on a config
  doc, defaults to unpublished if missing (`:52-55`).

### 4.2 The OR-semantics hazard (explicitly documented and tested in this repo)
Firestore rules are a **permissive union** across every matching `match`
block; a narrower/later `allow` can never restrict a broader one that also
matches the same path. This repo hit this bug twice in production and now
carries load-bearing comments + regression tests about it:

- `firestore.rules:384-401` — the canonical statement: *"a narrower allow can
  never restrict a broader one"* — explaining why `localUsers`,
  `clockTerminals`, `staffPerfMonth`, `staffInfractions` must be **excluded
  from** the store-member wildcard (`col in [...]`, line 400), not merely
  given their own `allow read: if false` block, which alone would be a no-op.
- `firestore.rules:358-362` (clockTerminals) and `:375-379`
  (staffInfractions) restate the same trap inline at each collection.
- Regression tests pin exactly this: `tests/rules/firestore.localUsers.test.ts`
  (header comment `:1-20` explains the original bug: "every cashier could
  pull every colleague's credential hashes... bypassing the LocalUserPublic
  stripping"), with explicit assertions that the wildcard still serves
  *everything else* — staff, expenses, nested subcollections
  (`:157-189`). `tests/rules/firestore.staffInfractions.test.ts:1-22` — same
  pattern, notes the fix order matters (Server Action gate added **first**,
  then the rules exclusion).
- A second, distinct trap documented at `firestore.rules:384-397`: the
  "obvious" fix (`{path=**}` with a `path[0] != 'x'` condition) is **wrong**
  and was verified wrong against the emulator — a `**` capture is not bound
  during a `list`, so every collection query died with "Variable is not
  bound in path template" (deny-by-error). The working spelling is a
  single-segment `{col}` capture plus a separate `{rest=**}` for depth.
- `storage.rules:3-16` states the identical principle for Storage rules and
  flags a live gap: store-membership is **not yet checked** on
  `stores/{storeId}/{allPaths=**}` writes (`storage.rules:49-53`) — any
  signed-in user can write into *any* store's Storage folder (size-capped at
  25 MB, no membership check). Documented as deliberately deferred pending
  emulator-backed tests, not yet fixed as of the rules file read in this pass.
- `storage.rules:13-16` also flags a distinct historical footgun: a bare
  `get(...)` in Storage rules is Firestore syntax, deploys with only a
  warning, and **silently denies at runtime** — must use `firestore.get(...)`.

### 4.3 Collections with explicit narrow rules (allowlist-style)
- `users/{userId}` — read: self or `isProvisionedMember()`
  (`firestore.rules:73`); create: locked to safe defaults (`:80-86`); update:
  self-edit allowlists only cosmetic fields via `diff().affectedKeys().hasOnly(...)`
  (`:96-101`); delete: admin only (`:103`).
- `stores/{storeId}` — read: admin or store member (`:119`); create/delete/update: admin only (`:121,127`), with an explicit prior-bug note that this used to be manager-writable and let a manager bypass the admin-only `updateStoreAction` server action via a direct client `updateDoc` (`:122-126`).
- `localUsers`, `clockTerminals`, `staffInfractions`: see §4.2 — narrow-and-excluded.
- `staffPerfMonth`: readable by admin, or by store-member manager, or by any store member once `performanceIsPublished` (`:343-346`).
- Financial-config collections requiring direct client writes are manager/admin gated explicitly: `paymentAccounts` (`:270-273`), `paymentSettings` (`:280-283`).
- `recipes`/`productionRecipes`/`staffIdentities` (global, cross-store): `isProvisionedMember()` read, all writes server-only (`:588-612`).
- Biometric secrets `fingerprintSecrets/{storeId}/users/{id}` and `faceSecrets/{storeId}/users/{id}` live **outside** `stores/{storeId}/**` specifically so the recursive store-member wildcard cannot reach them — `allow read, write: if false` unconditionally (`:622-634`).

### 4.4 Collections whose rules are permissive (readable by ANY store member, any Firebase role)
The default rule for store subcollections is broad by design:
`firestore.rules:348-353,398-401`: *"All store subcollections are readable by
any store member... Write is intentionally omitted here — all mutations go
through Server Actions."* This wildcard covers (non-exhaustive, confirmed via
rules test fixtures `tests/rules/firestore.localUsers.test.ts:67-76`):
`staff`, `expenses`, `receipts`, `deliveries`, `suppliers`, `loans` (+ nested
`payments`), and by omission from the exclusion list also:
`payrollPeriodCache` (explicit comment confirming this is intentional,
`firestore.rules:545-549`), `posSoldItemsCache`, `salaryAdvance*` collections,
`journal`/`accounts`/`dailySummary` (write-blocked but read falls through the
wildcard — no separate read restriction is defined for these in the file),
`cashLedger`/`cashAccounts` (these DO have an explicit, narrower-but-identical
read rule restating `isAdmin() || userHasStoreAccess` — same net effect,
`:141,145,149`). **Net effect: a `staff`-role cashier with `storeAccess`
containing store X can read essentially the entire operational and financial
document tree for store X directly via the Firestore client SDK** — including
other staff members' pay rates (`stores/{storeId}/staff/{staffId}.hourlyRate`/
`dailyRate`, confirmed field names at `src/app/manager/staff/[id]/staff-details-client.tsx:531`),
salary-advance balances, and cached payroll figures — regardless of whether
the UI hides these fields for non-managers. This is confirmed by regression
test assertions that a cashier "can still read staff" / "can still list
staff" (`tests/rules/firestore.localUsers.test.ts:157-163`) and "can still
read expenses" (`:165-167`) — these are asserted as the *desired* behavior
(the fix must not narrow them), not flagged as a bug in the source, but they
are exactly the shape of a coarse, store-level-only ACL rather than a
role/field-scoped one.

---

## 5. Session handling

- **Cookie**: `__session`, Firebase's reserved Hosting-forwarded cookie name
  (must not be renamed — `src/lib/server/session.ts:6-8`). httpOnly, `secure`
  in production, `sameSite:'lax'` (`src/app/api/auth/session/route.ts:22-28`).
  Max age 14 days (Firebase's session-cookie ceiling,
  `src/lib/server/session.ts:11`).
- **Minting**: `POST /api/auth/session` verifies the client's Firebase ID
  token first (`adminAuth.verifyIdToken`, `session/route.ts:16`) before
  minting the session cookie (`adminAuth.createSessionCookie`, `:17-19`) —
  garbage tokens never reach cookie creation.
- **Refresh**: the client re-mints the cookie on every
  `onIdTokenChanged` event — sign-in, page load, and the SDK's automatic
  hourly ID-token refresh (`src/firebase/provider.tsx:128-164`) — with a
  3-attempt exponential backoff retry if the sync call fails (`:150-161`).
- **Server verification**: `getServerSessionUid()`
  (`src/lib/server/session.ts:19-29`) calls `adminAuth.verifySessionCookie`;
  returns `null` (not throw) on any failure, so callers decide strictness.
  `buildServerPolicyContext` treats "no session" as hard-unauthorized in
  production, with two narrow escape hatches:
  1. `runWithVerifiedPrincipal` (`src/lib/server/verified-principal.ts:57-67`)
     — an `AsyncLocalStorage`-scoped identity for two allow-listed cookieless
     callers that authenticate with a different verified credential: the
     Flutter mobile inventory app (Bearer Firebase ID token,
     `verified-principal.ts:14-16`) and a wastage-email-ingest shared secret
     (`:17-18`). The allow-list is closed (`VerifiedPrincipalSource` union,
     `:12-18`) — adding a new entry requires an explicit code change.
  2. A dev/script-only fallback to a client-supplied `actorUid`, gated to
     `NODE_ENV !== 'production'` (`server-context.ts:58-62`).
- **Local-user PIN session**: not a session token at all — see §1.2. Expires
  8 hours client-side only (`useLocalUserStore.ts:23,29`); cleared on idle
  timeout, active-store switch, or logout (`ManagerIdleLogoutGate.tsx:59-61`,
  `provider.tsx:232`, `LocalUserGate.tsx:73-74`).
- **HMAC secret for passcode lookup**: `LOCAL_PASSCODE_HMAC_SECRET`
  (`src/lib/auth/local-credential-core.ts:14`). If unset in production, the
  code logs a `[SECURITY]` error but **does not fail closed** — it falls back
  to a hardcoded, source-visible secret string
  (`local-credential-core.ts:16-18`), meaning `passcodeLookupHash` values
  become forgeable/predictable if the env secret was never actually set. Not
  verified in this pass whether the secret is set in the live App Hosting
  environment (**UNVERIFIED**).
- **Admin PIN** (a *second*, separate PIN system gating sensitive admin
  actions — distinct from local-user PINs): PBKDF2 210,000 iterations with a
  random salt (`src/lib/actions/admin-pin.actions.ts:42-49`), replacing an
  older SHA-256 scheme whose fields are explicitly deleted on rotation
  (`:50-51`). A verified admin PIN mints a 15-minute session recorded under
  `users/{uid}/adminSessions` (`admin-pin.actions.ts:108-113`) —
  **UNVERIFIED** whether/where this `sessionId` is subsequently checked by
  other admin actions (not located in this pass; if nothing reads it back,
  the PIN-gated 15-minute window may be advisory-only).
- **Idle logout**: 30 minutes of inactivity signs a `manager`-role Firebase
  session out entirely (`ManagerIdleLogoutGate.tsx:8,51-64`), tracked via a
  cross-tab `localStorage` timestamp so an idle background tab doesn't sign
  out an active foreground tab (`:14-18,39-46`). A **separate** 30-minute
  idle timer clears only the local-user PIN session (not the Firebase
  session) for non-admin/manager roles (`LocalUserGate.tsx:24,71-76`).
- **`forceReauthAtMs`**: written on every admin-driven profile change
  (`src/lib/actions/user.actions.ts:73,153`) but **not read anywhere**
  client-side (confirmed: no reference in `src/firebase/provider.tsx` or
  elsewhere under `src/firebase`/`src/hooks`) — appears to be a stub for a
  forced-reauth mechanism that was never wired up. Not a security hole per se
  (role/status changes still take effect immediately because
  `buildServerPolicyContext` re-reads the Firestore profile on every call,
  and Firestore rules evaluate the live document too), but it is dead code
  that could mislead a reviewer into thinking a stronger mechanism exists.

---

## 6. Multi-store isolation

- **Rules layer**: every store-scoped Firestore rule follows the pattern
  `isAdmin() || userHasStoreAccess(storeId)`, checking `storeId` against the
  caller's live `users/{uid}.storeAccess` array (`firestore.rules:41-43` and
  repeated on essentially every rule in the file). Admins bypass store
  scoping entirely (org-wide).
- **List-query trap** (explicitly tested): a Firestore **list** rule that
  can't be satisfied fails the *whole query*, it does not filter it down —
  documented at `firestore.rules:113-118` and pinned by
  `tests/rules/firestore.stores.test.ts:87-109` (a member can list stores by
  documentId-`in`-storeAccess; cannot list the whole collection; cannot widen
  the `documentId()` filter to a store they lack).
- **Server action layer**: `hasStoreAccess(ctx, storeId)` must be called
  explicitly inside each action (`server-context.ts:123-127`); it is **not**
  automatic — every action's comments repeatedly flag this as a required,
  easy-to-forget check (e.g. `src/lib/actions/local-user.actions.ts:50,130,194,241,276,306,365`,
  `src/lib/actions/expense.actions.ts:162`). A new action that forgets this
  call has no other safety net stopping cross-store access.
- **Client layer**: `getEffectiveStoreIdClient` resolves which store a page
  operates on from `profile.activeStoreId`/URL param
  (`src/app/local-user-login/page.tsx:109-113`), but this is only a UX
  default — actual isolation is enforced by the two layers above, not by
  which store happens to be "active" in the UI.
- **Global (non-store-scoped) collections** — `recipes`, `productionRecipes`,
  `staffIdentities` — deliberately have **no** store isolation at all; they
  are shared org-wide by design (`firestore.rules:579-612`), gated only by
  `isProvisionedMember()` (any approved staff/manager/admin with at least one
  store, or any manager/admin).

---

## 7. Known gaps (for the relational rebuild to close by design)

1. **Local-user identity has no server-verified session.** `LocalActor`
   (`localUserId`, `position`, `positions[]`) is a plain client-supplied
   parameter on ~24 server actions (confirmed call sites include
   `expense.actions.ts:163,634`, `receipt.actions.ts:352`, and 22 others
   listed by the grep in this review). The server only checks that the named
   local user *exists and holds that position* (`resolveLocalPositions`,
   `server-context.ts:152-164`) — it never confirms the calling browser
   actually completed that local user's PIN check in this session. Any
   Firebase-authenticated caller with `storeAccess` to a store can claim to
   be *any* local user in that store (all local users' names/positions are
   already visible via `listLocalUsersAction`) and inherit their
   position-based permissions (e.g. the cashier 48-hour expense-edit window,
   `policy.ts:82-90`) or, more sensitively, attendance-adjudication rights if
   the claimed local user happens to have `attendanceManager:true`
   (`attendance-access.ts:11-26`). **Rebuild recommendation**: make the
   position-acting-as claim part of a server-issued, short-lived,
   cryptographically signed session established at PIN-verification time,
   not a client-asserted parameter re-validated only by existence.

2. **Store-level ACL, not role- or field-level.** Firestore rules grant read
   access to almost every store subcollection to *any* store member
   regardless of Firebase role (`firestore.rules:348-353`, confirmed
   permissive by design and pinned by tests,
   `tests/rules/firestore.localUsers.test.ts:157-189`). A plain `staff`-role
   cashier can read colleagues' pay rates (`staff.hourlyRate`/`dailyRate`),
   salary-advance balances, cached payroll figures, and full financial
   ledgers for their store straight from the client SDK — the UI hides these
   fields for non-managers (e.g. `staff-details-client.tsx:592`) but that is
   the *only* protection; it's bypassable via devtools/direct SDK calls.
   **Rebuild recommendation**: enforce row/column-level authorization in the
   relational layer (e.g. view-level or query-level role filtering) rather
   than relying on client-side field hiding.

3. **No systematic role gate on manager-facing pages.** Only
   `src/app/admin/layout.tsx` enforces a role at the layout level; there is
   no equivalent for `/manager/**`, `/operation/**`, `/accounting/**`, or
   `/cashier/**`. Individual pages self-gate inconsistently (some fields
   gated inline, most pages not gated at all beyond "signed in + approved").
   Combined with gap #2, this means page-level protection for sensitive
   views depends entirely on ad hoc per-page/per-field discipline.
   **Rebuild recommendation**: a declarative route-level permission
   requirement (checked server-side, e.g. in middleware/loader) so a new page
   cannot ship without an explicit access decision.

4. **Storage rules have a known, currently-open store-membership gap.**
   `storage.rules:49-57` allows any signed-in user to write into *any*
   store's Storage folder (25 MB cap, no content-type check, no membership
   check) — documented in the rules file itself as deliberately deferred
   pending emulator-backed tests (`storage.rules:49-53`), not yet closed as
   of this review.

5. **HMAC fallback secret is fail-open, not fail-closed.** If
   `LOCAL_PASSCODE_HMAC_SECRET` is unset in production,
   `local-credential-core.ts:14-18` logs an error but still serves a
   hardcoded, source-visible fallback secret, making every
   `passcodeLookupHash` forgeable/predictable rather than refusing to
   operate. **Rebuild recommendation**: fail closed (refuse clock-in lookups)
   rather than silently degrade to a public secret.

Additional smaller items worth carrying into the rebuild's design (not
scored as top-5, but verified in this pass):
- The admin-PIN 15-minute `adminSessions` record
  (`admin-pin.actions.ts:108-113`) has no confirmed consumer in this codebase
  pass — **UNVERIFIED** whether it's actually enforced anywhere or vestigial.
- `forceReauthAtMs` is written but never read (§5) — dead code that implies a
  forced-reauth capability that doesn't exist.
- Kiosk route gating fails by *omission*: a page not added to `KIOSK_NAV`
  becomes unreachable from the kiosk shell with no explicit "denied" audit
  trail — easy to lose track of as pages are added (`kiosk-access.ts:72-122`
  is a manually maintained allowlist).
