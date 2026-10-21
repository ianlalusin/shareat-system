import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = `${here}../../`;

// Customer v2 skeleton (fixtures only): its tests run here, with `@` -> apps/customer/src. The root `unit`
// project excludes apps/customer/** so the ERP's `@` alias never resolves a customer file (T-422 rule 9 pattern).
export default defineConfig({
  root: here,
  resolve: {
    alias: {
      '@': `${here}src`,
      '@shareat/core/money': `${repo}packages/core/src/money.ts`,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
