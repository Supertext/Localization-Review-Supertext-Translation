import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The end-to-end test runs the proxy's route handlers in-process; they import '@/…'.
  resolve: { alias: { '@': fileURLToPath(new URL('../proxy/src', import.meta.url)) } },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: { REVIEW_LINK_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456' },
  },
})
