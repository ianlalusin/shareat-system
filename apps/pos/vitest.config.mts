import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// T-422 ruling 9: copied POS v1 tests run here, with `@` -> apps/pos/src. The root `unit` project
// excludes apps/pos/** so the ERP's `@` alias never resolves a POS file.
export default defineConfig({
  root: here,
  resolve: {
    alias: {
      '@': `${here}src`,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
