# T-382: a guarded POS unlink — super-admin only, with a reason, audited; imported days stay as they are

**Status:** SPEC 2026-10-08 (Opus planner). Written at HEAD `9e89a0b`, lane `lane/t382-unlink`. Not yet reviewed.
**Model:** Sonnet for each slice, tester first, then builder. Any amendment is written in plan mode (Opus).
**Migration:** **0187**, hand-authored per ADR-012 §5, gated on the FULL suite on a fresh gate DB (memory: a CHECK /
trigger migration is gated on the full suite). Prechecks go in `docs/ops/README.md` before the push.
**Ruling behind it:** Ian, Open Questions `t375-unlink-safety`, answer **a**, 2026-10-07: *"Build a guarded unlink
before Monday: super-admin only, with a reason, recorded in the audit log; days already imported from POS stay as they
are."* Lipa links Monday 12 Oct (bible row 284), so this ships with the next push.
**Parent:** `docs/tasks/375-pos-v1-day-feed.md` (R6 the lock, I10 the link row is the switch, S1 the link, S4 0185).

## Goal
- A super-admin can unlink a store from POS on `/settings/pos-link`, giving a reason, after a confirm sentence that
  says exactly what changes. The act is in the audit log.
- From that moment the store takes typed sales days again, and nothing imported from POS can be edited, re-imported
  or corrected: not by the app, not by a raw `UPDATE` under the app role.
- An admin can link it again later (same or another POS store) through the existing link form.

## Research, evaluate, propose (bible row 283)
1. **Verdict: build it, as a soft unlink on the existing row, plus one hardening of 0185.** Not a delete.
2. **The stated reason holds.** Today there is no undo for a link. The app role has no DELETE on
   `pos_v1_store_links` (0183 REVOKEs it, header lines 13-16) and the link form can only change POS id, name, channel
   and tax type. A wrong link on Monday could only be undone by Ian running SQL as `doadmin` on production.
3. **What exists.** `linkStoreToPos` (`packages/domain/src/pos/store-link.ts`) with relink-by-update; the 0185 lock
   reading the link through one function, `sales_day_store_is_linked` (0185:36-50); the audit log. v1 has no link
   concept (v1 ERP pulls POS over HTTP with no per-store switch, T-375 §"v1 as requirements"); POS, CUSTOMER and the
   Website hold nothing about it. Nothing to reuse beyond our own code.
4. **Industry pattern.** Accounting bank feeds (Xero, QuickBooks Online) treat "disconnect" as stopping the feed while
   every imported line stays as it was, and "reconnect" resumes without rewriting history. Integration links are
   deactivated with who/when/why, not deleted (slowly-changing-dimension "valid to"). From memory, not re-read today.
5. **Open source:** nothing worth adopting. This is one row's state and one SQL function; a soft-delete library would
   add a dependency for four lines.
6. **Effort against use.** Expected use: 0-2 times a year (a wrong link, or POS trouble). Production holds **0** links
   today (0183 row in `docs/ops/README.md`), **1** from Monday. Cost: one migration, three slices, about a day. What
   gets worse without it: the only undo is production SQL by hand, under time pressure, with no audit row.
7. **Scope.** In: unlink, its guard, its audit, the screen, relink after unlink, the race with an import, usage pulls on
   already-imported days. Out: see "Out of scope", each with a reason.

## Census, verified at source

### The link and the lock
- `pos_v1_store_links` (0183:25-43): one row per store (`pos_v1_store_links_store_id_unique`), POS id unique GLOBALLY
  (`pos_v1_store_links_pos_store_id_unique`, a UNIQUE constraint). Columns end at `updated_at/updated_by`.
- Grants (0183:13-16): `shareat_app` has SELECT, INSERT, **UPDATE** on links, **no DELETE**. RLS `org_column`
  (`packages/db/src/rls/registry.ts:911`). Classification `keep` (`cutover/classification.ts:1147`).
- One trigger on the table: `pos_v1_store_links_store_fixed` (0185, BEFORE UPDATE, refuses a `store_id` change). No
  DELETE trigger. **So a delete is impossible without a migration; an update is possible today.**
- 0185's `sales_day_store_is_linked(store)` is `EXISTS (... WHERE store_id = p_store_id)` (0185:49). It is the only
  place the database reads the link. Its three callers:
  - `sales_days_check_figure_lock` INSERT: linked → only a feed day under the flag; unlinked → feed day refused, typed
    allowed.
  - the same, UPDATE of a protected column: **a feed day is judged by its `source`, never by the link** (0185:102-106):
    it needs the flag AND status open/submitted. A typed day needs its store unlinked. `source` never changes.
  - `sales_day_child_row_allowed` (0185:118-139): feed day → remitted rows need flag + open/submitted; platform rows
    need open/submitted; typed day → store unlinked.
- **So after an unlink, a VERIFIED feed day stays frozen with no change to 0185** (status verified fails every feed-day
  branch, flag or not). An OPEN or SUBMITTED feed day would stay writable under the flag (the import's re-import
  path). R3 and R4 close that.

### Who reads the link (all through `packages/db/src/repo/pos-v1.ts`)
| Repo fn | Callers | After an unlink it must |
|---|---|---|
| `getLinkByStore` (`:59`) | `sales-days/import.ts:147`, `create-block.ts:180`, `pos/usage-pull.ts:184`, `sales-days/correction.ts:123`, `sales-days/verify.ts:195`, `apps/erp/src/app/sales-days/lib.ts:73` | answer "not linked" |
| `getLinkByStoreForUpdate` (`:69`) | `store-link.ts:90` (relink) | see the unlinked row (to re-use it) |
| `getLinkByPosStoreId` (`:80`) | `store-link.ts:72` ("already linked to X") | ignore unlinked rows |
| `getLinkByChannel` (`:95`) | `sales-channels/index.ts:186` (channel guard V6) | ignore unlinked rows |
| `listLinks` (`:104`) | `settings/pos-link/lib.ts:30` | return both, with the unlink fields |
No raw SQL anywhere else names the table (grep of `packages/db/src`, `packages/domain/src`, `apps/erp/src`).

### Paths an imported day can still take after an unlink
- Verify (`verify.ts`): does not read the link. Void: reads it only for a sentence (`:195`).
- Re-import (`import.ts`): refuses at `:148` (no link).
- Correction (`correction.ts:123-129`): refuses, *"{Store} isn't linked to a POS store, so its POS figures can't be
  read."* Matches the ruling (no correction after unlink).
- Recheck (`pos/v1-recheck.ts`): does NOT read the link; uses the basis feed's stored POS id (W9). It stores a feed
  and posts nothing. `recheckRecentDays` runs only after an import, which needs a link.
- Usage pull (`usage-pull.ts:182-185`): refuses on an unlinked store. **But it reads the STORED sold items (S5-lite);
  the link is never used beyond that existence check** (grep: no `link.` in the file). After an unlink, a verified
  feed day with no finalized pull would raise `posUsagePullNotRun` (`repo/findings.ts:1899-1925`) forever. R7.

### The import's race window
- `runImport` reads the link with no lock (`:147`), fetches POS holding no lock (`:166`, T-373 R2), then locks only the
  DAY (`:194-195`) and writes. It never locks the store. A link or unlink that commits during the fetch is not seen.
  - New day: 0185's INSERT branch catches an unlink (feed day on unlinked store), but with the raw constraint sentence.
  - Relink to ANOTHER POS store mid-fetch (an existing race, not new): the day is derived with the old link's channel
    and tax type and stored under the store now linked elsewhere. R5 closes both.

### Capability
- `approve_item` is the only super-admin-only row of business meaning (`CAPABILITY-MATRIX.md:109`); T-378 reused it for
  unit changes. `SUPER_ADMIN_ONLY_CAPABILITIES` is derived from the matrix and PINNED
  (`packages/auth/tests/super-admin-capability-set.test.ts`, four members). `createFirstAdmin` materialises those as
  `person_grants` rows (`grant_source 'owner'`) once, and `holdsSuperAdminAuthority` (`packages/auth/src/roles.ts:206`)
  requires ALL of them. **So a new super-admin-only capability needs a backfill in the same migration**, or every
  existing owner silently loses super-admin authority for role assignment.

### The screen
- `/settings/pos-link`: `page.tsx` `StoreCard` (`:74-167`) shows "Not linked — sales are typed" or the link, one link
  form, then tenders. `actions.ts` still uses `?error=`/`?ok=` (`back()`, `:23-25`); **T-380 S4 converts this file**
  to `redirectWithFlash` (`apps/erp/src/lib/flash.ts:208`).

## Rulings (planner)
- **R1. Soft unlink: three columns on the row, not a delete.**
  - `unlinked_at timestamptz`, `unlinked_by uuid → persons`, `unlink_reason text`, all NULL on a live link.
  - Why not delete + audit row:
    - A delete needs a new DELETE grant on a table 0183 deliberately left without one, open to any app code.
    - A delete loses the row the settings screen reads; "who unlinked, when, why" would live only in audit JSON.
    - Soft keeps every reader on one row and relink stays an update (the existing path).
  - The cost of soft: every "is it linked" read must mean "is there a LIVE row". Contained: the database has one reader
    (`sales_day_store_is_linked`) and the app has five repo functions, all in one file (census).
- **R2. "Linked" means a LIVE row everywhere.** 0187 replaces `sales_day_store_is_linked` with
  `... WHERE store_id = p_store_id AND unlinked_at IS NULL`. `getLinkByStore`, `getLinkByPosStoreId` and
  `getLinkByChannel` add `isNull(unlinkedAt)`. `getLinkByStoreForUpdate` and `listLinks` return the row either way, with
  the three new fields on `PosV1StoreLinkRow`. I10 now reads: a store's switch is its LIVE link row.
- **R3. An unlink refuses while the store has an unverified imported day** (`source = 'pos_v1_day_feed'`, status
  `open` or `submitted`). Verified and voided ones do not block. Sentence: *"{Store} has imported sales days that
  aren't verified yet ({dates}). Verify or withdraw them before unlinking it."*
  - The mirror of W6 (a link refuses while typed days are unverified). After an unlink, every imported day is either
    verified (frozen by 0185) or voided. No imported day is left half-way, needing a re-import that can no longer run.
  - It keeps the void sentence at `verify.ts:190-195` true, and the race in R5 down to one case.
  - Told, not asked: Ian's ruling says imported days stay as they are. This adds a precondition, not a change to them.
- **R4. 0187 also hardens 0185 so no imported figure can change on an unlinked store, even under the flag.**
  - In `sales_days_check_figure_lock`, the feed-day UPDATE branch refuses unless the store is linked, the flag is on and
    the status is open or submitted.
  - In `sales_day_child_row_allowed`, the feed-day REMITTED branch gets the same rule.
  - Platform rows (non-remitted, R8) are untouched. They are typed data, writable only while the day is open or
    submitted, which R3 rules out on an unlinked store.
  - Defence in depth under R3, and it closes a re-import racing an unlink in the database itself, not only in the
    domain.
- **R5. The import re-reads the link under the store lock.** After the fetch and before the day lock, `runImport`
  takes the store `FOR KEY SHARE` (`salesDaysRepo.lockStoreKeyShare`, as `assertStoreTakesTypedDays` does) and
  re-reads `getLinkByStore`. If the link is gone, or its `posStoreId` differs from the one fetched, refuse:
  *"{Store}'s POS link changed while {date} was being imported. Nothing was saved. Try again."*
  - Lock order: store, then day. That is the order `linkStoreToPos` (store `FOR UPDATE`) and the unlink use.
  - The builder greps every caller that locks a sales day and then the store, and reports none (a deadlock would show
    as 40P01).
- **R6. Who: a NEW capability `unlink_store_from_pos`, org scope, super-admin only, non-offerable to positions.**
  - Not `approve_item`: a manager refused would read *"approve a new item"*, and the grant would mean two unrelated
    things.
  - Not `manage_chart_of_accounts`: Ian said super-admin only, and admins hold it.
  - 0187 backfills the grant to every person holding all four current super-admin-only grants, the exact
    `holdsSuperAdminAuthority` set (R6a). The PIN test moves to five members in the same slice as the backfill (its own
    instruction).
  - Matrix row: `| unlink_store_from_pos | org | ✅ | ✗ | ✗ | ✗ | T-382. Ian 2026-10-07: super-admin only, with a
    reason, audited. Linking stays manage_chart_of_accounts |`, under "Sales and cash".
  - Label `unlink a store from POS`; area `sales`.
  - R6a backfill: `INSERT INTO person_grants (person_id, grant_name, granted_by, grant_source) SELECT person_id,
    'unlink_store_from_pos', NULL, 'owner' FROM person_grants WHERE revoked_at IS NULL AND store_id IS NULL AND
    grant_name IN (the four) GROUP BY person_id HAVING count(DISTINCT grant_name) = 4 AND NOT EXISTS (a live
    person-level 'unlink_store_from_pos' grant)`.
    - The builder confirms the column set against `person_grants` at HEAD (0159, 0165 added `store_id`,
      `grant_source`, `source_ref` and their CHECKs) and that `'owner'` passes `person_grants_source_check`.
    - Wrap it in `-- B0187:begin` / `-- B0187:end` markers so the test can run it.
- **R7. A usage pull on an imported day no longer needs a live link.** Delete the link read at `usage-pull.ts:182-185`
  and `SENTENCES.unlinked`. The day's `source` decides: a typed day refuses with the typed sentence, as now; a feed day
  uses its stored sold items.
  - "Days already imported stay as they are" includes their stored sold items still counting for stock.
  - Without this, an unlinked store's verified feed days raise `posUsagePullNotRun` forever.
  - The builder checks the S5-lite race guards X1-X4 do not lean on the link, and reports any test assertion this
    changes.
- **R8. Relinking is allowed, through the existing form, by an admin (`manage_chart_of_accounts`).**
  - `linkStoreToPos` finds the unlinked row with `getLinkByStoreForUpdate` and updates it: the new POS id, name,
    channel and tax type, and `unlinked_at/by/reason = NULL`. Same POS store or another one.
  - `updateLink` sets the three to NULL. Its audit `before` gains `unlinkedAt` and `unlinkReason`.
  - W6 still applies: typed days entered while unlinked must be verified first.
  - History is kept:
    - Each feed keeps the POS id it actually called (W9), and each day keeps its feed.
    - The audit log holds every link and unlink, with before and after.
    - The row holds only the current state.
  - The partial unique (R9) means the old POS store can be linked to another v2 store while this one is unlinked.
- **R9. POS id uniqueness covers live links only.** 0187 drops the constraint `pos_v1_store_links_pos_store_id_unique`
  and creates `UNIQUE INDEX pos_v1_store_links_pos_store_id_unique ON pos_v1_store_links (pos_store_id) WHERE
  unlinked_at IS NULL`.
  - Same name, so `isPosStoreIdTaken` (`store-link.ts:139-145`, reading `constraint_name`) still matches. A unique
    index violation reports the index name.
  - Still GLOBAL, not per org (the reason at 0183:38 stands). `store_id` stays fully unique: one row per store, ever.
- **R10. The shape is enforced in the database.**
  - `pos_v1_store_links_unlink_shape_check`: `(unlinked_at IS NULL) = (unlinked_by IS NULL) AND (unlinked_at IS NULL)
    = (unlink_reason IS NULL)`.
  - `pos_v1_store_links_unlink_reason_check`: `unlink_reason IS NULL OR (btrim(unlink_reason) <> '' AND
    char_length(unlink_reason) <= 500)`.
  - FK `unlinked_by → persons(id) ON DELETE restrict`.
  - No new trigger, so no trigger-registry change.
- **R11. The domain function `unlinkStoreFromPos(tx, actor, { storeId, reason })`**, in `store-link.ts`.
  - Order: `authorize(tx, actor, 'unlink_store_from_pos', {})` FIRST (I1) → trim the reason (blank → *"Say why this
    store is being unlinked."*; over 500 → *"Keep the reason under 500 characters."*) → store `FOR UPDATE`
    (`posV1Repo.lockStoreForUpdate`; missing → `gone`) → link `FOR UPDATE` (missing, or already unlinked → *"{Store}
    isn't linked to POS."*) → R3's check (new repo fn `unverifiedFeedDates(tx, orgId, storeId)`, the mirror of
    `unverifiedTypedDates`) → `posV1Repo.unlink(tx, orgId, storeId, { unlinkedBy, reason })`, which sets
    `unlinked_at = now()` → audit.
  - Returns `{ linkId, importedDays: number }` (the count of verified feed days, for the banner).
- **R12. The audit row.** `action: 'unlink_store_from_pos'`, `entity: 'pos_v1_store_links'`, `entityId: link.id`,
  `source: 'web'`.
  - `before: { storeId, posStoreId, posStoreName, salesChannelId, posTaxType }`
  - `after: { unlinkedAt, unlinkReason }`
  - No figures, no day ids: the days do not change.
- **R13. The screen.** On a LINKED store's card, below the link form, only when the viewer holds
  `unlink_store_from_pos` (one `authorize` probe in `lib.ts`, caught to a boolean; the builder reuses whatever capability-probe helper other settings loaders use): a bordered
  "Unlink from POS" section with:
  - the confirm sentence, built from live data: *"Unlinking {Store} from POS store {posStoreName}: from the next
    sales day you type in, {Store}'s sales are typed, not imported. The {n} days already imported from POS stay
    exactly as they are. They can't be edited, re-imported or corrected from POS. An admin can link the store again
    later."* When R3 would refuse, the loader shows that sentence instead, with no form.
  - a required reason textarea (`maxLength=500`);
  - a required checkbox *"I understand: {Store}'s sales will be typed from now on."*;
  - a button **"Unlink {Store}"**.
  - The action is `unlinkStoreFromPosAction`. It refuses an unticked box (*"Tick the box to confirm."*), calls the
    domain fn, and goes back with `redirectWithFlash`, so neither the reason nor the banner reaches the URL (DEF-476).
  - Success banner: *"{Store} is unlinked from POS. Its sales days are typed from now on."*
  - An UNLINKED store's card keeps *"Not linked — sales are typed"* and adds one muted line: *"Unlinked {date} by
    {name}: {reason}"*. The link form shows as for any unlinked store (relink, R8).

## Invariants
- I1. `authorize()` is the first statement of `unlinkStoreFromPos` and of the action's server work.
- I2. No sales day, tender row, channel row, feed, correction or journal entry changes in an unlink. Only the link row
  changes, and one audit row is added.
- I3. "Linked" means a LIVE row, in the database (`sales_day_store_is_linked`) and in the app (the three repo readers).
- I4. Store row first, in every path that locks it with a day or a link.
- I5. No new table, so no RLS or classification registry change. No posting, so no POSTING-PATTERNS entry.

## Parallel plan
| Slice | Files (BUILDER) | Shared state | Order |
|---|---|---|---|
| S1 | `packages/db/migrations/0187_t382_pos_store_unlink.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/schema/pos-v1.ts`, `packages/db/src/repo/pos-v1.ts` (R2 filters, `unlink`, `unverifiedFeedDates`, `updateLink` clears), `packages/auth/src/capabilities.ts` (R6), `packages/auth/tests/super-admin-capability-set.test.ts` (PIN → five), `docs/decisions/CAPABILITY-MATRIX.md`, `docs/ops/README.md` (0187 precheck row), `apps/erp/src/lib/constraint-messages.ts` (the two CHECK names) | lane DB; migration number 0187 | first |
| S2 | `packages/domain/src/pos/store-link.ts` (`unlinkStoreFromPos`, relink audit `before`), `packages/domain/src/index.ts` (export), `packages/domain/src/sales-days/import.ts` (R5 only), `packages/domain/src/pos/usage-pull.ts` (R7 only) | lane DB | after S1 |
| S3 | `apps/erp/src/app/settings/pos-link/actions.ts` (new action only), `apps/erp/src/app/settings/pos-link/page.tsx` (`StoreCard`), `apps/erp/src/app/settings/pos-link/lib.ts` (`canUnlink`, unlink fields, imported-day count, R3 preview) | lane DB | after S2; **not at the same time as T-380 S4** (both edit `settings/pos-link/*`) |

Docs (S1 builder): bible §13 row (the rulings R1, R3, R6, R7, R8 in one line each), `docs/tasks/375-pos-v1-day-feed.md`
I10 note (*"✎T-382: the LIVE link row"*), `docs/GLOSSARY.md` entry "unlinked store", and the schema comment at
`packages/db/schema/pos-v1.ts:7` and the 0185 header's meaning are restated in 0187's header (0185 is applied, never
edited).

## S1: 0187, the schema, the repo, the capability
**0187 contents, in order:**
1. `ALTER TABLE` add the three columns.
2. FK on `unlinked_by`.
3. R10 CHECKs.
4. R9 drop the constraint, create the partial unique index.
5. `CREATE OR REPLACE FUNCTION sales_day_store_is_linked` (R2).
6. `CREATE OR REPLACE` `sales_days_check_figure_lock` and `sales_day_child_row_allowed` (R4). Copy 0185's bodies
   verbatim and change only the feed-day branches.
7. The R6a backfill between markers.

Header: purpose, the meaning change of "linked", grants unchanged (UPDATE suffices; no DELETE), no new table or
trigger, and the PRECHECKS block.

**Prechecks (read-only, `BEGIN READ ONLY; … ROLLBACK;`, with Ian, before the push):**
- P0187a `SELECT count(*) FROM pos_v1_store_links;`. Expected 0 before Monday, 1 after. Any count is fine; it tells
  Ian whether the R9 index swap touches a live row.
- P0187b `SELECT person_id, count(DISTINCT grant_name) FROM person_grants WHERE revoked_at IS NULL AND store_id IS
  NULL AND grant_name IN ('approve_item','post_journal_entry','cross_org_access','view_franchise_sales') GROUP BY 1;`.
  The rows with 4 are who the backfill grants. Ian confirms that is him (and only who he expects).
- P0187c `SELECT count(*) FROM person_roles WHERE role = 'super_admin' AND revoked_at IS NULL;`. Informational: role
  holders get the capability from the matrix and need no grant.

**TESTER** (`packages/db/tests/integration/t382-s1-unlink-lock.test.ts`,
`packages/db/tests/integration/t382-s1-backfill.test.ts`, `packages/auth/tests/...` existing matrix tests):
- D1. Link a store, then set the three unlink columns as the owner role. A raw typed `sales_days` INSERT under the app
  role succeeds. Mutant: the function without `AND unlinked_at IS NULL` → red.
- D2. A VERIFIED feed day on that unlinked store: a figure UPDATE with the flag on → 23514
  `sales_days_figures_locked`; `source` → `legacy_typed` → refused; a tender UPDATE/DELETE → `sales_day_tenders_locked`.
  Regression proof that no imported figure becomes editable. Mutant: the feed-day branch falls through to the typed
  branch when the store is unlinked → red.
- D3. An OPEN feed day (made while linked, then the row unlinked as owner): a figure UPDATE with the flag on → refused;
  a REMITTED channel row insert with the flag on → `sales_day_channels_locked`. Mutants: R4 dropped from
  `sales_days_check_figure_lock` → first red; dropped from `sales_day_child_row_allowed` → second red.
- D4. Same open feed day: a PLATFORM (non-remitted) channel row is still writable (R8 unchanged). Mutant: R4 applied
  to platform rows too → red.
- D5. R9: store A unlinked from POS id `P1`; store B links `P1` → succeeds. Then a second LIVE link of `P1` → 23505
  with `constraint_name = 'pos_v1_store_links_pos_store_id_unique'`. Mutants: the full unique kept → first red; the
  index under another name → second red.
- D6. R10: `unlinked_at` set without `unlinked_by` → 23514 `pos_v1_store_links_unlink_shape_check`; a reason of
  `'   '` → `pos_v1_store_links_unlink_reason_check`; 501 chars → the same. Mutant: either CHECK dropped → red.
- D7. Repo: `getLinkByStore`, `getLinkByPosStoreId`, `getLinkByChannel` return undefined for an unlinked row;
  `getLinkByStoreForUpdate` and `listLinks` return it with `unlinkedAt` set. Mutant: any one filter dropped → red.
- B1. Backfill: seed person X with the four grants, Y with `approve_item` only, Z with the four but one revoked, W
  with the four plus an existing live `unlink_store_from_pos`. Run the `B0187` block, read from the migration file.
  Then: X has exactly one live grant; Y, Z none; W still exactly one; a second run inserts 0. Mutants:
  `HAVING … = 4` dropped → Y red; the `revoked_at IS NULL` filter dropped → Z red; `NOT EXISTS` dropped → W/23505
  red.
- A1. `unlink_store_from_pos`: super_admin ✅, admin ✗, manager ✗, staff ✗ (the matrix parser test reads the new row).
  An admin `authorize` → `AuthorizationError`; admin + the five owner grants → allowed. Mutant: `admin: true` → red.
- A2. The PIN lists five; the derivation test still passes.

**Gates:** typecheck, lint, the FULL integration suite on a fresh gate DB (0187 replaces 0185's functions).

## S2: the domain
**TESTER** (`packages/domain/tests/integration/t382-s2-unlink.test.ts`; fixtures from `_fixtures/pos-day.ts`):
- U1. A super-admin unlinks a linked store with three verified imported days. Then:
  - the row has `unlinked_at`, `unlinked_by = actor`, the trimmed reason;
  - one audit row `unlink_store_from_pos` whose `before.posStoreId` and `after.unlinkReason` match;
  - the result is `{ importedDays: 3 }`;
  - `createSalesDay` on a new date succeeds;
  - `importSalesDay` refuses with the unlinked sentence.
  Mutants: audit append skipped → red; `unlinked_at` not set → red.
- U2. I2: a snapshot of the store's `sales_days` (all columns), `sales_day_tenders`, `sales_day_channels`,
  `pos_v1_day_feeds`, `sales_day_pos_corrections` and `journal_entries` for those days is identical before and after.
  Then:
  - `editSalesDay` on a verified feed day refuses;
  - `reimportSalesDay` refuses;
  - `postPosCorrection` refuses with *"…isn't linked to a POS store…"*.
  Mutant: the unlink touching any day row → red.
- U3. An admin holding `manage_chart_of_accounts` is refused: no row change, no audit row. Mutant: authorize under
  `manage_chart_of_accounts` → red.
- U4. I1: an admin naming a store that does not exist gets the authorization refusal, not "gone". Mutant: lock before
  authorize → red.
- U5. Reason `'   '` → the blank sentence; 501 chars → the length sentence; `'  wrong POS store  '` is stored trimmed.
  Mutant: no trim → red.
- U6. A store never linked, and a store already unlinked → *"{Store} isn't linked to POS."*; the second unlink leaves
  the first reason and time. Mutant: the check removed → red.
- U7. R3:
  - an OPEN feed day → refuse naming its date;
  - a SUBMITTED one → the same;
  - a store whose only feed days are verified or voided → unlinks.
  Mutants: `submitted` left out of the filter → red; `verified` included → red.
- U8. R8 relink: after U1, an admin links the same store to POS id `P2`. Then:
  - the row is live, the three unlink fields are NULL;
  - the `link_store_to_pos` audit `before.unlinkReason` is the old reason;
  - the old feeds still carry `P1`;
  - `P1` can now be linked by another store.
  - With an unverified typed day entered while unlinked, the relink refuses with the W6 sentence.
  Mutant: `updateLink` not clearing `unlinked_at` → the store still takes typed days → red.
- U9. The channel guard: after an unlink, the old link's channel can be retired (`refuseIfLinkedToPos` no longer
  fires). Mutant: `getLinkByChannel` unfiltered → red.
- U10. R5, two connections:
  - (a) Tx A unlinks and holds (not committed). Tx B imports a NEW date with the fake POS and blocks on the store lock.
    Commit A. B refuses with R5's sentence; zero feed rows and zero days for the date.
  - (b) Tx A relinks to `P2` and holds. B, fetched from `P1`, blocks. Commit A. B refuses with the same sentence.
  - (c) B imports first and commits an open day. A's unlink then refuses (R3).
  Mutants: no re-read under the lock → (a) gets the raw constraint sentence, red; (b) imports, red. No store lock →
  (b) red.
- U11. R7: after an unlink, a usage pull on a verified feed day with stored sold items builds its plan. On a typed day
  of the same store it refuses with the typed sentence. Mutant: the link read kept → red.

**Gates:** typecheck, lint, the domain integration suite on the lane DB, then `t375-*` and `t316-*` in full (they share
the link and fixtures).

## S3: the screen
**TESTER** (`apps/erp/tests/integration/t382-s3-unlink-web.test.ts`; banners read through `outcomeOf`, T-380 S1b):
- W1. A super-admin viewing a linked store sees the Unlink section with the confirm sentence (store name, POS store
  name, the imported-day count). An admin sees no Unlink section. Mutant: the section ungated → red.
- W2. The action, unticked box → *"Tick the box to confirm."*, row unchanged. Mutant: the check removed → red.
- W3. The action, ticked, reason `"wrong store 123"` → the success banner. `outcomeOf` reads it from the flash and the
  redirect URL contains neither the reason nor the banner. Mutant: `back({ ok })` with the URL → red.
- W4. A store with an open imported day: the loader shows R3's sentence and no form. The action posted anyway refuses
  with the same sentence. Mutant: the loader ignores R3 → red.
- W5. An unlinked store's card shows *"Not linked — sales are typed"* and *"Unlinked {date} by {name}: {reason}"*, and
  the link form. Mutant: `listLinks` treated as live → the card shows "linked" → red.

**Smoke (9008, the dev fake POS), after merge:**
1. As super-admin: link a demo store, import two days, verify them. Unlink with a reason. Check the banner, that the
   address bar holds no reason, the audit row, and that the sales-days page shows the typed form for the next date.
2. Open a verified imported day: no edit, no re-import; "Post correction" refuses with the unlinked sentence.
3. Import a third day without verifying it, on another linked store. The Unlink section shows R3's sentence instead.
4. As admin: no Unlink section anywhere. Relink the first store to another POS store; it imports again.

## Out of scope
- **N1. Hiding Re-check / Post-correction on an unlinked store's imported day.** The server refuses with a clear
  sentence, and T-380 S4 owns `sales-days/[id]/page.tsx` now. File it if the smoke finds it confusing.
- **N2. A drift finding raised by a manual recheck after an unlink stays open until a relink.** Recheck is evidence
  only (W9). Correcting a day after an unlink is what the ruling forbids.
- **N3. Unlinking on behalf of another org.** `cross_org_access` break-glass is not wired to settings; a super-admin
  acts inside the org.
- **N4. A link history table.** The audit log already holds every link and unlink with before/after; use is 0-2 a
  year.
- **N5. Bulk unlink.** One store at a time is the business act.

## Done when
- S1-S3 committed, each with the tester's mutants killed. The FULL integration suite is green on a fresh gate DB with
  0187.
- `docs/ops/README.md` carries the 0187 precheck row, and Ian has run P0187a-c READ ONLY before the push.
- Smoke steps 1-4 pass on 9008.
- The bible row, the matrix row, the 375 I10 note and the GLOSSARY entry are committed.

## Questions only Ian can answer
- None blocking. Told, not asked: R3 (an unlink waits until every imported day is verified or withdrawn) and R6 (a new
  super-admin-only capability, granted by 0187 to whoever holds the other four; P0187b shows who).

## Ruling log
| Date | Who | Ruling |
|---|---|---|
| 2026-10-07 | Ian | `t375-unlink-safety` **a**: guarded unlink, super-admin, reason, audit; imported days stay as they are |
| 2026-10-08 | Opus planner | R1-R13 above |
