import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelInventory, PluginStateMutationResult } from "../../src/api";
/**
 * 运行时模型协调浏览器实测（runtime spec §13.3 / Task 9 Step 8）。
 *
 * 隔离环境：playwright.config 的双 webServer（e2e-api fixture + vite preview），
 * e2e-api 注入假 OpenClaw 运行时 snapshot 与 xiaomi 双 Provider 插件目录，
 * 不碰真实 ~/.openclaw。desktop / mobile 两个 project 各跑一遍。
 *
 * 断言重点（Task 8 遗留的真浏览器验证项）：
 * - body 无横向溢出（document.body.scrollWidth <= clientWidth）；
 * - DataTable 容器允许横向滚动（scrollWidth >= clientWidth 是设计，不算回归）；
 * - 不可用模型处理对话框（删除 policy 引用与独立 metadata 复选项）；
 * - 插件多 Provider 分组（xiaomi / xiaomi-token-plan 同组一个开关）；
 * - unknown 降级（探测诊断/证据不足行无删除建议）。
 */

const TOKEN = "e2e-test-token";
/** API 地址：隔离配置（playwright.runtime.config.ts）注入 17420，默认回落主配置的 7420 */
const BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:7420";
const FIXTURE_SECRET = "e2e-fixture-secret-NEVER-LEAK";
/** 截图输出目录（SDD 工作区，不进 Git）；playwright 以 repo root 为 cwd */
const SDD_DIR = join(process.cwd(), ".superpowers/sdd/2026-09-09-runtime-model-management");

async function connect(page: Page) {
  await page.goto("/");
  await page.getByLabel("API 地址").fill(BASE_URL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByTestId("dashboard-view")).toBeVisible({ timeout: 15_000 });
}

/** 断言 body 不横向溢出（排除 scrollbar 后 scrollWidth 不超过 clientWidth） */
async function expectNoBodyOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const body = document.body;
    return { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `${label}: body 横向溢出（scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth}）`
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

/** 只约束 Policy 表；body 不溢出不能证明表内不横滚，导航横滚仍允许。 */
async function expectPolicyTableLayout(page: Page, mobile: boolean, targetRef: string) {
  const policy = page.getByRole("region", { name: "Policy 规则", exact: true });
  const scrollers = policy.locator(".overflow-x-auto");
  const sizes = await scrollers.evaluateAll(elements => elements.map(element => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollLeft: element.scrollLeft
  })));
  expect(sizes.length).toBeGreaterThan(0);
  if (mobile) {
    for (const [index, size] of sizes.entries()) {
      expect(size.scrollWidth, `Policy 表 ${index} 横向溢出：${size.scrollWidth}/${size.clientWidth}`).toBeLessThanOrEqual(size.clientWidth);
      expect(size.scrollLeft, `Policy 表 ${index} 不应为删除按钮横向滚动`).toBe(0);
    }
  }
  for (const header of await policy.locator("thead tr").all()) {
    await expect(header.locator("th:visible")).toHaveCount(mobile ? 2 : 4);
  }
  if (!mobile) return;

  // 调用前已 scrollIntoView 删除按钮；完整对象与按钮必须同时在可视区域，不能靠横滚隐藏对象。
  const value = policy.getByText(targetRef, { exact: true });
  const row = value.locator("xpath=ancestor::tr[1]");
  await expect(value).toBeVisible();
  await expect(value).toBeInViewport({ ratio: 1 });
  await expect(row.getByRole("button", { name: `删除规则 ${targetRef}`, exact: true })).toBeInViewport({ ratio: 1 });
  const counts = row.locator("td").first().locator(".md\\:hidden");
  await expect(counts).toBeVisible();
  await expect(counts).toContainText("命中 1 个模型，其中 1 个不可用");
}

const fixtureHeaders = { Authorization: `Bearer ${TOKEN}` };

async function readInventory(page: Page): Promise<ModelInventory> {
  const response = await page.request.get(`${BASE_URL}/api/model-inventory`, { headers: fixtureHeaders });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function restoreFixture(page: Page, backupId: string) {
  const restored = await page.request.post(`${BASE_URL}/api/backups/${encodeURIComponent(backupId)}/restore`, { headers: fixtureHeaders, data: {} });
  expect(restored.ok(), "必须还原本用例写入前的 fixture").toBe(true);
  const refreshed = await page.request.post(`${BASE_URL}/api/model-inventory/refresh`, { headers: fixtureHeaders });
  expect(refreshed.ok()).toBe(true);
}

test.describe("Runtime model inventory（统一 inventory 浏览器实测）", () => {
  test.beforeEach(async ({ page }) => {
    // 写入测试只能连接明确隔离的临时配置；绝不尝试常驻的 7420。
    const endpoint = new URL(BASE_URL);
    expect(["127.0.0.1", "localhost"]).toContain(endpoint.hostname);
    expect(endpoint.port, "请通过 E2E_API_BASE_URL 指定隔离端口").not.toBe("7420");
    const pathsResponse = await page.request.get(`${BASE_URL}/api/settings/paths`, { headers: fixtureHeaders });
    expect(pathsResponse.ok()).toBe(true);
    const paths = await pathsResponse.json() as { active: { openclawPath: string } };
    expect(paths.active.openclawPath).toMatch(/[/\\]oc-switch-e2e-[^/\\]+[/\\]openclaw\.json$/);
  });

  test("不再提醒跨页面和刷新有效，恢复提醒不改 OpenClaw 配置", async ({ page }) => {
    const original = await readInventory(page);
    let savedIssue: { id: string; revision: string } | undefined;
    try {
      await connect(page);
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "需处理 1", exact: true }).click();
      await page.getByRole("button", { name: "处理问题 ghost-provider/policy-only-model", exact: true }).click();
      await page.getByRole("button", { name: "本问题不再提醒", exact: true }).click();
      await expect(page.getByRole("button", { name: "需处理 0", exact: true })).toBeVisible();
      const report = await (await page.request.get(`${BASE_URL}/api/model-attention`, { headers: fixtureHeaders })).json();
      savedIssue = report.ignored.find((issue: { ownerId: string }) => issue.ownerId === "ghost-provider/policy-only-model");
      expect(savedIssue).toBeTruthy();
      await page.getByRole("button", { name: "服务商", exact: true }).click();
      await expect(page.getByRole("button", { name: "已忽略 1", exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("button", { name: "已忽略 1", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "已忽略 1", exact: true }).click();
      await page.getByRole("button", { name: "处理问题 ghost-provider/policy-only-model", exact: true }).click();
      await page.getByRole("button", { name: "恢复提醒", exact: true }).click();
      await expect(page.getByRole("button", { name: "需处理 1", exact: true })).toBeVisible();
      expect((await readInventory(page)).policyRules).toEqual(original.policyRules);
    } finally {
      if (savedIssue) await page.request.patch(`${BASE_URL}/api/model-attention/decision`, { headers: fixtureHeaders, data: { issueId: savedIssue.id, revision: savedIssue.revision, ignored: false } });
    }
  });

  test("Models 页：待处理区段 + 三维 badge + 处理对话框 + body 无横向溢出", async ({ page }, testInfo) => {
    await connect(page);
    await page.getByRole("button", { name: "模型" }).click();
    await expect(page.getByTestId("models-view")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("attention-panel")).toBeVisible();
    await page.getByRole("button", { name: "需处理 1", exact: true }).click();
    await page.getByRole("button", { name: "处理问题 ghost-provider/policy-only-model", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("button", { name: "配置 ghost-provider", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "本问题不再提醒", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "暂不处理", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 2b. 删除 policy 引用与独立 metadata 复选项对话框：通过 Policy 规则视图的 exact 删除入口触达
    //（规则视图是删除 exact 引用的另一个入口，legacy metadata 保留语义）
    await page.getByRole("button", { name: "展开 Policy 规则" }).click();
    const removeRuleButton = page.getByRole("button", { name: "删除规则 ghost-provider/policy-only-model" });
    await removeRuleButton.scrollIntoViewIfNeeded();
    await expectPolicyTableLayout(page, Boolean(testInfo.project.use.isMobile), "ghost-provider/policy-only-model");
    await removeRuleButton.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/确认删除 ghost-provider\/policy-only-model 的 modelPolicy\.allow 精确引用/)).toBeVisible();
    await page.getByRole("button", { name: "暂不处理" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 3. unknown 行无删除建议（探测证据不足 ≠ 不可用）：面板内无「建议删除」类文案
    await expect(page.getByText("建议删除")).toHaveCount(0);

    // 4. body 无横向溢出（桌面 1280 / 移动 390 两个 project 都会跑）
    await expectNoBodyOverflow(page, `models-${testInfo.project.name}`);
    // 其它 DataTable / nav 容器允许横向滚动；Policy 表的更严格验收已在上方单独执行。
    const tableOverflow = await page.evaluate(() => {
      const scrollers = Array.from(document.querySelectorAll(".overflow-x-auto"));
      return scrollers.map((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    });
    // 这里只确认滚动容器存在，不用它替代 Policy 表的 scrollWidth <= clientWidth 验收。
    expect(tableOverflow.length).toBeGreaterThan(0);

    // 5. Policy 规则视图：exact 可删 / wildcard 只读（2b 已展开，避免重复点击）
    await expect(page.getByRole("button", { name: "收起 Policy 规则" })).toBeVisible();
    await expect(page.getByText("ghost-provider/policy-only-model").first()).toBeVisible();
    await expect(page.getByRole("region", { name: "通配规则", exact: true })).toBeVisible();
    if (!testInfo.project.use.isMobile) await expect(page.getByText("通配", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("只读", { exact: true }).first()).toBeVisible();

    // 6. 密钥纪律：探测 fixture 的 authToken 不得出现在 DOM
    await expect(page.locator("body")).not.toContainText(FIXTURE_SECRET);

    // 截图存证（SDD 工作区，不进 Git）
    mkdirSync(SDD_DIR, { recursive: true });
    await page.screenshot({
      path: join(SDD_DIR, `e2e-models-${testInfo.project.name}.png`),
      fullPage: true
    });
  });

  test("Models 页：普通区段三维状态与通配覆盖提示", async ({ page }, testInfo) => {
    await connect(page);
    await page.getByRole("button", { name: "模型" }).click();
    await expect(page.getByTestId("models-view")).toBeVisible({ timeout: 15_000 });

    // 选中 nvidia（导航按钮含「模型数 N」计数，用正则匹配）
    await page.locator("nav").getByRole("button", { name: /^nvidia/ }).click();
    await expect(page.getByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeVisible();
    // wildcard 覆盖的模型行显示「通配覆盖」提示（无逐模型开关）
    await expect(page.getByText("通配覆盖").first()).toBeVisible();
    // 通配覆盖行不渲染普通启停开关（capability 拒绝 → 不渲染）
    await expect(page.getByLabel(/禁用 nvidia\/deepseek-ai\/deepseek-v4-flash/)).toHaveCount(0);

    // runtime-only available 模型（nvidia/vendor/runtime-extra）：可补全到目录
    await expect(page.getByText("nvidia/vendor/runtime-extra")).toBeVisible();
    await expect(page.getByRole("button", { name: /补全到目录 nvidia\/vendor\/runtime-extra/ })).toBeVisible();

    // 目录来源徽章：nvidia 行含「本地配置」（config）与「运行时目录」（runtime-only 行）。
    // 来源列在窄屏隐藏（hidden md:table-cell，低价值列让位给 ID/操作），仅桌面断言
    if (testInfo.project.name === "desktop") {
      await expect(page.getByText("运行时目录", { exact: true }).first()).toBeVisible();
    }

    // 精确策略 badge（切到 minimax-portal 主模型行）
    await page.locator("nav").getByRole("button", { name: /^minimax-portal/ }).click();
    await expect(page.getByText("精确策略", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("当前主模型").first()).toBeVisible();

    // Provider DTO 保留配置中的 DeepSeek，模型行 providerId 为 deepseek；导航不能漏行或显示 0。
    const current = await readInventory(page);
    const deepseekModels = current.models.filter(model => model.providerId.toLowerCase() === "deepseek");
    expect(deepseekModels.length).toBeGreaterThan(0);
    // 其它用例的合法目录写入可能已归一 Provider ID；两种大小写都必须正确匹配模型行。
    const deepseekNav = page.locator("nav").getByRole("button", { name: /^deepseek/i });
    await expect(deepseekNav.getByLabel(`模型数 ${deepseekModels.length}`)).toBeVisible();
    await deepseekNav.click();
    const availableDeepseek = deepseekModels.find(model => model.availability === "available")!;
    expect(availableDeepseek).toBeDefined();
    await expect(page.getByText(availableDeepseek.ref, { exact: true })).toBeVisible();

    await expectNoBodyOverflow(page, `models-normal-${testInfo.project.name}`);
    mkdirSync(SDD_DIR, { recursive: true });
    await page.screenshot({
      path: join(SDD_DIR, `e2e-models-normal-${testInfo.project.name}.png`),
      fullPage: true
    });
  });

  test("Providers 页：插件多 Provider 分组 + 一个插件级开关", async ({ page }, testInfo) => {
    await connect(page);
    await page.getByRole("button", { name: "服务商" }).click();
    await expect(page.getByTestId("providers-view")).toBeVisible({ timeout: 15_000 });

    // 1. 插件分组区段：xiaomi 组头（id + 启用中 Pill + 插件标记）
    const groupSection = page.locator("section[aria-label='插件 Provider']");
    await expect(groupSection).toBeVisible();
    await expect(groupSection.getByRole("heading", { name: "xiaomi", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "展开插件 xiaomi", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "展开插件 xiaomi", exact: true }).click();
    // 2. 同一插件贡献的两个 Provider 在同一组内（绝不能显示成两个独立插件）
    await expect(groupSection.getByText("xiaomi-token-plan", { exact: true })).toBeVisible();
    await expect(groupSection.getByText("xiaomi", { exact: true }).first()).toBeVisible();
    // 3. 组内只有一个插件级开关（aria-label 指向插件 id）
    await expect(page.getByLabel(/停用插件 xiaomi/)).toHaveCount(1);

    // 4. 开关切换 → 确认框列出两个 Provider 与 speech 能力影响
    await page.getByLabel(/停用插件 xiaomi/).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/^Provider：/)).toContainText("xiaomi-token-plan");
    await expect(dialog.getByText(/语音（speech）/)).toBeVisible();
    // 取消：不在 E2E 里写盘（插件停用是破坏性操作，确认框可达性即为验证目标）
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 5. Provider 行来源 badge：插件目录 / 运行时目录
    await expect(groupSection.getByText("插件目录", { exact: true }).first()).toBeVisible();
    await expect(groupSection.getByText("运行时目录", { exact: true }).first()).toBeVisible();

    // 6. 密钥纪律
    await expect(page.locator("body")).not.toContainText(FIXTURE_SECRET);

    await expectNoBodyOverflow(page, `providers-${testInfo.project.name}`);
    mkdirSync(SDD_DIR, { recursive: true });
    await page.screenshot({
      path: join(SDD_DIR, `e2e-providers-${testInfo.project.name}.png`),
      fullPage: true
    });
  });

  test("unknown 降级：探测失败时页面不白屏、不可用判定不误报", async ({ page }) => {
    await connect(page);
    // 拦截 inventory 端点：模拟探测不完整（provider 抛错 → diagnostics + 全 unknown）
    await page.route("**/api/model-inventory", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const inventory = (await response.json()) as ModelInventory;
      // 全部行降级为 unknown/probe-failed，capability 全关（模拟超时）
      inventory.models = inventory.models.map((model) => ({
        ...model,
        availability: "unknown",
        availabilityReasons: ["probe-failed"],
        capabilities: {
          canTogglePolicy: false,
          canSetPrimary: false,
          canEditCatalogEntry: false,
          canMaterializeConfigModel: false,
          canRemovePolicyExactRef: false
        }
      }));
      inventory.providers = inventory.providers.map(provider => ({
        ...provider, availability: "unknown", availabilityReasons: ["probe-failed"], availableModelCount: 0, unavailableModelCount: 0
      }));
      inventory.policyRules = inventory.policyRules.map(rule => ({ ...rule, removable: false, unavailableModelCount: 0 }));
      inventory.summary = { ...inventory.summary, availableCount: 0, unavailableCount: 0, unknownCount: inventory.models.length };
      inventory.diagnostics = [
        { command: "status", code: "timeout", message: "openclaw models status --json: timed out after 8000ms" }
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(inventory)
      });
    });

    await page.route("**/api/model-attention", async route => { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ pending: [{ id: "runtime:probe", revision: "probe", kind: "probe", ownerType: "runtime", ownerId: "gateway", providerIds: [], refs: [], protectedRefs: [], title: "运行状态尚未确认", detail: "探测超时", canIgnore: false, canDisable: false }], ignored: [] }) }); });
    await page.getByRole("button", { name: "模型" }).click();
    await expect(page.getByTestId("models-view")).toBeVisible();
    await page.getByRole("button", { name: "需处理 1", exact: true }).click();
    await expect(page.getByText("运行状态尚未确认", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^处理问题 / })).toHaveCount(1);
    await expect(page.getByText("不可用", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "展开 Policy 规则" }).click();
    await expect(page.getByRole("button", { name: /^删除规则 / })).toHaveCount(0);
    await expectNoBodyOverflow(page, "models-unknown");
  });

  test("真实停用移出 IM 规则并收起插件，恢复时还原规则", async ({ page }) => {
    const before = await readInventory(page);
    const xiaomi = before.plugins.find(plugin => plugin.id === "xiaomi")!;
    expect(xiaomi.enabled).toBe(true);
    expect(xiaomi.providerIds).toEqual(["xiaomi", "xiaomi-token-plan"]);
    let backupId: string | undefined;
    try {
      await connect(page);
      await page.getByRole("button", { name: "服务商" }).click();
      const groups = page.getByRole("region", { name: "插件 Provider", exact: true });
      await page.getByRole("switch", { name: "停用插件 xiaomi", exact: true }).click();
      const disabledResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/plugins/xiaomi/state" && response.request().method() === "PATCH");
      await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
      const disabled = await disabledResponse;
      expect(disabled.ok()).toBe(true);
      const written = await disabled.json() as PluginStateMutationResult;
      backupId = written.backupId;
      expect(written.runtimeConfirmed).toBe(true);
      await expect(page.getByRole("switch", { name: "启用插件 xiaomi", exact: true })).toHaveCount(0);
      const stopped = await readInventory(page);
      expect(stopped.policyRules.map(rule => rule.value)).toEqual(before.policyRules.map(rule => rule.value).filter(ref => !ref.startsWith("xiaomi/") && !ref.startsWith("xiaomi-token-plan/")));
      for (const providerId of xiaomi.providerIds) {
        expect(stopped.providers.find(provider => provider.providerId === providerId)?.pluginEnabled).toBe(false);
        expect(stopped.models.filter(model => model.providerId === providerId).every(model => !model.needsAttention && !model.pickerVisible)).toBe(true);
      }
      await page.getByRole("tab", { name: /^已停用/ }).click();
      await expect(page.getByRole("switch", { name: "启用插件 xiaomi", exact: true })).toBeVisible();
      // 未启用组只展示插件管理入口，不要求用户逐条处理模型。
      for (const providerId of xiaomi.providerIds) {
        await expect(groups.getByRole("row").filter({ has: page.getByText(providerId, { exact: true }) })).toHaveCount(0);
      }

      await page.getByRole("switch", { name: "启用插件 xiaomi", exact: true }).click();
      const enabledResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/plugins/xiaomi/state" && response.request().method() === "PATCH");
      await page.getByRole("dialog").getByRole("button", { name: "确认", exact: true }).click();
      expect((await enabledResponse).ok()).toBe(true);
      await page.getByRole("tab", { name: "当前使用", exact: true }).click();
      await expect(page.getByRole("switch", { name: "停用插件 xiaomi", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "展开插件 xiaomi", exact: true }).click();
      for (const providerId of xiaomi.providerIds) {
        const row = groups.getByRole("row").filter({ has: page.getByText(providerId, { exact: true }) });
        await expect(row.getByText("可用", { exact: true })).toBeVisible();
      }
      const restored = await readInventory(page);
      expect(restored.policyRules.map(rule => rule.value)).toEqual(before.policyRules.map(rule => rule.value));
      expect(restored.models.find(model => model.ref === "xiaomi/mi-1")?.policyAllowed).toBe(true);
      await expect(page.locator("body")).not.toContainText(FIXTURE_SECRET);
    } finally {
      if (backupId) await restoreFixture(page, backupId);
    }
  });

  test("删除真实悬空 exact 后模型行消失，强制刷新不会回放幽灵模型", async ({ page }) => {
    const ref = "ghost-provider/policy-only-model";
    const before = await readInventory(page);
    const dangling = before.models.find(model => model.ref === ref)!;
    expect(dangling.catalogSources).toEqual([]);
    expect(dangling.capabilities.canRemovePolicyExactRef).toBe(true);
    expect(before.providers.some(provider => provider.providerId === "ghost-provider")).toBe(false);
    let backupId: string | undefined;
    try {
      await connect(page);
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "需处理 1", exact: true }).click();
      await page.getByRole("button", { name: `处理问题 ${ref}`, exact: true }).click();
      const dialog = page.getByRole("dialog");
      // 初始 fixture 无 metadata；不会无端提供额外清理选项。
      await expect(dialog.getByRole("checkbox", { name: /metadata/ })).toHaveCount(0);
      const deletionResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/model-policy/exact-ref" && response.request().method() === "DELETE");
      await dialog.getByRole("button", { name: "不再使用，保留 Key", exact: true }).click();
      const deleted = await deletionResponse;
      expect(deleted.ok()).toBe(true);
      backupId = (await deleted.json() as { backupId: string }).backupId;
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("models-view").getByText(ref, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "刷新探测", exact: true }).click();
      await expect(page.getByText("已重新探测运行时模型状态", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: `处理 ${ref}`, exact: true })).toHaveCount(0);
      const after = await readInventory(page);
      expect(after.models.some(model => model.ref === ref)).toBe(false);
      expect(after.policyRules.some(rule => rule.value === ref)).toBe(false);
      expect(after.providers.some(provider => provider.providerId === "ghost-provider")).toBe(false);
      expect(after.policyRules.map(rule => rule.value)).toEqual(before.policyRules.filter(rule => rule.value !== ref).map(rule => rule.value));
      await expect(page.locator("body")).not.toContainText(FIXTURE_SECRET);
    } finally {
      if (backupId) await restoreFixture(page, backupId);
    }
  });

});
