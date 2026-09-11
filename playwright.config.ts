import { defineConfig } from "@playwright/test";

// 默认使用隔离端口，完整套件不停止或复用用户的常驻服务；必要时可经环境变量覆盖。
const apiPort = Number(process.env.E2E_API_PORT ?? "17420");
const webPort = Number(process.env.E2E_WEB_PORT ?? "15173");
const apiUrl = `http://127.0.0.1:${apiPort}`;
process.env.E2E_API_BASE_URL ??= apiUrl;

export default defineConfig({
  testDir: "packages/web/test/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  // desktop/mobile 两个 project 共用同一个带状态 fixture server，必须串行避免写冲突
  workers: 1,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
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
      port: apiPort,
      env: { E2E_API_PORT: String(apiPort) },
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `bun run --cwd packages/web preview --port ${webPort} --strictPort`,
      port: webPort,
      env: { VITE_PROXY_TARGET: apiUrl },
      reuseExistingServer: false,
      timeout: 60_000
    }
  ]
});
