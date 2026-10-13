import { defineConfig } from 'vitest/config';

// App↔DB contract tests (BUILD_PLAN Phase 3). Run only by supabase/tests/run.sh, which
// starts the local PostgreSQL and exports its connection settings.
export default defineConfig({
  test: {
    include: ['supabase/tests/contract/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
