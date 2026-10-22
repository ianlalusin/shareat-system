# T-464 — POS tablet sign-in: pair once, then Employee ID + PIN

> **Status:** spec APPROVED by Ian, 2026-10-22. It was approved in plan mode in the side session started from T-448, and the Employee ID was amended the same day (decision 1 below). Not built yet.
> **Numbers (orchestrator, 2026-10-22):** migration **0214** (0212 and 0213 belong to T-398 S3/S4; whichever PR lands second renumbers, by agreement and never out of order) · bible rows **381** and **382** · port 9008 only once the orchestrator clears it, served against a throwaway `_test` DB per `docs/SMOKETEST.md`.
> **Bible rows to write (planner):** **381** records Ian's four answers below. **382** records the pairing lookup joining row 194's closed auth-door caller list.

## Context

Today a store tablet signs in in two steps, every time:
1. The store's shared Firebase email and password ("Connect this terminal").
2. A PIN.

The Firebase client uses in-memory persistence (`sign-in/firebase-client.ts`), so step 1 is repeated whenever the page reloads. Ian wants a dedicated POS tablet to be set up once. From then on, the sign-in screen asks only for **Employee ID + PIN**.

What exists today:
- **ERP.**
  - PINs are 6 digits and unique per organisation (T-302): an HMAC lookup plus scrypt.
  - The PIN throttle is per store (T-303/T-395, `pin-attempts.ts`). 10 misses in a minute pause sign-in for 2 minutes. 50 misses in a day stop it until a manager reopens it.
  - A PIN session lasts 12 hours (`PIN_SESSION_TTL_MS`). `endAllForDevice` ends a lost tablet's sessions.
  - Each employment already carries a **per-store staff code**, `employments.staff_code` (`SE-007`), allocated by `allocateStaffCode` (`repo/employment.ts`). It is unique on `(store_id, lower(staff_code))` and **printed on the badge and the payslip**.
- **POS v1 (requirements only).** POS v1 has no pairing. A tablet stays on a Firebase login, staff pick their name and type a 6-digit passcode, and **5 wrong attempts lock that profile for 5 minutes** (`POS/src/app/api/server-profiles/route.ts:33-34`). Its device id is a `localStorage` uuid and is not a credential.

**Ian's answers (2026-10-22), which go in bible row 381:**
1. **The Employee ID is the staff code the person already has at that store** (the badge code), **typed as its 3-digit number only** (`007` for `SE-007`). Ian first chose a new org-wide staff number. On review he switched to the badge code, so there is no second number (no second source of truth).
2. A **manager of that store or an admin** may pair and un-pair a tablet.
3. **5 wrong PINs for one Employee ID = a 5-minute pause** for that ID. The existing store limits stay.
4. On a paired tablet, the email form sits behind a **small "Manager sign-in" link**, which keeps T-304 invariant 7.

**Goal (§1.2d):** beat v1's goal of letting a cashier get in fast on the store's one tablet (row 313), while staying attributable. The improvements over v1:
- The tablet holds a **server-issued, revocable secret**, not a shared store password and not a forgeable uuid.
- Day-to-day sign-in uses **no Firebase at all**, which fits the Firebase-exit direction (row 275/280).
- There is no name list on a counter screen.

## Design

### 1. How the tablet remembers being the POS tablet
- **New table `pos_tablet_pairings`.** Columns: `id`, `org_id`, `store_id`, `label` (e.g. "Lipa counter"), `token_hash` (sha256, unique), `paired_by`, `paired_at`, `last_used_at`, `revoked_at`, `revoked_by`, `revoke_reason`.
  - Same-org composite foreign keys `(org_id, store_id)`, `(org_id, paired_by)` and `(org_id, revoked_by)`, following T-398 S3's pattern.
  - **One live pairing per store** (partial unique index on `store_id where revoked_at is null`), following row 313.
  - Pairing a new tablet revokes the old pairing and ends its sessions in one transaction. The screen warns first: "This replaces the current POS tablet 'Lipa counter'."
  - The table is classified in `cutover/classification.ts` and `rls/registry.ts`.
  - The migration is hand-authored (ADR-012 §5) as **0214**.
- **On the device:** one cookie, `shareat_pos_tablet`, holding 32 random bytes (base64url). It is httpOnly, Secure, SameSite=Lax, path `/`. Nothing goes in localStorage. No org or store id reaches the browser (T-304 invariant 9).
- **How long it lasts:** until it is un-paired.
  - The cookie's max-age is 400 days (the browser cap), refreshed on each successful sign-in.
  - The server also refuses a pairing **unused for 30 days**, so a tablet left in a drawer goes dead on its own.
- **Revoking:** set `revoked_at` and call `endAllForDevice` with `deviceId = pairing.id`.
  - The live session on the tablet ends at once.
  - The next load shows today's screen and clears the cookie.

### 2. Pairing and un-pairing (manager or admin)
- **New capability `pair_pos_tablet`.** It is store-scoped and held by manager, admin and super_admin.
  - It is added to `CAPABILITY-MATRIX.md`.
  - Every ✅ has a test proving the ✗ fires: a staff member, and a manager of another store.
- **Pairing:** on the tablet, a manager signs in with email. On the new page `/settings/pos-tablet` they choose a store where they hold the capability, type a label, and confirm.
  - The server creates the row, sets the cookie, and writes the audit row `pos_tablet.paired`.
  - It then ends the manager's own session, and the tablet lands on the new sign-in screen.
- **Un-pairing:** the same page lists each store's live and past pairings: label, paired by, paired at, last used.
  - **Un-pair** uses the row 329 tier-1 confirm: retype the tablet's label.
  - It works from any device, so it covers a lost tablet.
  - Audit row: `pos_tablet.unpaired`.
- The T-304 lost-tablet runbook gains one step: "Un-pair it on POS tablets."

### 3. Employee ID = the existing staff code at this store
- **No new column and no backfill.** The paired tablet already knows its store, so `(store_id, staff_code)` names exactly one employment, and through it one person. This uses the same case-insensitive rule as the unique index and `findEmploymentByStaffCode`.
- **Why not `person_identities(kind='staff_no')`:** nothing writes it. It is unique globally rather than per org, so Padre Garcia and Shareat would collide. Filling it would duplicate the badge code. It stays untouched, and `GLOSSARY.md` notes that the Employee ID is `employments.staff_code`, not that kind.
- **What staff type — the number only (Ian, 2026-10-22: *"only use the number not the letters so i guess 3 digit number since we only have around 30 employees"*).**
  - The box is a 3-digit numeric field with a numeric keypad. No letters and no prefix are shown.
  - The server expands `7`, `07` or `007` to `SE-007`, the `allocateStaffCode` format.
  - A code that is not `SE-` plus digits cannot be typed on the tablet. Such a person (only possible through a T-391 S5 override) uses "Manager sign-in", or is given a fresh `SE-` code.
  - ⚠️ Check DEF-725, about digit-heavy codes, when building: the expansion must never reach a different person's code.
  - ⚠️ **Known limit (audit, 2026-10-23):** numbers are never reused, so a store's 1,000th hire gets `SE-1000`, which cannot be typed in a 3-digit box. That person signs in with "Manager sign-in" until the box is widened. At about 30 staff per store this is years away.
- **Audit fixes, 2026-10-23.** Each has a test that fails without the fix.
  - A sign-in re-checks the pairing under its row lock before issuing the session, so an un-pair racing a sign-in can never leave a live session behind.
  - Pairing a browser that already holds another store's cookie revokes that old pairing.
- **Scope rules that follow:**
  - Someone with no employment at this store (an admin from head office, for example) has no code here and uses the "Manager sign-in" link.
  - A person working at two stores uses each store's own code.
  - The employment must be live: an ended one is refused (T-407).

### 3a. Staff codes are issued automatically only, and never duplicate (Ian, 2026-10-22)
Ian: *"make sure the id is issued automatically not manually to avoid duplicate and for any live code make sure no duplicate"*.
- **No manual codes.** `createEmployment`'s T-391 S9 `staffCode` override goes away. Its only caller was the master-data load (`scripts/lib/master-data-apply.ts`, `packages/etl/src/master-data/staff-plan.ts`), and that load now leaves codes to v2, as t391-q6 = (b) already said. Every hire gets `allocateStaffCode`.
- **Allocator fix (DEF-725).** The allocator reads only `^SE-[0-9]+$` codes, parses the digits as numeric (no `int` overflow), and pads to 3.
- **Database guarantee (migration 0214).**
  - A CHECK requires `staff_code ~ '^SE-[0-9]{3,}$'`.
  - A UNIQUE index on `(store_id, ltrim(substring(staff_code from 4), '0'))` means `SE-007` and `SE-0007` can never coexist at one store.
  - Numbers are never reused, because the allocator takes max + 1 over every employment, ended ones included.
- **Production precheck before 0214 deploys.** Two read-only SELECTs, which the orchestrator runs: one finds non-standard codes, the other finds duplicate numbers per store. Both must return zero rows, or the migration fails loudly.
  - **Run on production 2026-10-22 by Ian** (read-only script `C:\Users\ianla\shareat-master-data\2026-10-22\staffcodes-check.sh`). Results: employments visible **2**, non-standard codes **0**, duplicate numbers per store **0**, so 0214 applies cleanly.
  - ⚠️ Lipa's full roster is not loaded yet. When the T-391 staff load runs, its codes come from `allocateStaffCode`, which this task enforces.

### 4. Signing in on a paired tablet
- **`sign-in/page.tsx`** reads the cookie on the server and resolves it with a new `resolvePosTablet(token)` in `packages/auth`.
  - **Live pairing:** render the new `TabletSignInForm`. It shows the store label, an **Employee ID** box, a **PIN** box (numeric, 6), and a small "Manager sign-in" link that reveals `EmailSignInForm`. It reuses `Input`, `Button` and `Banner` as they are, and T-448's files are not edited.
  - **No cookie, or a dead cookie:** today's screen, unchanged.
- **New server action `signInWithTabletPinAction(formData)`.**
  - It reads only `staffCode` and `pin` from the form. The pairing comes from the cookie, **never from the form**.
  - The pairing is re-resolved on every submit, so a revoke takes effect on the very next attempt.
  - Without a live pairing it refuses with one flat sentence and writes nothing.
- **New `signInWithStaffCodeAndPin(tx, { orgId, storeId, pairingId, staffCode, pin })`** in `packages/auth/src/sessions.ts`. It works in this order:
  1. Charge the **store bucket** through the existing `runChargedPinLookup`, so tiers 1 and 2 are unchanged.
  2. Charge the **staff-code bucket**: 5 misses in 5 minutes means a 5-minute pause.
  3. Find the employment by `(store_id, staff_code)`, then that person's live `pin` credential, then run **one scrypt verify**. A missing employment or missing PIN burns `DUMMY_SCRYPT_HASH`, so every path costs the same.
  4. Run the existing checks: `personMaySignInAtStore` and employment not ended (T-407).
  5. Issue a session through `issue()`: `credentialKind 'pin'`, `storeId`, `deviceId = pairing.id`, 12-hour TTL. Update `last_used_at`.
  6. Then the row 323 position pick, exactly as today.
- **Messages give nothing away.**
  - A wrong PIN, an unknown code and a code with no PIN all say the same sentence.
  - A paused code says: "Too many wrong PINs for this Employee ID. Wait 5 minutes."
  - Unknown codes pause the same way, so the pause itself does not show whether a code exists.
- **Lookups and doors:**
  - The pairing lookup (token hash → pairing) runs before authentication and across orgs, so it runs on the auth door (`authTransaction`). **This adds one lookup to row 194's closed caller list (bible row 382).**
  - A test proves the refusal fires for that lookup: an unknown hash, a revoked row and a stale row each resolve to nothing, and no other table is reachable through it.
  - The closed-list guard test is updated to name it.
  - Everything after runs under `withOrgPrincipal(orgId)`, as in T-304.
- **The staff-code bucket:** `pin_attempts` gains a nullable `staff_code` key column (normalised upper-case). `Bucket` gains `{ store, staffCode }` next to `store`, `org` and `actor`. Same migration, 0214.

### 5. Not in scope
- The unpaired screen and the T-304 Firebase terminal path. Both stay as they are.
- The POS v2 app (`apps/pos`). Its `pos_terminal_links` stays separate; the pairing row is built so POS v2 can reuse it later.
- Android kiosk or lock-task mode, and badge printing.

## Files

The `packages/*` list was sent to the orchestrator because of T-398 S3 overlap.
- **DB:**
  - New: `packages/db/schema/pos-tablet-pairings.ts`, and the `schema/index` export.
  - `packages/db/schema/pin-attempts.ts` (the `staff_code` column).
  - `packages/db/migrations/0214_t464_pos_tablet_pairings.sql` and `_journal.json`.
  - New: `packages/db/src/repo/pos-tablet-pairings.ts`.
  - `packages/db/src/repo/pin-attempts.ts` (bucket).
  - `packages/db/src/repo/employment.ts`: read-only use of the staff-code lookup, or one small store-scoped finder without the `for update` lock.
  - `packages/db/src/cutover/classification.ts` and `packages/db/src/rls/registry.ts`.
  - ⚠️ `rls/same-org-fk-exemptions.ts` and `cutover/purge.ts` are **not** touched unless the build guard demands it. If it does, coordinate with T-398 S3 first.
- **Auth:** `packages/auth/src/{sessions.ts, capabilities.ts, roles.ts, index.ts}`, plus a new `pos-tablet.ts` (resolve, pair, unpair).
- **ERP:**
  - `apps/erp/src/app/sign-in/{page.tsx, actions.ts, TabletSignInForm.tsx (new)}`.
  - `apps/erp/src/app/settings/pos-tablet/{page.tsx, actions.ts}` (new).
  - `apps/erp/src/lib/session.ts` (the cookie helpers).
  - The route-table entry for the new page.
- **Docs:** `CAPABILITY-MATRIX.md`, `GLOSSARY.md`, and the T-304 runbook step. Bible rows 381 and 382 are written by the planner.

## Slices
1. **Pairing:** migration 0214, the table, the capability, the `/settings/pos-tablet` pair and un-pair page, the cookie, audit rows.
2. **Tablet sign-in:** the page switch, the form, the action, `signInWithStaffCodeAndPin`, the staff-code bucket.
3. **Gates and smoke test:** full suite on a PR of its own (it carries a migration), then a smoke test on 9008 once the orchestrator clears it.

## Verification

Tests are written first, and each must fail for the right reason before the code exists.

**An unpaired device cannot use the ID+PIN path.** Each of these gets the flat refusal and creates no `sessions` row:
- no cookie;
- a random forged cookie;
- a revoked pairing's cookie;
- a pairing unused for 31 days.

**The page renders correctly.**
- No cookie: today's terminal form and the email form.
- Live pairing: only Employee ID and PIN, plus the "Manager sign-in" link.
- Revoked cookie: today's screen, and the cookie is cleared.

**The lockout policy holds.**
- 5 wrong PINs for `SE-007`: the 6th try, even with the correct PIN, gets the pause message.
- After 5 minutes on a controlled clock, the correct PIN succeeds.
- Another code still signs in during `SE-007`'s pause.
- An unknown code pauses identically.
- Store tiers 1 and 2 still count these misses.

**Codes are typed and scoped correctly.**
- Typing `7`, `07` and `007` reaches the same employment (`SE-007`). Letters and a 4th digit are refused by the form and by the server.
- `SE-007` at another store is not this store's `SE-007`.
- An ended employment is refused.
- A person with two or more positions gets the position pick.

**Un-pairing works.** Un-pair calls `endAllForDevice`, which ends the tablet's live session, and its next request is signed out.

**The capability is enforced.**
- A staff member cannot pair.
- A manager of store A cannot pair or un-pair store B.
- An admin can.

**The auth-door lookup refuses.** Unknown, revoked and stale hashes each resolve to nothing, and the closed caller-list guard names the new lookup.

**Smoke test on 9008 (`_test` DB):**
1. Pair a tablet as a manager.
2. Sign in with the badge code and PIN.
3. Un-pair from another browser.
4. The tablet falls back to today's screen.
