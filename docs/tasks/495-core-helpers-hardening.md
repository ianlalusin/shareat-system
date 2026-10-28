# T-495 — Core helpers refuse the unsafe case: no volatile file storage in production, deep log redaction, counted job results

**Status:** spec written 2026-10-28 (Opus planner role, AUDIT session). Source: Codex core audit, 27-28 Oct
(`C:\Users\ianla\shareat-audits\OPEN\core-foundation-2026-10-27.md` findings 1-2;
`core-startup-recovery-2026-10-28.md` the volatile-storage finding), re-verified on origin/main fd3ae7b.
Branch `audit/t495-core-hardening`. Numbers reserved on the coordination board: T-495, DEF-791..793. Ian asked on
28 Oct that these findings NOT be copied into `docs/DEFECTS-REGISTER.md`; this PR adds no register rows. The DEF numbers
appear only here and in test names so the three slices stay traceable.

## S1 — F28 / DEF-791 (P2, latent on production): production with no bucket accepts volatile file storage
`packages/domain/src/files/driver.ts` `resolveStorageDriver()` refuses only when `FIREBASE_STORAGE_BUCKET` is set and no driver
is installed. With the bucket absent or blank it builds and caches the in-memory driver whatever `NODE_ENV` says, so a
production process with a missing bucket setting accepts a receipt into process memory and the registry row outlives the bytes.
`packages/core/src/env.ts:110` keeps the bucket optional on purpose (build and dev must not need it).

Ruling: the refusal lives in the resolver (the one place that picks a driver), not in `env()` (which also runs at build time).
`NODE_ENV === 'production'` with no installed driver throws, bucket set or not, with a sentence that names the missing setting.
Development and test keep the memory fallback. Production on the droplet has the bucket set (docs/ops/README.md, DEF-311), so
this changes nothing there; it turns a future misconfiguration into a refused upload instead of a lost file.
Files: `packages/domain/src/files/driver.ts` (and the dev/test wording of the log line in `scripts/lib/storage-bootstrap.ts`); test `tests/unit/t495-s1-storage-production-refusal.test.ts`.

## S2 — F29 / DEF-792: nested sensitive keys are not redacted
`packages/core/src/logger.ts` redacts the sensitive keys at the root and four of them one level down (`*.password` ...). A
`context.pin`, `context.accessToken`, `request.credentials.password` or a child logger's `context.pin` is emitted unchanged.

Ruling (the supported contract): every sensitive key is redacted at the root and at depth 1-4 (`k`, `*.k`, `*.*.k`, `*.*.*.k`,
`*.*.*.*.k`), generated from ONE key list so a key cannot be added at one depth and forgotten at another. Deeper than four, or in
free text, is not covered and the file comment says so. `REDACT_PATHS` and the censor string are exported so a test builds a
pino instance with the production config and a capturing stream.
Files: `packages/core/src/logger.ts`; test `packages/core/tests/t495-s2-logger-redaction.test.ts`.

## S3 — F30 / DEF-793: `jobResult` accepts a success with no counts
`jobResult(job, {})` logs `<job> finished` at info: the bible 15.6 rule ("success WITH COUNTS, never a bare done") is a comment, not
code. Also `{ failed: 0, errors: 1 }` logged info because `failed ?? errors` lets a zero hide a non-zero.

Rulings: (1) counts with no entries, or any value that is not a finite non-negative number, throws a `TypeError` naming the job
(a job that cannot say what it did must not look finished). (2) `failed` and `errors` are independent indicators: the line is an
error when EITHER is above zero. No production code calls `jobResult` today, so nothing changes at runtime.
Files: `packages/core/src/logger.ts`; test `packages/core/tests/t495-s3-job-result-counts.test.ts`.

## Gates
Red first (all three test files fail on main), then green. Typecheck. `tests/unit/app-boundaries.test.ts`,
`scripts-install-storage-driver.test.ts`, `storage-bucket-config-contract.test.ts`, `packages/core/tests/*`. No migration.
