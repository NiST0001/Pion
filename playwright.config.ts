import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // Publish failed assertions as GitHub annotations, not just a generic exit code.
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  outputDir: 'test-results'
})
