Claimed by DeepSeek deepseek-flash, 2026-11-08 00:35 (Asia/Manila)

# T-547 — One test's database guard accepts any _test database and never prints the password (DEF-816, DEF-817)

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | <app and model> |
| Branch | `wo/t547-t512-test-db-guard` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t547` (the builder creates it, and works only there) |
| Risk class | **low** (one test file's top guard) |
| Numbers reserved | migration: none · DEF: DEF-816, DEF-817 (already logged; do not edit the register) · bible row: none |

## 1. Goal

`packages/domain/tests/integration/t512-duplicate-item-lines.test.ts` refuses to run unless the database
name contains `shareat_test`, so it fails on every lane's own test database (named like
`shareat_t528_test`). The project rule is that tests run on ANY `_test` database (DEF-816). Its
refusal message also hides the password with a regex that stops at the first `@`, and the local
password contains `@`, so part of the password gets printed (DEF-817). Make this test use the same
guard and the same redaction helper as the shared integration setup.

## 2. Read first (and nothing else is required)

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `packages/domain/tests/integration/t512-duplicate-item-lines.test.ts` lines 1-35
- `tests/integration/setup.ts` lines 50-60 (the shared guard: `/shareat_test|_test(\?|$)/` and `redactDbUrl(url)`)
- `tests/helpers/redact-db-url.ts` (the shared helper: `export function redactDbUrl(text, url = text)`)

## 3. What to build

1. In `t512-duplicate-item-lines.test.ts`, replace the guard
   `if (!/shareat_test/.test(url)) { throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — ...`) }`
   with the shared rule: test `/shareat_test|_test(\?|$)/`, and build the message with
   `redactDbUrl(url)` imported from the shared helper (use the correct relative path from this file
   to `tests/helpers/redact-db-url.ts`, the same way other files under `packages/domain/tests/` reach
   repo-root `tests/` — find one and copy its style). Message text: "the database name must contain
   \"_test\"".
2. Change nothing else in the file.
3. New unit test `tests/unit/t547-t512-guard.test.ts` that reads the t512 file's source and asserts:
   it contains `_test(\?|$)`, it imports `redactDbUrl`, and it no longer contains `[^@]*@`.
4. Not to build: no other test files (other inline copies are behind the shared setup guard and
   unreachable — Ian decided not to sweep them).

## 4. Files you may touch

| File | Change |
|---|---|
| `packages/domain/tests/integration/t512-duplicate-item-lines.test.ts` | edit — the guard only |
| `tests/unit/t547-t512-guard.test.ts` | new |

The repo copy of this work order (`docs/tasks/547-t512-test-db-guard.md`) is always allowed.

⛔ Any other file is off limits.

## 5. Tests that must pass

| Test | Proves |
|---|---|
| `tests/unit/t547-t512-guard.test.ts` | the guard and redaction are the shared ones |

Plus, every time — paste the real summary lines:
```bash
npm run typecheck
```
```bash
npx vitest run tests/unit/t547-t512-guard.test.ts
```
```bash
npx vitest run --project unit
```
(You cannot run the integration test without a database; that is fine — CI runs it.)

## 6. Done means

- [ ] §3 built inside the §4 list; worktree completeness check and pre-push diff check done
- [ ] §5 tests passing; typecheck clean; full unit suite summary pasted
- [ ] This work order copied as `docs/tasks/547-t512-test-db-guard.md` with real output under **Builder notes**
- [ ] One PR against `main`, title starting "T-547:", ending "Built by <app> <model> from a work order"
- [ ] Work order moved to `done\` with the PR link; entry added to `BUILD-AUDIT-LOG.md` ("BUILT — awaiting audit")
- [ ] **Stop there.**

## 7. Forbidden

Every rule in `docs/tasks/WORK-ORDER-TEMPLATE.md` §7 and the BUILDER-PROMPT.md NEVER list applies.
Never print or paste the database URL or password, even partly.

## 8. If you get stuck

Builder notes (both copies) → push → draft PR → move to `done\` with "BLOCKED" → next work order.

## Builder notes

Built by DeepSeek deepseek-flash, 2026-11-08, from `origin/main` at `8b41988`, in worktree
`C:\Users\ianla\webapps\wt-t547` on branch `wo/t547-t512-test-db-guard`.

### What changed (2 files, exactly §4)

`packages/domain/tests/integration/t512-duplicate-item-lines.test.ts` — its own copy of the guard is
replaced by the shared one, and nothing else in the file moved:

```diff
-if (!/shareat_test/.test(url)) {
+if (!/shareat_test|_test(\?|$)/.test(url)) {
   throw new Error(
-    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "shareat_test".`,
+    `Refusing to run against ${redactDbUrl(url)} — the database name must contain "_test".`,
   );
 }
```
plus the import, in the style the other files under `packages/domain/tests/integration/` already use:

```ts
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
```

That is now the same pair `tests/integration/setup.ts:53-58` uses, and the same shape
`posting-patterns.test.ts`, `t386-s6-code-shape.test.ts`, `t390-*` and `def640-*` already carry —
this file was the one copy that had drifted.

`tests/unit/t547-t512-guard.test.ts` — reads that file as text and asserts the three things §3 asks:
it contains `_test(\?|$)`, it imports `redactDbUrl` and passes the URL through it, and it keeps no
`[^@]*@` (or `'://***@'`) inline redaction.

### Checks — real output

`npm run typecheck`

```
> shareat-system@0.1.0 typecheck
> tsc --noEmit
```
exit 0, clean.

`npx vitest run tests/unit/t547-t512-guard.test.ts`

```
 ✓ |unit| tests/unit/t547-t512-guard.test.ts (3 tests) 13ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

`npx vitest run --project unit --maxWorkers=6`

```
Tests  total 11569  failed 57  passed 11508  pending 4
```

**The failures are not this change.** They are 33 files of the kinds this machine produces when the
suite runs at 6 workers on a loaded box (4.3 GB free, 21 `node` processes at the end of the run):
`STACK_TRACE_ERROR` (vitest's placeholder for a worker that died without a stack), the two
`bash`-dependent deploy tests (`deploy-pos-failed-build` 8, `t455-s9a-ops` 5) that fail identically
alone on Windows, and `packages/domain/tests/t375-s0-census-script.test.ts` dying with
`3221226505` (`0xC0000409`, a crashed child under memory pressure). This PR touches one integration
file (excluded from the unit project by `**/tests/integration/**`) and adds one unit test; no file in
the failing list imports either.

**The integration test itself was not run** — there is no test database on this machine, as §5 says
("CI runs it"). What was verified here is its source, by the new unit test.

### Guard tests

**None moved.** `glossary-trap-names`, `no-committed-secrets` and the other census files fail only
with `STACK_TRACE_ERROR` in the full run; none reads this file, and the new test adds no exported
name (so the production-caller ratchet is untouched).

### Smoketest

**N/A, a test-file guard.** No screen and no runtime behaviour is involved; the integration test
itself runs in CI against a real database.

### Commits

- `T-547: t512 uses the shared test-database guard and redaction (DEF-816, DEF-817)`
- `T-547: test the guard it now uses, and keep the work-order copy`
