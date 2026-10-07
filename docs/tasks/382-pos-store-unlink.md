# T-382: a guarded POS unlink — super-admin only, with a reason, audited; imported days stay as they are

**Status:** SPEC 2026-10-08 (Opus planner). Written at HEAD `9e89a0b`, lane `lane/t382-unlink`. ✎REV 2026-10-08: independently reviewed, APPROVE WITH CHANGES (see "Independent review"
below; REV-1 to REV-7 bind the builder). ✎AMEND 2026-10-08: orchestrator rulings on REV-1..10 applied inline (marked ✎AMEND).
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
- An admin can link it again later through the existing link form: to the same POS store, or to a POS store no other
  store holds (✎AMEND REV-1).

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

## Independent review, 2026-10-08 (✎REV). Verdict: APPROVE WITH CHANGES; the builder applies REV-1 to REV-7 first
Ranked. Every file:line was re-read at `0ab632c`.
- **✎REV-1 (HIGH, money). R9 reopens the double import that 0183:38 exists to stop.** Store A imports and verifies
  days from `P1`, then is unlinked. Store B links `P1` (R9 allows it), then imports a date A already holds. Nothing in
  `runImport` (`import.ts:162-198`) looks at another store's days, so the same POS sales are booked twice. The same
  happens when A relinks to a `P2` that B used before. **Cut for Monday: drop R9.** Keep the full UNIQUE, and keep
  `getLinkByPosStoreId` UNFILTERED so the refusal names the unlinked store (*"That POS store is still held by {store},
  which was unlinked. Link {store} to its own POS store first."*). Relinking the same store is an UPDATE, so it is
  unaffected. D5 then tests that the full UNIQUE holds against an unlinked row. A later R9 needs an import guard:
  refuse a date when a non-voided feed day of another store came from the same `pos_store_id`.
- **✎REV-2 (HIGH, money). After a relink, S6 corrections reopen on days imported before the unlink, derived with the
  NEW link.** `correction.ts:123-135` reads the current link and derives with `taxType: link.posTaxType` and the
  current tenders. After a relink, the next import runs `recheckRecentDays` (`v1-recheck.ts:142`, every verified
  feed day, whatever link it came under). If POS changed one of those days, that raises drift, and a manager can
  correct an imported day under a tax type it was never sold under. That breaks Goal line 15 ("can't be corrected").
  Fix (S2, `correction.ts` added to S2's files): refuse when the basis feed's `posStoreId` differs from the link's,
  or when the basis was fetched before the link's last relink (`link.updatedAt`). Use the unlinked sentence. Test
  U12: unlink, relink to `P2`, then correct an old `P1` day: refused, no entry. Mutant: the guard dropped → red.
- **✎REV-3 (HIGH, lockout). The R6a backfill runs on a FORCE RLS table.** `person_grants` is FORCE ROW LEVEL
  SECURITY (0014:84; 0166:55-69 explains). Under any role that does not bypass RLS, the SELECT sees zero rows and
  grants nobody, with no error. Then every owner fails `holdsSuperAdminAuthority` once the PIN moves to five. Copy
  0166: put `SET LOCAL row_security = off;` before the block and `SET LOCAL row_security = on;` after it, inside the
  B0187 markers. B1 also runs the block once as a role RLS filters and expects Postgres's loud RLS error. Mutant: the
  SET removed → red. **"The exact holdsSuperAdminAuthority set" is not accurate.** `roles.ts:211-218` also requires
  the ACTIVE ROLE to be `admin`, and `personHasActiveGrant` (`repo/access.ts:889-905`) counts store-scoped rows too.
  Add `AND EXISTS (an active person_roles row with role = 'admin')`, so a demoted person who still holds stray grants
  gains nothing. P0187b must run as `doadmin`, join `persons` and `person_roles` (name, role), and drop the
  `store_id IS NULL` filter so Ian sees every holder.
- **✎REV-4 (MEDIUM). R5 compares only `posStoreId`.** A relink to the SAME POS id with a new tax type or channel,
  committed during the fetch, is still derived with the old link (`import.ts:171-173`). Compare `id` and `updatedAt`
  (`updateLink` sets it) as well as `posStoreId`, and refuse on any difference. U10(d): relink `P1` from
  `vat_inclusive` to `non_vat` mid-fetch → refused. Mutant: compare only `posStoreId` → red.
- **✎REV-5 (MEDIUM). R2 does not pin the function's shape, and no test anywhere does.** A grep of every `tests/`
  finds nothing on `prosecdef` or the no-org refusal. 0187 must keep the TWO-argument signature `(p_store_id uuid,
  p_constraint text)`. A one-argument version creates an overload, which the three callers ignore. It also keeps
  LANGUAGE plpgsql, has NO SECURITY DEFINER, and copies the `app_current_org()` fail-closed block verbatim (0185:40-46).
  D0: `prosecdef = false` for all three functions, and a non-bypass session with no org gets 23514 on a typed insert.
  Mutants: SECURITY DEFINER → red; the org block dropped → red.
- **✎REV-6 (MEDIUM, test hole). R4 also covers TENDER rows.** In 0185:129-133 a tender (`p_remitted` NULL) reaches
  the same `RETURN flag_on AND …` line as a remitted channel row. D3 checks only the channel row, so the mutant "R4
  only when `p_remitted` IS TRUE" survives. Add to D3: a tender INSERT and UPDATE on the open feed day of the
  unlinked store, flag on, refused `sales_day_tenders_locked`.
- **✎REV-7 (LOW, copy regression). R7 makes never-linked stores see the wrong sentence.** That is every store in
  production today. After R7, the typed day of a store that was never linked gets *"typed in before it was linked to
  POS"* (`usage-pull.ts:102-103`). Keep the old `unlinked` sentence for a typed day on a store with no LIVE link, and
  use `typed` only while the store is linked. U11 asserts both.
- **✎REV-8 (LOW). The lock-order claim in R5 and I4 does not match the code today.** `editSalesDay` takes the DAY
  `FOR UPDATE` and then the store `FOR KEY SHARE` (`edit.ts:37,45`). It cannot deadlock: KEY SHARE does not conflict
  with KEY SHARE, and nothing that takes the store `FOR UPDATE` (link, unlink) locks a day. The builder records
  this and does not "fix" it. The unlink locks no day. Its R3 read is safe because the import keeps the store
  `FOR KEY SHARE` until it commits.
- **✎REV-9 (LOW, tell Ian). Void stays open after an unlink.** A manager can void a VERIFIED imported day: the
  reversal is in `verify.ts` `runVoid`, and status is not locked by 0185. That frees the date, so a typed day can then
  be entered there (`create-block.ts:101-117`). The imported row itself does not change; this is how a typed store
  normally works. Say so in the confirm sentence's sense and in U2 (void is allowed, and its figures stay).
- **✎REV-10 (LOW). Files missing from S1.** `tests/unit/capability-matrix.test.ts:199` (it counts the capability
  rows) and `tests/unit/t337-capability-areas.test.ts` (area lists) both change when a capability is added.
- **✎REV-11 (nit). Line numbers have drifted.** In 0185: `:36-50` is 35-49, `:49` is 47, `:102-106` is 98-107,
  `:118-139` is 117-137. In `import.ts`: `:166` is 167. Every other cited line checks out.
- **Prechecks:** P0187a-c are read-only and belong in the deploy-gate table of `docs/ops/README.md`, as written (S1).
  Run them as `doadmin` (REV-3).
- **Monday fit:** the scope fits about one day with REV-1's cut, which removes the index swap and its double-import
  risk. S3 must be sequenced after T-380 S4. Smallest safe cut: S1 without R9 + S2 (with REV-2 and REV-4) + S3.

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
  `... WHERE store_id = p_store_id AND unlinked_at IS NULL`. `getLinkByStore` and `getLinkByChannel` add
  `isNull(unlinkedAt)`. ✎AMEND (REV-1): `getLinkByPosStoreId` stays UNFILTERED, so a POS id held by an unlinked store
  is still refused. `getLinkByStoreForUpdate`, `getLinkByPosStoreId` and `listLinks` return the row either way, with
  the three new fields on `PosV1StoreLinkRow`. I10 now reads: a store's switch is its LIVE link row.
  - ✎AMEND (REV-5): 0187 keeps the function's shape exactly:
    - the TWO-argument signature `(p_store_id uuid, p_constraint text)`, replaced with `CREATE OR REPLACE`, so no
      overload is created;
    - `LANGUAGE plpgsql`, SECURITY INVOKER, and no `SECURITY DEFINER` on any of the three functions;
    - 0185's `app_current_org()` fail-closed block (0185:35-49), copied verbatim.
    - Only the `EXISTS` line changes.
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
  - In `sales_day_child_row_allowed`, the feed-day REMITTED branch gets the same rule. ✎AMEND (REV-6): that branch is
    also the TENDER branch (`p_remitted` NULL reaches the same `RETURN flag_on AND …`), so tender rows are covered and
    tested (D3).
  - Platform rows (non-remitted, R8) are untouched. They are typed data, writable only while the day is open or
    submitted, which R3 rules out on an unlinked store.
  - Defence in depth under R3, and it closes a re-import racing an unlink in the database itself, not only in the
    domain.
- **R5. The import re-reads the link under the store lock.** After the fetch and before the day lock, `runImport`
  takes the store `FOR KEY SHARE` (`salesDaysRepo.lockStoreKeyShare`, as `assertStoreTakesTypedDays` does) and
  re-reads `getLinkByStore`. ✎AMEND (REV-4): if the link is gone, or its `id`, `updatedAt` or `posStoreId` differs
  from the link read before the fetch, refuse. A relink to the SAME POS id with a new tax type or channel is caught too:
  *"{Store}'s POS link changed while {date} was being imported. Nothing was saved. Try again."*
  - Lock order in the import: store, then day. `linkStoreToPos` and the unlink take the store `FOR UPDATE` and lock no
    day.
  - ✎AMEND (REV-8): `editSalesDay` takes the day and then the store `FOR KEY SHARE` (`edit.ts:37,45`). It cannot
    deadlock: KEY SHARE does not conflict with KEY SHARE, and nothing that takes the store `FOR UPDATE` locks a day.
    The builder records this and does not change it.
- **R6. Who: a NEW capability `unlink_store_from_pos`, org scope, super-admin only, non-offerable to positions.**
  - Not `approve_item`: a manager refused would read *"approve a new item"*, and the grant would mean two unrelated
    things.
  - Not `manage_chart_of_accounts`: Ian said super-admin only, and admins hold it.
  - 0187 backfills the grant to every person who passes `holdsSuperAdminAuthority`'s second branch
    (`roles.ts:211-218`): an ACTIVE `admin` role and live grants of all four current super-admin-only capabilities
    (R6a). Holders of the `super_admin` role get it from the matrix and need no grant. The PIN test moves to five
    members in the same slice as the backfill (its own instruction).
  - Matrix row: `| unlink_store_from_pos | org | ✅ | ✗ | ✗ | ✗ | T-382. Ian 2026-10-07: super-admin only, with a
    reason, audited. Linking stays manage_chart_of_accounts |`, under "Sales and cash".
  - Label `unlink a store from POS`; area `sales`.
  - ✎AMEND (REV-3) R6a backfill, between `-- B0187:begin` / `-- B0187:end` markers so the test can run it:
    ```sql
    SET LOCAL row_security = off;
    INSERT INTO person_grants (person_id, grant_name, granted_by, grant_source)
    SELECT g.person_id, 'unlink_store_from_pos', NULL, 'owner'
      FROM person_grants g
     WHERE g.revoked_at IS NULL
       AND g.grant_name IN ('approve_item','post_journal_entry','cross_org_access','view_franchise_sales')
       AND EXISTS (SELECT 1 FROM person_roles r
                    WHERE r.person_id = g.person_id AND r.role = 'admin' AND r.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM person_grants u
                        WHERE u.person_id = g.person_id AND u.grant_name = 'unlink_store_from_pos'
                          AND u.revoked_at IS NULL AND u.store_id IS NULL)
     GROUP BY g.person_id
    HAVING count(DISTINCT g.grant_name) = 4;
    SET LOCAL row_security = on;
    ```
    - `person_grants` is FORCE ROW LEVEL SECURITY (0014:84). Without `row_security = off`, an RLS-filtered role sees
      zero rows and grants nobody, with no error. With it, such a role fails loudly. The 0166 pattern (0166:55-69).
    - No `store_id IS NULL` filter on the four: `personHasActiveGrant` (`repo/access.ts:889-905`) counts
      store-scoped rows too, so this matches what the check actually does.
    - The builder confirms the column set against `person_grants` at HEAD (0159, 0165) and that `'owner'` passes
      `person_grants_source_check`.
- **R7. A usage pull on an imported day no longer needs a live link.** Delete the link read at `usage-pull.ts:182-185`
  ✎AMEND (REV-7): `SENTENCES.unlinked` is KEPT. The day's `source` and the live link decide:
  - a feed day uses its stored sold items, linked or not;
  - a typed day on a store with a LIVE link gets the `typed` sentence;
  - a typed day on a store with no live link (never linked, every store in production today, or unlinked) gets the
    `unlinked` sentence, as now.
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
  - ✎AMEND (REV-1): the full UNIQUE on `pos_store_id` stays. An unlinked store keeps its POS id, so another store cannot
    link that POS store. Relinking the SAME store (same or a free POS id) is an UPDATE of its own row and stays allowed.
    The refusal for another store names the holder: *"That POS store is still held by {store}, which was unlinked.
    Link {store} to its own POS store first."* (`getLinkByPosStoreId` is unfiltered; the live wording stays for a
    live holder.)
- **R9. ✎AMEND (REV-1): DROPPED.** Uniqueness of POS ids for live links only would let store B import dates store A
  already booked from the same POS store, so the same sales would be booked twice. No partial index; 0183's full
  UNIQUE stands. A later version needs an import guard first: refuse a date when a non-voided feed day of another
  store came from the same `pos_store_id`.
- **R9a. ✎AMEND (REV-2): a correction on an old imported day refuses after a relink.** `postPosCorrection`
  (`correction.ts:123-135`) and `recheckPosDay` (`pos/v1-recheck.ts`) refuse, with the unlinked sentence, when:
  - the store has no live link; or
  - the basis feed's `posStoreId` differs from the live link's; or
  - the basis feed was fetched before the link's `updatedAt` (the last relink).
  Otherwise a day imported under the old link would be re-derived with the new tax type and tenders. `recheckRecentDays`
  skips such days (they are not rechecked, and no failure is logged).
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
    exactly as they are. They can't be edited, re-imported or corrected from POS. A manager can still withdraw an
    imported day and type it again. An admin can link the store again later."* (✎AMEND REV-9) When R3 would refuse, the loader shows that sentence instead, with no form.
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
- I3. "Linked" means a LIVE row, in the database (`sales_day_store_is_linked`) and in `getLinkByStore` and
  `getLinkByChannel`. ✎AMEND (REV-1): a POS id stays held by its store whether the link is live or unlinked.
- I4. The import takes the store before the day. Link and unlink take the store `FOR UPDATE` and lock no day (REV-8).
- I5. No new table, so no RLS or classification registry change. No posting, so no POSTING-PATTERNS entry.
- I6. ✎AMEND (REV-2): no imported day is ever re-derived under a link other than the one it was imported under.

## Parallel plan (✎AMEND)
| Slice | Files (BUILDER) | Shared state | Order |
|---|---|---|---|
| S1 | `packages/db/migrations/0187_t382_pos_store_unlink.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/schema/pos-v1.ts`, `packages/db/src/repo/pos-v1.ts` (R2 filters on `getLinkByStore` and `getLinkByChannel` only, `unlink`, `unverifiedFeedDates`, `updateLink` clears), `packages/auth/src/capabilities.ts` (R6), `packages/auth/tests/super-admin-capability-set.test.ts` (PIN → five), `tests/unit/capability-matrix.test.ts` (row count, REV-10), `tests/unit/t337-capability-areas.test.ts` (area lists, REV-10), `docs/decisions/CAPABILITY-MATRIX.md`, `docs/ops/README.md` (0187 precheck row), `apps/erp/src/lib/constraint-messages.ts` (the two CHECK names) | lane DB; migration number 0187 | first |
| S2 | `packages/domain/src/pos/store-link.ts` (`unlinkStoreFromPos`, relink audit `before`, the "still held by {store}, which was unlinked" sentence), `packages/domain/src/index.ts` (export), `packages/domain/src/sales-days/import.ts` (R5 only), `packages/domain/src/pos/usage-pull.ts` (R7 only), `packages/domain/src/sales-days/correction.ts` (R9a only), `packages/domain/src/pos/v1-recheck.ts` (R9a only) | lane DB | after S1 |
| S3 | `apps/erp/src/app/settings/pos-link/actions.ts` (new action only), `apps/erp/src/app/settings/pos-link/page.tsx` (`StoreCard`), `apps/erp/src/app/settings/pos-link/lib.ts` (`canUnlink`, unlink fields, imported-day count, R3 preview) | lane DB | after S2. T-380 S4 has carved `settings/pos-link/*` out, so this task owns those files |

Docs (S1 builder):
- a bible §13 row: R1, R3, R6, R7, R8, R9a and the R9 drop, one line each;
- a note on `docs/tasks/375-pos-v1-day-feed.md` I10: *"✎T-382: the LIVE link row"*;
- a `docs/GLOSSARY.md` entry, "unlinked store";
- 0187's header restates the schema comment at `packages/db/schema/pos-v1.ts:7` and the meaning in 0185's header.
  0185 is applied and is never edited.

## S1: 0187, the schema, the repo, the capability
**0187 contents, in order:**
1. `ALTER TABLE` add the three columns.
2. FK on `unlinked_by`.
3. R10 CHECKs.
4. ✎AMEND (REV-1): no index change. 0183's full UNIQUE on `pos_store_id` stays.
5. `CREATE OR REPLACE FUNCTION sales_day_store_is_linked(p_store_id uuid, p_constraint text)`, under R2's REV-5
   shape rules.
6. `CREATE OR REPLACE` `sales_days_check_figure_lock` and `sales_day_child_row_allowed` (R4). Copy 0185's bodies
   verbatim and change only the feed-day branches. Neither is SECURITY DEFINER.
7. The R6a backfill between its markers, with `row_security` off and back on.

Header:
- purpose;
- the meaning change of "linked";
- grants unchanged (UPDATE is enough, no DELETE);
- no new table, trigger or index;
- the RLS note for the backfill (0166 pattern: applies only as a role RLS cannot filter, `doadmin` on production);
- the PRECHECKS block.

**Prechecks (✎AMEND REV-3: run as `doadmin`, read-only, `BEGIN READ ONLY; … ROLLBACK;`, with Ian, before the push):**
- P0187a `SELECT count(*) FROM pos_v1_store_links;`. Expected 0 before Monday, 1 after. Informational.
- P0187b lists everyone who holds any of the four grants, with name and role, so Ian sees each holder:
  ```sql
  SELECT p.display_name, r.role, count(DISTINCT g.grant_name) AS grants
    FROM person_grants g
    JOIN persons p ON p.id = g.person_id
    LEFT JOIN person_roles r ON r.person_id = g.person_id AND r.revoked_at IS NULL
   WHERE g.revoked_at IS NULL
     AND g.grant_name IN ('approve_item','post_journal_entry','cross_org_access','view_franchise_sales')
   GROUP BY 1, 2
   ORDER BY 1;
  ```
  The backfill grants exactly the rows with `role = 'admin'` and `grants = 4`. Ian confirms that is only him.
- P0187c `SELECT count(*) FROM person_roles WHERE role = 'super_admin' AND revoked_at IS NULL;`. Informational: role
  holders get the capability from the matrix and need no grant.

**TESTER** (`packages/db/tests/integration/t382-s1-unlink-lock.test.ts`,
`packages/db/tests/integration/t382-s1-backfill.test.ts`, `packages/auth/tests/` matrix tests):
- **D0 (✎AMEND REV-5).**
  - `pg_proc.prosecdef = false` for `sales_day_store_is_linked`, `sales_days_check_figure_lock` and
    `sales_day_child_row_allowed`.
  - Exactly one `pg_proc` row named `sales_day_store_is_linked`, with two arguments (no overload).
  - A non-bypass session with no org context gets 23514 `sales_days_figures_locked` on a typed insert.
  - Mutants: SECURITY DEFINER → red; the `app_current_org()` block dropped → red; a one-argument version → red.
- **D1.** Link a store, then set the three unlink columns as the owner role. A raw typed `sales_days` INSERT under the
  app role succeeds. Mutant: the function without `AND unlinked_at IS NULL` → red.
- **D2.** A VERIFIED feed day on that unlinked store:
  - a figure UPDATE with the flag on → 23514 `sales_days_figures_locked`;
  - `source` → `legacy_typed` → refused;
  - a tender UPDATE/DELETE → `sales_day_tenders_locked`.
  Regression proof that no imported figure becomes editable. Mutant: the feed-day branch falls through to the typed
  branch when the store is unlinked → red.
- **D3.** An OPEN feed day, made while linked, then the row unlinked as owner. With the flag on:
  - a figure UPDATE → refused;
  - a REMITTED channel row insert → `sales_day_channels_locked`;
  - ✎AMEND (REV-6): a TENDER INSERT and a tender UPDATE → `sales_day_tenders_locked`.
  Mutants: R4 dropped from `sales_days_check_figure_lock` → red; dropped from `sales_day_child_row_allowed` → red;
  R4 applied only when `p_remitted IS TRUE` → the tender legs red.
- **D4.** Same open feed day: a PLATFORM (non-remitted) channel row is still writable. Mutant: R4 applied to platform
  rows too → red.
- **D5 (✎AMEND REV-1).** Store A linked to `P1`, then unlinked as owner. Store B inserting a link to `P1` → 23505
  `pos_v1_store_links_pos_store_id_unique`. A's own row updated to a live link of `P1` succeeds. Mutant: the UNIQUE
  made partial on `unlinked_at IS NULL` → red.
- **D6.** R10:
  - `unlinked_at` set without `unlinked_by` → 23514 `pos_v1_store_links_unlink_shape_check`;
  - a reason of `'   '` → `pos_v1_store_links_unlink_reason_check`;
  - 501 characters → the same.
  Mutant: either CHECK dropped → red.
- **D7.** Repo:
  - `getLinkByStore` and `getLinkByChannel` return undefined for an unlinked row;
  - `getLinkByPosStoreId`, `getLinkByStoreForUpdate` and `listLinks` return it with `unlinkedAt` set.
  Mutants: either live filter dropped → red; a filter added to `getLinkByPosStoreId` → red.
- **B1 (✎AMEND REV-3).** Seed these people, run the `B0187` block read from the migration file as the migration
  role, and expect:
  | Person | Seeded with | Expected |
  |---|---|---|
  | X | active `admin` role and the four grants | exactly one live grant |
  | Y | `approve_item` only | none |
  | Z | the four, one of them revoked | none |
  | V | the four, but a `manager` role (demoted) | none |
  | S | the four, one of them store-scoped | one grant (the four are counted as `personHasActiveGrant` counts) |
  | W | the four and an existing live `unlink_store_from_pos` | still exactly one |

  A second run inserts 0. Run once more as a role RLS filters, with no org: Postgres's row-level-security error, not
  a silent 0.
  Mutants:
  - `HAVING … = 4` dropped → Y red;
  - `revoked_at IS NULL` dropped → Z red;
  - the admin-role `EXISTS` dropped → V red;
  - `NOT EXISTS` dropped → W red (23505);
  - `SET LOCAL row_security = off` removed → the RLS leg red.
- **A1.** `unlink_store_from_pos`: super_admin ✅, admin ✗, manager ✗, staff ✗ (the matrix parser reads the new row).
  An admin `authorize` → `AuthorizationError`; admin plus the five owner grants → allowed. Mutant: `admin: true` → red.
- **A2.** The PIN lists five; the derivation test still passes.
- **A3 (✎AMEND REV-10).** `capability-matrix.test.ts`: the capability row count goes up by one, and the md row
  matches the code row. Mutant: the md row missing → red.
- **A4 (✎AMEND REV-10).** `t337-capability-areas.test.ts`: `unlink_store_from_pos` is in area `sales` and is NOT
  offerable to positions. Mutant: the area set to `admin` → red; offerable → red.

**Gates:** typecheck, lint, the FULL integration suite on a fresh gate DB (0187 replaces 0185's functions).

## S2: the domain
**TESTER** (`packages/domain/tests/integration/t382-s2-unlink.test.ts`; fixtures from `_fixtures/pos-day.ts`):
- **U1.** A super-admin unlinks a linked store with three verified imported days. Then:
  - the row has `unlinked_at`, `unlinked_by = actor` and the trimmed reason;
  - one audit row `unlink_store_from_pos`, whose `before.posStoreId` and `after.unlinkReason` match;
  - the result is `{ importedDays: 3 }`;
  - `createSalesDay` on a new date succeeds;
  - `importSalesDay` refuses with the unlinked sentence.
  Mutants: the audit append skipped → red; `unlinked_at` not set → red.
- **U2.** I2: a snapshot of the store's `sales_days` (all columns), `sales_day_tenders`, `sales_day_channels`,
  `pos_v1_day_feeds`, `sales_day_pos_corrections` and `journal_entries` for those days is identical before and after.
  Then:
  - `editSalesDay` on a verified feed day refuses;
  - `reimportSalesDay` refuses;
  - `postPosCorrection` refuses with the unlinked sentence;
  - `recheckPosDay` refuses with the same sentence (R9a) and stores no feed.
  - ✎AMEND (REV-9): `voidSalesDay` on a verified imported day is ALLOWED. It reverses as any void does, the day's
    figure columns are unchanged, and a typed day can then be entered on that date.
  Mutant: the unlink touching any day row → red.
- **U3.** An admin holding `manage_chart_of_accounts` is refused: no row change, no audit row. Mutant: authorize under
  `manage_chart_of_accounts` → red.
- **U4.** I1: an admin naming a store that does not exist gets the authorization refusal, not "gone". Mutant: lock
  before authorize → red.
- **U5.** Reason `'   '` → the blank sentence; 501 characters → the length sentence; `'  wrong POS store  '` is
  stored trimmed. Mutant: no trim → red.
- **U6.** A store never linked, and a store already unlinked → *"{Store} isn't linked to POS."*; the second unlink
  leaves the first reason and time. Mutant: the check removed → red.
- **U7.** R3:
  - an OPEN feed day → refuse naming its date;
  - a SUBMITTED one → the same;
  - a store whose only feed days are verified or voided → unlinks.
  Mutants: `submitted` left out of the filter → red; `verified` included → red.
- **U8 (✎AMEND REV-1).** R8 relink: after U1, an admin links the SAME store again.
  - To `P1`, then (on a fresh fixture) to a free `P2`: the row is live and the three unlink fields are NULL.
  - The `link_store_to_pos` audit `before.unlinkReason` is the old reason.
  - The old feeds still carry `P1`.
  - Store B trying `P1` while A is unlinked → *"That POS store is still held by {A}, which was unlinked. Link {A} to
    its own POS store first."*
  - An unverified typed day entered while unlinked → the relink refuses with the W6 sentence.
  Mutants: `updateLink` not clearing `unlinked_at` → the store still takes typed days → red; `getLinkByPosStoreId`
  filtered → B gets the raw 23505 sentence → red.
- **U9.** The channel guard: after an unlink, the old link's channel can be retired (`refuseIfLinkedToPos` no longer
  fires). Mutant: `getLinkByChannel` unfiltered → red.
- **U10.** R5, two connections:
  - (a) Tx A unlinks and holds (not committed). Tx B imports a NEW date with the fake POS and blocks on the store
    lock. Commit A. B refuses with R5's sentence; zero feed rows and zero days for the date.
  - (b) Tx A relinks the store to a free `P2` and holds. B, fetched from `P1`, blocks. Commit A. B refuses with the
    same sentence.
  - (c) B imports first and commits an open day. A's unlink then refuses (R3).
  - (d) ✎AMEND (REV-4): Tx A relinks `P1` from `vat_inclusive` to `non_vat` and holds. B, fetched under the old link,
    blocks. Commit A. B refuses.
  Mutants: no re-read under the lock → (a) gets the raw constraint sentence, (b) imports, red; no store lock → (b)
  red; only `posStoreId` compared → (d) red.
- **U11 (✎AMEND REV-7).** R7. After an unlink:
  - a usage pull on a verified feed day with stored sold items builds its plan;
  - a typed day of that store gets the `unlinked` sentence;
  - a typed day of a NEVER-linked store gets the `unlinked` sentence;
  - a typed day of a LINKED store (typed before the link) gets the `typed` sentence.
  Mutants: the link read kept for feed days → red; the `typed` sentence used for every typed day → red.
- **U12 (✎AMEND REV-2).** Store linked `P1`, a day imported and verified, store unlinked, relinked to `P2`.
  - `postPosCorrection` and `recheckPosDay` on the old day refuse with the unlinked sentence. No journal entry, no
    correction row, no feed is added.
  - Same with a relink to `P1` itself, `vat_inclusive` → `non_vat`: the basis predates `link.updatedAt`, so it
    refuses.
  - `recheckRecentDays` after a new import skips the old day.
  - Control: on a store linked once and never relinked, the correction still posts.
  Mutants: the guard dropped → red; only `posStoreId` compared → the same-id leg red; the control refusing (the
  `updatedAt` check run when `updatedAt` is NULL) → red.

**Gates:** typecheck, lint, the domain integration suite on the lane DB, then `t375-*` and `t316-*` in full (they share
the link and fixtures).

## S3: the screen
R13 stands, with one change to the confirm sentence (✎AMEND REV-9). It now ends: *"…They can't be edited,
re-imported or corrected from POS. A manager can still withdraw an imported day and type it again. An admin can link
the store again later."*

**TESTER** (`apps/erp/tests/integration/t382-s3-unlink-web.test.ts`; banners read through `outcomeOf`, T-380 S1b):
- **W1.** A super-admin viewing a linked store sees the Unlink section with the confirm sentence (store name, POS
  store name, the imported-day count). An admin sees no Unlink section. Mutant: the section ungated → red.
- **W2.** The action with the box unticked → *"Tick the box to confirm."*, row unchanged. Mutant: the check removed →
  red.
- **W3.** The action, ticked, reason `"wrong store 123"` → the success banner. `outcomeOf` reads it from the flash, and
  the redirect URL contains neither the reason nor the banner. Mutant: `back({ ok })` with the URL → red.
- **W4.** A store with an open imported day: the loader shows R3's sentence and no form, and the action posted anyway
  refuses with the same sentence. Mutant: the loader ignores R3 → red.
- **W5.** An unlinked store's card shows *"Not linked — sales are typed"*, *"Unlinked {date} by {name}: {reason}"* and
  the link form. Mutant: `listLinks` treated as live → the card shows "linked" → red.

**Smoke (9008, the dev fake POS), after merge:**
1. As super-admin: link a demo store, import two days, verify them. Unlink with a reason. Check:
   - the banner, and that the address bar holds no reason;
   - the audit row;
   - that the sales-days page shows the typed form for the next date.
2. Open a verified imported day: no edit, no re-import. "Post correction" and "Re-check" refuse with the unlinked
   sentence.
3. On another linked store, import a third day without verifying it. Its Unlink section shows R3's sentence instead
   of the form.
4. As admin: no Unlink section anywhere. Try to link a second store to the first store's POS id: refused with "still
   held by". Relink the first store: it imports new dates, and its old days still refuse correction.

## Out of scope
- **N1. Hiding Re-check / Post-correction on an unlinked store's imported day.** The server refuses with a clear
  sentence, and `sales-days/[id]/page.tsx` belongs to T-380 S4. File it if the smoke finds it confusing.
- **N2. ✎AMEND (REV-2): superseded by R9a.** A recheck refuses after an unlink or a relink, so no drift finding is
  raised against a day that can no longer be corrected.
- **N3. Unlinking on behalf of another org.** `cross_org_access` break-glass is not wired to settings; a super-admin
  acts inside the org.
- **N4. A link history table.** The audit log already holds every link and unlink with before and after; use is 0-2
  a year.
- **N5. Bulk unlink.** One store at a time is the business act.
- **N6. ✎AMEND (REV-1): moving a POS store to another v2 store.** That needs the cross-store import guard named under
  R9 first.

## Done when
- S1-S3 are committed, each with the tester's mutants killed. The FULL integration suite is green on a fresh gate DB
  with 0187.
- `docs/ops/README.md` carries the 0187 precheck row, and Ian has run P0187a-c READ ONLY as `doadmin` before the push.
- Smoke steps 1-4 pass on 9008.
- The bible row, the matrix row, the 375 I10 note and the GLOSSARY entry are committed.

## Questions only Ian can answer
- None blocking. Told, not asked:
  - R3: an unlink waits until every imported day is verified or withdrawn.
  - R6: a new super-admin-only capability. 0187 grants it to every active admin who holds the other four; P0187b
    shows who.
  - ✎AMEND (REV-1): an unlinked store keeps its POS store, so that POS store cannot be linked to a different branch.
    Only the same branch can be relinked to it. Moving a POS store between branches is a later task.
  - ✎AMEND (REV-9): after an unlink, a manager can still withdraw an imported day and type that date in by hand. The
    imported figures themselves never change, but the typed day replaces them in the books for that date. Example:
    Lipa is unlinked on 20 Oct; a manager withdraws the imported 15 Oct and types 15 Oct again. This is how a typed
    store normally works.

## Ruling log
| Date | Who | Ruling |
|---|---|---|
| 2026-10-07 | Ian | `t375-unlink-safety` **a**: guarded unlink, super-admin, reason, audit; imported days stay as they are |
| 2026-10-08 | Opus planner | R1-R13 above |
| 2026-10-08 | Orchestrator, on the independent review | ✎AMEND: REV-1 (R9 dropped, full UNIQUE kept), REV-2 (R9a), REV-3 (RLS-safe backfill, admin role, P0187b by name), REV-4, REV-5 (D0), REV-6, REV-7, REV-9 (told Ian), REV-10 (A3, A4). S3 stays in this task |

## ✎AMEND-2 (orchestrator, 2026-10-08) — from the T-382 audit (commit e735bb1)
- **R10 (DEF-607, money, predates T-382).** A POS store id whose sales were ever imported for one store can never be
  linked to a DIFFERENT store. `linkStoreToPos` refuses when any `pos_v1_day_feeds` row for that POS store id belongs to
  another store of the org (live link or not, relinked away or not): *"That POS store's sales were already imported for
  {Store}, so it can't be linked to another store."* Closes: A relinked P1→P2 frees P1; B links P1 and imports dates A
  booked under P1 (double count). Read through the repo (SQL only there); same transaction and store lock as the link.
  Tests R10-a (relink-away then another store links the old id → refused; nothing written), R10-b (a never-imported POS id
  freed by relink CAN be linked elsewhere — control), R10-c (the same store relinking back to its own old id is allowed).
  Mutants: drop the check; check only live links; check other orgs too (must not leak across orgs).
- **R9a clock (LOW).** Compare `link.updated_at` with a DATABASE-stamped time on the basis feed (the column's
  `default now()` or a `created_at`), never the app clock; if the feed's `fetched_at` is written from the app, write it
  from the database instead. Test: a basis feed stamped strictly before the relink by the DB is refused; one after is not.
- **Bible row 285** gains R4 (0185 hardened for unlinked stores) and R5 (the import re-checks the link under the store
  lock) and R10, and its "a POS id stays held" sentence is made exact.
