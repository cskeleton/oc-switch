import { expect, test, type Page, type Route } from "@playwright/test";

const TOKEN = "e2e-test-token";
/** API 地址：隔离配置注入 E2E_API_BASE_URL（默认主配置的 7420） */
const BASE_URL = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:7420";
const FIXTURE_SECRET = "e2e-fixture-secret-NEVER-LEAK";

type DiscoveryStatus =
  | "resolved"
  | "gateway-detected-path-unresolved"
  | "gateway-not-detected"
  | "probe-failed";

interface MockGroup {
  candidateId: string;
  instanceId: string;
  stateDir: string;
  openclawPath: string;
  envPath: string;
  serviceEnvPath: string;
  pid: number;
  confidence?: "confirmed" | "strong" | "inferred";
}

const GROUP_A: MockGroup = {
  candidateId: "launchd:ai.openclaw.gateway:e2e-a",
  instanceId: "launchd:ai.openclaw.gateway",
  stateDir: "/run-a",
  openclawPath: "/run-a/openclaw.json",
  envPath: "/run-a/.env",
  serviceEnvPath: "/run-a/service-env/ai.openclaw.gateway.env",
  pid: 27561,
  confidence: "strong"
};

const GROUP_B: MockGroup = {
  candidateId: "launchd:ai.openclaw.work:e2e-b",
  instanceId: "launchd:ai.openclaw.work",
  stateDir: "/run-b",
  openclawPath: "/run-b/openclaw.json",
  envPath: "/run-b/.env",
  serviceEnvPath: "/run-b/service-env/ai.openclaw.work.env",
  pid: 27562,
  confidence: "confirmed"
};

async function connect(page: Page) {
  await page.goto("/");
  await page.getByLabel("API 地址").fill(BASE_URL);
  await page.getByLabel("Token").fill(TOKEN);
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByTestId("dashboard-view")).toBeVisible({ timeout: 15_000 });
}

function pathSettingsPayload(input: {
  status: DiscoveryStatus;
  groups?: MockGroup[];
  confidence?: "confirmed" | "strong" | "inferred";
  active?: { openclawPath: string; envPath: string; stateDir: string };
}) {
  const groups = input.groups ?? [];
  const active = input.active ?? {
    openclawPath: "/default/openclaw.json",
    envPath: "/default/.env",
    stateDir: "/default"
  };
  return {
    active,
    openclawPaths: [
      {
        path: active.openclawPath,
        source: "openclaw-default",
        label: "OpenClaw 默认路径",
        recommended: false,
        exists: true,
        readable: true,
        writable: true,
        parentWritable: true
      },
      ...groups.map((group) => ({
        path: group.openclawPath,
        source: "running-instance",
        label: "运行中 OpenClaw",
        recommended: true,
        exists: true,
        readable: true,
        writable: true,
        parentWritable: true,
        candidateId: group.candidateId
      }))
    ],
    envPaths: [
      {
        path: active.envPath,
        source: "openclaw-default",
        label: "OpenClaw 默认路径",
        recommended: false,
        exists: true,
        readable: true,
        writable: true,
        parentWritable: true
      },
      ...groups.map((group) => ({
        path: group.envPath,
        source: "running-instance",
        label: "运行中 OpenClaw",
        recommended: true,
        exists: true,
        readable: true,
        writable: true,
        parentWritable: true,
        candidateId: group.candidateId
      }))
    ],
    runtimeDiscovery: {
      status: input.status,
      diagnostics: input.status === "probe-failed" ? ["process-probe-failed"] : [],
      instances: input.status === "gateway-not-detected"
        ? []
        : groups.length > 0
          ? groups.map((group) => ({
            instanceId: group.instanceId,
            pid: group.pid,
            openclawPath: group.openclawPath,
            envPath: group.envPath,
            stateDir: group.stateDir,
            serviceEnvPath: group.serviceEnvPath,
            confidence: group.confidence,
            evidence: ["launchd-plist"]
          }))
          : [{
            instanceId: "pid:1",
            pid: 1,
            ...(input.confidence ? { confidence: input.confidence } : {}),
            evidence: input.confidence === "inferred"
              ? ["default-state-dir"]
              : ["process-cmdline"]
          }]
    },
    runtimeCandidateGroups: groups
  };
}

/** 拦截 Settings 相关 API，避免触碰真实 OpenClaw；密钥字段仅用于断言不泄漏 */
async function mockSettingsApis(
  page: Page,
  options: {
    pathSettings: ReturnType<typeof pathSettingsPayload>;
    onPut?: (body: Record<string, unknown>) => void;
    onApply?: (body: Record<string, unknown>) => void;
  }
) {
  await page.route("**/api/settings/paths", async (route: Route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(options.pathSettings)
      });
      return;
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      options.onPut?.(body);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          paths: {
            openclawPath: body.openclawPath,
            envPath: body.envPath,
            stateDir: "/state"
          }
        })
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/settings", async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        configPath: options.pathSettings.active.openclawPath,
        envPath: options.pathSettings.active.envPath,
        bindAddress: "127.0.0.1",
        port: 7420,
        backupRetention: 20,
        gatewayRestartCommand: "openclaw gateway restart",
        orphanEnvKeys: []
      })
    });
  });

  await page.route("**/api/env", async (route: Route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      // 故意不把 FIXTURE_SECRET 放进响应；页面 DOM 也不应出现
      body: JSON.stringify({ variables: [], warnings: [] })
    });
  });

  await page.route("**/api/gateway/apply", async (route: Route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    options.onApply?.(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        sync: {
          ok: true,
          syncedKeys: ["NVIDIA_API_KEY"],
          removedKeys: [],
          warnings: [],
          candidateId: body.candidateId,
          targetKind: "launchd",
          targetPath: GROUP_A.serviceEnvPath
        },
        restart: { ok: true, exitCode: 0, message: "Gateway restarted" }
      })
    });
  });
}

test.describe("WebGUI smoke", () => {
  test("dashboard loads and is not blank", async ({ page }) => {
    await connect(page);
    await expect(page.getByText("minimax-portal/MiniMax-M3")).toBeVisible();
    await expect(page.locator("main")).not.toBeEmpty();
  });

  test("记住密码 + 自动登录后重开页面直接进入主页", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("API 地址").fill(BASE_URL);
    await page.getByLabel("Token").fill(TOKEN);
    await page.getByLabel("记住密码").click();
    await page.getByLabel("自动登录").click();
    await expect(page.getByLabel("自动登录")).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "连接" }).click();
    await expect(page.getByTestId("dashboard-view")).toBeVisible({ timeout: 15_000 });

    // 清掉会话态以模拟新开浏览器：此时只能靠 localStorage 里的记住凭据自动登录
    await page.evaluate(() => window.sessionStorage.clear());
    await page.reload();
    await expect(page.getByTestId("dashboard-view")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "连接" })).toHaveCount(0);
  });

  test("未勾记住密码时自动登录开关不可用", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("自动登录")).toBeDisabled();
    await page.getByLabel("记住密码").click();
    await expect(page.getByLabel("自动登录")).toBeEnabled();
    await page.getByLabel("自动登录").click();
    await page.getByLabel("记住密码").click();
    await expect(page.getByLabel("自动登录")).toBeDisabled();
    await expect(page.getByLabel("自动登录")).toHaveAttribute("aria-checked", "false");
  });

  test("providers table visible", async ({ page }, testInfo) => {
    await connect(page);
    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByTestId("providers-view")).toBeVisible();
    await expect(page.getByTestId("providers-view").getByText("nvidia", { exact: true })).toBeVisible();
    // API 类型列在窄屏（sm 以下）按设计隐藏（低价值列让位给 ID/操作），
    // 仅桌面断言其可见
    if (testInfo.project.name === "desktop") {
      await expect(page.getByText("openai-completions").first()).toBeVisible();
    }
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
    // 模型区已改为多行表格；若无行则先添加一行再填带斜杠 id
    if (await page.getByLabel("模型 ID 1").count() === 0) {
      await page.getByLabel("添加模型行").click();
    }
    await page.getByLabel("模型 ID 1").fill("vendor/model-b");
    await page.getByLabel("模型 Alias 1").fill("b");
    await expect(page.getByLabel("模型 ID 1")).toHaveValue("vendor/model-b");
    await page.getByRole("button", { name: "取消" }).click();
    // 已填写内容时会二次确认放弃
    await expect(page.getByText("放弃已填写内容？")).toBeVisible();
    await page.getByRole("button", { name: "确认" }).click();
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

test.describe("Runtime discovery (mocked API)", () => {
  test("four discovery statuses render distinct copy", async ({ page }) => {
    await connect(page);

    const cases: Array<{
      status: DiscoveryStatus;
      groups?: MockGroup[];
      confidence?: "confirmed" | "strong" | "inferred";
      expectText: RegExp;
      amber?: boolean;
    }> = [
      {
        status: "resolved",
        groups: [GROUP_A],
        expectText: /已确认管理源/,
        amber: false
      },
      {
        status: "resolved",
        groups: [{ ...GROUP_A, confidence: "inferred" }],
        confidence: "inferred",
        expectText: /由运行中 Gateway 与默认 state dir 推断/,
        amber: false
      },
      {
        status: "gateway-detected-path-unresolved",
        expectText: /检测到 Gateway，但无法确认其管理源/,
        amber: true
      },
      {
        status: "gateway-not-detected",
        expectText: /未检测到运行中的 Gateway/,
        amber: false
      },
      {
        status: "probe-failed",
        expectText: /运行实例探测失败，当前路径未改变/,
        amber: false
      }
    ];

    for (const item of cases) {
      await page.unroute("**/api/settings/paths").catch(() => undefined);
      await page.unroute("**/api/settings").catch(() => undefined);
      await page.unroute("**/api/env").catch(() => undefined);

      await mockSettingsApis(page, {
        pathSettings: pathSettingsPayload({
          status: item.status,
          groups: item.groups,
          confidence: item.confidence
        })
      });

      await page.getByRole("button", { name: "仪表盘" }).click();
      await page.getByRole("button", { name: "设置" }).click();
      await expect(page.getByTestId("settings-view")).toBeVisible();
      await page.getByRole("tab", { name: "路径" }).click();

      // 状态摘要在路径 Tab 顶部；避免与候选卡内「（已确认管理源）」撞 strict mode
      const statusNode = page.locator("p.mb-4").filter({ hasText: item.expectText });
      await expect(statusNode).toBeVisible();
      const className = await statusNode.getAttribute("class");
      if (item.amber) {
        expect(className ?? "").toMatch(/warning/);
      } else {
        expect(className ?? "").not.toMatch(/warning/);
      }
      await expect(page.locator("body")).not.toContainText(FIXTURE_SECRET);
    }
  });

  test("candidate group selection, read-only service-env, and candidate-aware apply", async ({ page }) => {
    await connect(page);

    const putBodies: Array<Record<string, unknown>> = [];
    const applyBodies: Array<Record<string, unknown>> = [];

    await mockSettingsApis(page, {
      pathSettings: pathSettingsPayload({
        status: "resolved",
        groups: [GROUP_A, GROUP_B]
      }),
      onPut: (body) => putBodies.push(body),
      onApply: (body) => applyBodies.push(body)
    });

    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();

    // 通用 Tab：多实例时须先选候选再 apply
    await expect(page.getByText(/检测到多个运行实例/)).toBeVisible();
    await page.getByRole("button", { name: "同步并重启 Gateway" }).click();
    await expect(page.getByText(/请先选择运行实例/)).toBeVisible();
    expect(applyBodies).toHaveLength(0);

    await page.getByLabel(`Gateway 目标运行实例 ${GROUP_A.candidateId}`).check();
    await page.getByRole("button", { name: "同步并重启 Gateway" }).click();
    await expect.poll(() => applyBodies.length).toBe(1);
    expect(applyBodies[0]?.candidateId).toBe(GROUP_A.candidateId);

    // 路径 Tab：组选择 + 只读 service-env
    await page.getByRole("tab", { name: "路径" }).click();
    await expect(page.locator("p.mb-4").filter({ hasText: "已确认管理源" })).toBeVisible();
    await expect(page.getByText(GROUP_A.serviceEnvPath)).toBeVisible();
    await expect(page.getByText(/Gateway 运行时快照，由 sync 维护，不作为 active \.env/).first()).toBeVisible();

    const envSelect = page.getByLabel(".env 路径");
    await expect(envSelect.locator(`option[value="${GROUP_A.serviceEnvPath}"]`)).toHaveCount(0);
    await expect(envSelect.locator(`option[value="${GROUP_B.serviceEnvPath}"]`)).toHaveCount(0);

    await page.getByLabel(`选择运行实例 ${GROUP_B.candidateId}`).click();
    await page.getByRole("button", { name: "切换路径" }).click();
    await expect.poll(() => putBodies.length).toBe(1);
    expect(putBodies[0]).toMatchObject({
      openclawPath: GROUP_B.openclawPath,
      envPath: GROUP_B.envPath,
      candidateId: GROUP_B.candidateId
    });

    await expect(page.locator("body")).not.toContainText(FIXTURE_SECRET);
  });
});

test.describe("Model metadata suggestions (offline fixtures)", () => {
  test("query → apply → save round-trip; catalog failure still allows manual save", async ({ page }) => {
    await connect(page);
    await page.getByRole("button", { name: "模型" }).click();
    // metadata-e2e Provider：e2e fixture 专供（不被任何 policy wildcard 覆盖——
    // restricted 模式下 wildcard 覆盖的 Provider 删除模型会 fail closed）
    await page.locator("nav").getByRole("button", { name: /^metadata-e2e/ }).click();

    // 1+2. 打开“添加模型”，输入含斜杠的 raw Model ID
    await page.getByRole("button", { name: "添加模型" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Model ID").fill("openai/gpt-5.2");

    // 3. 查询建议；成功后输入框保持为空（不自动填充）
    await page.getByLabel("查询参考参数").click();
    await expect(page.getByTestId("model-metadata-suggestion-card")).toBeVisible();
    await expect(page.getByLabel("原生上下文窗口")).toHaveValue("");
    await expect(page.getByLabel("运行上下文预算")).toHaveValue("");
    await expect(page.getByLabel("最大输出长度")).toHaveValue("");

    // 布局：建议卡不超出视口；保存主操作滚动后始终可达
    const cardBox = await page.getByTestId("model-metadata-suggestion-card").boundingBox();
    const viewport = page.viewportSize();
    expect(cardBox).not.toBeNull();
    if (cardBox && viewport) {
      expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(viewport.width + 1);
    }
    const saveButton = page.getByRole("button", { name: "保存模型" });
    await saveButton.scrollIntoViewIfNeeded();
    await expect(saveButton).toBeVisible();

    // 4. 应用建议 → 完整整数
    await page.getByLabel("应用建议的原生上下文 400000").click();
    await expect(page.getByLabel("原生上下文窗口")).toHaveValue("400000");
    await page.getByLabel("应用建议的最大输出 128000").click();
    await expect(page.getByLabel("最大输出长度")).toHaveValue("128000");

    // 5. 运行预算快捷值（完整整数）并保存
    await page.getByLabel("运行预算快捷值 32K").click();
    await expect(page.getByLabel("运行上下文预算")).toHaveValue("32768");
    await saveButton.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 6. 重新打开编辑，三字段 round-trip 正确
    await page.getByLabel("编辑模型 metadata-e2e/openai/gpt-5.2").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByLabel("原生上下文窗口")).toHaveValue("400000");
    await expect(page.getByLabel("运行上下文预算")).toHaveValue("32768");
    await expect(page.getByLabel("最大输出长度")).toHaveValue("128000");
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // 7. 模拟目录端点 500：查询失败给出提示，手工保存不受阻
    await page.route("**/api/model-metadata/suggestions*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "catalog unavailable" })
      })
    );
    await page.getByRole("button", { name: "添加模型" }).click();
    await page.getByLabel("Model ID").fill("manual-model");
    await page.getByLabel("查询参考参数").click();
    await expect(page.getByRole("alert")).toContainText("查询参考参数失败");
    await expect(page.getByTestId("model-metadata-suggestion-card")).toHaveCount(0);
    await page.getByLabel("原生上下文窗口").fill("12345");
    await page.getByRole("button", { name: "保存模型" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("编辑模型 metadata-e2e/manual-model")).toBeVisible();

    // 清理：删除测试模型，避免 desktop/mobile 两个 project 复用同一 server 时状态串扰
    for (const ref of ["metadata-e2e/manual-model", "metadata-e2e/openai/gpt-5.2"]) {
      await page.getByLabel(`删除模型 ${ref}`).click();
      await expect(page.getByText(`确认删除 ${ref}？此操作将创建备份。`)).toBeVisible();
      await page.getByRole("button", { name: "确认" }).click();
      await expect(page.getByLabel(`编辑模型 ${ref}`)).toHaveCount(0);
    }
  });
});
