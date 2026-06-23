import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "packages/web/test/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry"
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium", viewport: { width: 1280, height: 800 } } },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true
      }
    }
  ],
  webServer: [
    {
      command: "bun run scripts/e2e-api.ts",
      port: 7420,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: "bun run --cwd packages/web preview --port 5173",
      port: 5173,
      reuseExistingServer: false,
      timeout: 60_000
    }
  ]
});
