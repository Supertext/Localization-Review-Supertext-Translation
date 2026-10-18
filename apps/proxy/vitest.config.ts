import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    // Integration tests each use their own database, but share the process environment.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { REVIEW_LINK_SECRET: 'test-secret-test-secret-test-secret-0123' },
  },
});
