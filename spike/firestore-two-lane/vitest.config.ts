import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The emulator is one shared backend; parallel files racing clearFirestore() against each
    // other is the same shared-STATE trap bible §3.4 describes for the test database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
