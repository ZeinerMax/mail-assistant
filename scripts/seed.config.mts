import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Runs scripts/seed-demo.ts (dev helper), not part of the test suite.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['scripts/seed-demo.ts'], environment: 'node' }
})
