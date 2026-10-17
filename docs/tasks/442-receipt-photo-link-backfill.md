# T-442: Link the files already saved (DEF-672 backfill + census)

**Status:** SPEC 2026-10-17 (Opus planner). Depends on T-441 S1 (merged). Run in production only after T-441 S2
(the other receipt-photo screens claim on save) is deployed, so no new unlinked file arrives after the backfill.

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
