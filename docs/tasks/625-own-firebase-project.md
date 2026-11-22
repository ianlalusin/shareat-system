# T-625: ERP v2 moves to its own Firebase project, `shareat-system`

**Owner:** builder (Sonnet), laptop. Auditor: Sonnet (auth + files). **Spec:** BOSS (Opus), 22 Nov 2026.
**Ian, 21-22 Nov 2026:** created project `shareat-system` (Email/Password sign-in, Storage bucket
`shareat-system.firebasestorage.app`, Firestore) and said "we set it up now". This carries out bible row 202
("v2 will get its own Firebase project") and supersedes row 275's pending "leave Firebase Auth" for now.
**No migration.** No Postgres data changes except new rows a script writes on cut-over day (none planned, see S3).

## Today (inventory, 22 Nov)

v2 borrows **two** v1 projects:
- **Identity:** v1 ERP's `studio-7300228488-a394e`. Person link = `person_credentials` (kind `firebase`, `external_id` =
  uid). Email accounts (ERP users) and **terminal** accounts (store tablets, PIN layer 1) live there.
- **Storage:** `shareat-hub-v2` bucket (POS/CUSTOMER project). `stored_files.storage_path` holds the object key; the
  bucket comes from env only.
- **Firestore** (clock terminals): `mirror/*`, `biometricMirror/*`, `inbox/*`, relay `shareat-firestore-relay`
  (every 2 min) writes with the service-account project; the clock page reads with the `NEXT_PUBLIC_FIREBASE_*` project.
  They must be the same project; one project fixes the current split.
- **Reading v1** (stays on v1, untouched): `POS_FIREBASE_SA_KEY_FILE` (v1-bridge writer), `POS_BRIDGE_SA_KEY_FILE`,
  `CAPTURE_*`, `apps/pos` hard-coded config, `POS_FIREBASE_PROJECT_ID='shareat-hub-v2'`.

## Rulings (BOSS)

1. **One project for all three:** identity, storage and Firestore all move to `shareat-system`.
2. **Accounts keep their uid and password.** Use Firebase's user export/import with the old project's password-hash
   parameters, importing **only** the uids that appear in live `person_credentials` (kind `firebase`). Then
   `person_credentials` needs no change and nobody re-links or resets a password. (Fallback if the hash import fails:
   create the accounts fresh and send password-reset emails; terminal accounts get new passwords set by Ian.)
3. **Files are copied, not moved:** every `stored_files.storage_path` object is copied old bucket → new bucket and
   verified (size and MD5). The old bucket keeps its copies until Ian deletes them (rollback path).
4. **Clock terminals:** drain `inbox` (relay run, inbox empty), then re-mint each terminal's token in the new project.
   Unsynced punches on a tablet would be orphaned by the project change, so drain first. A clock terminal's uid lives in
   `clock_terminals.firebase_uid`; clock terminals are NOT imported (they are not in `person_credentials`), and the
   custom-token sign-in at re-pair recreates them in the new project. Each tablet must reload the clock page (new build)
   before re-pairing. The empty new Firestore mirror is refilled by `reseed-mirror.ts` (BOSS ruling): one fresh outbox row
   per LIVE roster employment, live credential and current store config (no history, no tombstones), `--check` coverage
   mode, counts only; the runbook states the relay drains 500 rows per org per run.
5. **Rules are ours now:** v2 deploys its own `firebase/firestore.rules` and a deny-all `storage.rules` to
   `shareat-system` (row 155's "never deploy rules" applied to the shared project only).
6. **Rollback** = put the old env values back and restart (and rebuild for `NEXT_PUBLIC_*`). Nothing in Postgres changes,
   so rollback is clean as long as the old buckets/accounts are left in place.
7. Firestore must have a **`(default)`** database (the code does not pass a database id). Ian creates it if missing.

## What to build (code + scripts; nothing runs against production from an agent)

- **S1 config:** `scripts/lib/config-contract.ts:123` bucket `allowedValues` → `shareat-system.firebasestorage.app`
  (keep accepting the old value only behind an explicit `--allow-old-bucket` for the rollback check);
  `scripts/storage-smoke.ts`, `scripts/deploy-preflight.ts`, `.env.example`, `packages/core/src/env.ts` comments that
  name hub-v2/studio as v2's projects. `firebase/.firebaserc` with `default: shareat-system`;
  `firebase/firebase.json` gains `"storage": { "rules": "storage.rules" }`; new `firebase/storage.rules` deny-all
  (copy from `docs/reference/private-bucket-storage-rules.md`). Guard tests that pin these values updated honestly.
- **S2 scripts** in `scripts/firebase-move/` (each with `--dry-run` default, prints counts only, never secrets, refuses
  unless `--confirm`):
  - `select-uids.ts`: reads live `person_credentials` (kind firebase, not revoked) → writes the uid list file.
  - `filter-export.ts`: filters a `firebase auth:export` JSON to those uids (for `firebase auth:import`).
  - `copy-files.ts`: copies every `stored_files` object old → new using two service-account files given by path
    (`--from-key`, `--to-key`), skips objects already present with the same MD5, reports copied/skipped/missing.
  - `verify.ts`: checks every live credential uid exists in the new project and every stored file exists in the new bucket;
    exit 1 on any gap.
  - Unit tests for the pure parts (uid filter, MD5 skip logic) with mutants.
- **S3 runbook** `docs/ops/firebase-move-runbook.md`: Ian's steps, in order, plain words: freeze window (night, stores
  closed), count credentials and files, drain the clock inbox and stop the relay timer, export + filter + import users,
  copy files, verify, deploy rules, put the new key on the droplet (`docs/ops/install-*.sh` style script that copies a
  local key file and prints only a short SHA prefix), edit `/srv/shareat-shared/.env.local` (+ `customer.env`) for
  `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_KEY_FILE`, `FIREBASE_STORAGE_BUCKET`, set the GitHub secrets for the
  five `NEXT_PUBLIC_FIREBASE_*` values, redeploy (rebuild), restart, re-mint clock terminal tokens, smoke tests (email
  sign-in, PIN sign-in on a tablet, open a staff photo, upload a file, a clock punch syncs), rollback steps.
- **Docs:** bible row text is BOSS's at wrap-up; `docs/ops/README.md` storage/identity section updated.

## Tests

1. Unit: uid filter keeps only listed uids and never drops a listed one (mutant: off-by-one/inverted filter → red).
2. Unit: copy skip logic copies when MD5 differs or object missing, skips when equal (mutant → red).
3. Guard/config tests that pin the bucket name pass with the new value.
- Typecheck `apps/erp` and the new scripts + tests via a temp tsconfig. `npm run census:write` if any page changes (none
  expected).
