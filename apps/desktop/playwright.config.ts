import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: 'e2e/electron',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
})
