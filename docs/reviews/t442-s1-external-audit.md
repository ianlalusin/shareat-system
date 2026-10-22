FINDINGS: 2 (1 MED, 1 LOW), corrected; S1 checkpoint only
- MED · scripts/backfill-file-links.ts:94 · --check counted only linkable files and its test expected success for a wrong-purpose reference; such a file remained unlinked while the census returned 0. Corrected test failed 0 versus 1 before repair; the read-only census now includes wrong-purpose files.
- LOW · packages/domain/src/files/backfill-links.ts:92 · Two new raw errors raised the files ceiling from nine to eleven. Existing ratchet failed first; standard refusals restore the unchanged limit.
CHECKED CLEAN
- Six-source registry and catalog check, explicit org filters plus principal, null-only link updates, lowest-owner shared links, purpose guard, dry-run rollback and read-only check.
- Guarded output uses counts; script results contain no storage path/name/URL; storage bytes are not touched by backfill.
- Real PostgreSQL integration: 21 passed, three writer checks TODO. Argument/throw checks: 66 passed; broader caller/system-transaction/boundary/register guards: 91 passed. Typecheck passed after correcting the refusal API call.
- Earlier multiword test filter expanded through the DB wrapper; interrupted and reproduced with a one-word filter on the isolated test database. No production backfill executed.
- S2 orphan-sweep exclusion, delete-race protection and log census remain unfinished; T-441 S2 writer/link-target dependency and its three TODOs remain open. No build/full PR CI or release-readiness claim.
FOR IAN: approved dashboard fd8af80 is live (main CI 39353485354, Deploy 39355100476, public health revision verified). Backfill stays separate and is not deployed.
Model: GPT-6 (Codex).
