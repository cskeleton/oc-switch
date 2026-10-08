import { expect, test, type Page } from "@playwright/test";

const apiUrl = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:17420";
const headers = { Authorization: "Bearer e2e-test-token" };
test.skip(process.env.E2E_PROVIDER_FIXES !== "1", "使用 E2E_PROVIDER_FIXES=1 的隔离专项夹具");

async function providers(page: Page) {
  expect(new URL(apiUrl).port).not.toBe("7420");
  const settings = await (await page.request.get(`${apiUrl}/api/settings`, { headers })).json();
  expect(settings.configPath).toMatch(/oc-switch-e2e-[^/\\]+[/\\]openclaw\.json$/);
  await page.goto("/");
  await page.getByLabel("API 地址").fill(apiUrl);
  await page.getByLabel("Token").fill("e2e-test-token");
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await page.getByRole("button", { name: "服务商", exact: true }).click();
  await expect(page.getByTestId("static-providers")).toBeVisible();
  await expect(page.getByText("正在检查 OpenClaw / Gateway…", { exact: true })).toHaveCount(0);
}

test("原生openai发现无需API Key，弹窗明确是OpenClaw目录", async ({ page }) => {
  await providers(page);
  const config = page.getByTestId("static-providers");
  await config.getByRole("button", { name: "更多操作 openai", exact: true }).click();
  await page.getByRole("menuitem", { name: "发现模型 openai", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/读取 OpenClaw 原生模型目录/)).toBeVisible();
  await expect(dialog.getByText("native-extra", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText("no API key configured");
});

test("同步参数后插件表保持在线视图，不再切成待确认目录表", async ({ page }) => {
  await providers(page);
  await page.getByRole("button", { name: "展开插件 xiaomi", exact: true }).click();
  const group = page.getByRole("region", { name: "插件 Provider", exact: true });
  await expect(group.getByRole("columnheader", { name: "运行状态", exact: true })).toBeVisible();
  let reads = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/model-inventory") reads += 1; });
  await page.getByTestId("static-providers").getByRole("button", { name: "更多操作 nvidia", exact: true }).click();
  await page.getByRole("menuitem", { name: "同步参数 nvidia", exact: true }).click();
  await expect(page.getByText(/已回填/)).toBeVisible();
  await expect(group.getByRole("columnheader", { name: "运行状态", exact: true })).toBeVisible();
  await expect(group.getByRole("columnheader", { name: "目录模型", exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
});

test("omen运行时模型提供移除引用入口，保留模型目录", async ({ page }) => {
  await providers(page);
  let backupId: string | undefined;
  try {
    await page.getByTestId("static-providers").getByRole("button", { name: "管理模型 opencode", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("使用引用", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "删除模型 opencode/omen-alpha", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "移除使用引用 opencode/omen-alpha", exact: true }).click();
    const confirmation = page.getByRole("dialog").filter({ hasText: "确认移除 opencode/omen-alpha" });
    await expect(confirmation.getByText(/插件与运行时目录中的模型保留/)).toBeVisible();
    const response = page.waitForResponse(result => new URL(result.url()).pathname === "/api/model-policy/exact-ref" && result.request().method() === "DELETE");
    await confirmation.getByRole("button", { name: "移除引用", exact: true }).click();
    const result = await response;
    expect(result.ok()).toBe(true);
    backupId = (await result.json()).backupId;
    await expect(page.getByText("opencode/omen-alpha", { exact: true })).toHaveCount(0);
    const inventory = await (await page.request.get(`${apiUrl}/api/model-inventory`, { headers })).json();
    const omen = inventory.models.find((model: { ref: string }) => model.ref === "opencode/omen-alpha");
    expect(omen.catalogSources).toContain("openclaw-runtime");
    expect(omen.policyAllowed).toBe(false);
    expect(omen.referenceSources).not.toContain("legacy-metadata");
  } finally {
    if (backupId) expect((await page.request.post(`${apiUrl}/api/backups/${encodeURIComponent(backupId)}/restore`, { headers, data: {} })).ok()).toBe(true);
  }
});
