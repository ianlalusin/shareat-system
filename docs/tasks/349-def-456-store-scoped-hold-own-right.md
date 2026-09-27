# T-349: "Hold in their own right" keeps the grant at that store (DEF-456)

**Status:** APPROVED 2026-09-27 (orchestrator, after independent Opus spec audit; S3 awaits Ian's Q1)
**Closes:** DEF-456 (`docs/DEFECTS-REGISTER.md:663`). **Ian's ruling, 2026-09-27:** *"keep it at that store."*
**Migrations:** S1 `0165_t349_person_grants_store_grant.sql`, journal `when` = `1800329507084` (0164's `1800243107084` +
86 400 000; it must exceed the previous entry, ADR-012 §5.5). S2 none. **S3 `0166_t349_def456_repair.sql` is reserved
but not built** until Ian answers Q1; its `when` = previous entry + 86 400 000 × (idx gap), so `1800415907084` if it
directly follows 0165. If another migration lands first, S3 takes the next free index and recomputes.
**Needs:** T-343 S7 committed first (S7 is editing `apps/erp/src/app/admin/users/actions.ts` in the working tree now).
S2 after S1 lands. S1 and S2 **never wait** for S3. One migration per cycle (DEF-091).
**Model:** Sonnet, both roles, per slice. TESTER writes first and records the raw red; BUILDER second; paths disjoint (§5).
Integration tests run on a lane DB: `node ~/.claude/skills/orchestrator/tools/run-with-db.mjs <lane>_test npx vitest run <file>`.

---

## 1. Goal (bible §1.2d)

**v1's goal.** Authority came from a position held *at that store* (0159 header). T-291 §C3 / Ian's decision 5 added one
act on top: an administrator can make a job-derived capability the person's own, so switching the job default off no
longer takes it away.

**What v2 does today (static read, HEAD `1e98cd0`).** Since 0159 a `'position'` row always has a store and every other
row never has one (`person_grants_store_shape_check`, 0159 step 7). The hold form posts only `capability`
(`[personId]/page.tsx:241-249`). `grantCapabilityAsActor` (`packages/auth/src/roles.ts:571`) calls
`accessRepo.grantCapability` with `grantSource: 'grant'`. Its person-level branch (`packages/db/src/repo/access.ts:637-655`)
looks for an active `storeId IS NULL` row, finds none, and **inserts a NULL-store row**.
`personHasActiveGrant` (`access.ts:739`) and `authorize.ts:155` treat a NULL-store row as valid at every store.
**Cashier-at-SmokeStore's `confirm_receipt` becomes `confirm_receipt` at every store where the person has scope.** The
list then shows it twice, the button stays, and the banner says "…is now held in their own right" without saying where.

**v2's goal.** Holding a capability in their own right gives a hand-granted row **at the same store as the position row it
was made from**. It lasts after the job default is switched off, can be revoked by itself, and **never gives more
reach than the position row did**. The page shows one line per capability and store.

**Live data (read-only, `shareat_dev`, 2026-09-27):** 1 active NULL-store `'grant'` row sits beside an earlier active
`'position'` row for the same person and capability (the S6b tester's Dev Cashier, `confirm_receipt`, `2026-09-27T03:17Z`).
Shapes: 18 `position`/store, 4 `owner`/NULL, 2 `grant`/NULL (1 revoked), 0 NULL-source rows. **Production (erp2): count at
cutover** with §3.5's matching condition as a `SELECT`.

## 2. Evidence

| Fact | Where |
|---|---|
| Shape CHECK: only `'position'` may carry a store | `0159_*.sql` step 7; `schema/access.ts:256` |
| ⚠️ **That CHECK has a NULL-blind hole.** For `grant_source IS NULL` with a store set, branch 1 evaluates to NULL and branch 2 to FALSE, so the whole expression is NULL, and a CHECK passes on NULL. No such rows exist today (tally above). §3.1 closes the hole | 0159 step 7 text |
| Per-store active slot is `(person, grant_name, store_id) WHERE revoked_at IS NULL AND store_id IS NOT NULL`, with **no source term**. A `'grant'` row at store S would collide with the `'position'` row at S | 0159 step 4; `schema/access.ts:221-223` |
| Composite FK `(source_ref, store_id)` is MATCH SIMPLE, so a row whose `source_ref` is NULL skips it | 0159 step 8 |
| Fill trigger acts only when `grant_source = 'position'` | 0159 step 9 |
| `personHasActiveGrant(…, atStoreId)` matches `store_id IS NULL OR store_id = atStoreId`, **whatever the source**. So a store-scoped `'grant'` row already matches only its own store. No `authorize()` change is needed (verified, not assumed; H1 proves it) | `access.ts:731-746`; `authorize.ts:155` |
| Reconcile only ever sees `'position'` rows: `heldPositionGrantsForPersonAtStore` filters `grant_source = 'position'`, and step 5 calls the `'position'` branch of `grantCapability` | `repo/position-defaults.ts:206-230`; `domain/people/position-defaults.ts:219-300` |
| `positionGrantsElsewhere` (refusal text) filters `'position'` | `access.ts:760-795` |
| RLS: `person_grants` is `derived` via `persons.org_id`. Adding a store to a row changes nothing about who can see it. **`rls/registry.ts` needs no edit** | `rls/registry.ts:275-282` |
| Cutover: `person_grants` is `keep` and has no `clearColumns`. **`cutover/classification.ts` needs no edit** | `cutover/classification.ts:128-134` |
| A test pins the old CHECK: `'grant'` with a store → 23514. It goes red by design | `packages/db/tests/integration/t341-person-grants-store-migration.test.ts:441-447` |
| Position defaults for **org-scoped** capabilities already apply org-wide (T-341 §7, out of scope there). A store-scoped `'grant'` row for such a capability reaches exactly as far as its position row, no further | `docs/tasks/341-*.md:165`; `authorize.ts:155` passes no store for org scope |

## 3. Design

### 3.1 S1: migration `0165_t349_person_grants_store_grant.sql` (hand-authored, ADR-012 §5; header names T-349/DEF-456 and why)

**Planner ruling, coexist rather than upgrade in place.** Decision 5's literal words were "upgrade its provenance". Since
0159 an in-place upgrade (turning the `'position'` row at S into `'grant'`) breaks two things: (a) revoking the hand
grant would also remove the job access until the next reconcile happens to run, a silent narrowing; (b) the next reconcile
re-inserts a `'position'` row at S and collides with the upgraded row. **A separate `'grant'` row at S next to the
`'position'` row at S** gives decision 5's intent exactly: the hand grant and the job grant each survive the other's
removal. The page folds the two into one line (§3.4), which is Ian's "the position row may then drop from the list".

1. **Shape CHECK, replaced** (`DROP CONSTRAINT person_grants_store_shape_check`, then re-add under the same name):
   ```sql
   ("grant_source" IS NOT DISTINCT FROM 'position' AND "store_id" IS NOT NULL)
   OR ("grant_source" IS NOT DISTINCT FROM 'grant')
   OR ("grant_source" IS DISTINCT FROM 'position' AND "grant_source" IS DISTINCT FROM 'grant' AND "store_id" IS NULL)
   ```
   `'grant'` may carry a store or not; `'elevation'`, `'owner'` and NULL never do. `IS NOT DISTINCT FROM` closes the
   NULL-blind hole (§2). It validates clean on every known DB. If one holds a NULL-source row with a store, the
   `ADD CONSTRAINT` fails loudly, which is correct.
2. **Per-store slot, split by source.** `DROP INDEX person_grants_active_position_store_unique`, then:
   - `person_grants_active_position_store_unique` on `(person_id, grant_name, store_id) WHERE revoked_at IS NULL AND
     store_id IS NOT NULL AND grant_source = 'position'`
   - `person_grants_active_grant_store_unique` on `(person_id, grant_name, store_id) WHERE revoked_at IS NULL AND
     store_id IS NOT NULL AND grant_source = 'grant'`

   The person-level slot (`store_id IS NULL`) is unchanged.
3. *(Step 3 is not in 0165. The DEF-456 data repair is slice S3, §3.5, with its own migration.)*
4. No trigger change: the fill trigger is still `'position'`-only. No RLS or policy change. No FK change: the new rows
   carry `source_ref` NULL.

0165 ships steps 1, 2 and 4 only.

**`schema/access.ts` (BUILDER):** mirror step 2's two `uniqueIndex(...).where(...)` definitions and step 1's `check`.
Rewrite the `storeId` column comment ("ALWAYS set for `'position'`, MAY be set for `'grant'` (T-349, a hold in their own
right at that store), NEVER for any other source") and the index comment. **No new table**, so there is nothing to
classify or register.

### 3.2 S2: repo, `packages/db/src/repo/access.ts`

1. **`GrantCapabilityInput`** gains a third arm: `GrantBase & { grantSource: 'grant'; atStoreId: string; sourceRef?: never }`.
   `grantCapability` routes it to a new **store-grant branch**, kept separate from the person-level branch. Neither branch
   ever reads or rewrites the other's rows (the T-341 rule, extended).
2. **Store-grant branch, idempotent.** "Already held in their own right at S" means an ACTIVE row for `(personId, grantName)`
   with `grant_source IN ('grant','owner')` and (`store_id = S` **or** `store_id IS NULL`). If one exists, return
   `{ id, wrote: false, heldEverywhere }` and write nothing. `heldEverywhere` is true when the covering row has a NULL
   store. `'elevation'` and NULL-source person-level rows **do not count**: they can be swept, and holding at S must
   outlive that sweep. Otherwise `INSERT … (grant_source 'grant', store_id S, source_ref NULL)
   ON CONFLICT (person_id, grant_name, store_id) WHERE revoked_at IS NULL AND store_id IS NOT NULL AND grant_source = 'grant'
   DO NOTHING`, then re-select. A lost race returns the winner's id with `wrote: false, heldEverywhere: false`.
   **Never a raw 23505.**
3. **`grantCapability`'s return** widens to `{ id: string; wrote: boolean; heldEverywhere: boolean }` on every branch.
   Existing callers ignore both new fields. The `'position'` and person-level branches set `wrote` truthfully; their
   `heldEverywhere` is `false` for `'position'` and `true` for person-level.
4. **New read `activePositionGrantForPerson(tx, { personId, grantId })`** → `{ id, grantName, storeId, storeName } | null`.
   It returns a row only if it is ACTIVE, `grant_source = 'position'` and belongs to `personId`. It joins `stores` for the
   name. RLS stays in force, and the `persons`-derived policy is the org boundary (roles.ts:560-566's ruling).
5. `GrantRow.storeId` comment updated (a `'grant'` row may carry one).
6. **`personHasActiveGrant`'s JSDoc (`access.ts:722-728`)** is rewritten (comment only). Given `atStoreId`, any row
   carrying a store (a `'position'` row, or since T-349 a `'grant'` row held in their own right at that store) matches
   only its own store. A NULL-store row matches every store. **The query does not change.**
7. **`packages/auth/src/authorize.ts:31-32`, comment only.** The axis-2 paragraph says the same thing: "a store-carrying
   row (`'position'`, or a T-349 `'grant'` hold) is honoured only at its own store". No code change.
9. **Added 2026-09-27 (orchestrator, from the S2 pre-commit review), binding on S2: org-scoped capabilities.**
   17 position-defaultable capabilities are org-scoped (`CAPABILITY_SCOPE[c] !== 'store'`, e.g. `post_journal_entry`);
   `authorize` never applies a store filter to them, so a store-scoped hold would be honoured everywhere while the
   banner says "at SmokeStore". Ruling: when the capability is not store-scoped, hold-own-right writes the existing
   **person-level** `'grant'` row (store NULL) — exactly the authority the position row already gives org-wide, so
   nothing widens and T-291 decision 5's intent is kept — and the banner omits the store ("…is now held in their own
   right." / "…was already held in their own right everywhere."). Store-scoped capabilities keep the §3.2 store-grant
   branch. Test **H9**: hold on an org-scoped capability writes a NULL-store `'grant'` row, the banner names no store,
   and a second click writes nothing.
8. **Added 2026-09-27 (orchestrator, from the S1 post-commit review of `3d601ab`), binding on S2:**
   - **`source_ref` is always NULL on a store-scoped `'grant'` row.** 0165's header says the composite
     `(source_ref, store_id)` FK "does not apply" to the new rows; that is only true because S2 writes `source_ref NULL`.
     `person_grants_position_source_ref_check` still lets a `'grant'` row keep a ref, so `'grant'` + ref + store is a
     legal shape since 0165, and with both columns set the MATCH SIMPLE FK fires and pins the store to the history
     default's store (a bare 23503). 0165 is applied locally and its checksum is recorded, so its header is NOT edited;
     this note is the correction. Test **H7**: after a hold, the new row's `source_ref IS NULL` (read back from the DB).
   - **The store comes only from the position row, never from input.** Nothing in the DB ties a `'grant'` row's
     `store_id` to the person's org or scope (FK checks bypass RLS; the policy keys on `persons.org_id`), so S2's
     "the store is taken from the job's grant row" (§3.4) is the sole guard. Test **H8**: a forged `atStoreId`/store field
     in the form for another org's store (or any store other than the position row's) writes nothing and refuses.
   - Items 5 and 6 are also where `schema/access.ts:197`'s present-tense "the store-grant branch sets it" becomes true;
     S2's builder re-reads all three comments (`repo/access.ts:493`, `:727`, `schema/access.ts:197`) against the code.
   - Page fold (§3.4) must label a store-scoped `'grant'` row with its store, so no hand grant reads as org-wide
     (`admin/users/lib.ts:137,189` today render "hand-granted" with no store).

### 3.3 S2: gate, `packages/auth/src/roles.ts`

`GrantCapabilityAsActorInput` gains an optional `positionGrantId?: string`. **Same function, same three checks, same order**
(DEF-223: one gate). After the target checks, when `positionGrantId` is given:
- `activePositionGrantForPerson` returns null, or its `grantName !== input.capability` → refuse through the existing
  `refuse(...)` helper with **"That permission no longer comes from their job there. Reload the page to see what they
  hold now."** (T-343 wording rules: one line, no ids, no key).
- otherwise call `grantCapability({ grantSource: 'grant', atStoreId: row.storeId, … })`.

Without `positionGrantId` the function behaves as today (person-level). Return type `void` → `{ wrote: boolean;
heldEverywhere: boolean; storeName: string | null }` (`storeName` is the position row's store on the hold path and null on
the person-level path). Store identity comes **only from the position row**, never
from the form (§7.1: a store id arriving from a form is not evidence).

### 3.4 S2: action and page

**`actions.ts` (`setCapabilityGrantAction`).** Read `positionGrantId` (a new field; `grantId` stays the revoke field).
When `intent === 'hold_own_right'`:
- exactly one capability **and** a non-empty `positionGrantId` are required. Otherwise refuse with **"Reload the page and
  try again."** before any write. So `intent` can now only *refuse*, never widen: an old cached form cannot fall back to
  an org-wide grant.
- then one `grantCapabilityAsActor(tx, actor, { personId, capability, positionGrantId })` call.

Banners (success, after commit):
- wrote → `` `${capabilityTitle(cap)} is now held in their own right at ${storeName}.` ``
- not wrote, `heldEverywhere` → `` `${capabilityTitle(cap)} was already held in their own right everywhere.` ``
- not wrote, otherwise → `` `${capabilityTitle(cap)} was already held in their own right at ${storeName}.` ``

Every other banner is unchanged.

**Page (`[personId]/page.tsx` + a pure `foldActiveGrants` in `lib.ts`).** Dedupe rule: **one line per capability and
store.**
- A `'position'` row is *covered* by an ACTIVE `'grant'` row for the same capability at its store, or by an ACTIVE
  `'grant'`/`'owner'` row with a NULL store.
- A covered `'position'` row is not listed on its own. Its covering line gains a muted second provenance line, "also via
  Cashier at SmokeStore" (`positionProvenanceLine`), and shows **no** hold button.
- A `'grant'` row with a store reads "hand-granted at SmokeStore". The store name comes from the page's existing `stores`
  list, so there is no new query. It keeps its Revoke form.
- An uncovered `'position'` row renders as today, and its hold form adds `<input type="hidden" name="positionGrantId"
  value={g.id} />`.
- `grantSummaryLine` keeps its signature (`Pick<GrantRow,'grantSource'>[]`). The page passes it the **folded** list
  (covered position rows removed), so *inherited* = uncovered position rows and *granted* = non-position rows.
- The picker's `heldNames` is unchanged.

**Revoke path.** No new code. The store-scoped `'grant'` row is revocable (`canRevokeHere`: source ≠ `'position'`) through
`revokeGrantById`. Its `'position'` sibling is untouched, so the job access at S continues, and the position line (with
its button) comes back.

**Reconcile.** No code change. It sees only `'position'` rows. Because the per-store slot is split (§3.1 step 2), a
re-inserted `'position'` row at S coexists with the `'grant'` row at S. C1–C4 prove it.

### 3.5 S3: the DEF-456 data repair, migration `0166_t349_def456_repair.sql` (reserved; built only if Ian answers Q1 yes)

A *widened row* is an ACTIVE `'grant'` row R with `store_id IS NULL` and `source_ref IS NULL`, where a `'position'` row P
for the same `(person_id, grant_name)` **was active at R's time**: `P.granted_at < R.granted_at AND (P.revoked_at IS NULL
OR P.revoked_at > R.granted_at)`. Since 0159 no other path produces one: the picker hides held capabilities, and 0159
step 5 twins copy `granted_at` and are never `'grant'`.

For each R, and for each distinct `P.store_id` among those P rows:
1. Insert a `'grant'` row at that store with R's `granted_by` and `granted_at` (the 0159 step 5 precedent: provenance is
   copied, not re-dated). Use `ON CONFLICT DO NOTHING` on `person_grants_active_grant_store_unique`.
2. Then revoke R with `revoke_reason = 'DEF-456: an own-right hold was widened to every store; re-scoped to the store(s)
   of the job it came from (migration 0166)'`.

This can re-scope to **more than the clicked store**: every store with a P active at R's time (Q1 says so). It runs as
the owner role (no RLS), the same as 0159's data steps, and needs 0165 applied first.

## 4. Tests (TESTER, real Postgres via run-with-db, raw red recorded; real `authorize()`; every ⛔ asserts nothing was written)

Fixture: org, stores **SmokeStore (A)** and **B**, admin actor, staff target with scope at A and B, Cashier at A with the
`confirm_receipt` default on (the capability is store-scoped; the TESTER confirms `CAPABILITY_SCOPE`, or picks another
store-scoped capability that Cashier can hold, and names it).

| Id | Slice | Case | + / ⛔ | Expected red |
|---|---|---|---|---|
| M1 | S1 | APP role raw insert `'grant'` + store A, source_ref NULL | + succeeds; row reads back with store A | 23514 (old CHECK) |
| M2 | S1 | raw inserts: `'elevation'`+store, `'owner'`+store, **NULL source + store**, `'position'` with no store and no ref | ⛔ each 23514 (the position case: 23514 or the trigger's named error; record which) | NULL-source leg **passes today** (the hole): red = "expected rejection, resolved" |
| M3 | S1 | active `'position'` at A + active `'grant'` at A, same person/cap | + both exist | 23514 (the old CHECK fires before the unique index) |
| M4 | S1 | a second active `'grant'` at A | ⛔ 23505 (`person_grants_active_grant_store_unique`) | 23514 today (wrong reason). Record it |
| M5 | S1 | `'grant'` at A + NULL-store `'grant'`, same person/cap | + both exist (separate slots) | 23514 |
| M6 | S3 | **repair (only if Q1 = yes)**, on a scratch DB migrated to 0165 (the t341 migration-test technique). Seed: (a) widened R1, with P at A active then and now; (b) widened R2, with P at A granted before R2 and **revoked after R2's `granted_at`** (the revoked-since case); (c) a control NULL-store `'grant'` with **no** P active at its time (P revoked before it, or none) | + R1 and R2 revoked with the DEF-456 reason; each has one active `'grant'` at A carrying its own `granted_by`/`granted_at`. ⛔ the control row is untouched; ⛔ no row at B | locating `0166` fails; **and, against 0165 steps 1-2 alone, R1 and R2 are still active** (assert this first, as the pre-state) |
| H1 | S2 | **widening.** Hold via `grantCapabilityAsActor({…, positionGrantId: P_A})`, then switch Cashier's default at A off (position row revoked) | + `authorize(staff, cap, {storeId: A})` resolves. ⛔ `authorize(…, {storeId: B})` throws `AuthorizationError` | **red today:** B resolves (NULL-store row) |
| H2 | S2 | row shape after hold | + exactly one new active row: `'grant'`, store A, source_ref NULL, granted_by = admin. ⛔ no active NULL-store row for the cap | NULL-store row present |
| H3 | S2 | idempotency: hold twice | + second call returns `wrote: false`; row count unchanged; no 23505 | `wrote` undefined / 23505 |
| H4 | S2 | concurrent double hold (two connections, `Promise.all`) | + exactly one active `'grant'` at A; neither call throws | 23505 surfaces |
| H5 | S2 | "already held": target holds an active NULL-store `'owner'` (or `'grant'`) row for the cap | + `wrote: false, heldEverywhere: true`, nothing inserted. With an `'elevation'` NULL-store row instead → + a store row IS inserted | as H3 |
| H6 | S2 | ⛔ refusals: `positionGrantId` of another person's row; of a revoked row; of a `'grant'` row; capability ≠ row's cap; self as target; staff actor | each throws (the §3.3 sentence for the first four; the existing self/authorize refusals otherwise); zero rows written | 1–4 resolve today (field ignored, org-wide insert) |
| H7 | S2 | revoke the hand grant at A (default still on) | + position row at A still active; `authorize` at A resolves. ⛔ at B throws | as H1 |
| C1 | S2 | reconcile: hold at A, then end the Cashier employment at A | + `'grant'` at A active, position row revoked; `authorize` at A resolves | `'grant'` at A absent |
| C2 | S2 | hold at A, default off, default on again (`setPositionDefault`) | + one new active `'position'` row at A beside the `'grant'` row; no 23505. ⛔ no second `'grant'` row | no active `'grant'` row at A |
| C3 | S2 | `reconcilePositionGrants` for store B (Cashier also at B) after a hold at A | ⛔ nothing written at A; the `'grant'` row untouched | none (guard) |
| C4 | S2 | `ReconcileResult.granted` after C2 | + reports the capability as granted (a new position row), not suppressed by the `'grant'` row | record the value |
| P1 | S2 | page fold (`renderToStaticMarkup`, S6b harness): position at A + `'grant'` at A | + one line: title, "hand-granted at SmokeStore", "also via Cashier at SmokeStore", a Revoke form. ⛔ no hold form for it | two lines + hold form |
| P2 | S2 | position at A uncovered + position at B covered by `'grant'` at B | + A's line has the hold form carrying hidden `positionGrantId` = A's row id; B folded | no `positionGrantId` field |
| P3 | S2 | NULL-store `'owner'` row + position at A | ⛔ position folded, no hold form | hold form present |
| P4 | S2 | `grantSummaryLine` over P1's rows | `0 inherited from positions · 1 granted` | `1 inherited … · 1 granted` |
| A1 | S2 | action: hold, mock returns `{wrote: true, storeName: 'SmokeStore'}` | `ok === '<Title> is now held in their own right at SmokeStore.'` | old sentence |
| A2 | S2 | same with `wrote: false, heldEverywhere: false` | `ok === '<Title> was already held in their own right at SmokeStore.'` | as A1 |
| A2e | S2 | same with `wrote: false, heldEverywhere: true` | `ok === '<Title> was already held in their own right everywhere.'`; ⛔ no store name in `ok` | as A1 |
| A3 | S2 | ⛔ `intent=hold_own_right` with no `positionGrantId`, or two capabilities | `error` param; `grantCapabilityAsActor` **not called** | called / org-wide |
| A4 | S2 | ⛔ picker grant (no intent) | `grantCapabilityAsActor` called without `positionGrantId`; banner `Granted: …` unchanged | green now (guard) |

**Files (TESTER).** `packages/db/tests/integration/t349-person-grants-store-grant-migration.test.ts` (M1–M5);
`packages/auth/tests/integration/t349-hold-own-right.test.ts` (H1–H7);
`packages/domain/tests/integration/t349-hold-own-right-reconcile.test.ts` (C1–C4); `apps/erp/tests/t349-hold-own-right-page.test.ts`
(P1–P4, A1–A4, A2e; S6b harness, `.test.ts` + `createElement`, partial `@shareat/auth` mock);
`packages/db/tests/integration/t349-s3-def456-repair-migration.test.ts` (M6, S3).

**Edits to existing tests, red by design.** Each is recorded in the TESTER report as **a behaviour change the orchestrator
ruled, not a weakening**:
- `t341-person-grants-store-migration.test.ts:441-447` (S1). The `'grant'`+store → 23514 assertion becomes
  `'elevation'`+store → 23514. Nothing else in the file changes.
- `apps/erp/tests/t343-s6b-admin-users-labels.test.ts` (S2):
  - `grantFormData` adds `positionGrantId`.
  - **A2, both halves.** The one-capability hold's expected banner gains ` at SmokeStore`, and its `grantCapabilityAsActor`
    mock returns `{ wrote: true, heldEverywhere: false, storeName: 'SmokeStore' }`. The two-capability case with
    `intent=hold_own_right` now expects an `error` param, not the A3 banner.
  - **U2** also asserts the hidden `positionGrantId`.
  - **A5**: the call-count clause excludes the refused hold cases, and nothing says `now held`.

**Negative halves (unedited, must stay green):** `packages/domain/tests/integration/t341-position-grants-per-store.test.ts`,
`position-defaults.test.ts`, `packages/auth/tests/integration/roles.test.ts`, `sessions.test.ts`,
`t343-s2b-authorize-lookup.test.ts`, `packages/domain/tests/integration/t346-store-opening-date.test.ts` (its NULL-store
`'grant'` insert stays legal), `apps/erp/tests/admin-users-lib.test.ts`, `tests/unit/migration-journal.test.ts`, the
classification/RLS registry guards, `route-capability-coverage`, `action-link-sweep` (the hold control keeps its size).

## 5. Paths (disjoint per slice; S2 after S1 lands; S3 only after Ian's Q1, after S1)

**S1 BUILDER:** `packages/db/migrations/0165_t349_person_grants_store_grant.sql` (new), `packages/db/migrations/meta/_journal.json`,
`packages/db/schema/access.ts`.
**S1 TESTER:** `packages/db/tests/integration/t349-person-grants-store-grant-migration.test.ts` (new),
`packages/db/tests/integration/t341-person-grants-store-migration.test.ts` (lines 441-447 only).
**S2 BUILDER:** `packages/db/src/repo/access.ts`, `packages/auth/src/roles.ts`, `packages/auth/src/authorize.ts`
(**comment only, :31-32**), `apps/erp/src/app/admin/users/actions.ts`, `apps/erp/src/app/admin/users/[personId]/page.tsx`,
`apps/erp/src/app/admin/users/lib.ts`.
**S2 TESTER:** `packages/auth/tests/integration/t349-hold-own-right.test.ts`, `packages/domain/tests/integration/t349-hold-own-right-reconcile.test.ts`,
`apps/erp/tests/t349-hold-own-right-page.test.ts` (all new), `apps/erp/tests/t343-s6b-admin-users-labels.test.ts`
(`grantFormData`, A2, U2, A5 only).
**S3 BUILDER:** `packages/db/migrations/0166_t349_def456_repair.sql` (new), `packages/db/migrations/meta/_journal.json`.
**S3 TESTER:** `packages/db/tests/integration/t349-s3-def456-repair-migration.test.ts` (new).
⛔ **Do not touch:** applied migrations (0159 included), `authorize.ts` code (only its :31-32 comment is edited; H1 proves
the code needs nothing, and a BUILDER who finds otherwise stops and reports), `domain/people/position-defaults.ts`, `repo/position-defaults.ts`, `rls/registry.ts`,
`cutover/classification.ts`, `persons.ts` (`activeGrantCount`, §7), `CAPABILITY_MATRIX`, the bible, the register, the glossary.

## 6. Invariants

1. **Nothing widens.** A hold at S authorises at S and nowhere else a position row at S would not. H1, H7, M6.
2. **Store identity comes from the position row, never the form.** H6, A3.
3. **Idempotent and race-safe:** a re-click writes nothing; a double submit never surfaces 23505. H3, H4.
4. **Hand grant and job grant are independent:** revoking either leaves the other (and its authority) intact. H7, C1, C2.
5. **The DB enforces the shape** (RULES §6 item 3, §15.11): no NULL-blind CHECK; one active `'grant'` per (person, cap, store). M1–M5.
6. **One gate** (DEF-223): the hold still passes `authorize(grant_capability)`, the self-refusal and the capability check in `grantCapabilityAsActor`. H6.
7. **One line per capability and store on the page; names, never ids** (DEF-417). P1–P4, A1–A2.
8. Tenancy unchanged: `person_grants` stays `derived` RLS; `registry.ts` and `classification.ts` need no edit (the BUILDER confirms in the report).
9. `withOrgPrincipal`, never a bare transaction (DEF-287).

## 7. Out of scope

- Position defaults for org-scoped capabilities reaching org-wide (T-341 §7; unchanged, and not widened here).
- `/admin/users` list's `activeGrantCount` (`repo/persons.ts:79`) counts raw rows, so a hold shows +1 there. Candidate
  DEF for the orchestrator. It is not a widening.
- The `jobIsElsewhere` refusal does not mention a hand grant held at another store. A candidate wording follow-up.
- Holding org-wide from this page (the picker still grants person-level; unchanged).
- **Orchestrator:** GLOSSARY ("held in their own right" = a `'grant'` row at the position's store), bible §13 row for the
  coexist-over-upgrade ruling, DEF-456 status, production count at cutover.

## 8. Done when (per slice)

Every case seen red for its stated reason (guards green), then passing. Typecheck + unit clean. **FULL** integration green
on a lane DB (most at risk: every grant/position/authorize file). Scratch-DB proof from zero (ADR-012 §5.8).
Build green with 9008 stopped. **Smoketest on 9008** (`docs/SMOKETEST.md`, screenshots, 390px and 1280px, both themes):
Dev Cashier's position-held row → "Hold in their own right" → banner "<Title> is now held in their own right at
SmokeStore." → one line, "hand-granted at SmokeStore" / "also via Cashier at SmokeStore", Revoke present, no hold button.
Re-click from a stale tab → "was already held…". Revoke → the position line and its button come back.
**S3** (only if Q1 = yes): M6 red then green, plus scratch-DB proof. On dev, afterwards, Dev Cashier's `confirm_receipt`
reads "hand-granted at SmokeStore", and the store-less row appears in the revoked list with the DEF-456 reason.

## 9. Open for Ian

**Q1. Re-scope the rows DEF-456 already widened?** (dev: 1 row; production: count at cutover.) Slice S3 (§3.5) revokes
each widened NULL-store hand grant and replaces it with a hand grant **at every store where the person held that
capability through a job at the moment of the click**. That can be **more than the store that was clicked**: the old
button did not record which job row it came from, so the repair cannot tell. **This removes authority at every other
store**, which someone may have used since the click. Planner proposes **yes**: your ruling says the click was meant to
stay at that store, and nobody chose the wider reach. If no, S3 is never built, and those rows stay org-wide until an
administrator revokes them by hand. S1 and S2 ship either way.
