import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Workspace packages are resolved from source, matching tsconfig paths and
// next.config's transpilePackages. One copy of the truth, three resolvers agreeing.
const alias = {
  '@shareat/core/money': `${root}packages/core/src/money.ts`,
  '@shareat/core/datetime': `${root}packages/core/src/datetime.ts`,
  '@shareat/core/logger': `${root}packages/core/src/logger.ts`,
  '@shareat/core/env': `${root}packages/core/src/env.ts`,
  '@shareat/core/exif': `${root}packages/core/src/exif.ts`,
  '@shareat/core': `${root}packages/core/src/index.ts`,
  '@shareat/db/schema': `${root}packages/db/schema/index.ts`,
  '@shareat/db/client': `${root}packages/db/src/client.ts`,
  '@shareat/db': `${root}packages/db/src/index.ts`,
  '@shareat/domain': `${root}packages/domain/src/index.ts`,
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
          include: [
            'tests/unit/**/*.test.ts',
            'tests/invariants/**/*.test.ts',
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
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts', 'packages/**/tests/integration/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/.next/**'],
          environment: 'node',
          setupFiles: ['tests/integration/setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
