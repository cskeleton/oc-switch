import { expect, test, type Page } from "@playwright/test";

const TOKEN = "e2e-test-token";
const BASE_URL = "http://127.0.0.1:7420";

async function connect(page: Page) {
  await page.goto("/");
  await page.getByLabel("API 地址").fill(BASE_URL);
  await page.getByLabel("Token").fill(TOKEN);
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
    await page.getByRole("button", { name: "nvidia" }).click();
    const ref = page.getByText("nvidia/deepseek-ai/deepseek-v4-flash");
    await expect(ref).toBeVisible();

    // 获取元素的边界框和视口尺寸，确保模型引用文本没有超出视口宽度导致水平溢出
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
    await page.getByRole("button", { name: "nvidia" }).click();
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

  test("model editing entry points are reachable", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByLabel("管理模型 nvidia")).toBeVisible();
    await page.getByLabel("管理模型 nvidia").click();
    await expect(page.getByText("nvidia 模型")).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).click();

    await page.getByRole("navigation").getByRole("button", { name: "模型" }).click();
    await page.getByRole("button", { name: "nvidia" }).click();
    await expect(page.getByRole("button", { name: "添加模型" })).toBeVisible();
    await expect(page.getByLabel(/编辑模型 nvidia\/deepseek-ai\/deepseek-v4-flash/)).toBeVisible();
  });
});
