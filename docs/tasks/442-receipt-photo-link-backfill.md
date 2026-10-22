# T-442: Link the files already saved (DEF-672 backfill + census)

**Status:** 2026-10-22: S1+S2 backfill in open draft PR #43 (with part of T-441 S2), fixes pushed 22 Oct; not merged, not deployed. Production run by Ian after deploy.

## 1. The problem, measured in code (not assumed)

- `stored_files.linked_to` (`packages/db/schema/stored-files.ts`) is `text`, null until claimed. Convention (T-441
  `claimFile`, `linkFile` callers in `staff-media.ts`, `leave/documents.ts`, `ap/actions.ts:192`): **the bare id of the
  owning row** (invoice id, collection id, employment id, person id, leave request id). No table prefix.
- Sweep predicate: `listOrphans` (`packages/db/src/repo/files.ts:140`) = `org_id = $org AND linked_to IS NULL AND
  uploaded_at < now() - 24h ORDER BY uploaded_at LIMIT 500`; `deleteFile` = `... AND linked_to IS NULL`. Nothing
  checks whether a row references the file. Only the `ON DELETE restrict` FK stops the delete.
- ⛔ **Consequence beyond DEF-672's wording.** Every in-use unlinked file is a candidate EVERY night: the FK error is
  caught as a failure, so the timer exits 1 nightly (a watchdog that always barks is a dead watchdog), and because the
  batch is oldest-first and capped at 500, 500 in-use files would starve the sweep permanently.
- FKs to `stored_files` (schema + migrations 0046, 0049, 0057, 0066, 0080, 0204; no others):

| Table.column | Purpose actually stored | Linked on save today? |
|---|---|---|
| `supplier_invoices.receipt_file_id` | `receipt_photo` | yes since T-441 S1 (`/ap`); older rows no |
| `ar_collections.receipt_file_id` | `receipt_photo` (T-441 F2: never `ar_collection_proof`) | no until T-441 S2 (`/customers`, `/trade/orders` pay-now) |
| `deliveries.proof_file_id` | `receipt_photo` | no until T-441 S2 |
| `channel_settlements.withholding_certificate_file_id` | whatever the caller uploaded | no (domain takes an id; no screen) |
| `employments.photo_file_id` | `staff_photo` | yes (`staff-media.ts:85`) |
| `persons.signature_file_id` (composite same-org FK) | `staff_signature` | yes (`staff-media.ts:127`) |

  `leave_document` has no FK column: it is found BY `linked_to` (`leaveRepo.proofFileOf`), so it is linked by
  construction. `memo_document`, `wastage_dispute`, `onboarding_document`, `ar_collection_proof` have no writer yet.

## 2. Decision: a one-off script, not a migration

Chosen: `scripts/backfill-file-links.ts`. Rejected: a data-only migration (`UPDATE stored_files ... FROM ...`).
- A migration cannot dry-run, cannot report counts per purpose, and cannot list cross-org or shared references for
  Ian to read; this task's value is as much the report as the write.
- It would run as the table owner with RLS bypassed, across orgs in one statement; the repo's convention for data
  backfills is a per-org script under `withSystemOrgPrincipal` (`backfill-store-attendance-config.ts`,
  `backfill-fiscal-periods.ts`), and migrations here are schema (ADR-012 §5). A no-op on every CI database, it would
  also prove nothing.
- It runs once; the regression risk is new writers, which only a census test catches. So: script + census guard.

## 3. Design

**Registry (repo, the one list).** `packages/db/src/repo/files.ts` exports
`FILE_REFERENCES: readonly { table; column; label }[]` for the six rows above. SQL lives only in the repo.

**Repo functions** (all take `orgId`, filter on it explicitly: RLS is not enforced for `doadmin`, see `deleteFile`):
- `listReferencedUnlinked(tx, orgId)`: one `UNION ALL` over the registry: `{ fileId, ownerId, source, purpose }` for
  rows whose `stored_files` row (same org) has `linked_to IS NULL`.
- `listReferenceProblems(tx, orgId)`: (a) **shared**: one file referenced by 2+ rows; (b) **mismatched**: file linked
  to an id that is not the referencing row's; (c) **referenced, not in this org**: the referencing row's org has no
  `stored_files` row with that id (cross-org, the DEF-491 shape: single-column FKs do not check org).
- `listUnreferenced(tx, orgId)`: `linked_to IS NULL` and not referenced; count per purpose and age bucket
  (< 24 h / older). Report only: these are what the sweep will remove, correctly.
- `backfillLink(tx, orgId, fileId, ownerId)`: `UPDATE stored_files SET linked_to = $owner WHERE id = $id AND
  org_id = $org AND linked_to IS NULL RETURNING id`. ⛔ Not `linkFile` (no null guard, would overwrite).

**Domain.** `packages/domain/src/files/backfill-links.ts` `backfillFileLinks(orgId, { confirm })`: per org,
`withSystemOrgPrincipal`; dry run = same transaction, rolled back with a sentinel (as
`backfill-store-attendance-config.ts:150`), so dry-run counts are the real would-link counts. Shared file: link to
the oldest referencing row (lowest id), report the others. Mismatched / cross-org: report, never write.
Returns `{ linked: Record<purpose, n>; bySource: Record<label, n>; shared; mismatched; crossOrg; unreferenced }`.
**Touches no bytes:** must not import the storage driver; never deletes a row.

**Script.** `scripts/backfill-file-links.ts`, `npm run backfill-file-links`. Args: `--confirm`, `--org=<uuid>`;
anything else refused (same `parseArgs` shape). Default is dry run. Prints per org: would-link / linked per purpose
and per source, then the three problem lists (file id, source, owner id; no personal data), then unreferenced counts.
Exit 1 if any org failed, if no org was processed, or (with `--check`) if any referenced file is still unlinked:
`--check` is the read-only census Ian can run any time after.

**Sweep hardening (S2, small).** `listOrphans` adds `AND NOT EXISTS` over `FILE_REFERENCES` (built from the same
registry), so an in-use file is never a candidate even if a future writer forgets to link it. The FK stays as the
last wall. The sweep run output gains `referencedUnlinked: n` (census count) so a regression shows in the nightly log.

## 4. Slices

- **S1 (Sonnet).** Registry, four repo functions, `backfillFileLinks`, script, npm entry. Tests M1-M10.
- **S2 (Sonnet).** `listOrphans` NOT EXISTS + census count in the sweep report. Tests M11-M12.
  Both slices: integration tests on fixtures, run on any `_test` DB (never a lane DB name).

## 5. Tests and the mutants they kill

Integration (`packages/domain/tests/integration/t442-backfill-file-links.test.ts`), fixture: two orgs, one unlinked
referenced file per registry source, one already linked, one shared, one unreferenced old, one unreferenced fresh.
- M1 a registry entry dropped (e.g. deliveries): **catalog test** reads `pg_constraint` (`contype='f'`,
  `confrelid='stored_files'::regclass`) and asserts the set of (table, column) equals `FILE_REFERENCES` exactly.
  Kills the future "new FK column, nobody added it" too.
- M2 `linked_to IS NULL` guard removed: a file linked to X stays linked to X after `--confirm`.
- M3 dry run writes: after a dry run every fixture file's `linked_to` is unchanged and counts equal the confirm run's.
- M4 wrong link value (file id, prefixed id): `linked_to` equals the referencing row's id for each source.
- M5 org scope dropped: org B's files untouched by an org A run; a cross-org reference is reported, not linked.
- M6 idempotence broken: a second `--confirm` links 0 and reports the same problems.
- M7 counts keyed wrong: the `ar_collections` file counts under `receipt_photo` (F2), the employment photo under
  `staff_photo`.
- M8 anything deleted: `stored_files` row count unchanged; in-memory driver `remove` called 0 times.
- M9 shared file crashes or double-links: linked once, to the lowest owner id, other owner listed as shared.
- M10 script args: no args = dry run; unknown arg exits 1; `--check` exits 1 while one referenced file is unlinked,
  0 after `--confirm` (unit test on `parseArgs` + one integration run of the domain entry).
- M11 (S2) `listOrphans` without NOT EXISTS: a referenced, unlinked, 2-day-old file is not a candidate.
- M12 (S2) the census guard: after `--confirm`, `sweepOrphanedFiles(org, 0)` reports `failed: []`, every referenced
  file survives, the unreferenced old file is removed.
- **Census on every write path (the lasting guard):** one test per registry source saves a record through its real
  domain/action path with a file and asserts `listReferencedUnlinked` is empty. Sources not yet migrated by T-441 S2
  are `it.todo` naming S2, so the gap is visible in the suite rather than silent; S2 flips them on.

## 6. Production run (Ian runs; agents cannot write to production)

After this task and T-441 S2 are merged and deployed by CI (🚫 never build on the droplet, 159.223.46.224):
```
ssh root@159.223.46.224
cd /srv/shareat                       # the deployed artifact (as T-391)
sudo -u shareat env NODE_ENV=production npm run backfill-file-links            # dry run: read the report
sudo -u shareat env NODE_ENV=production npm run backfill-file-links -- --confirm
sudo -u shareat env NODE_ENV=production npm run backfill-file-links -- --check  # must exit 0
```
Paste the dry-run and `--check` output back. Shared, mismatched or cross-org lines are for Ian to decide, not the
script. Then watch the next 03:00 sweep log: `failed 0`, `referencedUnlinked 0`. Safe to re-run any time.

## 7. Out of scope

- Fixing F2 (customer payments stored as `receipt_photo`, not `ar_collection_proof`): no rename of existing purposes.
- Migrating screens to `claimUpload` (T-441 S2-S7). Cross-org same-org FK twins for the five single-column FKs
  (log as a DEF if the report finds any). Deleting stranded bytes (DEF-307). PNG/WebP metadata (DEF-674).
- Close DEF-672 when S1+S2 are merged, the production `--check` exits 0, and one nightly sweep shows `failed 0`.

## Audit 2026-10-17

Opus spec audit against main (`d634523`). Verified: the six FK columns are complete (schema grep + every migration
`REFERENCES stored_files`: 0046, 0049, 0057, 0066, 0080, 0204; 0204 adds TWO constraints on `persons`, single + composite);
`claimFile`/`claimUpload` link the bare record id (`ap/actions.ts:192`, `staff-media.ts:85,127`, `leave/documents.ts:34`);
sweep deletes the row before the bytes (`files/index.ts:405-420`), so an FK refusal never removes bytes. Folded in:

- **A1 Catalog test, composite FK.** `pg_constraint` returns 7 rows for 6 columns (persons has the single-column FK and
  `persons_signature_file_id_same_org_fk (org_id, signature_file_id)`). Compare the DISTINCT set of
  (table, referencing column other than `org_id`) to `FILE_REFERENCES`. Also assert every `uuid` column in
  `information_schema.columns` named `%file_id` (public schema) is in `FILE_REFERENCES`: catches a future file column
  added WITHOUT an FK, which the constraint query cannot see.
- **A2 Guarded files never named in output.** For purposes `staff_signature`, `staff_photo`, `leave_document`, the script
  prints COUNTS ONLY (no file id, no owner id), in every list including shared/mismatched/cross-org. No purpose ever
  prints `storage_path`, a URL, or a name: the domain result type carries no `storagePath` field. Test M13: capture the
  script's stdout for the fixture and assert it contains no fixture `storage_path`, no fixture person name, no `http`,
  and no id of a guarded-purpose file or of its owner person/employment.
- **A3 Purpose guard before linking.** Link only when the file's purpose fits the source: `supplier_invoices`,
  `deliveries` -> `receipt_photo`; `ar_collections` -> `receipt_photo` or `ar_collection_proof`; `employments` ->
  `staff_photo`; `persons` -> `staff_signature`; `channel_settlements` -> any purpose except the three guarded ones.
  Otherwise report under `wrongPurpose` (count) and do not write. Reason: `signature.ts:46,121` resolves a signature's
  person FROM `linked_to`; a guarded file linked to an invoice id would be read as belonging to that id. Mutant M14:
  a `staff_signature` file referenced from `supplier_invoices` stays `linked_to IS NULL` and counts once in `wrongPurpose`.
- **A4 Shared vs mismatched.** A shared file's non-owner references (after linking to the lowest owner id) are listed
  under `shared` only, never also under `mismatched` (on the second, idempotent run too: M6 must see identical lists).
- **A5 Census tests also assert `listReferenceProblems` is empty** for each write path, not only
  `listReferencedUnlinked`. ⛔ This pins the convention for T-441 S2's trade pay-now: the file is stored on
  `ar_collections.receipt_file_id`, so it must be claimed with `linkTo` = the **ar_collections id** (claim inside
  `dispatchTradeOrder` after the collection insert, or have it return the id), never the trade order id. Same for
  deliveries: the `deliveries` row id.
- **A6 `deleteFile` takes the same NOT EXISTS predicate** (built from `FILE_REFERENCES`), so a file referenced between
  `listOrphans` and the delete resolves as `claimed`, not as an FK error in `failed`. FK `restrict` stays the last wall.
  M15: reference a candidate after `listOrphans` and before `deleteFile`; result `claimed: 1`, `failed: []`, bytes kept.
- **A7 RLS, corrected.** Production `DATABASE_URL` is `shareat_app_prod` (non-bypassing, docs/ops/README.md:66) and
  `withSystemOrgPrincipal` sets role `shareat_app` anyway, so RLS IS enforced; keep the explicit `org_id` filters as the
  second layer. Consequence: under the org principal a cross-org referencing row is invisible to the sweep's NOT EXISTS,
  so a cross-org-referenced file stays a candidate and fails visibly on the FK. That is intended; it is exactly the
  report's list (c). Both sides of every join filter `org_id = $org` (all six tables carry `org_id`).
- **A8 No `systemTransaction`.** List orgs with a bare `transaction((tx) => schedulerRepo.listOrgsToRun(tx))` exactly as
  `backfill-store-attendance-config.ts:209`; per-org work under `withSystemOrgPrincipal`. Do NOT add the script to
  `tests/unit/system-transaction-callers.test.ts`; it must stay green unchanged. Script loads `.env.local` via `dotenv`
  like its siblings (on the droplet `/srv/shareat` resolves the shared `.env.local`, docs/ops/README.md:759).
- **A9 Sweep log field.** `runOrphanFileSweepForOrg` has one `detail` string (`scheduler/index.ts:983`); put
  `referencedUnlinked n` there, joined with the cap message when both apply. A count only, never ids.
- **A10 Args.** `--org=` must match the UUID shape or exit 1; a well-formed id of no org = "no org processed", exit 1.

Tests added: M13 (output privacy), M14 (purpose guard), M15 (race resolves as claimed). Open (orchestrator): A5 is a
constraint on T-441 S2's trade pay-now builder; brief S2 with it before S2 starts.

**Status:** AUDITED 2026-10-17. Build after T-441 S2 (the trade pay-now link fix) so the backfill and new uploads use the same link targets; production run by Ian after deploy.
