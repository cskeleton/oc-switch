import { defineConfig } from "@playwright/test";

/**
 * Task 9 Step 8 专用 Playwright 配置：隔离端口（API 17420 / 预览 15173），
 * 避免与用户常驻的 oc-switch serve（127.0.0.1:7420）冲突。
 *
 * 只跑 runtime-models.e2e.ts（runtime spec §13.3 浏览器实测）。fixture server
 * 是 scripts/e2e-api.ts（经 E2E_API_PORT=17420 覆盖默认 7420），注入假 OpenClaw
 * 运行时 snapshot 与 xiaomi 双 Provider 插件目录，全程不碰真实 ~/.openclaw。
 *
 * 运行方式（spec 从 process.env 读 E2E_API_BASE_URL 决定登录的 API 地址）：
 *   E2E_API_BASE_URL=http://127.0.0.1:17420 bunx playwright test -c playwright.runtime.config.ts
 */
export default defineConfig({
  testDir: "packages/web/test/e2e",
  testMatch: "runtime-models.e2e.ts",
  fullyParallel: false,
  // desktop/mobile 两个 project 共用同一个带状态 fixture server，必须串行避免写冲突
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:15173",
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
      port: 17420,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { E2E_API_PORT: "17420" }
    },
    {
      command: "bunx vite preview --port 15173 --strictPort",
      cwd: "packages/web",
      port: 15173,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_PROXY_TARGET: "http://127.0.0.1:17420" }
    }
  ]
});
