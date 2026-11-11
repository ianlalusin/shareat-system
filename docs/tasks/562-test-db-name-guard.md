# T-562: the destructive-test guard checks the database NAME, not the whole URL (DEF-818, audit GT-001)

**Status:** SPEC 2026-11-11 (AUDIT). Number from the orchestrator (BOARD). Source: `shareat-audits/OPEN/2026-11-09-test-db-guard.md`
(GT-001), logged by BOSS as DEF-818. No migration. Branch `audit/t562-test-db-name-guard`, worktree `wt-audit-t562`.

## 1. Problem

About 640 files guard destructive tests and scripts with `/shareat_test|_test(\?|$)/.test(url)` on the WHOLE connection URL.
`postgres://shareat_test_user:x@localhost/production` passes (the user name matches), and so would a host or query
containing `shareat_test`. These tests TRUNCATE tables. Separately, the worker clone name `shareat_t528_test_w1` (setup
appends `_w<N>`) is refused, because it has neither `shareat_test` nor a final `_test`.

## 2. Rule

A URL is a test database only when the decoded database name (the URL pathname without the leading `/`) matches
`/(^|_)test(_|$)/`. Accepted: `shareat_test`, `shareat_test_audit512`, `shareat_t503_test`, `shareat_t528_test_w1`.
Refused: `production`, `shareat`, `shareat_dev`, `contest`, `shareat_testing`, a URL whose only `test` is in the user,
password, host or query, and an unparseable URL. Never connect to a database to check this.

## 3. Changes

1. One shared helper, `isTestDatabaseUrl(url: string): boolean`. Put it where both TS tests and `.mjs` scripts can import it
   without a build. Preferred: a plain `.mjs` module under `scripts/lib/` (like `scripts/lib/practice-env.mjs`), plus a
   `.d.mts` if TS needs types. If every TS caller already resolves another shared module more simply, use that and say
   why.
2. Replace EVERY copy of the whole-URL regex in tracked files (`git grep -n "shareat_test|_test"`) with the helper call.
   Keep each site's existing refusal behaviour (throw or exit) and message, and never print the URL. Do it with a script,
   not by hand. Verify with `git grep` that zero copies remain.
3. A unit test `tests/unit/t562-test-db-name.test.ts` covering every accepted and refused example in section 2, including
   encoded names (`%5F`) and misleading userinfo, host and query. Update any existing unit guard that pins the old regex
   TEXT so that it pins the behaviour instead.

## 4. Checks

- The new unit test passes; root `npm run typecheck` is clean.
- Unit guard and census files pass (`tests/unit` filtered to guard, census, app-boundaries).
- At least 3 integration files of different packages pass on this worktree's own `_test` DB, proving the shared setup still
  accepts a real test DB.
- `git diff --stat` shows only guard-line replacements, the helper, the test and this spec. No CR or control bytes.

## 5. Acceptance

No destructive test or script can run against a database whose NAME is not a test name, whatever the user, host or query
says. Legitimate worker clones are accepted. DEF-818 and GT-001 close after merge.
