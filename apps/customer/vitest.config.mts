import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = `${here}../../`;

// Customer v2 (fixtures + the T-455 lobby server): its tests run here, with `@` -> apps/customer/src. The root `unit`
// project excludes apps/customer/** so the ERP's `@` alias never resolves a customer file (T-422 rule 9 pattern).
// The workspace aliases mirror the root vitest.config.mts (exact subpath entries BEFORE the bare package name).
export default defineConfig({
  root: here,
  resolve: {
    alias: {
      '@': `${here}src`,
      '@shareat/core/money': `${repo}packages/core/src/money.ts`,
      '@shareat/core/datetime': `${repo}packages/core/src/datetime.ts`,
      '@shareat/core/logger': `${repo}packages/core/src/logger.ts`,
      '@shareat/core/env': `${repo}packages/core/src/env.ts`,
      '@shareat/core/exif': `${repo}packages/core/src/exif.ts`,
      '@shareat/core/sentence': `${repo}packages/core/src/sentence.ts`,
      '@shareat/core': `${repo}packages/core/src/index.ts`,
      '@shareat/db/pos-v1/wire': `${repo}packages/db/src/pos-v1/wire.ts`,
      '@shareat/db/schema': `${repo}packages/db/schema/index.ts`,
      '@shareat/db/client': `${repo}packages/db/src/client.ts`,
      '@shareat/db': `${repo}packages/db/src/index.ts`,
      '@shareat/domain/money-lines': `${repo}packages/domain/src/shared/money-lines.ts`,
      '@shareat/domain/money-input': `${repo}packages/domain/src/shared/money-input.ts`,
      '@shareat/domain/item-code': `${repo}packages/domain/src/item-code.ts`,
      '@shareat/domain/files/limits': `${repo}packages/domain/src/files/limits.ts`,
      '@shareat/domain/refusal-leaf': `${repo}packages/domain/src/shared/refusal-leaf.ts`,
      '@shareat/domain/attendance/fingerprint': `${repo}packages/domain/src/attendance/fingerprint/index.ts`,
      '@shareat/domain/service-charge': `${repo}packages/domain/src/service-charge/index.ts`,
      '@shareat/domain/field-rules': `${repo}packages/domain/src/field-rules/index.ts`,
      '@shareat/domain/business-rules': `${repo}packages/domain/src/business-rules/index.ts`,
      '@shareat/domain': `${repo}packages/domain/src/index.ts`,
      '@shareat/auth/errors': `${repo}packages/auth/src/errors.ts`,
      '@shareat/auth': `${repo}packages/auth/src/index.ts`,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The lobby routes import the whole @shareat/domain index; the first route call in a file pays that cold transform.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
