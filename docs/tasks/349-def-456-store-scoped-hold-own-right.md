# T-349: "Hold in their own right" keeps the grant at that store (DEF-456)

**Status:** S1 DONE 2026-09-27 (`3d601ab`, migration 0165), S2 DONE (`ea0ccb4`), S2b DONE 2026-09-27 (post-commit follow-ups, §4b). **S3 (repair of already-widened rows, migration 0166 reserved) APPROVED — Ian answered Q1 YES 2026-09-27 — **S3 DONE 2026-09-28** (migration 0166, with Amendment A1 and the row_security wrapper).** S2c DONE 2026-09-28 (§4c; gates PASS on its files; §9.4 banner check folded into the T-350 S2 smoketest; post-commit audit pending).
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
- not wrote, `heldEverywhere` → store-scoped: `` `${capabilityTitle(cap)} was already held in their own right at every store they have access to.` ``; org/platform: `` `…in their own right everywhere.` `` (amended by §4e E5, S2e)
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
| A2e | S2 | same with `wrote: false, heldEverywhere: true` (store-scoped) | `ok === '<Title> was already held in their own right at every store they have access to.'` (§4e E5); ⛔ no store name in `ok` | as A1 |
| A2f | S2e | same, ORG-scoped capability | `ok === '<Title> was already held in their own right everywhere.'`; ⛔ no "have access to" | pins the non-store arm |
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

## 4b. S2b: follow-ups from the S2 post-commit review of `ea0ccb4` (APPROVED 2026-09-27, orchestrator)
Model Sonnet, tester then builder; no migration. Rulings are the orchestrator's; each finding was verified by the auditor.
1. **Org-scoped hold over an `'elevation'` row** (`repo/access.ts` person-level arm, ~:728-745): the rank-upgrade to
   `'grant'` is the intended effect of "hold in their own right" (it must outlive `revokeElevationGrantsForOrg`), but it
   is a write — return `wrote: true` when the arm upgraded a lower-ranked row, so the banner says "…is now held in their
   own right." Leg **H10**: elevation row exists → hold → row is `'grant'`, `wrote: true`, banner "now held".
2. **Fold loses provenance** (`admin/users/lib.ts` ~:230): `alsoViaByOtherId` becomes `Map<string, PositionDefaultSource[]>`
   so every covered position row's job appears under its cover ("also via Cashier at StoreA; Supervisor at StoreB"), and
   `grantSummaryLine` still counts correctly. Leg **P5**: one NULL-store grant covering two position rows at two stores
   shows both jobs.
3. **Picker store dimension** (`[personId]/page.tsx` ~:66): the picker excludes only capabilities held ORG-WIDE (an active
   row with `store_id` NULL); a store-scoped hold or a position row no longer removes the capability from the picker, so
   an admin can still grant it org-wide. `t343-s6b` U4's expected set changes accordingly (TESTER-ruled edit). Leg **P6**.
4. **Revoked list** (`[personId]/page.tsx` ~:307-310): a store-scoped hand grant reads "hand-granted at <store>" there
   too. Leg **P7**.
5. **No `holdResult!`** (`actions.ts` ~:211-217): compute the ok sentence inside the branch that holds the result
   (`let ok: string`), removing all five assertions (RULES: prefer a guard to `!`). Behaviour unchanged; A-legs pin it.
6. **Deterministic cover** (`repo/access.ts` ~:659): `ORDER BY store_id NULLS FIRST` before `limit(1)`, so an org-wide
   cover wins and "everywhere" is reported when true.
7. **Honest titles:** H8's describe says what it proves (structural: the input has no store field; a row is written at
   the position's store), H2's title matches what it checks.
- **BUILDER paths:** `packages/db/src/repo/access.ts`, `apps/erp/src/app/admin/users/{lib.ts,[personId]/page.tsx,actions.ts}`.
- **TESTER paths:** `packages/auth/tests/integration/t349-hold-own-right.test.ts`, `apps/erp/tests/t349-hold-own-right-page.test.ts`,
  `apps/erp/tests/t343-s6b-admin-users-labels.test.ts` (U4 only).

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

## 8b. S2c — findings from the S2b post-commit /code-review (`8d14e7a`), 2026-09-28 — NOT YET SPECCED (planner)
1. `packages/db/src/repo/access.ts:746` — the upgrade UPDATE sets `grantSource` only; `grantedBy` stays the writer of
   the `'elevation'` row, so a row reading "hand-granted" names someone who did not grant it (rule:
   `packages/auth/src/roles.ts:656`, `granted_by` is the ACTOR). Also check it against T-349's coexist-not-upgrade design.
2. `apps/erp/src/app/admin/users/lib.ts:223` — `others.find` picks the cover row by array order; `grantsForPerson` has
   no `orderBy`, so the "also via …" annotation is nondeterministic and hops after an upgrade.
3. `apps/erp/src/app/admin/users/[personId]/page.tsx:68` — intended (§4b item 3), but the `Granted: X.` banner
   (`actions.ts:204`) does not say the grant is org-wide. Banner should name the scope.
4. `8d14e7a`'s message claims the S5.5s full-suite run covered it; that run predates the commit. The next full gates
   (at the S5.5t commit) are the first real run over it.

### 4c. S2c: follow-ups from the S2b post-commit review of `8d14e7a` (APPROVED 2026-09-28 (orchestrator, after independent Opus spec audit; Ian's Q2 folded))

Model **Sonnet, tester then builder**; **no migration**. All four items are buildable now: **Ian answered Q2 on
2026-09-28: "Close and replace"** (§9). Line numbers are HEAD `645693d`. Paths are disjoint from T-349 S3
(`0166_*.sql`, `_journal.json`, `packages/db/tests/integration/t349-s3-def456-repair-migration.test.ts`) and from
T-343 S5.5u/S5.5v/S5.5w (none of their files are under `admin/users/`, `repo/access.ts` or `packages/auth/`).
⛔ `tests/unit/t343-throw-ratchet.test.ts` is dirty in the S5.5v lane: **do not edit it**. Its check is `<=` the
ceiling, so this slice needs no edit there (item 1 adds only `throw refuse(...)`, never a raw `throw new Error`).

**Rulings.**

- **Finding 1: the upgrade keeps someone else's name on a "hand-granted" row. Ian's ruling (Q2): close and replace.**
  - *Where it comes from.* T-248 (`fddef02`, bible §13 row 188: "closed as a monotone upgrade") re-tags the row in
    place. This happens on every person-level call whose source outranks an `'elevation'` or NULL-source row, including
    the picker. S2b only made it report `wrote: true`. `assignRole` writes elevation rows with
    `grantedBy: input.grantedBy` (`roles.ts:112`), which may be NULL. So an upgraded row can read "hand-granted" while
    its `granted_by` is NULL or is whoever appointed the manager, and its `granted_at` is the appointment date. That
    breaks the rule at `roles.ts:656` and `:671` (`granted_by` is the ACTOR, never null).
  - *Coexisting at person level is impossible.* `person_grants_active_person_level_unique` (`schema/access.ts:226-228`)
    has no source term. **Rejected**: it would need a migration and would put two active rows on one line.
  - *Ruled mechanism (Ian, Q2 = replace).* In the same transaction, revoke the lower-ranked row with a fixed reason,
    then insert a fresh row with the incoming source, the actor as `granted_by` and `now()`. No migration. This keeps
    both moments on record, matching this table's own rule ("re-granting inserts a new one rather than reviving the
    old", `access.ts:573-576`). The result is still monotone: the active row only ever becomes less sweepable. What
    changes from row 188 is the mechanism, a new row instead of a re-tag. **Bible §13 row 188's closing sentence is
    superseded by this ruling.** Recording that in the bible is the orchestrator's job at commit, not the builder's.
  - *Invariants this must keep (the audit checked each).*
    - (a) **Atomic.** The revoke and the insert run on the same `tx`. The UPDATE must come first, because the insert
      needs the slot free. If the insert fails, the revoke rolls back.
    - (b) **No window.** Other sessions see either the old active row or the new one. Under READ COMMITTED (the
      default: `client.ts:84` passes no isolation level) there is never a moment with neither.
    - (c) **Idempotent on double-click.** A concurrent second call blocks on the row lock. It then sees the row
      revoked, so its UPDATE touches 0 rows. Its INSERT hits the committed winner and does nothing. It returns
      `wrote: false`. Never a raw 23505.
    - (d) **`authorize()` is unchanged for the person.** `authorize.ts` never reads `grant_source`. The old row and
      the new one have the same `(person, grant_name, store_id NULL)`, so every check answers the same before and
      after.
    - (e) **Tenancy.** Both statements run on the caller's `withOrgPrincipal` tx. `person_grants` stays `derived`
      RLS, with a `WITH CHECK` through `persons`. `registry.ts` and `classification.ts` need no edit.
- **Finding 2.** Fix both halves.
  - The fold's choice of cover must not depend on input order. **An org-wide (NULL-store) cover wins over a
    same-store cover**, the same preference as the repo's covering select (`access.ts:674`, `nulls first`). The page
    and the "already held everywhere" banner then agree.
  - Separately, `grantsForPerson` gains `ORDER BY granted_at, id`, so the page list stops moving after an UPDATE. The
    other callers (`authorize.ts:269`, `domain/people/position-defaults.ts:275`) do not depend on order (verified).
- **Finding 3.** The picker grant is always person-level.
  - For a **store-scoped** capability (`CAPABILITY_SCOPE[c] === 'store'`) that means every store, and the banner
    says so.
  - For `'org'`/`'platform'` capabilities the banner is unchanged. "At every store" would claim a store axis they
    do not have.
- **Finding 4. No work.** The S5.5t commit (`7896e2a`) ran the full gates over a tree that contained `8d14e7a`.
  Integration: 3464 passed, 22 failed, and every failure was in the uncommitted S5.5v red files. Closed.

**BUILDER items.**

1. **Supersede, not re-tag.** In `packages/db/src/repo/access.ts:726-748`, the person-level "existing" arm of
   `grantCapability`:
   1. Keep the rank test (`grantSourceRank(input.grantSource) > grantSourceRank(existingSource)`). When the incoming
      call does not outrank, nothing changes: `{ id: existing.id, wrote: false, heldEverywhere: true }`, no write.
   2. When it outranks, **do not UPDATE `grant_source`**. Instead, on the same `tx`:
      - `UPDATE person_grants SET revoked_at = now(), revoke_reason = SUPERSEDED_BY_HAND_GRANT_REASON
        WHERE id = existing.id AND revoked_at IS NULL`.
        - Export `SUPERSEDED_BY_HAND_GRANT_REASON = 'Replaced by a hand grant of the same capability.'` from
          `repo/access.ts`.
        - The wording is plain, with no ids (T-343). It is also true for a NULL-source row, not only for an
          elevation row.
        - **Ignore the affected-row count.** It is 0 when a concurrent supersede, the admin-arrival sweep or a manual
          revoke got there first. In every one of those cases the next step is still correct.
      - `INSERT { personId, grantName, grantedBy: input.grantedBy, grantSource: input.grantSource, sourceRef: null }`.
        `granted_at` takes its default, `now()`, which equals the revoke's `revoked_at` because both use the
        transaction's timestamp.
        - Use `.onConflictDoNothing({ target: [personId, grantName], where: sql\`revoked_at is null and store_id is null\` })`
          with `.returning({ id })`.
        - The `where` must match `person_grants_active_person_level_unique`'s predicate exactly.
      - If a row was inserted, return `{ id: <new id>, wrote: true, heldEverywhere: true }`.
      - If not (a concurrent writer holds the slot), re-select the active `storeId IS NULL` row and return
        `{ id: winner.id, wrote: false, heldEverywhere: true }`. If none is visible, `throw refuse(...)` with the same
        two sentences as `:718-721`. Never a raw 23505, never a raw `throw new Error`.
      - ⛔ Why "0 rows" must NOT return early: when the sweep revoked the elevation row concurrently, returning early
        would leave the person holding neither row, and the admin's deliberate grant would be lost. Falling through
        to the insert keeps it.
   3. Comments to rewrite, each to say *supersede* (a revoke plus a new row, with who and when both kept):
      - the JSDoc at `:573-604`, i.e. the "rank-based rewrite", "`grantSource` is re-written ONLY when" and T-248
        paragraphs;
      - the `GRANT_SOURCE_RANK` JSDoc at `:537-561`, where ":541 idempotent branch … may only ever move a stored
        `grantSource`" becomes "may only ever REPLACE the active row with a less sweepable one";
      - the S2b comment at `:740-742`.

      In each, cite Ian's Q2 ruling (2026-09-28). ⚠️ The `'position'` branch and its `reconcilePositionGrants`
      "elevation → position" note (`:553-556`) are a separate arm and do NOT change. Leave that sentence alone.
2. **Deterministic cover in the fold.** In `apps/erp/src/app/admin/users/lib.ts:216-243` (`foldActiveGrants`), replace
   `others.find` (`:222-227`) with two lookups:
   1. First, an active `'grant'`/`'owner'` row for the capability with `storeId === null`.
   2. Only if there is none, a `'grant'` row with `storeId === position.storeId`.

   Rewrite the JSDoc at `:199-206` to state the preference and why: it agrees with `access.ts:674`.
3. **Stable order.** In `packages/db/src/repo/access.ts:929-945` (`grantsForPerson`), add
   `.orderBy(asc(personGrants.grantedAt), asc(personGrants.id))`. `asc` is already imported. Update the JSDoc: the
   order is stable, so the admin page list does not move after an UPDATE.
4. **Banner names the scope.** In `apps/erp/src/app/admin/users/actions.ts`:
   - Add `CAPABILITY_SCOPE` to the `@shareat/auth` import (`:19-28`). It is exported at
     `packages/auth/src/index.ts:8`.
   - Define a local phrase at `:202-205`: when `CAPABILITY_SCOPE[c] === 'store'` it is
     `` `${capabilityTitle(c)}, at every store` ``, otherwise `capabilityTitle(c)`.
   - One capability → `` `Granted: ${phrase}.` ``
   - Several → `` `Granted ${n} capabilities: ${phrases.join('; ')}.` ``

   The hold banners (`:173-180`) and the revoke banner stay as they are.

**BUILDER paths:** `packages/db/src/repo/access.ts`, `apps/erp/src/app/admin/users/lib.ts`,
`apps/erp/src/app/admin/users/actions.ts`. ⛔ Not `roles.ts`: its callers already pass `grantedBy: actor.personId`
and ignore `id`. The returned `id` changing on a supersede has no production consumer (verified: `roles.ts:647,657,673`
read only `wrote`/`heldEverywhere`; `organizations/index.ts:287` and `roles.ts:109,705` discard the result).

**TESTER paths.**

- **New files.**
  - `apps/erp/tests/t349-s2c-fold-and-banner.test.ts` (P8, G1-G3). It uses the S6b harness with a partial
    `@shareat/auth` mock that spreads the real module, so `CAPABILITY_SCOPE` is the real one.
  - `packages/db/tests/integration/t349-s2c-grants-order.test.ts` (R1).
  - `packages/auth/tests/integration/t349-s2c-supersede-elevation.test.ts` (E1-E8).
- **Existing files to edit.** Each edit is **a ruled behaviour change, not a weakening**, and is recorded in the
  TESTER report.
  - `apps/erp/tests/t343-s6b-admin-users-labels.test.ts`:
    - **A1** (`:595-600`, `record_sale`) and **A3** (`:638-649`, `record_sale` + `submit_sales_day`). Both
      capabilities are store-scoped, so each expected title gains `, at every store`.
    - Retitle both so the title states the suffix.
    - ⛔ Do not touch A2/A4 (`:603-636`, the hold path).
  - `apps/erp/tests/t349-hold-own-right-page.test.ts`: **A4** (describe `:574`, `it` `:585-592`). `confirm_receipt` is
    store-scoped, so the expectation gains `, at every store`. Retitle "unchanged" to "names every store". The
    `positionGrantId`-absent assertion stays.
  - `packages/auth/tests/integration/authorize.test.ts`, **case 12** (`:720-758`):
    - Its `after` and `survived` selects have no `revoked_at` filter, so after a supersede they would read one of two
      rows at random. Add `and revoked_at is null` to both, and assert that exactly one active row exists.
    - Reword the comment at `:751-752` from "move this row OUT of the sweepable set" to "replace it with a
      non-sweepable row".
    - The assertions themselves do not change: source `'grant'`, and the row survives the admin-arrival sweep.
  - `packages/auth/tests/integration/t349-hold-own-right.test.ts`, **H10** (`:461-500`):
    - Retitle "upgrades in place to 'grant'" to "is superseded by a new 'grant' row".
    - Drop the comment at `:481-486`, which describes pre-S2b code.
    - Reword the message at `:495` from "upgraded in place, not duplicated" to "one active row: the elevation row is
      replaced, not duplicated".
    - The active-row-count and `'grant'` checks stay green unchanged.

**Legs.** Every leg asserts the TARGET. Record the raw red for each one.

*Fixture for E1-E8 (the TESTER names it):*

- an org with an active admin (the actor);
- a target person with a raw-inserted `manager` role;
- a third person (the seeded grantor);
- an org-scoped capability that `CAPABILITY_MATRIX.manager` does NOT grant, so `authorize` for the target depends on
  the grant row alone (e.g. `manage_fixed_assets`; the TESTER confirms the matrix cell and names the capability).

The seeded row is a raw INSERT with an explicit past `granted_at`.

| Id | Item | Case | Target (+ / ⛔) | Expected red today |
|---|---|---|---|---|
| E1 | 1 | Seed an active NULL-store `'elevation'` row, `granted_by` = third person, `granted_at` = fixed past time. The admin picker-grants it (`grantCapabilityAsActor`, no `positionGrantId`) | + exactly one active NULL-store row: `'grant'`, `granted_by` = actor, `source_ref` NULL, `granted_at` > seeded; + the seeded row is revoked, `revoke_reason` = the literal `'Replaced by a hand grant of the same capability.'`, its `granted_by`/`granted_at`/`grant_source` unchanged; + seeded `revoked_at` = new row's `granted_at` (no gap on record); + `wrote: true`, `heldEverywhere: true` | active row `granted_by` = third person; no revoked row |
| E2 | 1 | E1 with the seeded `granted_by` NULL | + as E1 | active row `granted_by` NULL |
| E3 | 1 | E1 via the org-scoped hold path (H10's fixture, `positionGrantId` given) | + as E1; + `storeName` null | as E1 |
| E4 | 1 | Seeded `grant_source` NULL (a pre-0140 row), then picker grant | + as E1 (same reason literal) | no revoked row |
| E5 | 1 | After E1: `authorize(target, cap)` BEFORE the grant and AFTER it; then an admin arrival (`assignRole` admin) runs `revokeElevationGrantsForOrg` | + authorize resolves both before and after (identical result); + after the sweep the new `'grant'` row is still active and authorize still resolves; ⛔ the sweep revokes nothing of the target's | green (guard) |
| E6 | 1 | Same-rank call over an active `'grant'` row, and over an active `'owner'` row; also a second picker grant right after E1 (a sequential double-click) | ⛔ no new row, no newly revoked row, `wrote: false`, returned id = the active row's id | green (guard) |
| E7 | 1 | Concurrent double submit: two `grantCapabilityAsActor` calls over one seeded elevation row, `Promise.allSettled` (H4's pattern, separate transactions) | + both fulfilled (no 23505); + exactly one active NULL-store row (`'grant'`); + exactly one revoked row (the seeded one); + exactly one result has `wrote: true` | 0 revoked rows (and both report `wrote: true`). If the race does not interleave, record it; E7 stands as a guard |
| E8 | 1 | Atomicity: `accessRepo.grantCapability` directly, `grantSource: 'grant'`, `grantedBy` = a random uuid (FK 23503 on the INSERT), over a seeded elevation row, in one `asOrg` tx | + the call rejects; + afterwards the seeded elevation row is still ACTIVE and unrevoked (the revoke rolled back with the failed insert) | the call resolves (today's UPDATE never touches `granted_by`) |
| R1 | 3 | 3 rows for one person with explicit `granted_at` t1<t2<t3 (distinct capabilities); `UPDATE` the t1 row (e.g. `grant_source` elevation→grant); then `grantsForPerson` | + ids in order t1, t2, t3 | t1 last (heap order after UPDATE). If the unordered read happens to return this order, record it: R1 stands as a guard and P8 is the load-bearing red |
| P8 | 2 | `foldActiveGrants` over [store-A `'grant'`, NULL-store `'grant'`, position at A], then over the same rows in reverse order | + in **both** orders the NULL-store line has `alsoVia` = [Cashier at A] and the store-A line's `alsoVia` is empty | the first order puts it on the store-A line |
| G1 | 4 | Picker grant, one store-scoped capability (`confirm_receipt`) | `ok === 'Granted: <Title>, at every store.'` | `Granted: <Title>.` |
| G2 | 4 | Picker grant, one org-scoped capability (`manage_fixed_assets`) | `ok === 'Granted: <Title>.'`; ⛔ `ok` does not contain "every store" | green (guard) |
| G3 | 4 | Picker grant, two capabilities: `confirm_receipt` then `manage_fixed_assets` | `ok === 'Granted 2 capabilities: <A>, at every store; <B>.'` | no suffix |

**Out of scope.**

- A picker grant that writes nothing (stale tab) still says "Granted: …". It could read `wrote`. Candidate follow-up.
- A double-click on the picker for a capability the person does NOT yet hold. The person-level fresh INSERT
  (`access.ts:750-761`) has no `ON CONFLICT`, so the second submit can raise a raw 23505. This predates S2c. It breaks
  T-349 invariant 3's spirit on the picker path. Candidate follow-up, and the orchestrator should log a DEF.
- Showing `granted_by` on the page.
- The revoked list renders a superseded row as "auto-elevated — clears when this org gains an active administrator ·
  Replaced by a hand grant of the same capability." The label is the existing `grantSourceLabel` and the reason
  explains it. A past-tense label is a wording follow-up, not this slice.
- A production count, or a repair, of rows already re-tagged since `fddef02`. Q2 fixes future writes only. A repair
  would be its own migration slice, and only if Ian asks for one.
- Everything S3 owns.

**Orchestrator, at commit (not the builder).**

- Add a bible §13 row recording Ian's Q2 ruling: a hand grant over an automatic grant closes the automatic row and
  inserts a new one. This supersedes row 188's closing "monotone upgrade" mechanism, and the direction is unchanged.
- Update the GLOSSARY if it describes the re-tag.
- In this task file, add Q2 and its answer to §9 and mark §8b as specced.
- ⚠️ **Flag for S3 (not an S2c path).** §3.5 says a widened row is R, an active NULL-store `'grant'` row with
  `source_ref` NULL, beside a `'position'` row that was active at R's time. It argues "since 0159 no other path
  produces one: the picker hides held capabilities". **That premise has been false since S2b item 3 (`8d14e7a`).**
  The picker no longer hides a position-held capability, so a deliberate org-wide picker grant, or an S2c supersede
  over an elevation row, produces exactly R's shape. 0166 as specced would narrow those deliberate grants to the job's
  store. The S3 lane needs a bound. For example, R must predate S2 going live: no hold since `ea0ccb4` writes a
  NULL-store row for a store-scoped capability. It also needs a ⛔ leg in `t349-s3-def456-repair-migration.test.ts`
  proving a post-S2b picker grant survives.

**Done when.**

- Every leg seen red for its stated reason (guards green), then passing.
- Typecheck and unit clean. **FULL** integration green on a lane DB. The files most at risk are
  `authorize.test.ts`, `roles.test.ts`, `t349-hold-own-right*.test.ts`, `position-defaults.test.ts` and
  `admin-users-lib.test.ts`.
- Build green with 9008 stopped.
- **Smoketest on 9008** (390px and 1280px, both themes):
  - Picker-grant a store-scoped capability. The banner reads "Granted: <Title>, at every store."
  - Picker-grant an org-scoped capability. The banner reads "Granted: <Title>." with no store phrase.
  - One covered position shows "also via …" on the org-wide line after a reload, and again after a second reload.
  - Give an elevated manager a capability by hand. The page shows one active "hand-granted" line and, in the revoked
    list, one line whose reason reads "Replaced by a hand grant of the same capability."

## 9. Open for Ian

**Q1. Re-scope the rows DEF-456 already widened?** (dev: 1 row; production: count at cutover.) Slice S3 (§3.5) revokes
each widened NULL-store hand grant and replaces it with a hand grant **at every store where the person held that
capability through a job at the moment of the click**. That can be **more than the store that was clicked**: the old
button did not record which job row it came from, so the repair cannot tell. **This removes authority at every other
store**, which someone may have used since the click. Planner proposes **yes**: your ruling says the click was meant to
stay at that store, and nobody chose the wider reach. If no, S3 is never built, and those rows stay org-wide until an
administrator revokes them by hand. S1 and S2 ship either way.

**Answer (Ian, 2026-09-27): YES — re-scope.** S3 is built as §3.5 specifies.

**Q2 (S2c). When someone hand-grants a capability a person already holds automatically, how does the record change?**
**Answer (Ian, 2026-09-28): close and replace** — the automatic row is revoked ("Replaced by a hand grant of the same
capability.") and a new hand-grant row names the clicking actor and the time. Supersedes bible §13 row 188's in-place
re-label (bible row owed — planner).

### S3 Amendment A1 — APPROVED 2026-09-28 (orchestrator, drafted by the independent Opus S2c auditor) (2026-09-28, independent Opus spec audit)

This amends §3.5, the S3 repair in migration `0166_t349_def456_repair.sql`, and leg M6. It is binding on the S3
TESTER and BUILDER. Line numbers are HEAD `586d8eb`.

**The defect in §3.5 as written.**

- §3.5 defines a widened row R: an active `'grant'` row with `store_id IS NULL` and `source_ref IS NULL`, beside a
  `'position'` row P for the same capability that was active at R's `granted_at`.
- It then justifies that definition with "since 0159 no other path produces one: the picker hides held capabilities".
  That premise is now false.
- Since S2b item 3 (`8d14e7a`), the picker hides only capabilities held org-wide. An admin can therefore deliberately
  grant org-wide a capability the person also holds through a job. That write has exactly R's shape.
- S2c's close-and-replace (§4c) also produces R's shape when a position row is active.
- **Result:** 0166 as specced would narrow deliberate org-wide grants down to the job's store.

**Is there a structural marker? No, and the reason is recorded here so it is not searched for again.**

- Before S2 (`ea0ccb4^:apps/erp/src/app/admin/users/actions.ts`), the hold button and the picker ran the same loop:
  `grantCapabilityAsActor(tx, actor, { personId, capability })`, person-level.
- `intent === 'hold_own_right'` changed only the banner (`:190-191`).
- Both paths wrote an identical row: `grant_source = 'grant'`, `store_id` NULL, `source_ref` NULL,
  `granted_by` = the actor, `granted_at` = now().
  - 0140 added `grant_source` with the value `'grant'` for both.
  - 0165 added the store-scoped `'grant'` shape, which the old path never wrote.
- The rows carry no reason, no ref and no source value that could tell the two paths apart.
- What *did* tell them apart was the page. Until S2b, the picker offered only capabilities with **no active row of
  any kind** (`ea0ccb4^:[personId]/page.tsx:64-65`, the `heldNames` set built from every active row). So before
  S2b, an active P at R's time proves R came from the hold button. After S2b it proves nothing. **The discriminator is
  therefore time, and only a date bound works.**

**The ruled definition.** It replaces §3.5's first paragraph. Its three conditions are all required:

1. **Shape.** R is an ACTIVE row with `grant_source = 'grant'`, `store_id IS NULL` and `source_ref IS NULL`.
   A `'position'` row P exists for the same `(person_id, grant_name)` with `P.granted_at < R.granted_at` and
   `(P.revoked_at IS NULL OR P.revoked_at > R.granted_at)`. This part is unchanged.
2. **Date bound, new.** `R.granted_at < '2026-09-27T10:59:23Z'`, the committer time of `ea0ccb4`
   (`2026-09-27T18:59:23+08:00`), with a strict `<`. Why this date:
   - From that commit on, the hold path writes a store-scoped row for a store-scoped capability, so no later
     NULL-store R can have come from the old button.
   - The picker change (S2b, `8d14e7a`, 22:51 +08:00) came strictly later. So no deliberate R the picker could have
     made while a job row was active falls before the bound, on any machine. The same holds for S2c's replacements,
     which come later still.
   - ⚠️ **Residual, and it errs in the safe direction.** CI deploys on push, and pushes happen at wrap-up, so
     production ran the old hold path until the S2 deploy, which may be later than the commit. A hold clicked in
     production between the commit and that deploy is *missed*: it stays org-wide, which is today's state, visible
     and revocable by hand. It is never wrongly narrowed.
   - The app is deployed but not launched: production holds essentially one person. The orchestrator runs the §3.5
     SELECT read-only on erp2 before 0166 ships. The SELECT uses the shape condition and reports two counts: rows
     matched below the bound, and rows between the bound and the S2 deploy time. If the second count is not zero,
     that is a question for Ian (below).
3. **Store-scoped capabilities only, new.** `R.grant_name IN (<the literal list of every capability with
   CAPABILITY_SCOPE = 'store' at build time>)`. The reason:
   - DEF-456 is a *store* widening. For an org-scoped capability, `authorize` applies no store filter, so a NULL-store
     row is the correct shape. §3.2 item 9 made that ruling: S2 itself writes NULL-store for an org-scoped hold.
   - Re-scoping such a row would create a shape S2 never writes, a store-carrying `'grant'` row for an org-scoped
     capability. The page would then read "hand-granted at X" for authority that is org-wide.
   - The BUILDER generates the list from `packages/auth/src/capabilities.ts`'s `CAPABILITY_SCOPE` and pastes it into
     the SQL with a header comment naming the source and the HEAD it came from. The report records the count. A
     migration is immutable, so the list is a snapshot, and later edits to `CAPABILITY_SCOPE` do not touch it.

The repair steps 1-2 of §3.5 (insert at each P store with R's `granted_by`/`granted_at`, then revoke R with the
DEF-456 reason) are **unchanged**. Delete the sentence "Since 0159 no other path produces one: the picker hides held
capabilities, and 0159 step 5 twins copy `granted_at` and are never `'grant'`." Replace it with a pointer to this
amendment. Q1's answer stands: this narrows *what* 0166 matches and does not change what it does to a match.

**M6: TESTER's ruled edit to `packages/db/tests/integration/t349-s3-def456-repair-migration.test.ts`.**

*Existing seeds (`:163-201`).* R1, R2 and the control stay as they are. They already satisfy the new bound and
capability conditions: they use `record_sale` (store-scoped) and dates in 2026-01 to 2026-04. Record in the TESTER
report that the existing seeds were checked against A1 and needed no change.

*New seeds, in `beforeAll`.* Each has a P at A active from `'2026-01-01T00:00:00Z'` and still active.

- **S1, a post-S2b picker grant.** A NULL-store `'grant'` row, `source_ref` NULL, `record_sale`,
  `granted_at = '2026-09-28T00:00:00Z'`.
- **S2, an S2c replacement.** A revoked `'elevation'` NULL-store `record_sale` row: `granted_at '2026-01-05'`,
  `revoked_at = '2026-09-28T01:00:00Z'`, reason `'Replaced by a hand grant of the same capability.'`. Plus an active
  NULL-store `'grant'` row with `granted_at = '2026-09-28T01:00:00Z'`.
- **S3, an org-scoped hold before the bound.** It needs a second `position_capability_defaults` row at A for an
  org-scoped capability (e.g. `manage_fixed_assets`; the TESTER confirms its `CAPABILITY_SCOPE` is `'org'`), and P
  for that capability. R is a NULL-store `'grant'` row with `granted_at '2026-03-10T00:00:00Z'`.
- **S4, the bound edge.** A shape-matching `record_sale` R with `granted_at = '2026-09-27T10:59:23Z'`, exactly the
  bound.

*Legs.* Each "untouched" check reads the R row back by id and also counts active `'grant'` rows at A for that person.

| Id | Case | Target | Expected red today |
|---|---|---|---|
| M6-S1 | post-S2b deliberate picker grant | ⛔ after 0166 the row is still active and unrevoked; ⛔ no `'grant'` row at A for S1's person | locating 0166 fails (as M6). Against the pre-A1 SQL it would be revoked and re-scoped |
| M6-S2 | S2c replacement | ⛔ as S1; ⛔ the revoked elevation row is unchanged | as M6-S1 |
| M6-S3 | org-scoped hold before the bound | ⛔ as S1: an org-scoped capability is never re-scoped | as M6-S1 |
| M6-S4 | R exactly at the bound | ⛔ as S1 (strict `<`) | as M6-S1 |

- Extend the pre-state block (`:213-225`) so S1-S4 are asserted active exactly as seeded.
- Update the `grantsAtA` count so it still reads 0.

⚠️ **A gap in M6 today, which the TESTER closes in the same edit.** The file's only post-repair check is "locating
0166" (`:227-229`). It never applies 0166 and never asserts the repaired state, even though the `it` title promises
it. So as soon as 0166 exists, M6 goes green without proving anything. Add a second `it` that applies 0166 to the
scratch DB and then asserts:

- R1/R2's targets as §4 M6 states them, and the control untouched;
- M6-S1 to M6-S4;
- no row at B.

This is a ruled edit: it adds proof and does not weaken anything.

**BUILDER paths (S3, unchanged):** `packages/db/migrations/0166_t349_def456_repair.sql` (new) and
`packages/db/migrations/meta/_journal.json`. Put the bound and the capability list in the migration header with
their reasons, citing this amendment.

**For Ian, only if needed.**

- If the erp2 count finds a row between the bound and the S2 deploy time, Ian decides: re-scope it by hand, or leave
  it org-wide.
- Otherwise nothing here needs Ian. The bound only ever errs toward leaving a row as it is today, and the org-scoped
  exclusion follows his §3.2 item 9 ruling.

---

✅ **S3 HOLD LIFTED by S3 Amendment A1 above.** Was: §3.5's "widened row" definition assumes the picker hides held capabilities,
which stopped being true at S2b (`8d14e7a`). As specced, 0166 would also narrow deliberate org-wide picker grants and
S2c replacements. S3 is not built until an amendment bounds the definition and a test proves a deliberate grant
survives.

### 4d. S2d: follow-ups from the executed post-commit review of `7415676` (APPROVED 2026-09-28, orchestrator — DONE 2026-09-28)
The auditor RAN invariants (a)–(e) on its own DB (`shareat_test_auditor`, restricted role) — all PASS, plus five
mutants (four killed). **Model** Sonnet, tester then builder. **Migration** none.
- **D1 (MED, tester).** The ⛔ "0 rows must NOT return early" (§4c item 1.2) is pinned by nothing: a mutant adding
  `if (revoked.length === 0) return …wrote:false` kept all 472 tests green. New leg **E9**: another connection revokes
  the elevation row (FOR UPDATE barrier) between the call's SELECT and its UPDATE → the call still inserts the hand
  grant; exactly one active row, `grant_source='grant'`, `wrote: true`. Must be red under that mutant.
- **D2 (LOW, tester).** E7 cannot tell a real interleaving from serialisation. Make it deterministic with the same
  FOR UPDATE barrier so the ON CONFLICT arm is actually reached, and assert that it was (loser returns the winner's id).
- **D3 (LOW, builder + tester red).** `admin/users/actions.ts:206` "…, at every store" overclaims: a store-scoped
  capability also needs a `person_store_scope` row at each store. Wording becomes
  `` `${capabilityTitle(c)}, at every store they work at` `` (store-scoped only; org/platform unchanged). Red **G4**.
- **D4 (LOW, builder + tester red).** `admin/users/lib.ts:234-236` second lookup accepts `'grant'` only; the old fold
  also accepted `'owner'`. Accept `'grant' | 'owner'` in the SAME-STORE lookup only — the org-wide lookup already accepts both (§4c item 2.1), unchanged (parity; `person_grants_store_shape_check`
  forbids owner+store today, so this is defensive) and say so in the JSDoc. Red **P9** (pure fold with an owner
  same-store fixture).
- **BUILDER paths:** `apps/erp/src/app/admin/users/actions.ts`, `apps/erp/src/app/admin/users/lib.ts`.
- **TESTER paths:** `packages/auth/tests/integration/t349-s2c-supersede-elevation.test.ts` (E7, E9),
  `apps/erp/tests/t349-s2c-fold-and-banner.test.ts` (G4, P9), plus the banner pins in
  `apps/erp/tests/t343-s6b-admin-users-labels.test.ts` / `t349-hold-own-right-page.test.ts` that the new wording moves.

### 4e. S2e: follow-ups from the executed review of `bad8c32` (APPROVED 2026-09-28, orchestrator — DONE 2026-09-29)
The committed CODE is correct (invariants a–e untouched, D4 clean). The gaps are test determinism and one wording.
- **E1 (HIGH, tester).** E9's "barrier" is `setTimeout(300)`: at 0 ms the SUT takes the virgin-insert branch and E9
  passes even under the F1 mutant. Replace the sleep with a real barrier: hold the row lock, start the SUT, **poll
  `pg_stat_activity` until the SUT's backend is waiting on that lock** (`wait_event_type = 'Lock'`), then revoke and
  commit. Assert the branch was reached (the revoke affected 0 rows for the SUT) — not only the outcome.
- **E2 (HIGH, tester).** E7: same sleep, and `result.id === winner.id` cannot tell the ON CONFLICT re-select from the
  same-rank no-op. Same barrier; assert something only the ON CONFLICT arm produces (e.g. the SUT's own UPDATE
  revoked 0 rows AND its INSERT returned nothing — expose via the result shape the test can see, or a DB-side fact).
  If that needs a source hook, report BLOCKED rather than adding one.
- **E3 (MED, tester).** Restore a leg with TWO concurrent real `grantCapabilityAsActor` calls on the person-level
  supersede branch: no raw 23505, exactly one revoked row, exactly one `wrote: true` (the old E7's assertions).
- **E4 (MED, builder + tester pins).** "at every store they work at" is neither necessary nor sufficient (axis 2 is a
  `person_store_scope` row — employment, manual or fan-out). Wording becomes
  `` `${capabilityTitle(c)}, at every store they have access to` `` (store-scoped only).
- **E5 (LOW, builder + pin).** `actions.ts:180` "…was already held in their own right everywhere." → for a
  store-scoped capability "…at every store they have access to."; org/platform unchanged.
- **E6 (LOW).** Stale comments: builder `actions.ts:203-208`; tester `t343-s6b-admin-users-labels.test.ts:595`,
  `t349-hold-own-right-page.test.ts:584-586` + its `it()` title.
- **BUILDER paths:** `apps/erp/src/app/admin/users/actions.ts`. **TESTER paths:**
  `packages/auth/tests/integration/t349-s2c-supersede-elevation.test.ts`, `apps/erp/tests/t349-s2c-fold-and-banner.test.ts`,
  `apps/erp/tests/t343-s6b-admin-users-labels.test.ts`, `apps/erp/tests/t349-hold-own-right-page.test.ts`.
