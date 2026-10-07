import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Workspace packages are resolved from source, matching tsconfig paths and
// next.config's transpilePackages. One copy of the truth, three resolvers agreeing.
const alias = {
  // T-348 S2 — apps/erp's own tsconfig maps `@/*` -> `./src/*` (Next's own resolver honours it
  // fine), but nothing here did: every prior `@/components/...` import in a rendered page was
  // covered by a `vi.mock`, so the gap was silent until `PageDescription` became a SECOND,
  // unmocked `@/components/shell/*` import next to the always-mocked `Page` — "Cannot find
  // package '@/components/shell/PageDescription'" is this alias missing, not the component.
  // ⚠️ Single-app assumption, kept at ROOT deliberately, not scoped into a project's own
  // `resolve.alias`: the only project that runs `apps/erp/tests/*.test.ts` is `unit` below, and
  // `unit`'s own include glob already spans `packages/**` and `tests/unit/**` — repo-wide, not
  // erp-scoped — plus `apps/**` for EVERY app, so a future `apps/pos`/`apps/customer` test would
  // land in that same project and inherit this alias either way. Moving it into `unit`'s block
  // would look narrower without being narrower. `apps/pos`/`apps/customer` are reserved, not
  // built today (RULES §"out of scope") — the day either gets its own `@/` imports under test,
  // `unit`'s glob needs splitting into a per-app project FIRST, and this alias follows that split.
  '@': `${root}apps/erp/src`,
  '@shareat/core/money': `${root}packages/core/src/money.ts`,
  '@shareat/core/datetime': `${root}packages/core/src/datetime.ts`,
  '@shareat/core/logger': `${root}packages/core/src/logger.ts`,
  '@shareat/core/env': `${root}packages/core/src/env.ts`,
  '@shareat/core/exif': `${root}packages/core/src/exif.ts`,
  '@shareat/core': `${root}packages/core/src/index.ts`,
  '@shareat/db/pos-v1/wire': `${root}packages/db/src/pos-v1/wire.ts`,
  '@shareat/db/schema': `${root}packages/db/schema/index.ts`,
  '@shareat/db/client': `${root}packages/db/src/client.ts`,
  '@shareat/db': `${root}packages/db/src/index.ts`,
  // ⚠️ Subpath BEFORE the bare name — same ordering rule as `@shareat/auth/errors` below.
  '@shareat/domain/money-lines': `${root}packages/domain/src/shared/money-lines.ts`,
  // T-326 — mirrors '@shareat/domain/money-lines' above; same exact-match-before-bare-name rule.
  '@shareat/domain/money-input': `${root}packages/domain/src/shared/money-input.ts`,
  // T-343 S5.0 — mirrors the two subpaths above: `refusal-leaf.ts` has no `@shareat/db` import
  // deliberately (a `'use client'` component may reach for `humanDate`/`internalFault` directly),
  // so it needs its own exact entry the same reason the other leaves above do.
  '@shareat/domain/refusal-leaf': `${root}packages/domain/src/shared/refusal-leaf.ts`,
  // ⭐ T-314 slice A — the clock terminal is a CLIENT path and must reach the fingerprint logic
  // without dragging `@shareat/db` into the browser bundle. T-266 proved that exact failure once
  // (`Module not found: Can't resolve 'net'`), which is why this leaf exists at all.
  '@shareat/domain/attendance/fingerprint': `${root}packages/domain/src/attendance/fingerprint/index.ts`,
  // T-187 slice 1 — mirrors the two subpaths above: `apps/erp`'s own tsconfig has no generic
  // `@shareat/domain/*` wildcard (only the root tsconfig does), so this leaf needs its own exact
  // entry rather than relying on the wildcard the way `npm run typecheck` (root config) does.
  '@shareat/domain/service-charge': `${root}packages/domain/src/service-charge/index.ts`,
  '@shareat/domain': `${root}packages/domain/src/index.ts`,
  // ⚠️ The subpath goes BEFORE the bare name: these are exact-match aliases applied in order, and
  // T-237's `@shareat/auth/errors` leaf (the error classes without `@shareat/db` behind them) is
  // otherwise left to node resolution, which does not read this workspace's `exports` map here.
  // Same reason `@shareat/core/env` and `@shareat/db/schema` are listed above.
  '@shareat/auth/errors': `${root}packages/auth/src/errors.ts`,
  '@shareat/auth': `${root}packages/auth/src/index.ts`,
  '@shareat/etl/run': `${root}packages/etl/src/run.ts`,
  '@shareat/etl/capture': `${root}packages/etl/src/capture.ts`,
  '@shareat/etl/source-reader': `${root}packages/etl/src/source-reader.ts`,
  '@shareat/etl': `${root}packages/etl/src/index.ts`,
  '@shareat/etl-firestore': `${root}packages/etl-firestore/src/index.ts`,
  '@shareat/storage-firebase': `${root}packages/storage-firebase/src/index.ts`,
  '@shareat/sync-firestore': `${root}packages/sync-firestore/src/index.ts`,
};

export default defineConfig({
  resolve: { alias },
  test: {
    // ⭐ Let a test's own console output through. The golden master REPORTS its triage summary —
    // which classes of v1-vs-v2 divergence exist and how many — and a summary nobody can see is
    // not a report.
    disableConsoleIntercept: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          // ⭐ DEF-081: `tests/invariants/` and `tests/golden/` existed as empty directories and
          // matched NO include glob, so a test placed in either would never have run — while both
          // are named in the definition of done. A guard that does not execute is worse than no
          // guard, because it is credited. T-157 adds the first golden test and needs the glob to
          // be real; proven by watching a deliberately failing golden test actually fail.
          // `tests/invariants/` moved OUT to the integration project below (T-111) — the standing
          // invariant checks it holds post through the real `postEntry` against real Postgres, so
          // they are DB-touching by nature and belong with every other suite this file already
          // routes there, not here.
          include: [
            'tests/unit/**/*.test.ts',
            'tests/golden/**/*.test.ts',
            'packages/**/*.test.ts',
            'apps/**/*.test.ts',
          ],
          // A test that needs a database is not a unit test. CI runs the unit project
          // BEFORE migrations are applied, so a DB-touching test here fails on a fresh
          // database with "relation does not exist". Convention: anything under a
          // `tests/integration/` directory, anywhere, is an integration test.
          exclude: ['**/node_modules/**', '**/.next/**', '**/tests/integration/**'],
          environment: 'node',
          // T-380 S1a / REV-2: an empty `next/headers` jar for any test that renders a page which
          // calls `withFlash` without mocking cookies itself (a test's own vi.mock still wins).
          setupFiles: ['apps/erp/tests/helpers/flash-jar-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          // T-111 (DEF-081): `tests/invariants/` holds the standing, continuous invariant checks
          // (bible §16.1) — they post through the real `postEntry`, so they need real Postgres and
          // run here, not under `unit`.
          include: [
            'tests/integration/**/*.test.ts',
            'tests/invariants/**/*.test.ts',
            'packages/**/tests/integration/**/*.test.ts',
            // T-247 (DEF-221): apps/erp/tests/integration/** matched no include glob here and
            // was excluded from the unit project below — a file placed there the obvious way
            // (mirroring packages/**/tests/integration/** above) was collected by no project and
            // silently never ran. See tests/unit/integration-glob-guard.test.ts for the durable
            // guard against the next such directory.
            'apps/**/tests/integration/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/.next/**'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts', 'apps/erp/tests/helpers/flash-jar-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          // T-285 (DEF-313): `testTimeout` and `hookTimeout` are SEPARATE vitest settings — raising
          // one does not raise the other. Whoever set `testTimeout: 30_000` above for exactly this
          // package's slow-under-load Postgres fixtures did not also set `hookTimeout`, so every
          // `beforeEach` truncate here was silently defaulting to vitest's global 10_000ms. Measured
          // (docs/tasks/285-def-313-truncate-hook-timeout.md): a `TRUNCATE … CASCADE` from
          // `organizations` reaches 124 of 128 tables regardless of how narrow the caller's explicit
          // list is (every test creates its own org/store/persons, so all three — and everything
          // that references them — must be cleared every time; narrowing the list does not shrink
          // the closure). Under real concurrent load this legitimately runs several seconds, and
          // self-induced contention measurements reached 32.9s. `hookTimeout: 30_000` matches the
          // precedent already adopted in `firebase/vitest.config.ts:8,10` and
          // `spike/firestore-two-lane/vitest.config.ts:8,10`, which pair the same two settings for
          // the same reason. Deliberately NOT set on the `unit` project above — those tests never
          // touch a database, and a hung unit hook has no business taking 30s to say so.
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
