import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = `${here}../../`;

// T-422 ruling 9: copied POS v1 tests run here, with `@` -> apps/pos/src. The root `unit` project
// excludes apps/pos/** so the ERP's `@` alias never resolves a POS file.
export default defineConfig({
  root: here,
  resolve: {
    alias: {
      '@': `${here}src`,
      // T-424 slice T: ONLY the ERP-contract test (src/server/__tests__/erp-contract.test.ts) loads packages/domain/src/pos/v1-*.ts,
      // which import these two leaves (no imports of their own) and `@shareat/db` for one constant. `@shareat/db` resolves to that
      // constant's leaf file, never the database client, so no Postgres code is pulled into the POS test run.
      '@shareat/core/money': `${repo}packages/core/src/money.ts`,
      '@shareat/core/datetime': `${repo}packages/core/src/datetime.ts`,
      '@shareat/db': `${repo}packages/db/src/pos-v1/wire.ts`,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
