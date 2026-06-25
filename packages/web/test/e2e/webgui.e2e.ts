import { expect, test } from "@playwright/test";

const TOKEN = "e2e-test-token";
const BASE_URL = "http://127.0.0.1:7420";

async function connect(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.locator('input[type="text"], input:not([type="password"])').first().fill(BASE_URL);
  await page.locator('input[type="password"]').fill(TOKEN);
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByTestId("dashboard-view")).toBeVisible({ timeout: 15_000 });
}

test.describe("WebGUI smoke", () => {
  test("dashboard loads and is not blank", async ({ page }) => {
    await connect(page);
    await expect(page.getByText("minimax-portal/MiniMax-M3")).toBeVisible();
    await expect(page.locator("main")).not.toBeEmpty();
  });

  test("providers table visible", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByTestId("providers-view")).toBeVisible();
    await expect(page.getByTestId("providers-view").getByText("nvidia", { exact: true })).toBeVisible();
    await expect(page.getByText("openai-completions").first()).toBeVisible();
  });

  test("models page includes slash ref without overflow", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "模型" }).click();
    await expect(page.getByTestId("models-view")).toBeVisible();
    const ref = page.getByText("nvidia/deepseek-ai/deepseek-v4-flash");
    await expect(ref).toBeVisible();
    const box = await ref.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    if (box && viewport) {
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    }
  });

  test("primary model button is reachable", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "模型" }).click();
    const btn = page.getByLabel("设为主模型 nvidia/deepseek-ai/deepseek-v4-flash");
    await expect(btn).toBeVisible();
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeEnabled();
  });

  test("backup restore dialog opens and can be cancelled", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "备份" }).click();
    await expect(page.getByTestId("backups-view")).toBeVisible();

    const restoreButtons = page.getByRole("button", { name: /恢复备份/ });
    await expect(restoreButtons.first()).toBeVisible();
    await restoreButtons.first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("custom provider dialog opens and accepts slash model ids", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "Providers" }).click();
    await page.getByRole("button", { name: "添加 Provider" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("供应商名称").fill("Custom OpenAI");
    await page.getByLabel("Provider ID").fill("custom-openai");
    await page.getByLabel("请求地址").fill("https://api.custom.example");
    await page.getByLabel("API Key", { exact: true }).fill("sk-test-custom-secret");
    await page.getByLabel("模型列表").fill("vendor/model-b | b");
    await expect(page.getByText("vendor/model-b | b")).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
