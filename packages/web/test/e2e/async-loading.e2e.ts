import { expect, test, type Page } from "@playwright/test";

const apiUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:17420";
const headers = { Authorization: "Bearer e2e-test-token" };

async function connect(page: Page) {
  await page.goto("/");
  await page.getByLabel("API 地址").fill(apiUrl);
  await page.getByLabel("Token").fill("e2e-test-token");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByTestId("dashboard-view")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  // 只允许隔离 fixture，不能误写常驻服务或真实配置。
  expect(new URL(apiUrl).port).not.toBe("7420");
  const response = await page.request.get(`${apiUrl}/api/settings`, { headers });
  expect(response.ok()).toBe(true);
  expect((await response.json()).configPath).toMatch(/oc-switch-e2e-[^/\\]+[/\\]openclaw\.json$/);
});

test("运行时响应未完成时，三个页面的本地配置已经可见", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let pending = 0;
  await page.route(/\/api\/(model-inventory|model-extensions|model-attention)(?:\?|$)/, async route => {
    // 使用真实 fixture server 的 DTO，仅延迟传输，不手造 API 数据。
    const response = await route.fetch();
    pending += 1;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await connect(page);
    await expect(page.getByText("正在检查 OpenClaw / Gateway…", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await expect(page.getByTestId("static-models")).toBeVisible();
    await page.getByRole("button", { name: "服务商", exact: true }).click();
    await expect(page.getByTestId("static-providers")).toContainText("metadata-e2e");
    await expect(page.getByText("正在读取插件目录…", { exact: true })).toBeVisible();
    expect(pending).toBeGreaterThan(0);
    const dimensions = await page.evaluate(() => ({ width: document.body.clientWidth, scroll: document.body.scrollWidth }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("运行时失败仍保留本地配置和可用的编辑入口", async ({ page }) => {
  await page.route("**/api/model-inventory", route => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "fixture runtime unavailable" })
  }));
  await connect(page);
  await page.getByRole("button", { name: "服务商", exact: true }).click();
  await expect(page.getByTestId("static-providers")).toContainText("metadata-e2e");
  await page.getByRole("button", { name: "更多操作 metadata-e2e", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "编辑 metadata-e2e", exact: true })).toBeEnabled();
  await expect(page.getByText(/运行时未确认.*fixture runtime unavailable/)).toBeVisible();
});

test("保存显示真实进度，写后只刷新配置，确认按钮才重新检查运行时", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "服务商", exact: true }).click();
  const table = page.getByTestId("static-providers");
  await expect(table).toContainText("metadata-e2e");
  const before = await (await page.request.get(`${apiUrl}/api/model-config`, { headers })).json();
  const original = before.providers.find((provider: { id: string }) => provider.id === "metadata-e2e").baseUrl;
  let runtimeReads = 0;
  let refreshes = 0;
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/model-inventory" || path === "/api/model-attention") runtimeReads += 1;
    if (path === "/api/model-inventory/refresh") refreshes += 1;
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let backupId: string | undefined;
  await page.route("**/api/providers/metadata-e2e", async route => {
    const response = await route.fetch();
    backupId = (await response.json()).backupId;
    await gate;
    await route.fulfill({ response });
  });
  try {
    // 首轮后台请求完成后清零，避免把进入页面的请求算作写后刷新。
    await expect(page.getByText("正在检查 OpenClaw / Gateway…", { exact: true })).toHaveCount(0);
    runtimeReads = 0;
    await page.getByRole("button", { name: "更多操作 metadata-e2e", exact: true }).click();
    await page.getByRole("menuitem", { name: "编辑 metadata-e2e", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Provider baseUrl", { exact: true }).fill(`${original}/async-e2e`);
    await page.getByRole("button", { name: "保存 Provider", exact: true }).click();
    await expect(page.getByRole("dialog").getByText("正在保存本地配置…", { exact: true })).toBeVisible();
    release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(table).toContainText(`${original}/async-e2e`);
    await expect(page.getByText(/在线状态待确认/).first()).toBeVisible();
    expect(runtimeReads).toBe(0);
    expect(refreshes).toBe(0);
    await page.getByRole("button", { name: "检查并确认", exact: true }).click();
    await expect.poll(() => refreshes).toBe(1);
    await expect(page.getByText("正在检查 OpenClaw / Gateway…", { exact: true })).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    if (backupId) {
      const restored = await page.request.post(`${apiUrl}/api/backups/${encodeURIComponent(backupId)}/restore`, { headers, data: {} });
      expect(restored.ok()).toBe(true);
    }
  }
});
