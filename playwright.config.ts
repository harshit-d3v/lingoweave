import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'test/browser',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  use: { baseURL: 'http://localhost:4817' },
  webServer: { command: 'node scripts/serve-demo.mjs', port: 4817, reuseExistingServer: !process.env.CI },
})
