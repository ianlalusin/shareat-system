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
  '@shareat/core': `${root}packages/core/src/index.ts`,
  '@shareat/db/schema': `${root}packages/db/schema/index.ts`,
  '@shareat/db/client': `${root}packages/db/src/client.ts`,
  '@shareat/db': `${root}packages/db/src/index.ts`,
  '@shareat/etl': `${root}packages/etl/src/index.ts`,
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts', 'packages/**/*.test.ts', 'apps/**/*.test.ts'],
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
