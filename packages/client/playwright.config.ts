import { defineConfig, devices } from '@playwright/test'
import { BASE_URL, SERVER } from './tests/config.js'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // serialized — server is stateful (one project at a time)
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use system Chrome when Playwright's bundled browser isn't available for this distro
        channel: 'chrome'
      }
    }
  ],
  webServer: [
    {
      command: 'pnpm --filter @graphcoder/server dev',
      url: `${SERVER}/api/projects/current`,
      reuseExistingServer: !process.env.CI,
      cwd: '../..'
    },
    {
      command: 'pnpm dev',
      url: BASE_URL,
      reuseExistingServer: !process.env.CI
    }
  ]
})
