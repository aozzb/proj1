import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 40000,
    // Integration tests share one Redis queue + test DB; run files serially (one
    // fork per file) so they never contend on the queue. Each file closes its
    // own connections in afterAll.
    fileParallelism: false,
  },
});
