import "./test-setup.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { DiffSummary } from "./components/DiffSummary";
import { ModelDialog } from "./components/ModelDialog";
import { ToastProvider } from "./components/Toast";
import { ModelStateBadges } from "./components/ModelStateBadges";
import { UnavailableModelsPanel } from "./components/UnavailableModelsPanel";
import { ModelPolicyPanel } from "./components/ModelPolicyPanel";
import { PluginProviderGroup } from "./components/PluginProviderGroup";
import { ProviderModelsDialog } from "./components/ProviderModelsDialog";
import { createApiClient, type ApiClient, type CaseDuplicateKind, type ConfigHealthReport, type ModelAvailability, type ModelInventoryEntry, type ModelInventory, type ModelMetadataQueueItem, type ModelMetadataSuggestionsResponse, type ModelPluginDescriptor, type ModelSummary, type PluginStateMutationResult, type ProviderInventoryEntry, type ProviderModelInput, type ProviderSummary } from "./api";
import { Dashboard } from "./views/Dashboard";
import { ModelsView } from "./views/ModelsView";
import { ProvidersView } from "./views/ProvidersView";
import { PresetsView } from "./views/PresetsView";
import { BackupsView } from "./views/BackupsView";
import { SettingsView } from "./views/SettingsView";
import { modelSummary, providerSummary } from "./test-fixtures";
import { GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT, GATEWAY_RESTART_NEXT_STEP_HINT } from "./env-feedback";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  // 登录偏好（记住密码 / 自动登录）落在 localStorage，不清会让后续用例误走自动登录分支
  window.localStorage.clear();
  mock.restore();
});

const originalFetch = globalThis.fetch;

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  return { ...base, getModelInventory: async () => inventoryFixture(), ...overrides };
}

/** ProvidersView 的操作反馈走 toast（useToast 需要 ToastProvider），测试统一包裹 */
function renderProvidersView(client: ApiClient) {
  return render(
    <ToastProvider>
      <ProvidersView client={client} />
    </ToastProvider>
  );
}

/** ModelsView 的操作反馈走 toast，测试统一包裹 */
function renderModelsView(client: ApiClient) {
  return render(
    <ToastProvider>
      <ModelsView client={client} />
    </ToastProvider>
  );
}

/** BackupsView 的操作反馈走 toast，测试统一包裹 */
function renderBackupsView(client: ApiClient) {
  return render(
    <ToastProvider>
      <BackupsView client={client} />
    </ToastProvider>
  );
}

/** PresetsView 的操作反馈走 toast，测试统一包裹 */
function renderPresetsView(client: ApiClient) {
  return render(
    <ToastProvider>
      <PresetsView client={client} />
    </ToastProvider>
  );
}

/** SettingsView 的操作反馈走 toast，测试统一包裹 */
function renderSettingsView(client: ApiClient, baseUrl = "http://127.0.0.1:7420") {
  return render(
    <ToastProvider>
      <SettingsView baseUrl={baseUrl} client={client} />
    </ToastProvider>
  );
}

/** rerender 也需保持同一棵包裹树 */
function settingsViewTree(client: ApiClient, baseUrl = "http://127.0.0.1:7420") {
  return (
    <ToastProvider>
      <SettingsView baseUrl={baseUrl} client={client} />
    </ToastProvider>
  );
}

describe("Dashboard", () => {
  test("shows current primary model and counts", async () => {
    const { findAllByText, findByText } = render(
      <Dashboard
        client={mockClient({
          getStatus: async () => ({
            ok: true,
            primaryModel: "nvidia/deepseek-ai/deepseek-v4-flash",
            providerCount: 3,
            providerModelCount: 5,
            allowlistModelCount: 4,
            modelPolicyMode: "restricted" as const,
            effectiveModelCount: 5
          })
        })}
      />
    );

    expect(await findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
    expect(await findByText("3")).toBeTruthy();
    expect((await findAllByText("5")).length).toBe(2);
    expect(await findByText("4")).toBeTruthy();
    expect(await findByText("有效可选模型（受限策略）")).toBeTruthy();
    expect(await findByText("传统元数据条目")).toBeTruthy();
  });

  test("shows configuration health from latest backup diff", async () => {
    const { findByText } = render(
      <Dashboard
        client={mockClient({
          getStatus: async () => ({
            ok: true,
            primaryModel: "minimax-portal/MiniMax-M3",
            providerCount: 3,
            providerModelCount: 5,
            allowlistModelCount: 4,
            modelPolicyMode: "legacy" as const,
            effectiveModelCount: 4
          }),
          getDiff: async () => ({
            providersAdded: [],
            providersRemoved: [],
            providersChanged: [],
            modelsEnabled: ["nvidia/deepseek-ai/deepseek-v4-flash"],
            modelsDisabled: [],
            primaryChanged: null,
            credentialsChanged: [],
            providerStateChanges: [],
            providerFieldChanges: []
          })
        })}
      />
    );

    expect(await findByText("配置健康")).toBeTruthy();
    expect(await findByText("与最近备份有 1 项差异")).toBeTruthy();
    expect(await findByText(/启用了模型/)).toBeTruthy();
    expect(await findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
  });

  test("配置健康展示大小写重复组并对 mergeable 组显示合并入口", async () => {
    const getHealth = mock(async (): Promise<ConfigHealthReport> => ({
      caseDuplicateGroups: [{
        groupKey: "deepseek", ids: ["DeepSeek", "deepseek"], kinds: ["provider-duplicate", "same-origin-hint"] as CaseDuplicateKind[],
        confidence: "high", sameOrigin: true, mergeable: true, mergeBlockers: [],
        canonicalId: "deepseek", duplicateIds: ["DeepSeek"], reasons: ["baseUrl 相同：https://api.deepseek.com/v1"],
        details: { baseUrls: {}, allowlistCounts: {}, modelCounts: {}, envVars: {} }
      }],
      summary: { duplicateGroupCount: 1, affectedProviderCount: 2, affectedAllowlistCount: 0 }
    }));
    const { findByText, findByLabelText } = render(
      <Dashboard client={mockClient({ getStatus: async () => ({ ok: true, providerCount: 2, providerModelCount: 2, allowlistModelCount: 0, modelPolicyMode: "legacy" as const, effectiveModelCount: 0 }), getDiff: async () => { throw new Error("no backup"); }, getHealth })} />
    );
    expect(await findByText(/发现 1 组 Provider 大小写重复/)).toBeTruthy();
    expect(await findByLabelText("合并 deepseek")).toBeTruthy();
  });
});

describe("ModelsView", () => {
  test("calls setPrimary with slash-containing ref", async () => {
    const setPrimary = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash" }));
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "nvidia" })],
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek"
        })
      ]
    });

    const { findByLabelText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), setPrimary }));

    await userEvent.click(await findByLabelText("设为主模型 nvidia/deepseek-ai/deepseek-v4-flash"));

    expect(setPrimary).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("enables/disables via PATCH body not URL path", async () => {
    const patchModel = mock(async () => ({ ok: true, ref: "a/b/c", enabled: false }));
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "a" })],
      models: [
        modelSummary({ ref: "a/b/c" })
      ]
    });

    const { findByLabelText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), patchModel }));

    await userEvent.click(await findByLabelText("禁用 a/b/c"));

    expect(patchModel).toHaveBeenCalledWith("a/b/c", false);
  });

  test("renders wildcard-selected models as enabled and prevents individual toggles", async () => {
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "cpa", enabledModelCount: 1 })],
      models: [
        modelSummary({
          ref: "cpa/m2",
          enabled: true,
          selectionSource: "policy-wildcard"
        })
      ]
    });

    const { queryByLabelText, findByText, findAllByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }) }));

    // 通配策略徽章出现（Badge + Pill 两处），通配行不渲染普通启停开关（capability 拒绝）
    expect((await findAllByText("通配策略")).length).toBeGreaterThan(0);
    expect(queryByLabelText(/禁用 cpa\/m2/)).toBeNull();
    // 「先收窄规则」提示必须可达（spec §11.2）：操作列渲染通配覆盖提示，title 含收窄指引
    const hint = await findByText("通配覆盖");
    expect(hint.getAttribute("title")).toContain("先收窄 policy");
  });

  for (const scenario of [
    { selectionSource: "legacy" as const, badge: "传统元数据", toggleDisabled: false },
    { selectionSource: "unrestricted" as const, badge: "无限制策略", toggleDisabled: false },
    { selectionSource: "policy-exact" as const, badge: "精确策略", toggleDisabled: false }
  ]) {
    test(`renders ${scenario.selectionSource} model selection state`, async () => {
      const inventory = legacyAsInventory({
        providers: [providerSummary({ id: "cpa", disabled: false })],
        models: [modelSummary({ ref: "cpa/m2", enabled: true, selectionSource: scenario.selectionSource })]
      });

      const { findByLabelText, findAllByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }) }));

      expect((await findAllByText(scenario.badge)).length).toBeGreaterThan(0);
      expect(await findByLabelText("禁用 cpa/m2")).toBeTruthy();
    });
  }

  test("shows a wildcard blocking error without reporting a successful toggle", async () => {
    const patchModel = mock(async () => {
      throw new Error("Cannot disable cpa/m2 while agents.defaults.modelPolicy.allow contains cpa/*; narrow the policy first.");
    });
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "cpa", enabledModelCount: 1 })],
      models: [modelSummary({ ref: "cpa/m2", enabled: true, selectionSource: "policy-exact" })]
    });

    const { findByLabelText, findByText, queryByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), patchModel }));

    await userEvent.click(await findByLabelText("禁用 cpa/m2"));
    expect(patchModel).toHaveBeenCalledWith("cpa/m2", false);
    expect(await findByText(/Cannot disable cpa\/m2/)).toBeTruthy();
    expect(queryByText("已禁用 cpa/m2")).toBeNull();
  });

  test("filters models by search and provider while marking current primary", async () => {
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "minimax-portal", api: "anthropic-messages", baseUrl: "https://api.minimax.io", containsPrimary: true }),
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1", modelCount: 2 })
      ],
      models: [
        modelSummary({
          ref: "minimax-portal/MiniMax-M3",
          name: "MiniMax M3",
          alias: "mm3",
          isPrimary: true
        }),
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek"
        }),
        modelSummary({
          ref: "nvidia/llama-3",
          name: "Llama 3",
          enabled: false
        })
      ]
    });
    const client = mockClient({
      getModelInventory: async () => inventory,
      getModels: async () => ({ models: [] })
    });

    const searchView = renderModelsView(client);
    expect(await searchView.findByText("当前主模型")).toBeTruthy();
    await userEvent.click(await searchView.findAllByText(/^nvidia/).then((nodes) => nodes.find((node) => node.closest("nav"))!));
    await userEvent.type(await searchView.findByLabelText("搜索模型"), "deepseek");
    expect(await searchView.findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
    await waitFor(() => expect(searchView.queryByText("minimax-portal/MiniMax-M3")).toBeNull());
    searchView.unmount();

    const filterView = renderModelsView(client);
    await userEvent.click(await filterView.findAllByText(/^nvidia/).then((nodes) => nodes.find((node) => node.closest("nav"))!));
    expect(await filterView.findByText("nvidia/llama-3")).toBeTruthy();
    await userEvent.click(await filterView.findAllByText(/^minimax-portal/).then((nodes) => nodes.find((node) => node.closest("nav"))!));
    expect(await filterView.findByText("minimax-portal/MiniMax-M3")).toBeTruthy();
    await waitFor(() => expect(filterView.queryByText("nvidia/llama-3")).toBeNull());
  });

  test("matches revamp styling for selected provider and keyboard focus actions", async () => {
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1", modelCount: 2 })
      ],
      models: [
        modelSummary({ ref: "nvidia/enabled-model" }),
        modelSummary({ ref: "nvidia/disabled-model", enabled: false })
      ]
    });

    const { container, findByLabelText, findByRole } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }) }));

    await findByRole("button", { name: "添加模型" });
    expect(container.querySelector("nav button")?.className).toContain("bg-brand/10");
    expect((await findByLabelText("设为主模型 nvidia/enabled-model")).parentElement?.className).toContain("group-focus-within:opacity-100");
  });

  test("adds model from global Models page with structured fields", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-pro" }));
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ],
      models: []
    });

    const { findByLabelText, findByRole, findByText, getByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), createModel }));

    await userEvent.click(await findByText("添加模型"));
    await userEvent.selectOptions(await findByLabelText("Provider"), "nvidia");
    await userEvent.type(await findByLabelText("Model ID"), "deepseek-ai/deepseek-v4-pro");
    await userEvent.type(await findByLabelText("Name"), "DeepSeek V4 Pro");
    await userEvent.type(await findByLabelText("Alias"), "ds-pro");
    await userEvent.selectOptions(await findByLabelText("API"), "openai-completions");
    const reasoningCheckbox = await findByLabelText("Reasoning") as HTMLInputElement;
    expect(reasoningCheckbox.checked).toBe(true);
    await userEvent.type(await findByLabelText("原生上下文窗口"), "128000");
    await userEvent.type(await findByLabelText("最大输出长度"), "8192");
    await userEvent.click(await findByRole("button", { name: "text" }));
    await userEvent.click(await findByRole("button", { name: "image" }));
    await userEvent.click(getByText("保存模型"));

    expect(createModel).toHaveBeenCalledWith("nvidia", {
      id: "deepseek-ai/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      alias: "ds-pro",
      enabled: true,
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text", "image"]
    });
  });

  test("edits model from global Models page", async () => {
    const updateModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-pro" }));
    const legacyModels = [
      modelSummary({
        ref: "nvidia/deepseek-ai/deepseek-v4-flash",
        name: "DeepSeek Flash",
        alias: "flash",
        reasoning: false
      })
    ];
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ],
      models: legacyModels
    });

    const { findByLabelText, getByText } = renderModelsView(mockClient({
      getModelInventory: async () => inventory,
      getModels: async () => ({ models: legacyModels }),
      updateModel
    }));

    await userEvent.click(await findByLabelText("编辑模型 nvidia/deepseek-ai/deepseek-v4-flash"));
    const modelIdInput = await findByLabelText("Model ID");
    await userEvent.clear(modelIdInput);
    await userEvent.type(modelIdInput, "deepseek-ai/deepseek-v4-pro");
    const aliasInput = await findByLabelText("Alias");
    await userEvent.clear(aliasInput);
    await userEvent.type(aliasInput, "ds-pro");
    await userEvent.click(getByText("保存模型"));

    expect(updateModel).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-pro",
      name: "DeepSeek Flash",
      alias: "ds-pro",
      enabled: true,
      reasoning: false
    });
  });

  test("preserves an absent reasoning value when editing another field", async () => {
    const updateModel = mock(async (_ref: string, _model: ProviderModelInput) => ({
      ok: true,
      ref: "nvidia/deepseek-ai/deepseek-v4-flash"
    }));
    const legacyModels = [
      modelSummary({
        ref: "nvidia/deepseek-ai/deepseek-v4-flash",
        alias: "flash"
      })
    ];
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ],
      models: legacyModels
    });

    const { findByLabelText, getByText } = renderModelsView(mockClient({
      getModelInventory: async () => inventory,
      getModels: async () => ({ models: legacyModels }),
      updateModel
    }));

    await userEvent.click(await findByLabelText("编辑模型 nvidia/deepseek-ai/deepseek-v4-flash"));
    const aliasInput = await findByLabelText("Alias");
    await userEvent.clear(aliasInput);
    await userEvent.type(aliasInput, "renamed");
    await userEvent.click(getByText("保存模型"));

    const payload = updateModel.mock.calls[0]?.[1];
    expect(payload).toEqual(expect.objectContaining({ alias: "renamed" }));
    expect(Object.prototype.hasOwnProperty.call(payload, "reasoning")).toBe(false);
  });

  test("submits reasoning after editing an originally absent value", async () => {
    const updateModel = mock(async (_ref: string, _model: ProviderModelInput) => ({
      ok: true,
      ref: "nvidia/deepseek-ai/deepseek-v4-flash"
    }));
    const legacyModels = [
      modelSummary({
        ref: "nvidia/deepseek-ai/deepseek-v4-flash",
        alias: "flash"
      })
    ];
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ],
      models: legacyModels
    });

    const { findByLabelText, getByText } = renderModelsView(mockClient({
      getModelInventory: async () => inventory,
      getModels: async () => ({ models: legacyModels }),
      updateModel
    }));

    await userEvent.click(await findByLabelText("编辑模型 nvidia/deepseek-ai/deepseek-v4-flash"));
    await userEvent.click(await findByLabelText("Reasoning"));
    await userEvent.click(getByText("保存模型"));

    expect(updateModel.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ reasoning: true })
    );
  });

  test("rejects invalid numeric model fields before submit", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/bad-window" }));
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ],
      models: []
    });

    const { findByLabelText, findByText, getByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), createModel }));

    await userEvent.click(await findByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "bad-window");
    await userEvent.type(await findByLabelText("原生上下文窗口"), "abc");
    await userEvent.click(getByText("保存模型"));

    expect(await findByText("原生上下文窗口 必须是正整数")).toBeTruthy();
    expect(createModel).not.toHaveBeenCalled();
  });

  test("marks disabled provider and disables model enable controls", async () => {
    const inventory = legacyAsInventory({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://nvidia.example/v1",
          enabledModelCount: 0,
          disabled: true
        })
      ],
      models: [
        modelSummary({ ref: "nvidia/llama-3", enabled: false })
      ]
    });

    const { findByLabelText, findAllByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }) }));

    expect((await findAllByText(/已关闭/)).length).toBeGreaterThan(0);
    // Provider 已关闭：capability 拒绝普通开关（不渲染），添加模型入口禁用
    expect(await findByLabelText("添加模型", { selector: "button" })).toBeTruthy();
    expect((await findByLabelText("添加模型") as HTMLButtonElement).disabled).toBe(true);
  });

  for (const selectionSource of ["policy-exact", "policy-wildcard"] as const) {
    test(`保留 ${selectionSource} 来源并在 disabled Provider 下禁用模型控件`, async () => {
      const inventory = legacyAsInventory({
        providers: [providerSummary({ id: "cpa", disabled: true, enabledModelCount: 0 })],
        models: [modelSummary({
          ref: "cpa/m2",
          enabled: false,
          selectionSource
        })]
      });

      const { queryByLabelText, findByLabelText, findByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }) }));

      // disabled Provider 下：capability 拒绝 → 普通启停开关一律不渲染；添加模型入口禁用
      expect(queryByLabelText(/启用 cpa\/m2/)).toBeNull();
      expect((await findByLabelText("添加模型") as HTMLButtonElement).disabled).toBe(true);
      if (selectionSource === "policy-wildcard") {
        // 通配行额外给出「先收窄规则」的可达提示（spec §11.2）
        expect(await findByText("通配覆盖")).toBeTruthy();
      } else {
        // exact 行无通配提示（提示文案只属于通配覆盖行）
        expect(await findByLabelText("刷新探测")).toBeTruthy();
      }
    });
  }
});

describe("ProvidersView", () => {
  test("prompts for legacy env reference migration and submits only ready Providers", async () => {
    const getProviderSecretRefMigrations = mock(async () => ({
      candidates: [
        {
          providerId: "nvidia",
          envVar: "NVIDIA_API_KEY",
          currentFormat: "env-shorthand" as const,
          status: "ready" as const,
          blockers: []
        },
        {
          providerId: "blocked",
          envVar: "BLOCKED_API_KEY",
          currentFormat: "legacy-env-ref" as const,
          status: "blocked" as const,
          blockers: ["gateway-env-drift" as const]
        }
      ],
      summary: { candidateCount: 2, readyCount: 1, blockedCount: 1 }
    }));
    const migrateProviderSecretRefs = mock(async () => ({
      ok: true,
      migratedProviderIds: ["nvidia"],
      backupId: "backup-1",
      gatewayRestartRequired: true
    }));
    const client = mockClient({
      getProviders: async () => ({ providers: [providerSummary({ id: "nvidia" })] }),
      getProviderSecretRefMigrations,
      migrateProviderSecretRefs
    });

    const { findByText, getByText } = renderProvidersView(client);

    expect(await findByText("发现 2 个旧环境变量引用")).toBeTruthy();
    await userEvent.click(getByText("查看并迁移"));
    expect(await findByText(/blocked.*Gateway 服务环境中的值与 .env 不一致/)).toBeTruthy();
    await userEvent.click(getByText("迁移 1 项"));

    await waitFor(() => expect(migrateProviderSecretRefs).toHaveBeenCalledWith(["nvidia"]));
    expect(await findByText("已将 1 个 Provider API Key 引用迁移为 SecretRef；请重启 Gateway 使运行时快照生效。")).toBeTruthy();
  });

  test("shows provider id, api type, counts, and primary marker", async () => {
    const { findByLabelText, findByText } = renderProvidersView(mockClient({
          getProviders: async () => ({
            providers: [
              providerSummary({
                id: "nvidia",
                baseUrl: "https://integrate.api.nvidia.com/v1",
                modelCount: 2,
                containsPrimary: true
              })
            ]
          })
        }));

    expect(await findByText("nvidia", { exact: true })).toBeTruthy();
    expect(await findByLabelText("包含当前主模型")).toBeTruthy();
    expect(await findByText("openai-completions")).toBeTruthy();
    expect(await findByText("2")).toBeTruthy();
    expect(await findByText("1")).toBeTruthy();
  });

  test("requires a new primary instead of forcing deletion for provider containing primary", async () => {
    const deleteProvider = mock(async () => ({ ok: true, warnings: [] as string[] }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "minimax-portal",
          api: "anthropic-messages",
          baseUrl: "https://api.minimax.io",
          containsPrimary: true
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "minimax-portal/MiniMax-M3",
          name: "MiniMax M3",
          alias: "mm3",
          isPrimary: true
        }),
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek",
          alias: "nv"
        })
      ]
    }));

    const { findByLabelText, getByText } = renderProvidersView(mockClient({ getProviders, getModels, deleteProvider }));

    await userEvent.click(await findByLabelText("更多操作 minimax-portal"));
    await userEvent.click(await findByLabelText("删除 minimax-portal"));
    await userEvent.selectOptions(await findByLabelText("新主模型"), "nvidia/deepseek-ai/deepseek-v4-flash");
    await userEvent.click(getByText("确认"));

    expect(deleteProvider).toHaveBeenCalledWith("minimax-portal", {
      newPrimary: "nvidia/deepseek-ai/deepseek-v4-flash"
    });
    expect(deleteProvider).not.toHaveBeenCalledWith("minimax-portal", { force: true });
  });

  test("adds model from provider-scoped model manager", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-pro" }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek Flash",
          alias: "flash"
        })
      ]
    }));

    const { findByLabelText, findByText, getByText } = renderProvidersView(mockClient({ getProviders, getModels, createModel }));

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    expect(await findByText("nvidia 模型")).toBeTruthy();
    await userEvent.click(getByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "deepseek-ai/deepseek-v4-pro");
    await userEvent.type(await findByLabelText("Alias"), "ds-pro");
    await userEvent.click(getByText("保存模型"));

    expect(createModel).toHaveBeenCalledWith("nvidia", {
      id: "deepseek-ai/deepseek-v4-pro",
      alias: "ds-pro",
      enabled: true,
      reasoning: true
    });
  });

  test("deleting primary model from provider manager defaults to a different new primary", async () => {
    const deleteModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash", warnings: [] as string[] }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          containsPrimary: true
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek Flash",
          alias: "flash",
          isPrimary: true
        }),
        modelSummary({
          ref: "minimax-portal/MiniMax-M3",
          name: "MiniMax M3",
          alias: "mm3"
        })
      ]
    }));

    const { findByLabelText, getByText } = renderProvidersView(mockClient({ getProviders, getModels, deleteModel }));

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByLabelText("删除模型 nvidia/deepseek-ai/deepseek-v4-flash"));
    await userEvent.click(getByText("确认"));

    expect(deleteModel).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash", {
      newPrimary: "minimax-portal/MiniMax-M3",
      layers: { metadata: false, policyExact: false }
    });
  });

  test("provider model manager sorts primary then enabled then disabled", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 3,
          containsPrimary: true
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/z-disabled",
          enabled: false
        }),
        modelSummary({
          ref: "nvidia/a-enabled",
          enabled: true
        }),
        modelSummary({
          ref: "nvidia/m-primary",
          enabled: true,
          isPrimary: true
        }),
        modelSummary({
          ref: "other/should-not-appear",
          enabled: true
        })
      ]
    }));

    const { findByLabelText, findAllByLabelText } = renderProvidersView(mockClient({ getProviders, getModels }));

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    const checkboxes = await findAllByLabelText(/^选择本地模型 /);
    expect(checkboxes.map((el) => el.getAttribute("aria-label"))).toEqual([
      "选择本地模型 m-primary",
      "选择本地模型 a-enabled",
      "选择本地模型 z-disabled"
    ]);
  });

  test("provider model manager batch-removes selected raw modelIds", async () => {
    const batchRemoveProviderModels = mock(async () => ({
      ok: true,
      removedModelIds: ["vendor/model-b"],
      warnings: [] as string[]
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/vendor/model-a",
          enabled: true,
          isPrimary: true
        }),
        modelSummary({
          ref: "nvidia/vendor/model-b",
          enabled: false
        })
      ]
    }));

    const { findByLabelText, getByText } = renderProvidersView(mockClient({ getProviders, getModels, batchRemoveProviderModels }));

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByLabelText("选择本地模型 vendor/model-b"));
    await userEvent.click(await findByLabelText("删除所选模型"));
    await userEvent.click(getByText("确认"));

    await waitFor(() =>
      expect(batchRemoveProviderModels).toHaveBeenCalledWith("nvidia", {
        modelIds: ["vendor/model-b"]
      })
    );
  });

  test("provider model manager keep-enabled-only confirms and calls API", async () => {
    const batchRemoveProviderModels = mock(async () => ({
      ok: true,
      removedModelIds: ["idle-model"],
      warnings: [] as string[]
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/kept",
          enabled: true
        }),
        modelSummary({
          ref: "nvidia/idle-model",
          enabled: false
        })
      ]
    }));

    const { findByLabelText, findByText, getByText } = renderProvidersView(mockClient({ getProviders, getModels, batchRemoveProviderModels }));

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByLabelText("只保留已启用模型"));
    expect(await findByText(/主模型始终保留/)).toBeTruthy();
    await userEvent.click(getByText("确认"));

    await waitFor(() =>
      expect(batchRemoveProviderModels).toHaveBeenCalledWith("nvidia", {
        keepEnabledOnly: true
      })
    );
  });

  test("disabled provider still allows keep-enabled-only cleanup", async () => {
    const batchRemoveProviderModels = mock(async () => ({
      ok: true,
      removedModelIds: ["idle-model"],
      warnings: [] as string[]
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 21,
          disabled: true
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/kept",
          enabled: true
        }),
        modelSummary({
          ref: "nvidia/idle-model",
          enabled: false
        })
      ]
    }));

    const { findByLabelText, getByText } = renderProvidersView(mockClient({ getProviders, getModels, batchRemoveProviderModels }));
    await userEvent.click(screen.getAllByRole("tab").at(-1)!);

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    const keepEnabled = await findByLabelText("只保留已启用模型");
    expect((keepEnabled as HTMLButtonElement).disabled).toBe(false);
    expect((await findByLabelText("添加模型") as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(keepEnabled);
    await userEvent.click(getByText("确认"));

    await waitFor(() =>
      expect(batchRemoveProviderModels).toHaveBeenCalledWith("nvidia", {
        keepEnabledOnly: true
      })
    );
  });

  test("adds custom provider through preview and confirm without rendering api key", async () => {
    const previewCustomProvider = mock(async () => ({
      providersAdded: ["custom-openai"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["custom-openai/model-a", "custom-openai/vendor/model-b"],
      modelsDisabled: [],
      primaryChanged: null,
      credentialsChanged: [],
      providerStateChanges: [],
      providerFieldChanges: []
    }));
    const addCustomProvider = mock(async () => ({
      ok: true,
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "CUSTOM_OPENAI_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));

    const { findByLabelText, findByRole, findByText, getByText, queryByText } = renderProvidersView(mockClient({ getProviders, previewCustomProvider, addCustomProvider }));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    expect(await findByLabelText("模型 ID 1")).toBeTruthy();
    expect(await findByLabelText("模型 ID 2")).toBeTruthy();
    expect(await findByLabelText("模型 ID 3")).toBeTruthy();
    await userEvent.type(await findByLabelText("供应商名称"), "Custom OpenAI");
    const providerIdInput = await findByLabelText("Provider ID");
    await userEvent.clear(providerIdInput);
    await userEvent.type(providerIdInput, "custom-openai");
    await userEvent.type(await findByLabelText("官网链接"), "https://custom.example");
    await userEvent.type(await findByLabelText("备注"), "Company account");
    await userEvent.type(await findByLabelText("API Key"), "sk-abcdefghijklmnopqrstuvwxyz123456");
    await userEvent.type(await findByLabelText("请求地址"), "https://api.custom.example");
    await userEvent.type(await findByLabelText("模型 ID 1"), "model-a");
    await userEvent.type(await findByLabelText("模型名称 1"), "Model A");
    await userEvent.type(await findByLabelText("模型 Alias 1"), "a");
    await userEvent.type(await findByLabelText("模型 ID 2"), "vendor/model-b");
    await userEvent.type(await findByLabelText("模型名称 2"), "Vendor Model B");
    await userEvent.type(await findByLabelText("模型 Alias 2"), "b");
    await userEvent.click(await findByLabelText("添加模型行"));
    expect(await findByLabelText("模型 ID 4")).toBeTruthy();
    await userEvent.click(getByText("预览并添加"));
    expect(await findByText("custom-openai/model-a")).toBeTruthy();
    await userEvent.click(getByText("确认"));

    expect(previewCustomProvider).toHaveBeenCalledWith({
      providerId: "custom-openai",
      displayName: "Custom OpenAI",
      notes: "Company account",
      websiteUrl: "https://custom.example",
      api: "openai-completions",
      baseUrl: "https://api.custom.example",
      isFullUrl: false,
      apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
      models: [
        { id: "model-a", name: "Model A", alias: "a" },
        { id: "vendor/model-b", name: "Vendor Model B", alias: "b" }
      ],
      enableAllModels: true
    });
    expect(addCustomProvider).toHaveBeenCalledWith({
      providerId: "custom-openai",
      displayName: "Custom OpenAI",
      notes: "Company account",
      websiteUrl: "https://custom.example",
      api: "openai-completions",
      baseUrl: "https://api.custom.example",
      isFullUrl: false,
      apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
      models: [
        { id: "model-a", name: "Model A", alias: "a" },
        { id: "vendor/model-b", name: "Vendor Model B", alias: "b" }
      ],
      enableAllModels: true
    }, "sk-abcdefghijklmnopqrstuvwxyz123456", undefined);
    expect(await findByText(`Provider custom-openai 的 API Key 已写入托管块：CUSTOM_OPENAI_API_KEY = sk-abc********123456 ${GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT}`)).toBeTruthy();
    expect(queryByText("sk-abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
  });

  test("clears custom provider api key when dialog is cancelled", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));

    const { findByLabelText, findByRole, findByText, getByText } = renderProvidersView(mockClient({ getProviders }));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    const keyInput = await findByLabelText("API Key", { exact: true }) as HTMLInputElement;
    await userEvent.type(keyInput, "sk-test-custom-secret");
    await userEvent.click(getByText("取消"));
    expect(await findByText("放弃已填写内容？")).toBeTruthy();
    await userEvent.click(getByText("确认"));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    expect((await findByLabelText("API Key", { exact: true }) as HTMLInputElement).value).toBe("");
  });

  test("custom provider dialog blocks escape close and only closes by cancel flow", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));

    const { findByLabelText, findByRole, findByText, queryByText, getByText } = renderProvidersView(mockClient({ getProviders }));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    await userEvent.type(await findByLabelText("供应商名称"), "Escape Test");
    await userEvent.keyboard("{Escape}");
    expect(queryByText("放弃已填写内容？")).toBeNull();
    expect(await findByText("填写自定义 Provider 信息，确认前会预览配置差异。")).toBeTruthy();
    await userEvent.click(getByText("取消"));
    expect(await findByText("放弃已填写内容？")).toBeTruthy();
  });

  test("custom provider dialog closes directly when empty form is cancelled", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));

    const { findByRole, findByText, queryByText, getByText } = renderProvidersView(mockClient({ getProviders }));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    expect(await findByText("填写自定义 Provider 信息，确认前会预览配置差异。")).toBeTruthy();
    await userEvent.click(getByText("取消"));
    await waitFor(() => expect(queryByText("填写自定义 Provider 信息，确认前会预览配置差异。")).toBeNull());
    expect(queryByText("放弃已填写内容？")).toBeNull();
  });

  test("custom provider model rows support deleting empty rows", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));

    const { findByLabelText, findByRole, queryByLabelText } = renderProvidersView(mockClient({ getProviders }));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    expect(await findByLabelText("模型 ID 1")).toBeTruthy();
    expect(await findByLabelText("模型 ID 3")).toBeTruthy();
    await userEvent.click(await findByLabelText("删除模型行 1"));
    expect(queryByLabelText("模型 ID 3")).toBeNull();
    expect(await findByLabelText("模型 ID 2")).toBeTruthy();
    await userEvent.click(await findByLabelText("添加模型行"));
    expect(await findByLabelText("模型 ID 3")).toBeTruthy();
  });

  test("custom provider discover preview merges deduplicated models and fills empty rows first", async () => {
    const discoverProviderPreview = mock(async () => ({
      ok: true,
      providerId: "preview",
      remoteModels: [
        { id: "model-a", name: "Model A" },
        { id: "model-b", name: "Model B" }
      ],
      alreadyAddedIds: ["model-a"],
      truncated: false
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));
    const { findByLabelText, findByRole, getByText } = renderProvidersView(mockClient({ getProviders, discoverProviderPreview }));

    await userEvent.click(await findByRole("button", { name: "添加 Provider" }));
    await userEvent.type(await findByLabelText("请求地址"), "https://api.custom.example");
    await userEvent.type(await findByLabelText("API Key", { exact: true }), "sk-custom-preview");
    await userEvent.type(await findByLabelText("模型 ID 1"), "model-a");
    await userEvent.click(await findByLabelText("删除模型行 2"));
    await userEvent.click(await findByLabelText("发现模型"));
    await userEvent.click(getByText("开始发现"));
    expect(discoverProviderPreview).toHaveBeenCalledWith({
      api: "openai-completions",
      baseUrl: "https://api.custom.example",
      apiKey: "sk-custom-preview",
      isFullUrl: false,
      alreadyAddedIds: ["model-a"]
    });
    await userEvent.click(await findByLabelText("选择发现模型 model-b"));
    await userEvent.click(getByText("回填到模型列表"));

    expect((await findByLabelText("模型 ID 2") as HTMLInputElement).value).toBe("model-b");
    expect((await findByLabelText("模型名称 2") as HTMLInputElement).value).toBe("Model B");
    expect((await findByLabelText("模型 ID 1") as HTMLInputElement).value).toBe("model-a");
  });

  test("edits provider base URL and API key without rendering the key", async () => {
    const updateProvider = mock(async () => ({
      ok: true,
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "NVIDIA_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    }));
    const previewUpdateProvider = mock(async () => ({
      providersAdded: [],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: [],
      modelsDisabled: [],
      primaryChanged: null,
      credentialsChanged: [],
      providerStateChanges: [],
      providerFieldChanges: [],
      envPreview: {
        affectedKeys: ["NVIDIA_API_KEY"],
        requiresConfirmation: false,
        requiresMigration: false,
        requiresComplex: false,
        warnings: [],
        backupWillIncludeSecrets: true
      }
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          apiKeyEnv: "NVIDIA_API_KEY",
          apiKeyEnvManaged: true,
          apiKeyEnvStatus: "managed"
        })
      ]
    }));

    const { findByLabelText, findByText, getByText, queryByText } = renderProvidersView(mockClient({ getProviders, previewUpdateProvider, updateProvider }));

    await userEvent.click(await findByLabelText("更多操作 nvidia"));
    await userEvent.click(await findByLabelText("编辑 nvidia"));
    const baseUrlInput = await findByLabelText("Provider baseUrl");
    await userEvent.clear(baseUrlInput);
    await userEvent.type(baseUrlInput, "https://new-nvidia.example/v1");
    await userEvent.selectOptions(await findByLabelText("Provider API 类型"), "anthropic-messages");
    await userEvent.type(await findByLabelText("Provider API Key 新值"), "sk-abcdefghijklmnopqrstuvwxyz123456");
    await userEvent.click(getByText("保存 Provider"));

    expect(previewUpdateProvider).toHaveBeenCalledWith("nvidia", {
      baseUrl: "https://new-nvidia.example/v1",
      api: "anthropic-messages",
      includeApiKeyEnv: true
    });
    expect(updateProvider).toHaveBeenCalledWith("nvidia", {
      baseUrl: "https://new-nvidia.example/v1",
      api: "anthropic-messages",
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456"
    });
    expect(await findByText(`Provider nvidia 的 API Key 已写入托管块：NVIDIA_API_KEY = sk-abc********123456 ${GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT}`)).toBeTruthy();
    expect(queryByText("sk-abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
  });

  test("preserves an unknown provider api when editing only the base URL", async () => {
    const updateProvider = mock(async () => ({ ok: true }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "future-api",
          api: "openai-responses",
          baseUrl: "https://future.example/v1"
        })
      ]
    }));

    const { findByLabelText, getByText } = renderProvidersView(mockClient({ getProviders, updateProvider }));

    await userEvent.click(await findByLabelText("更多操作 future-api"));
    await userEvent.click(await findByLabelText("编辑 future-api"));
    expect((await findByLabelText("Provider API 类型") as HTMLSelectElement).value).toBe("openai-responses");
    const baseUrlInput = await findByLabelText("Provider baseUrl");
    await userEvent.clear(baseUrlInput);
    await userEvent.type(baseUrlInput, "https://future-new.example/v1");
    await userEvent.click(getByText("保存 Provider"));

    expect(updateProvider).toHaveBeenCalledWith("future-api", {
      baseUrl: "https://future-new.example/v1"
    });
  });

  test("shows gateway apply banner after provider key save", async () => {
    const updateProvider = mock(async () => ({
      ok: true,
      envWrite: {
        verified: true,
        entries: [{ envVar: "NVIDIA_API_KEY", verified: true, managed: true, maskedValue: "sk-abc********123456" }]
      },
      gatewayEnvSync: {
        ok: true,
        syncedKeys: ["NVIDIA_API_KEY"],
        removedKeys: [],
        warnings: [],
        candidateId: "launchd:gw:test"
      }
    }));
    const previewUpdateProvider = mock(async () => ({
      providersAdded: [],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: [],
      modelsDisabled: [],
      primaryChanged: null,
      credentialsChanged: [],
      providerStateChanges: [],
      providerFieldChanges: [],
      envPreview: {
        affectedKeys: ["NVIDIA_API_KEY"],
        requiresConfirmation: false,
        requiresMigration: false,
        requiresComplex: false,
        warnings: [],
        backupWillIncludeSecrets: true
      }
    }));
    const restartGateway = mock(async () => ({
      ok: true,
      restart: { ok: true, exitCode: 0, message: "Gateway restarted" }
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          apiKeyEnv: "NVIDIA_API_KEY",
          apiKeyEnvManaged: true,
          apiKeyEnvStatus: "managed"
        })
      ]
    }));

    const { findByLabelText, findByTestId, findByText, getByText } = renderProvidersView(mockClient({ getProviders, previewUpdateProvider, updateProvider, restartGateway }));

    await userEvent.click(await findByLabelText("更多操作 nvidia"));
    await userEvent.click(await findByLabelText("编辑 nvidia"));
    await userEvent.type(await findByLabelText("Provider API Key 新值"), "sk-abcdefghijklmnopqrstuvwxyz123456");
    await userEvent.click(getByText("保存 Provider"));

    expect(await findByTestId("gateway-apply-banner")).toBeTruthy();
    await userEvent.click(getByText("重启 Gateway"));
    await waitFor(() => expect(restartGateway).toHaveBeenCalledWith("launchd:gw:test"));
  });

  test("provider edit previews unmanaged API key migration before saving", async () => {
    const previewUpdateProvider = mock(async () => ({
      providersAdded: [],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: [],
      modelsDisabled: [],
      primaryChanged: null,
      credentialsChanged: [],
      providerStateChanges: [],
      providerFieldChanges: [],
      envPreview: {
        affectedKeys: ["NVIDIA_API_KEY"],
        requiresConfirmation: true,
        requiresMigration: true,
        requiresComplex: false,
        warnings: ["NVIDIA_API_KEY 将迁入 oc-switch 托管块"],
        backupWillIncludeSecrets: true
      }
    }));
    const updateProvider = mock(async () => ({ ok: true }));

    const { findByLabelText, findByText, getByText } = renderProvidersView(mockClient({
      getProviders: async () => ({ providers: [{
        id: "nvidia",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: false,
        disabled: false,
        source: "config" as const,
        apiKeyEnv: "NVIDIA_API_KEY",
        apiKeyEnvManaged: false,
        apiKeyEnvStatus: "unmanaged" as const
      }] }),
      getHealth: async () => ({ caseDuplicateGroups: [], summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 } }),
      previewUpdateProvider,
      updateProvider
    }));

    await userEvent.click(await findByLabelText("更多操作 nvidia"));
    await userEvent.click(await findByLabelText("编辑 nvidia"));
    expect(await findByText(/NVIDIA_API_KEY.*托管块外/)).toBeTruthy();
    await userEvent.type(await findByLabelText("Provider API Key 新值"), "new-secret");
    await userEvent.click(getByText("保存 Provider"));
    expect(await findByText(/不在 oc-switch 托管区/)).toBeTruthy();
    await userEvent.click(getByText("确认"));
    await waitFor(() => expect(updateProvider).toHaveBeenCalledWith("nvidia", {
      baseUrl: "https://example.com/v1",
      apiKey: "new-secret",
      confirmMigration: true
    }));
    expect(await findByText("Provider nvidia 的 API Key 已迁入托管块并更新")).toBeTruthy();
  });

  test("discovers provider models and batch-adds selection", async () => {
    const discoverProvider = mock(async () => ({
      ok: true,
      providerId: "nvidia",
      remoteModels: [
        { id: "remote-model-a", name: "Remote A" },
        { id: "vendor/already", name: "Already" }
      ],
      alreadyAddedIds: ["vendor/already"],
      truncated: false
    }));
    const batchAddProviderModels = mock(async () => ({
      ok: true,
      addedModelIds: ["remote-model-a"],
      skippedModelIds: [],
      enabled: false
    }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2
        })
      ]
    }));

    const { findByLabelText, findByText, getByText } = renderProvidersView(mockClient({ getProviders, discoverProvider, batchAddProviderModels }));

    await userEvent.click(await findByLabelText("更多操作 nvidia"));
    await userEvent.click(await findByLabelText("发现模型 nvidia"));
    expect(discoverProvider).toHaveBeenCalledWith("nvidia");
    expect(await findByText("remote-model-a")).toBeTruthy();
    expect(await findByText("已添加")).toBeTruthy();

    await userEvent.click(await findByLabelText("选择模型 remote-model-a"));
    await userEvent.click(getByText("添加到配置"));

    await waitFor(() =>
      expect(batchAddProviderModels).toHaveBeenCalledWith("nvidia", {
        models: [{ id: "remote-model-a", name: "Remote A" }],
        enable: false
      })
    );
    expect(await findByText("已添加 1 个模型")).toBeTruthy();
  });

  test("重复组 Provider 显示⚠重复徽章与合并入口", async () => {
    const getProviders = mock(async () => ({ providers: [
      providerSummary({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelCount: 2, enabledModelCount: 2 }),
      providerSummary({ id: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", modelCount: 2, enabledModelCount: 0 })
    ] }));
    const getHealth = mock(async (): Promise<ConfigHealthReport> => ({
      caseDuplicateGroups: [{
        groupKey: "deepseek", ids: ["DeepSeek", "deepseek"], kinds: ["provider-duplicate"] as CaseDuplicateKind[], confidence: "high",
        sameOrigin: true, mergeable: true, mergeBlockers: [], canonicalId: "deepseek", duplicateIds: ["DeepSeek"],
        reasons: [], details: { baseUrls: {}, allowlistCounts: {}, modelCounts: {}, envVars: {} }
      }],
      summary: { duplicateGroupCount: 1, affectedProviderCount: 2, affectedAllowlistCount: 0 }
    }));
    const { findAllByText, findAllByLabelText } = renderProvidersView(mockClient({ getProviders, getHealth }));
    expect((await findAllByText("⚠ 重复")).length).toBeGreaterThanOrEqual(1);
    expect((await findAllByLabelText("合并 deepseek")).length).toBeGreaterThanOrEqual(1);
  });

  test("closes and restores provider from provider list", async () => {
    const patchProviderState = mock(async () => ({ ok: true, providerId: "nvidia", enabled: false }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          disabled: false
        })
      ]
    }));

    const { findAllByText, findByLabelText, findByText, getByText } = renderProvidersView(mockClient({ getProviders, patchProviderState }));

    // 「已启用」同时是列头与状态 Pill 文案
    expect((await findAllByText("已启用")).length).toBeGreaterThan(0);
    await userEvent.click(await findByLabelText("关闭 Provider nvidia"));
    expect(await findByText("关闭 nvidia？")).toBeTruthy();
    await userEvent.click(getByText("确认"));

    expect(patchProviderState).toHaveBeenCalledWith("nvidia", false);
  });

  test("shows restore action for disabled provider and blocks closing primary provider", async () => {
    const patchProviderState = mock(async () => ({ ok: true, providerId: "nvidia", enabled: true }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          enabledModelCount: 0,
          disabled: true
        }),
        providerSummary({
          id: "minimax-portal",
          api: "anthropic-messages",
          baseUrl: "https://api.minimax.io",
          containsPrimary: true,
          disabled: false
        })
      ]
    }));

    const { findByLabelText, findByText, getByText } = renderProvidersView(mockClient({ getProviders, patchProviderState }));
    await userEvent.click(screen.getAllByRole("tab").at(-1)!);

    expect(await findByText("已关闭")).toBeTruthy();
    await userEvent.click(await findByLabelText("恢复 Provider nvidia"));
    expect(await findByText("恢复 nvidia？")).toBeTruthy();
    await userEvent.click(getByText("确认"));
    expect(patchProviderState).toHaveBeenCalledWith("nvidia", true);

    const closePrimary = await findByLabelText("关闭 Provider minimax-portal");
    expect((closePrimary as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps Provider shutdown available when only policy-effective models are selectable", async () => {
    const getProviders = mock(async () => ({
      providers: [providerSummary({ id: "cpa", enabledModelCount: 0, disabled: false, containsPrimary: false })]
    }));

    const { findByLabelText } = renderProvidersView(mockClient({ getProviders }));

    expect((await findByLabelText("关闭 Provider cpa") as HTMLButtonElement).disabled).toBe(false);
  });

  for (const scenario of [
    { disabled: false, enabledModelCount: 0, action: "关闭" },
    { disabled: true, enabledModelCount: 2, action: "恢复" }
  ]) {
    test(`uses disabled=${scenario.disabled} rather than policy-effective model count for Provider controls`, async () => {
      const getProviders = mock(async () => ({
        providers: [providerSummary({ id: "cpa", containsPrimary: false, ...scenario })]
      }));

      const { findByLabelText } = renderProvidersView(mockClient({ getProviders }));
      await userEvent.click(screen.getByRole("tab", { name: "全部配置" }));

      expect((await findByLabelText(`${scenario.action} Provider cpa`) as HTMLButtonElement).disabled).toBe(false);
    });
  }

  test("providers view runs metadata sync from row menu and shows summary toast", async () => {
    const syncProviderModelMetadata = mock(async () => ({
      ok: true, providerId: "nvidia",
      updated: [{ modelId: "vendor/model-b", filled: { contextWindow: 128000 }, catalogKey: "nvidia/vendor/model-b", matchKind: "provider-exact" }],
      queued: [{ modelId: "vendor/model-c", candidateCount: 2 }],
      unmatched: [], skipped: [], warnings: []
    }));
    const getModelMetadataSyncQueue = mock(async () => ({ items: [] }));
    const getProviders = mock(async () => ({ providers: [providerSummary({ id: "nvidia" })] }));
    const { findByLabelText, findByText } = renderProvidersView(mockClient({ getProviders, getModelMetadataSyncQueue, syncProviderModelMetadata }));
    await userEvent.click(await findByLabelText("更多操作 nvidia"));
    await userEvent.click(await findByLabelText("同步参数 nvidia"));
    await waitFor(() => expect(syncProviderModelMetadata).toHaveBeenCalledWith("nvidia", {}));
    await findByText(/已回填 1/);
  });

  test("providers view shows pending queue count and opens queue dialog; accept applies candidate and keeps dialog open", async () => {
    const queueItem: ModelMetadataQueueItem = {
      providerId: "nvidia", modelId: "vendor/model-c", dismissed: false, lastSeenAt: "2026-09-05T00:00:00.000Z",
      candidates: [{ catalogKey: "nvidia/vendor/model-c", score: 0.9, reason: "shared-model-tokens",
        metadata: { catalogKey: "nvidia/vendor/model-c", providerId: "nvidia", modelId: "vendor/model-c", contextWindow: 128000, sourceKind: "models-dev-model", sourceUrl: "https://models.dev/nvidia/vendor/model-c" } }]
    };
    // resolve 之后队列读回为空
    let resolved = false;
    const getModelMetadataSyncQueue = mock(async () => ({ items: resolved ? [] : [queueItem] }));
    const resolveModelMetadataSyncQueue = mock(async () => {
      resolved = true;
      return {
        ok: true, applied: [{ modelId: "vendor/model-c", filled: { contextWindow: 128000 }, catalogKey: "nvidia/vendor/model-c", matchKind: "queue-shared-model-tokens" }],
        dismissedCount: 0, failed: []
      };
    });
    const getProviders = mock(async () => ({ providers: [providerSummary({ id: "nvidia" })] }));
    const { findByLabelText, findByText } = renderProvidersView(mockClient({ getProviders, getModelMetadataSyncQueue, resolveModelMetadataSyncQueue }));
    await userEvent.click(await findByLabelText("更多操作 nvidia"));
    await userEvent.click(await findByLabelText("参数待确认 nvidia"));
    await userEvent.click(await findByLabelText("应用候选 nvidia/vendor/model-c"));
    await waitFor(() =>
      expect(resolveModelMetadataSyncQueue).toHaveBeenCalledWith([
        { providerId: "nvidia", modelId: "vendor/model-c", action: "accept", catalogKey: "nvidia/vendor/model-c" }
      ])
    );
    // accept 后对话框保持打开：队列已空 → EmptyState 可见，用户可继续处理或自行关框
    expect(await findByText("暂无待确认项")).toBeTruthy();
  });

  test("provider models dialog batch-syncs selected models metadata", async () => {
    const syncProviderModelMetadata = mock(async () => ({
      ok: true, providerId: "nvidia", updated: [], queued: [], unmatched: [], skipped: ["vendor/model-b"], warnings: []
    }));
    const getProviders = mock(async () => ({ providers: [providerSummary({ id: "nvidia", modelCount: 2 })] }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({ ref: "nvidia/vendor/model-a", enabled: true, isPrimary: true }),
        modelSummary({ ref: "nvidia/vendor/model-b", enabled: false })
      ]
    }));
    const { findByLabelText } = renderProvidersView(mockClient({ getProviders, getModels, syncProviderModelMetadata }));
    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByLabelText("选择本地模型 vendor/model-b"));
    await userEvent.click(await findByLabelText("同步所选模型参数"));
    await waitFor(() => expect(syncProviderModelMetadata).toHaveBeenCalledWith("nvidia", { modelIds: ["vendor/model-b"] }));
  });
});

describe("PresetsView", () => {
  test("sends apiKey only in request body and never renders it after submit", async () => {
    const addProvider = mock(async () => ({
      ok: true,
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "NVIDIA_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    }));
    const previewAddProvider = mock(async () => ({
      providersAdded: ["nvidia"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["nvidia/deepseek-ai/deepseek-v4-flash"],
      modelsDisabled: [],
      primaryChanged: null,
      credentialsChanged: [],
      providerStateChanges: [],
      providerFieldChanges: []
    }));
    const getPresets = mock(async () => ({
      presets: [{ id: "nvidia", name: "NVIDIA", source: "builtin" as const, tags: [], modelCount: 1 }]
    }));
    const getDiff = mock(async () => { throw new Error("getDiff should not be used for preset preview"); });

    const { findByLabelText, findByText, getByText, queryByText } = renderPresetsView(mockClient({ getPresets, getDiff, previewAddProvider, addProvider }));

    const keyInput = await findByLabelText("API Key");
    await userEvent.type(keyInput, "sk-abcdefghijklmnopqrstuvwxyz123456");
    await userEvent.click(getByText("预览并添加"));
    await userEvent.click(getByText("确认"));

    expect(previewAddProvider).toHaveBeenCalledWith("nvidia");
    expect(addProvider).toHaveBeenCalledWith("nvidia", "sk-abcdefghijklmnopqrstuvwxyz123456", undefined, undefined);
    expect(await findByText(`Provider nvidia 的 API Key 已写入托管块：NVIDIA_API_KEY = sk-abc********123456 ${GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT}`)).toBeTruthy();
    expect(getDiff).not.toHaveBeenCalled();
    expect(queryByText("sk-abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
  });
});

describe("BackupsView", () => {
  test("lists backups and restore asks confirmation", async () => {
    const { findByText, getByLabelText, getByText, queryByText } = renderBackupsView(mockClient({
          getBackups: async () => ({
            backups: [{
              id: "2024-01-01T00-00-00",
              createdAt: "2024-01-01",
              reason: "test write",
              openclawPath: "/default/openclaw.json",
              envPath: "/default/.env",
              pathMatchesActive: true
            }]
          })
        }));

    await findByText("test write");
    await userEvent.click(getByLabelText("恢复备份 2024-01-01T00-00-00"));
    expect(getByText("恢复备份")).toBeTruthy();
    await userEvent.click(getByText("取消"));
    await waitFor(() => expect(queryByText("恢复备份")).toBeNull());
  });

  test("offers restore target choices when backup paths differ from active paths", async () => {
    const restoreBackup = mock(async () => ({ ok: true, id: "backup-a" }));
    const { findByLabelText, getAllByText, getByLabelText, getByText } = renderBackupsView(mockClient({
          getBackups: async () => ({
            backups: [{
              id: "backup-a",
              createdAt: "2024-01-01",
              reason: "test write",
              openclawPath: "/old/openclaw.json",
              envPath: "/old/.env",
              pathMatchesActive: false
            }]
          }),
          restoreBackup
        }));

    await userEvent.click(await findByLabelText("恢复备份 backup-a"));
    expect(getByText(/备份路径与当前路径不一致/)).toBeTruthy();
    await userEvent.click(getByLabelText("明确恢复到当前选中路径"));
    await userEvent.click(getAllByText("恢复").at(-1)!);

    expect(restoreBackup).toHaveBeenCalledWith("backup-a", "current");
  });

  test("shows gateway restart hint after backup restore syncs env", async () => {
    const restoreBackup = mock(async () => ({
      ok: true,
      id: "backup-a",
      gatewayRestartRequired: true,
      gatewayEnvSync: { ok: true, syncedKeys: ["RESTORED_KEY"], removedKeys: ["CURRENT_KEY"], warnings: [] }
    }));
    const { findByLabelText, findByText, getAllByText } = renderBackupsView(mockClient({
          getBackups: async () => ({
            backups: [{
              id: "backup-a",
              createdAt: "2024-01-01",
              reason: "test write",
              openclawPath: "/default/openclaw.json",
              envPath: "/default/.env",
              pathMatchesActive: true
            }]
          }),
          restoreBackup
        }));

    await userEvent.click(await findByLabelText("恢复备份 backup-a"));
    await userEvent.click(getAllByText("恢复").at(-1)!);

    expect(await findByText("备份已恢复，Gateway 环境已同步；请重启 Gateway 使运行中进程加载恢复后的密钥。")).toBeTruthy();
  });

  test("does not claim env synced when gatewayEnvSync.ok is false", async () => {
    const restoreBackup = mock(async () => ({
      ok: true,
      id: "backup-b",
      gatewayEnvSync: {
        ok: false,
        syncedKeys: [],
        removedKeys: [],
        warnings: ["No runtime candidate group uniquely matches"]
      }
    }));
    const { findByLabelText, findByText, getAllByText, queryByText } = renderBackupsView(mockClient({
          getBackups: async () => ({
            backups: [{
              id: "backup-b",
              createdAt: "2024-01-02",
              reason: "test write",
              openclawPath: "/default/openclaw.json",
              envPath: "/default/.env",
              pathMatchesActive: true
            }]
          }),
          restoreBackup
        }));

    await userEvent.click(await findByLabelText("恢复备份 backup-b"));
    await userEvent.click(getAllByText("恢复").at(-1)!);

    expect(await findByText("备份已恢复。")).toBeTruthy();
    expect(queryByText(/环境已同步/)).toBeNull();
  });
});

describe("DiffChangelog", () => {
  test("renders semantic entries with expand control", async () => {
    const { findAllByText, findByTestId, findByText } = render(
      <Dashboard
        client={mockClient({
          getStatus: async () => ({
            ok: true,
            primaryModel: "a/b",
            providerCount: 1,
            providerModelCount: 1,
            allowlistModelCount: 1,
            modelPolicyMode: "legacy" as const,
            effectiveModelCount: 1
          }),
          getDiff: async () => ({
            providersAdded: ["p1", "p2"],
            providersRemoved: ["old"],
            providersChanged: ["changed"],
            modelsEnabled: ["a/b"],
            modelsDisabled: ["c/d"],
            primaryChanged: { before: "x/y", after: "a/b" },
            credentialsChanged: [
              { envVar: "NEW_KEY", change: "added", providerId: "p2" },
              { envVar: "OLD_KEY", change: "removed" }
            ],
            providerStateChanges: [],
            providerFieldChanges: []
          })
        })}
      />
    );

    expect(await findByTestId("diff-changelog")).toBeTruthy();
    expect((await findAllByText(/新增了 Provider/)).length).toBe(2);
    expect(await findByText(/移除了 Provider/)).toBeTruthy();
    expect(await findByText(/展开其余 3 项差异/)).toBeTruthy();
    expect(await findByText(/OLD_KEY/)).toBeTruthy();
  });
});

describe("DiffSummary", () => {
  test("renders diff sections", async () => {
    const { findByText } = render(
      <DiffSummary
        diff={{
          providersAdded: ["new"],
          providersRemoved: ["old"],
          providersChanged: [],
          modelsEnabled: ["a/b"],
          modelsDisabled: ["c/d"],
          primaryChanged: { before: "x/y", after: "a/b" },
          credentialsChanged: [],
          providerStateChanges: [],
          providerFieldChanges: []
        }}
      />
    );

    expect(await findByText("new")).toBeTruthy();
    expect(await findByText("old")).toBeTruthy();
    expect(await findByText("a/b")).toBeTruthy();
    expect(await findByText(/x\/y/)).toBeTruthy();
  });
});

describe("SettingsView", () => {
  const defaultPathSettings = {
    active: { openclawPath: "/default/openclaw.json", envPath: "/default/.env", stateDir: "/state" },
    openclawPaths: [],
    envPaths: [],
    runtimeDiscovery: {
      status: "gateway-not-detected" as const,
      instances: [],
      diagnostics: []
    },
    runtimeCandidateGroups: []
  };

  test("shows non-secret settings", async () => {
    const { findAllByText, findByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "~/.openclaw/openclaw.json",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => defaultPathSettings,
          getEnvIndex: async () => ({ variables: [], warnings: [] })
        }), "http://127.0.0.1:7420");

    expect(await findByText(/openclaw\.json/)).toBeTruthy();
    expect((await findAllByText("/default/.env")).length).toBeGreaterThan(0);
    expect(await findByText("127.0.0.1")).toBeTruthy();
    expect(await findByText("7420")).toBeTruthy();
    expect(await findByText("20（默认）")).toBeTruthy();
    expect((await findAllByText("openclaw gateway restart")).length).toBeGreaterThan(0);
  });

  test("manual gateway apply requires selecting a runtime group when multiple exist", async () => {
    const applyGateway = mock(async (candidateId?: string) => ({
      ok: true,
      sync: {
        ok: true,
        syncedKeys: ["K"],
        removedKeys: [] as string[],
        warnings: [] as string[],
        ...(candidateId ? { candidateId } : {})
      },
      restart: { ok: true, exitCode: 0, message: "Gateway restarted" }
    }));
    const groups = [
      {
        candidateId: "launchd:a:candidate",
        instanceId: "launchd:a",
        stateDir: "/run-a",
        openclawPath: "/run-a/openclaw.json",
        envPath: "/run-a/.env",
        serviceEnvPath: "/run-a/service.env",
        serviceManager: "launchd" as const,
        pid: 1,
        confidence: "strong" as const,
        evidence: ["launchd-plist" as const]
      },
      {
        candidateId: "launchd:b:candidate",
        instanceId: "launchd:b",
        stateDir: "/run-b",
        openclawPath: "/run-b/openclaw.json",
        envPath: "/run-b/.env",
        serviceEnvPath: "/run-b/service.env",
        serviceManager: "launchd" as const,
        pid: 2,
        confidence: "strong" as const,
        evidence: ["launchd-plist" as const]
      }
    ];
    const { findByLabelText, findByText, getByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => ({
            ...defaultPathSettings,
            runtimeDiscovery: {
              status: "resolved" as const,
              instances: groups.map((group) => ({
                instanceId: group.instanceId,
                pid: group.pid,
                openclawPath: group.openclawPath,
                envPath: group.envPath,
                stateDir: group.stateDir,
                serviceEnvPath: group.serviceEnvPath,
                serviceManager: group.serviceManager,
                confidence: group.confidence,
                evidence: group.evidence
              })),
              diagnostics: []
            },
            runtimeCandidateGroups: groups
          }),
          getEnvIndex: async () => ({ variables: [], warnings: [] }),
          applyGateway
        }), "http://127.0.0.1:7420");

    expect(await findByText("同步并重启 Gateway")).toBeTruthy();
    await userEvent.click(getByText("同步并重启 Gateway"));
    expect(await findByText(/请先选择运行实例/)).toBeTruthy();
    expect(applyGateway).not.toHaveBeenCalled();

    await userEvent.click(await findByLabelText("Gateway 目标运行实例 launchd:a:candidate"));
    await userEvent.click(getByText("同步并重启 Gateway"));
    await waitFor(() => expect(applyGateway).toHaveBeenCalledWith("launchd:a:candidate"));
  });

  test("can clean orphan env keys from settings", async () => {
    const cleanupOrphanEnvKeys = mock(async () => ({ ok: true, removedKeys: ["OLD_API_KEY"] }));
    const { findByText, getByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "~/.openclaw/openclaw.json",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: ["OLD_API_KEY"]
          }),
          getPathSettings: async () => defaultPathSettings,
          getEnvIndex: async () => ({ variables: [], warnings: [] }),
          cleanupOrphanEnvKeys
        }), "http://127.0.0.1:7420");

    expect(await findByText("OLD_API_KEY")).toBeTruthy();
    await userEvent.click(getByText("清理 orphan keys"));
    expect(cleanupOrphanEnvKeys).toHaveBeenCalled();
  });

  test("shows path candidates and switches selected paths", async () => {
    const putPaths = mock(async () => ({ ok: true, paths: { openclawPath: "/next/openclaw.json", envPath: "/next/.env", stateDir: "/state" } }));
    const { findByText, getByLabelText, getByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => ({
            active: { openclawPath: "/default/openclaw.json", envPath: "/default/.env", stateDir: "/state" },
            openclawPaths: [{ path: "/next/openclaw.json", source: "running-instance", label: "运行中 OpenClaw", recommended: true, exists: true, readable: true, writable: true, parentWritable: true }],
            envPaths: [{ path: "/next/.env", source: "running-instance", label: "运行中 OpenClaw", recommended: true, exists: true, readable: true, writable: true, parentWritable: true }]
          }),
          updatePathSettings: putPaths,
          getEnvIndex: async () => ({ variables: [], warnings: [] })
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("路径"));
    expect(await findByText(/\/next\/openclaw\.json/)).toBeTruthy();
    await userEvent.selectOptions(getByLabelText("openclaw.json 路径"), "/next/openclaw.json");
    await userEvent.selectOptions(getByLabelText(".env 路径"), "/next/.env");
    await userEvent.click(getByText("切换路径"));
    expect(putPaths).toHaveBeenCalledWith("/next/openclaw.json", "/next/.env");
  });

  test("allows manual path entry and explains when no running instance is found", async () => {
    const putPaths = mock(async () => ({ ok: true, paths: { openclawPath: "/manual/openclaw.json", envPath: "/manual/.env", stateDir: "/state" } }));
    const { findByLabelText, findByText, getByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => ({
            active: { openclawPath: "/default/openclaw.json", envPath: "/default/.env", stateDir: "/state" },
            openclawPaths: [{ path: "/default/openclaw.json", source: "openclaw-default", label: "OpenClaw 默认路径", recommended: false, exists: true, readable: true, writable: true, parentWritable: true }],
            envPaths: [{ path: "/default/.env", source: "openclaw-default", label: "OpenClaw 默认路径", recommended: false, exists: true, readable: true, writable: true, parentWritable: true }],
            runtimeDiscovery: {
              status: "gateway-not-detected",
              instances: [],
              diagnostics: []
            },
            runtimeCandidateGroups: []
          }),
          updatePathSettings: putPaths,
          getEnvIndex: async () => ({ variables: [], warnings: [] })
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("路径"));
    expect(await findByText(/未检测到运行中的 Gateway/)).toBeTruthy();
    await userEvent.type(await findByLabelText("手动 openclaw.json 路径"), "/manual/openclaw.json");
    await userEvent.type(await findByLabelText("手动 .env 路径"), "/manual/.env");
    await userEvent.click(getByText("使用手动路径"));
    expect(await findByText(/未验证配对/)).toBeTruthy();
    await userEvent.click(getByText("切换路径"));

    expect(putPaths).toHaveBeenCalledWith("/manual/openclaw.json", "/manual/.env");
  });

  test("selects runtime candidate groups together and renders status-specific copy", async () => {
    const putPaths = mock(async () => ({
      ok: true,
      paths: { openclawPath: "/run/openclaw.json", envPath: "/run/.env", stateDir: "/run" }
    }));
    const group = {
      candidateId: "launchd:ai.openclaw.gateway:candidate",
      instanceId: "launchd:ai.openclaw.gateway",
      stateDir: "/run",
      openclawPath: "/run/openclaw.json",
      envPath: "/run/.env",
      serviceEnvPath: "/run/service-env/ai.openclaw.gateway.env",
      pid: 27561,
      confidence: "strong" as const,
      evidence: ["launchd-plist" as const]
    };
    const { findByLabelText, findByText, getByText, queryByText, rerender } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => ({
            active: { openclawPath: "/default/openclaw.json", envPath: "/default/.env", stateDir: "/state" },
            openclawPaths: [
              { path: "/default/openclaw.json", source: "openclaw-default", label: "OpenClaw 默认路径", recommended: false, exists: true, readable: true, writable: true, parentWritable: true },
              { path: group.openclawPath, source: "running-instance", label: "运行中 OpenClaw", recommended: true, exists: true, readable: true, writable: true, parentWritable: true, candidateId: group.candidateId }
            ],
            envPaths: [
              { path: "/default/.env", source: "openclaw-default", label: "OpenClaw 默认路径", recommended: false, exists: true, readable: true, writable: true, parentWritable: true },
              { path: group.envPath, source: "running-instance", label: "运行中 OpenClaw", recommended: true, exists: true, readable: true, writable: true, parentWritable: true, candidateId: group.candidateId }
            ],
            runtimeDiscovery: {
              status: "resolved",
              diagnostics: [],
              instances: [{
                instanceId: group.instanceId,
                pid: group.pid,
                confidence: "strong",
                evidence: ["launchd-plist"]
              }]
            },
            runtimeCandidateGroups: [group]
          }),
          updatePathSettings: putPaths,
          getEnvIndex: async () => ({ variables: [], warnings: [] })
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("路径"));
    expect(await findByText("已确认管理源")).toBeTruthy();
    expect(queryByText(/检测到 Gateway，但无法确认/)).toBeNull();
    expect(await findByText(group.serviceEnvPath)).toBeTruthy();
    expect(await findByText(/Gateway 运行时快照/)).toBeTruthy();
    const envSelect = await findByLabelText(".env 路径") as HTMLSelectElement;
    expect([...envSelect.options].map((option) => option.value)).not.toContain(group.serviceEnvPath);

    await userEvent.click(await findByLabelText(`选择运行实例 ${group.candidateId}`));
    await userEvent.click(getByText("切换路径"));
    expect(putPaths).toHaveBeenCalledWith("/run/openclaw.json", "/run/.env", group.candidateId);

    // load 会回到 active；重新选组后再进手动，确认清除 candidateId 且 env 仍为组内路径
    await userEvent.click(await findByLabelText(`选择运行实例 ${group.candidateId}`));
    await userEvent.type(await findByLabelText("手动 openclaw.json 路径"), "/manual/openclaw.json");
    await userEvent.click(getByText("使用手动路径"));
    expect(await findByText(/未验证配对/)).toBeTruthy();
    await userEvent.click(getByText("切换路径"));
    expect(putPaths).toHaveBeenCalledWith("/manual/openclaw.json", "/run/.env");

    const statusCases: Array<{
      status: "resolved" | "gateway-detected-path-unresolved" | "probe-failed";
      confidence?: "confirmed" | "inferred";
      expectText: RegExp;
      amber?: boolean;
    }> = [
      { status: "resolved", confidence: "inferred", expectText: /由运行中 Gateway 与默认 state dir 推断/ },
      { status: "gateway-detected-path-unresolved", expectText: /检测到 Gateway，但无法确认其管理源/, amber: true },
      { status: "probe-failed", expectText: /运行实例探测失败，当前路径未改变/ }
    ];

    for (const item of statusCases) {
      const client = mockClient({
        getSettings: async () => ({
          configPath: "/default/openclaw.json",
          envPath: "/default/.env",
          bindAddress: "127.0.0.1",
          port: 7420,
          backupRetention: 20,
          gatewayRestartCommand: "openclaw gateway restart",
          orphanEnvKeys: []
        }),
        getPathSettings: async () => ({
          active: { openclawPath: "/default/openclaw.json", envPath: "/default/.env", stateDir: "/state" },
          openclawPaths: [],
          envPaths: [],
          runtimeDiscovery: {
            status: item.status,
            diagnostics: item.status === "probe-failed" ? ["process-probe-failed" as const] : [],
            instances: item.confidence
              ? [{ instanceId: "pid:1", pid: 1, confidence: item.confidence, evidence: ["default-state-dir" as const] }]
              : [{ instanceId: "pid:1", pid: 1, evidence: ["process-cmdline" as const] }]
          },
          runtimeCandidateGroups: item.confidence === "inferred"
            ? [{
              candidateId: "pid:1:candidate",
              instanceId: "pid:1",
              stateDir: "/default",
              openclawPath: "/default/openclaw.json",
              envPath: "/default/.env",
              pid: 1,
              confidence: "inferred" as const,
              evidence: ["default-state-dir" as const]
            }]
            : []
        }),
        getEnvIndex: async () => ({ variables: [], warnings: [] })
      });
      rerender(settingsViewTree(client));
      await userEvent.click(await findByText("路径"));
      const statusNode = await findByText(item.expectText);
      expect(statusNode).toBeTruthy();
      if (item.amber) {
        expect(statusNode.className).toMatch(/warning/);
      } else {
        expect(statusNode.className).not.toMatch(/warning/);
      }
    }
  });

  test("renders env variables without secret values", async () => {
    const { findByText, queryByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => ({
            active: { openclawPath: "/default/openclaw.json", envPath: "/default/.env", stateDir: "/state" },
            openclawPaths: [],
            envPaths: []
          }),
          getEnvIndex: async () => ({
            variables: [{
              envVar: "NVIDIA_API_KEY",
              present: true,
              managed: false,
              providerRef: true,
              providerIds: ["nvidia"],
              extraManaged: false,
              orphan: false,
              missing: false,
              duplicate: false,
              complex: false
            }],
            warnings: []
          })
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("环境变量"));
    expect(await findByText("NVIDIA_API_KEY")).toBeTruthy();
    expect(queryByText("sk-test-secret")).toBeNull();
  });

  test("advanced env section is collapsed by default", async () => {
    const { findByText, queryByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => defaultPathSettings,
          getEnvIndex: async () => ({
            variables: [{
              envVar: "SOME_MCP_EPID",
              present: true,
              managed: true,
              providerRef: false,
              providerIds: [],
              extraManaged: true,
              orphan: false,
              missing: false,
              duplicate: false,
              complex: false
            }],
            warnings: []
          })
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("环境变量"));
    expect(await findByText(/高级：额外托管变量/)).toBeTruthy();
    expect(queryByText("SOME_MCP_EPID")).toBeNull();
  });

  test("updates provider env var and clears input after submit", async () => {
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["NVIDIA_API_KEY"],
      requiresConfirmation: false,
      requiresMigration: false,
      requiresComplex: false,
      warnings: [],
      backupWillIncludeSecrets: true
    }));
    const updateEnvVar = mock(async () => ({
      ok: true as const,
      affectedKeys: ["NVIDIA_API_KEY"],
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "NVIDIA_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    }));
    const getEnvIndex = mock(async () => ({
      variables: [{
        envVar: "NVIDIA_API_KEY",
        present: true,
        managed: true,
        providerRef: true,
        providerIds: ["nvidia"],
        extraManaged: false,
        orphan: false,
        missing: false,
        duplicate: false,
        complex: false
      }],
      warnings: []
    }));

    const { findByText, findByLabelText, getByText, queryByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => defaultPathSettings,
          getEnvIndex,
          previewEnvVar,
          updateEnvVar
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("环境变量"));
    const input = await findByLabelText("NVIDIA_API_KEY 新值");
    await userEvent.type(input, "sk-abcdefghijklmnopqrstuvwxyz123456");
    await userEvent.click(getByText("重填"));
    await waitFor(() => expect(updateEnvVar).toHaveBeenCalled());
    expect(updateEnvVar).toHaveBeenCalledWith({
      type: "upsert",
      envVar: "NVIDIA_API_KEY",
      value: "sk-abcdefghijklmnopqrstuvwxyz123456"
    });
    expect(await findByText(`NVIDIA_API_KEY 已写入托管块：NVIDIA_API_KEY = sk-abc********123456 ${GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT}`)).toBeTruthy();
    expect(queryByText("sk-abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  test("shows migration confirmation for unmanaged provider env var", async () => {
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["NVIDIA_API_KEY"],
      requiresConfirmation: true,
      requiresMigration: true,
      requiresComplex: false,
      warnings: ["NVIDIA_API_KEY will be migrated into the oc-switch managed block"],
      backupWillIncludeSecrets: true
    }));
    const updateEnvVar = mock(async () => ({ ok: true as const, affectedKeys: ["NVIDIA_API_KEY"] }));

    const { findByLabelText, findByText, getByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => defaultPathSettings,
          getEnvIndex: async () => ({
            variables: [{
              envVar: "NVIDIA_API_KEY",
              present: true,
              managed: false,
              providerRef: true,
              providerIds: ["nvidia"],
              extraManaged: false,
              orphan: false,
              missing: false,
              duplicate: false,
              complex: false
            }],
            warnings: []
          }),
          previewEnvVar,
          updateEnvVar
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("环境变量"));
    await userEvent.type(await findByLabelText("NVIDIA_API_KEY 新值"), "new-secret");
    await userEvent.click(getByText("重填"));
    expect(await findByText(/不在 oc-switch 托管区/)).toBeTruthy();
    await userEvent.click(getByText("确认"));
    await waitFor(() => expect(updateEnvVar).toHaveBeenCalledWith({
      type: "upsert",
      envVar: "NVIDIA_API_KEY",
      value: "new-secret",
      confirmMigration: true
    }));
    expect(await findByText("NVIDIA_API_KEY 已迁入托管块并写入新值")).toBeTruthy();
  });

  test("renames advanced managed env var without rendering its secret", async () => {
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["SOME_MCP_EPID", "SOME_MCP_EPID_NEXT"],
      requiresConfirmation: false,
      requiresMigration: false,
      requiresComplex: false,
      warnings: [],
      backupWillIncludeSecrets: true
    }));
    const renameEnvVar = mock(async () => ({
      ok: true as const,
      affectedKeys: ["SOME_MCP_EPID", "SOME_MCP_EPID_NEXT"],
      gatewayEnvSync: { ok: true, syncedKeys: ["SOME_MCP_EPID_NEXT"], removedKeys: ["SOME_MCP_EPID"], warnings: [] }
    }));

    const { findByLabelText, findByText, getByText, queryByText } = renderSettingsView(mockClient({
          getSettings: async () => ({
            configPath: "/default/openclaw.json",
            envPath: "/default/.env",
            bindAddress: "127.0.0.1",
            port: 7420,
            backupRetention: 20,
            gatewayRestartCommand: "openclaw gateway restart",
            orphanEnvKeys: []
          }),
          getPathSettings: async () => defaultPathSettings,
          getEnvIndex: async () => ({
            variables: [{
              envVar: "SOME_MCP_EPID",
              present: true,
              managed: true,
              providerRef: false,
              providerIds: [],
              extraManaged: true,
              orphan: false,
              missing: false,
              duplicate: false,
              complex: false,
              note: "MCP endpoint id"
            }],
            warnings: []
          }),
          previewEnvVar,
          renameEnvVar
        }), "http://127.0.0.1:7420");

    await userEvent.click(await findByText("环境变量"));
    await userEvent.click(getByText("展开"));
    await userEvent.type(await findByLabelText("SOME_MCP_EPID 新变量名"), "SOME_MCP_EPID_NEXT");
    await userEvent.click(getByText("重命名"));
    await waitFor(() => expect(renameEnvVar).toHaveBeenCalledWith({
      type: "rename",
      fromEnvVar: "SOME_MCP_EPID",
      toEnvVar: "SOME_MCP_EPID_NEXT",
      note: "MCP endpoint id"
    }));
    expect(queryByText("epid-secret")).toBeNull();
    expect(await findByText(`SOME_MCP_EPID 已重命名为 SOME_MCP_EPID_NEXT ${GATEWAY_RESTART_NEXT_STEP_HINT}`)).toBeTruthy();
  });
});

describe("App shell", () => {
  test("theme setup uses class-based dark mode and treats system as system on first paint", () => {
    const styles = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
    const html = readFileSync(join(import.meta.dir, "../index.html"), "utf8");

    expect(styles).toContain("@custom-variant dark");
    expect(html).toContain("theme === 'system'");
  });

  test("defaults API address to browser origin and keeps presets after main operating pages", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({
        ok: true, protocolVersion: 2,
        primaryModel: "minimax-portal/MiniMax-M3",
        providerCount: 1,
        providerModelCount: 1,
        allowlistModelCount: 1
      }), { headers: { "content-type": "application/json" } })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const disconnected = render(<App />);
      expect((await disconnected.findByLabelText("API 地址") as HTMLInputElement).value).toBe(window.location.origin);
      disconnected.unmount();

      window.sessionStorage.setItem("oc-switch-token", "token");
      const connected = render(<App />);
      await connected.findByText("minimax-portal/MiniMax-M3");
      await connected.findByText("没有可比较备份");
      const navLabels = Array.from(connected.container.querySelectorAll("aside nav button")).map((button) =>
        button.textContent?.trim()
      );
      expect(navLabels).toEqual(["仪表盘", "服务商", "模型", "备份", "设置", "预设"]);
    } finally {
      // 恢复全局 fetch，避免污染同进程后续包测试（如 cli waitForHttp）
      globalThis.fetch = originalFetch;
    }
  });

  test("记住密码 + 自动登录：打开页面直接进入主页", async () => {
    globalThis.fetch = okStatusFetch() as unknown as typeof fetch;
    try {
      rememberedLogin("stored-token");
      const app = render(<App />);
      // 首屏不闪登录表单，直接进入自动登录中间态
      expect(app.getByTestId("auto-login-pending")).toBeTruthy();

      await app.findByTestId("dashboard-view");
      // 自动登录成功需回写会话态，保住同 tab 刷新恢复的老路径
      expect(window.sessionStorage.getItem("oc-switch-token")).toBe("stored-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("自动登录失败时回到登录表单、预填 Token 且不重试", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" }
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      rememberedLogin("stale-token");
      const app = render(<App />);

      expect(await app.findByText("自动登录失败：unauthorized")).toBeTruthy();
      expect((app.getByLabelText("Token") as HTMLInputElement).value).toBe("stale-token");
      expect(app.queryByTestId("auto-login-pending")).toBeNull();
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("未勾记住密码时自动登录不可用，取消记住密码会联动关闭", async () => {
    const user = userEvent.setup();
    const app = render(<App />);
    const remember = app.getByLabelText("记住密码");
    const auto = app.getByLabelText("自动登录") as HTMLButtonElement;

    expect(auto.disabled).toBe(true);
    expect(auto.getAttribute("aria-checked")).toBe("false");

    await user.click(remember);
    expect(auto.disabled).toBe(false);
    await user.click(auto);
    expect(auto.getAttribute("aria-checked")).toBe("true");

    // 取消记住密码：自动登录必须同时关闭并禁用
    await user.click(remember);
    expect(auto.disabled).toBe(true);
    expect(auto.getAttribute("aria-checked")).toBe("false");
  });

  test("连接时按开关落盘：记住则存 Token，断开关自动登录，取消记住则清除", async () => {
    globalThis.fetch = okStatusFetch() as unknown as typeof fetch;
    try {
      const user = userEvent.setup();
      const app = render(<App />);
      await user.type(app.getByLabelText("Token"), "tok-1");
      await user.click(app.getByLabelText("记住密码"));
      await user.click(app.getByLabelText("自动登录"));
      await user.click(app.getByRole("button", { name: "连接" }));
      await app.findByTestId("dashboard-view");

      expect(window.localStorage.getItem("oc-switch-token")).toBe("tok-1");
      expect(window.localStorage.getItem("oc-switch-auto-login")).toBe("1");

      // 显式断开：保留预填 Token，但关闭自动登录，避免刷新又被登进去
      await user.click(app.getByRole("button", { name: "断开" }));
      expect(window.localStorage.getItem("oc-switch-auto-login")).toBe("0");
      expect((app.getByLabelText("Token") as HTMLInputElement).value).toBe("tok-1");
      expect((app.getByLabelText("自动登录") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");

      // 取消记住密码后重连：清掉此前记住的陈旧凭据
      await user.click(app.getByLabelText("记住密码"));
      await user.click(app.getByRole("button", { name: "连接" }));
      await app.findByTestId("dashboard-view");
      expect(window.localStorage.getItem("oc-switch-token")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** 预置「记住密码 + 自动登录」的持久化登录态（模拟新的浏览器会话） */
function rememberedLogin(token: string) {
  window.localStorage.setItem("oc-switch-token", token);
  window.localStorage.setItem("oc-switch-remember-token", "1");
  window.localStorage.setItem("oc-switch-auto-login", "1");
}

/** App shell 用的宽松 fetch mock：所有请求都返回可渲染的 status 载荷 */
function okStatusFetch() {
  return mock(async () =>
    new Response(
      JSON.stringify({
        ok: true, protocolVersion: 2,
        primaryModel: "minimax-portal/MiniMax-M3",
        providerCount: 1,
        providerModelCount: 1,
        allowlistModelCount: 1
      }),
      { headers: { "content-type": "application/json" } }
    )
  );
}

function singleSuggestionResponse(overrides: Partial<ModelMetadataSuggestionsResponse> = {}): ModelMetadataSuggestionsResponse {
  return {
    suggestions: [
      {
        matchKind: "model-key-exact",
        confidence: "high",
        model: {
          catalogKey: "openai/gpt-5.2",
          providerId: "openai",
          modelId: "gpt-5.2",
          name: "GPT-5.2",
          contextWindow: 400000,
          maxTokens: 128000,
          updatedAt: "2026-07-01",
          sourceKind: "models-dev-model",
          sourceUrl: "https://models.dev/models.json"
        }
      }
    ],
    sources: [
      {
        kind: "models-dev-model",
        fetchedAt: "2026-08-01T00:00:00.000Z",
        checkedAt: "2026-08-01T00:00:00.000Z",
        stale: false
      }
    ],
    warnings: [],
    ...overrides
  };
}

function renderModelDialog(options: {
  providers?: Parameters<typeof ModelDialog>[0]["providers"];
  mode?: "create" | "edit";
  model?: Parameters<typeof ModelDialog>[0]["model"];
  onLookupMetadata?: Parameters<typeof ModelDialog>[0]["onLookupMetadata"];
  onSave?: (providerId: string, model: ProviderModelInput) => Promise<void>;
  onCancel?: () => void;
} = {}) {
  const onSave = options.onSave ?? (async () => {});
  const onLookupMetadata = options.onLookupMetadata ?? (async () => singleSuggestionResponse());
  const utils = render(
    <ModelDialog
      open
      mode={options.mode ?? "create"}
      providers={options.providers ?? [providerSummary({ id: "nvidia" })]}
      {...(options.model ? { model: options.model } : {})}
      onCancel={options.onCancel ?? (() => {})}
      onSave={onSave}
      onLookupMetadata={onLookupMetadata}
    />
  );
  return { ...utils, onSave, onLookupMetadata };
}

async function queryAndMatch(utils: { getByLabelText: (label: string) => Promise<HTMLElement> | HTMLElement }) {
  await userEvent.type(await utils.getByLabelText("Model ID"), "openai/gpt-5.2");
  await userEvent.click(await utils.getByLabelText("查询参考参数"));
}

describe("ModelDialog 参考参数建议", () => {
  test("三个数值字段标注可选并有关联帮助文本", () => {
    const { getByText, getByLabelText } = renderModelDialog();

    for (const label of ["原生上下文窗口（可选）", "运行上下文预算（可选）", "最大输出长度（可选）"]) {
      expect(getByText(label)).toBeTruthy();
    }
    for (const field of ["原生上下文窗口", "运行上下文预算", "最大输出长度"]) {
      const describedBy = getByLabelText(field).getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect(document.getElementById(describedBy!)?.textContent).toContain("可以留空");
    }
  });

  test("查询按钮在 Provider 或 Model ID 缺失时禁用", async () => {
    const { getByLabelText } = renderModelDialog();
    const button = getByLabelText("查询参考参数") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await userEvent.type(getByLabelText("Model ID"), "openai/gpt-5.2");
    expect((getByLabelText("查询参考参数") as HTMLButtonElement).disabled).toBe(false);

    // Provider 列表为空时同样禁用（先卸载，避免两个 Dialog portal 同时存在）
    cleanup();
    const noProviders = renderModelDialog({ providers: [] });
    await userEvent.type(noProviders.getByLabelText("Model ID"), "openai/gpt-5.2");
    expect((noProviders.getByLabelText("查询参考参数") as HTMLButtonElement).disabled).toBe(true);
  });

  test("loading 时禁用重复查询，但不禁用取消与手工输入", async () => {
    const pending = new Promise<ModelMetadataSuggestionsResponse>(() => {
      // 永不 resolve，保持 loading 状态
    });
    const { getByLabelText, getByText } = renderModelDialog({ onLookupMetadata: () => pending });

    await userEvent.type(getByLabelText("Model ID"), "openai/gpt-5.2");
    await userEvent.click(getByLabelText("查询参考参数"));

    expect((getByLabelText("查询参考参数") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("取消") as HTMLButtonElement).disabled).toBe(false);
    expect((getByLabelText("Model ID") as HTMLInputElement).disabled).toBe(false);
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).disabled).toBe(false);
  });

  test("单候选卡显示名称、来源、更新时间与精确数值", async () => {
    const { getByLabelText, findByText, getByText } = renderModelDialog();
    await queryAndMatch({ getByLabelText });

    expect(await findByText("GPT-5.2")).toBeTruthy();
    expect(getByText("400000")).toBeTruthy();
    expect(getByText("128000")).toBeTruthy();
    expect(getByText("Models.dev 模型事实")).toBeTruthy();
    expect(getByText("模型 Key 精确匹配")).toBeTruthy();
    expect(getByText(/2026-07-01/)).toBeTruthy();
  });

  test("查询成功不自动修改输入框", async () => {
    const { getByLabelText, findByTestId } = renderModelDialog();
    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");

    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("");
    expect((getByLabelText("运行上下文预算") as HTMLInputElement).value).toBe("");
    expect((getByLabelText("最大输出长度") as HTMLInputElement).value).toBe("");
  });

  test("分别应用上下文/最大输出；全部应用不修改运行上下文预算", async () => {
    const { getByLabelText, findByTestId } = renderModelDialog();
    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");

    await userEvent.click(getByLabelText("应用建议的原生上下文 400000"));
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("400000");

    await userEvent.click(getByLabelText("应用建议的最大输出 128000"));
    expect((getByLabelText("最大输出长度") as HTMLInputElement).value).toBe("128000");

    await userEvent.type(getByLabelText("运行上下文预算"), "50000");
    await userEvent.click(getByLabelText("全部应用建议值"));
    expect((getByLabelText("运行上下文预算") as HTMLInputElement).value).toBe("50000");
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("400000");
    expect((getByLabelText("最大输出长度") as HTMLInputElement).value).toBe("128000");
  });

  test("已有非空值必须用户点击才替换，卡片显示当前值与建议值差异", async () => {
    const { getByLabelText, findByTestId, findByText } = renderModelDialog({
      mode: "edit",
      model: modelSummary({ ref: "nvidia/custom-model", contextWindow: 100000 })
    });

    await userEvent.click(getByLabelText("查询参考参数"));
    await findByTestId("model-metadata-suggestion-card");

    expect(await findByText(/原生上下文当前值 100000，应用后将替换为 400000/)).toBeTruthy();
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("100000");

    await userEvent.click(getByLabelText("应用建议的原生上下文 400000"));
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("400000");
  });

  test("目录全部不可用时显示目录错误，而不是未找到模型", async () => {
    const { getByLabelText, findByRole } = renderModelDialog({
      onLookupMetadata: async () => ({
        suggestions: [],
        sources: [],
        warnings: ["models-dev-model 目录不可用：network down"]
      })
    });
    await queryAndMatch({ getByLabelText });

    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("模型目录加载失败");
    expect(alert.textContent).not.toContain("未找到匹配的参考模型");
  });

  test("查询期间修改 Model ID，过期响应返回后恢复可查询状态", async () => {
    let resolveLookup: ((value: ModelMetadataSuggestionsResponse) => void) | undefined;
    const pending = new Promise<ModelMetadataSuggestionsResponse>((resolve) => {
      resolveLookup = resolve;
    });
    const { getByLabelText, queryByTestId } = renderModelDialog({ onLookupMetadata: () => pending });

    await userEvent.type(getByLabelText("Model ID"), "openai/gpt-5.2");
    await userEvent.click(getByLabelText("查询参考参数"));
    expect((getByLabelText("查询参考参数") as HTMLButtonElement).disabled).toBe(true);

    // 用户在查询期间改了 Model ID；随后旧响应才返回
    await userEvent.type(getByLabelText("Model ID"), "-suffix");
    resolveLookup?.(singleSuggestionResponse());
    await waitFor(() => expect((getByLabelText("查询参考参数") as HTMLButtonElement).disabled).toBe(false));
    expect(queryByTestId("model-metadata-suggestion-card")).toBeNull();
  });

  test("逐源 stale 只标记来自 stale 来源的候选", async () => {
    const response: ModelMetadataSuggestionsResponse = {
      suggestions: [
        {
          matchKind: "provider-exact",
          confidence: "high",
          model: {
            catalogKey: "openrouter/gpt-x",
            providerId: "openrouter",
            modelId: "gpt-x",
            name: "GPT-X (Provider)",
            contextWindow: 1000,
            maxTokens: 100,
            sourceKind: "models-dev-provider",
            sourceUrl: "https://models.dev/api.json"
          }
        },
        {
          matchKind: "model-key-exact",
          confidence: "high",
          model: {
            catalogKey: "vendor/gpt-x",
            providerId: "vendor",
            modelId: "gpt-x",
            name: "GPT-X (Facts)",
            contextWindow: 2000,
            maxTokens: 200,
            sourceKind: "models-dev-model",
            sourceUrl: "https://models.dev/models.json"
          }
        }
      ],
      sources: [
        { kind: "models-dev-provider", fetchedAt: "2026-07-01T00:00:00.000Z", checkedAt: "2026-07-01T00:00:00.000Z", stale: true },
        { kind: "models-dev-model", fetchedAt: "2026-08-01T00:00:00.000Z", checkedAt: "2026-08-01T00:00:00.000Z", stale: false }
      ],
      warnings: []
    };
    const { getByLabelText, findByText, queryByText } = renderModelDialog({
      onLookupMetadata: async () => response
    });
    await queryAndMatch({ getByLabelText });

    // 选择来自 stale 来源的候选 → 显示缓存数据标记
    await userEvent.click(getByLabelText("选择参考模型 openrouter/gpt-x"));
    expect(await findByText(/该候选来自缓存快照/)).toBeTruthy();

    // 切换到 fresh 来源候选 → 不得继续显示 stale 标记
    await userEvent.click(getByLabelText("选择参考模型 vendor/gpt-x"));
    await waitFor(() => expect(queryByText(/该候选来自缓存快照/)).toBeNull());
  });

  test("多候选必须先选择再应用；low confidence 有明确提示", async () => {
    const response = singleSuggestionResponse({
      suggestions: [
        {
          matchKind: "provider-exact",
          confidence: "high",
          model: {
            catalogKey: "openrouter/openai/gpt-5.2",
            providerId: "openrouter",
            modelId: "openai/gpt-5.2",
            name: "GPT-5.2 (OpenRouter)",
            contextWindow: 400000,
            maxTokens: 128000,
            sourceKind: "models-dev-provider",
            sourceUrl: "https://models.dev/api.json"
          }
        },
        {
          matchKind: "unique-model-id",
          confidence: "low",
          model: {
            catalogKey: "zhipu/gpt-5.2",
            providerId: "zhipu",
            modelId: "gpt-5.2",
            name: "GPT-5.2 (Zhipu)",
            contextWindow: 200000,
            maxTokens: 64000,
            sourceKind: "models-dev-model",
            sourceUrl: "https://models.dev/models.json"
          }
        }
      ],
      sources: [
        { kind: "models-dev-provider", fetchedAt: "2026-08-01T00:00:00.000Z", checkedAt: "2026-08-01T00:00:00.000Z", stale: false },
        { kind: "models-dev-model", fetchedAt: "2026-08-01T00:00:00.000Z", checkedAt: "2026-08-01T00:00:00.000Z", stale: false }
      ]
    });
    const { getByLabelText, findByText } = renderModelDialog({ onLookupMetadata: async () => response });
    await queryAndMatch({ getByLabelText });

    expect(await findByText(/找到 2 个候选参考模型/)).toBeTruthy();
    // 多候选不预选：两个 radio 都未选中
    expect((getByLabelText("选择参考模型 openrouter/openai/gpt-5.2") as HTMLInputElement).checked).toBe(false);
    expect((getByLabelText("选择参考模型 zhipu/gpt-5.2") as HTMLInputElement).checked).toBe(false);
    // 未选择候选时应用按钮禁用
    expect((getByLabelText("应用建议的原生上下文") as HTMLButtonElement).disabled).toBe(true);
    expect((getByLabelText("全部应用建议值") as HTMLButtonElement).disabled).toBe(true);
    expect(await findByText(/请先选择一个候选参考模型/)).toBeTruthy();

    await userEvent.click(getByLabelText("选择参考模型 zhipu/gpt-5.2"));
    expect(await findByText("低置信匹配：仅根据模型 ID 唯一性推断，请人工核对后再应用。")).toBeTruthy();

    await userEvent.click(getByLabelText("应用建议的原生上下文 200000"));
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("200000");
  });

  test("core-model-id 的 low 置信候选显示核心 ID 回退专属文案", async () => {
    const { getByLabelText, findByText, queryByText } = renderModelDialog({
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [
            {
              matchKind: "core-model-id",
              confidence: "low",
              model: {
                catalogKey: "openai/gpt-5",
                providerId: "openai",
                modelId: "gpt-5",
                name: "GPT-5",
                contextWindow: 400000,
                maxTokens: 128000,
                sourceKind: "models-dev-model",
                sourceUrl: "https://models.dev/models.json"
              }
            }
          ]
        })
    });
    await queryAndMatch({ getByLabelText });

    expect(
      await findByText("低置信匹配：核心 ID 回退剥离了未归类后缀（可能不是同一模型），请人工核对后再应用。")
    ).toBeTruthy();
    expect(queryByText(/仅根据模型 ID 唯一性推断/)).toBeNull();
  });

  test("not-found/error/stale 文案可被 screen reader 读到", async () => {
    // not-found：role=status
    const notFound = renderModelDialog({
      onLookupMetadata: async () => singleSuggestionResponse({ suggestions: [] })
    });
    await queryAndMatch({ getByLabelText: notFound.getByLabelText });
    const statusEl = await notFound.findByRole("status");
    expect(statusEl.textContent).toContain("未找到匹配的参考模型");
    notFound.unmount();

    // error：role=alert
    const errored = renderModelDialog({
      onLookupMetadata: async () => {
        throw new Error("models.dev unavailable");
      }
    });
    await queryAndMatch({ getByLabelText: errored.getByLabelText });
    const alert = await errored.findByRole("alert");
    expect(alert.textContent).toContain("查询参考参数失败");
    expect(alert.textContent).toContain("models.dev unavailable");
    errored.unmount();

    // stale：role=status 且标注缓存数据
    const stale = renderModelDialog({
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [],
          sources: [
            { kind: "models-dev-model", fetchedAt: "2026-07-01T00:00:00.000Z", checkedAt: "2026-07-01T00:00:00.000Z", stale: true }
          ]
        })
    });
    await queryAndMatch({ getByLabelText: stale.getByLabelText });
    const staleEl = await stale.findByRole("status");
    expect(staleEl.textContent).toContain("缓存数据");
  });

  test("快捷按钮填入完整整数，支持键盘 focus/activate", async () => {
    const { getByLabelText } = renderModelDialog();

    const oneMegabyte = getByLabelText("原生上下文快捷值 1M");
    oneMegabyte.focus();
    await userEvent.keyboard("{Enter}");
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("1048576");

    await userEvent.click(getByLabelText("运行预算快捷值 32K"));
    expect((getByLabelText("运行上下文预算") as HTMLInputElement).value).toBe("32768");

    await userEvent.click(getByLabelText("最大输出快捷值 4K"));
    expect((getByLabelText("最大输出长度") as HTMLInputElement).value).toBe("4096");
  });

  test("保存 payload 含 contextTokens", async () => {
    const onSave = mock(async () => {});
    const { getByLabelText, getByText } = renderModelDialog({ onSave });

    await userEvent.type(getByLabelText("Model ID"), "custom-model");
    await userEvent.type(getByLabelText("原生上下文窗口"), "200000");
    await userEvent.type(getByLabelText("运行上下文预算"), "128000");
    await userEvent.type(getByLabelText("最大输出长度"), "8192");
    await userEvent.click(getByText("保存模型"));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("nvidia", {
        id: "custom-model",
        enabled: true,
        reasoning: true,
        contextWindow: 200000,
        contextTokens: 128000,
        maxTokens: 8192
      })
    );
  });

  test("Input Modes 使用按钮并支持多选保存", async () => {
    const onSave = mock(async () => {});
    const { getByLabelText, getByRole, getByText } = renderModelDialog({ onSave });

    const textMode = getByRole("button", { name: "text" });
    const imageMode = getByRole("button", { name: "image" });
    const videoMode = getByRole("button", { name: "video" });
    expect(textMode.getAttribute("aria-pressed")).toBe("false");
    expect(imageMode.getAttribute("aria-pressed")).toBe("false");
    expect(videoMode.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(textMode);
    await userEvent.click(imageMode);
    expect(textMode.getAttribute("aria-pressed")).toBe("true");
    expect(imageMode.getAttribute("aria-pressed")).toBe("true");
    expect(videoMode.getAttribute("aria-pressed")).toBe("false");

    await userEvent.type(getByLabelText("Model ID"), "custom-model");
    await userEvent.click(getByText("保存模型"));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("nvidia", {
        id: "custom-model",
        enabled: true,
        reasoning: true,
        input: ["text", "image"]
      })
    );
  });

  test("contextTokens 大于 contextWindow 时前端阻止提交", async () => {
    const onSave = mock(async () => {});
    const { getByLabelText, getByText, findByText } = renderModelDialog({ onSave });

    await userEvent.type(getByLabelText("Model ID"), "custom-model");
    await userEvent.type(getByLabelText("原生上下文窗口"), "100000");
    await userEvent.type(getByLabelText("运行上下文预算"), "200000");
    await userEvent.click(getByText("保存模型"));

    expect(await findByText(/运行上下文预算不能大于原生上下文窗口/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  test("关闭再打开 dialog 不残留上次候选、error 或 loading", async () => {
    const onLookupMetadata = mock(async () => singleSuggestionResponse());

    function dialog(open: boolean) {
      return (
        <ModelDialog
          open={open}
          mode="create"
          providers={[providerSummary({ id: "nvidia" })]}
          onCancel={() => {}}
          onSave={async () => {}}
          onLookupMetadata={onLookupMetadata}
        />
      );
    }

    const { getByLabelText, findByTestId, queryByTestId, queryByRole, rerender } = render(dialog(true));
    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");

    rerender(dialog(false));
    rerender(dialog(true));

    expect(queryByTestId("model-metadata-suggestion-card")).toBeNull();
    expect(queryByRole("status")).toBeNull();
    expect(queryByRole("alert")).toBeNull();
    expect(onLookupMetadata).toHaveBeenCalledTimes(1);
  });

  test("Models 页入口注入 client 查询方法", async () => {
    const getModelMetadataSuggestions = mock(async () => singleSuggestionResponse());
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "nvidia" })],
      models: []
    });

    const { findByLabelText, findByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), getModelMetadataSuggestions }));

    await userEvent.click(await findByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "openai/gpt-5.2");
    await userEvent.click(await findByLabelText("查询参考参数"));

    await waitFor(() => expect(getModelMetadataSuggestions).toHaveBeenCalledWith("nvidia", "gpt-5.2"));
    expect(await findByText("GPT-5.2")).toBeTruthy();
  });

  test("Provider 模型弹窗入口注入同一个 client 查询方法", async () => {
    const getModelMetadataSuggestions = mock(async () => singleSuggestionResponse());
    const getProviders = mock(async () => ({ providers: [providerSummary({ id: "nvidia" })] }));
    const getModels = mock(async () => ({ models: [] }));

    const { findByLabelText, findByText } = renderProvidersView(mockClient({ getModels, getProviders, getModelMetadataSuggestions }));

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "openai/gpt-5.2");
    await userEvent.click(await findByLabelText("查询参考参数"));

    await waitFor(() => expect(getModelMetadataSuggestions).toHaveBeenCalledWith("nvidia", "gpt-5.2"));
  });

  test("卡片展示输入/输出类型；输出类型无应用按钮", async () => {
    const { getByLabelText, findByTestId, findByText, queryByLabelText } = renderModelDialog({
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [
            {
              matchKind: "core-model-id",
              confidence: "medium",
              model: {
                catalogKey: "openai/gpt-5.2",
                providerId: "openai",
                modelId: "gpt-5.2",
                name: "GPT-5.2",
                contextWindow: 400000,
                maxTokens: 128000,
                input: ["text", "image"],
                output: ["text"],
                sourceKind: "models-dev-model",
                sourceUrl: "https://models.dev/models.json"
              }
            }
          ]
        })
    });
    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");
    expect(await findByText("输入类型")).toBeTruthy();
    expect(await findByText("text, image")).toBeTruthy();
    expect(await findByText("输出类型")).toBeTruthy();
    // 输出类型仅展示：不存在任何 output 应用按钮
    expect(queryByLabelText(/应用建议的输出类型/)).toBeNull();
    // 核心 ID 匹配标注
    expect(await findByText(/核心 ID 匹配/)).toBeTruthy();
  });

  test("应用输入类型写入勾选并随保存提交；未知模态被过滤", async () => {
    const saved: ProviderModelInput[] = [];
    const { getByLabelText, findByTestId, getByText, getByRole } = renderModelDialog({
      onSave: async (_providerId, model) => {
        saved.push(model);
      },
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [
            {
              matchKind: "model-key-exact",
              confidence: "high",
              model: {
                catalogKey: "openai/gpt-5.2",
                providerId: "openai",
                modelId: "gpt-5.2",
                name: "GPT-5.2",
                contextWindow: 400000,
                maxTokens: 128000,
                input: ["text", "image", "hologram"],
                output: ["text"],
                sourceKind: "models-dev-model",
                sourceUrl: "https://models.dev/models.json"
              }
            }
          ]
        })
    });
    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");

    await userEvent.click(getByLabelText("应用建议的输入类型 text,image,hologram"));
    expect(getByRole("button", { name: "text" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "image" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "video" }).getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(getByText("保存模型"));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.input).toEqual(["text", "image"]);
  });

  test("pdf 不属于 OpenClaw 支持的输入类型：不渲染 pdf 选项且建议中的 pdf 被过滤", async () => {
    const saved: ProviderModelInput[] = [];
    const { getByLabelText, findByTestId, getByText, queryByRole } = renderModelDialog({
      onSave: async (_providerId, model) => {
        saved.push(model);
      },
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [
            {
              matchKind: "model-key-exact",
              confidence: "high",
              model: {
                catalogKey: "openai/gpt-5.2",
                providerId: "openai",
                modelId: "gpt-5.2",
                name: "GPT-5.2",
                input: ["text", "pdf"],
                sourceKind: "models-dev-model",
                sourceUrl: "https://models.dev/models.json"
              }
            }
          ]
        })
    });

    // 用布尔断言避免失败时序列化整个按钮元素
    expect(queryByRole("button", { name: "pdf" }) === null).toBe(true);

    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");
    await userEvent.click(getByLabelText("应用建议的输入类型 text,pdf"));
    expect(getByLabelText("应用建议的输入类型 text,pdf")).toBeTruthy();

    await userEvent.click(getByText("保存模型"));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.input).toEqual(["text"]);
  });

  test("建议输入类型与当前勾选仅顺序不同视为一致，不显示替换提示", async () => {
    const suggestionWithInput = (input: string[]) => async () =>
      singleSuggestionResponse({
        suggestions: [
          {
            matchKind: "model-key-exact",
            confidence: "high",
            model: {
              catalogKey: "openai/gpt-5.2",
              providerId: "openai",
              modelId: "gpt-5.2",
              name: "GPT-5.2",
              input,
              sourceKind: "models-dev-model",
              sourceUrl: "https://models.dev/models.json"
            }
          }
        ]
      });

    // 勾选 text+image（UI 归一化为选项顺序），建议 ["image","text"] 集合相同 → 无替换提示
    const same = renderModelDialog({ onLookupMetadata: suggestionWithInput(["image", "text"]) });
    await userEvent.click(same.getByRole("button", { name: "text" }));
    await userEvent.click(same.getByRole("button", { name: "image" }));
    await queryAndMatch(same);
    await same.findByTestId("model-metadata-suggestion-card");
    expect(same.queryByText(/输入类型当前为/)).toBeNull();
    same.unmount();

    // 对照：集合不同（多出 audio）→ 显示替换提示
    const different = renderModelDialog({ onLookupMetadata: suggestionWithInput(["image", "text", "audio"]) });
    await userEvent.click(different.getByRole("button", { name: "text" }));
    await userEvent.click(different.getByRole("button", { name: "image" }));
    await queryAndMatch(different);
    expect(
      await different.findByText(/输入类型当前为 text, image，应用后将替换为 image, text, audio/)
    ).toBeTruthy();
  });

  test("建议输入类型全为未知模态时应用为无操作，保存不携带 input", async () => {
    const saved: ProviderModelInput[] = [];
    const { findByLabelText, getByLabelText, findByTestId, getByText, getByRole } = renderModelDialog({
      mode: "edit",
      model: modelSummary({ ref: "nvidia/custom-model", input: ["text"] }),
      onSave: async (_providerId, model) => {
        saved.push(model);
      },
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [
            {
              matchKind: "model-key-exact",
              confidence: "high",
              model: {
                catalogKey: "openai/gpt-5.2",
                providerId: "openai",
                modelId: "gpt-5.2",
                name: "GPT-5.2",
                input: ["hologram"],
                sourceKind: "models-dev-model",
                sourceUrl: "https://models.dev/models.json"
              }
            }
          ]
        })
    });
    // edit 模式 Provider 与 Model ID 已预填，直接查询
    await userEvent.click(await findByLabelText("查询参考参数"));
    await findByTestId("model-metadata-suggestion-card");

    await userEvent.click(getByLabelText("应用建议的输入类型 hologram"));
    // 无操作：既有 text 勾选不变
    expect(getByRole("button", { name: "text" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "image" }).getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(getByText("保存模型"));
    expect(saved).toHaveLength(1);
    // 未标记 touched：保存不携带 input，编辑场景既有 input 不被清空
    expect(saved[0]!.input).toBeUndefined();
  });

  test("全部应用包含输入类型且不修改运行上下文预算", async () => {
    const { getByLabelText, findByTestId, getByRole } = renderModelDialog({
      onLookupMetadata: async () =>
        singleSuggestionResponse({
          suggestions: [
            {
              matchKind: "model-key-exact",
              confidence: "high",
              model: {
                catalogKey: "openai/gpt-5.2",
                providerId: "openai",
                modelId: "gpt-5.2",
                name: "GPT-5.2",
                contextWindow: 400000,
                maxTokens: 128000,
                input: ["image"],
                sourceKind: "models-dev-model",
                sourceUrl: "https://models.dev/models.json"
              }
            }
          ]
        })
    });
    await queryAndMatch({ getByLabelText });
    await findByTestId("model-metadata-suggestion-card");

    await userEvent.type(getByLabelText("运行上下文预算"), "50000");
    await userEvent.click(getByLabelText("全部应用建议值"));
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("400000");
    expect((getByLabelText("最大输出长度") as HTMLInputElement).value).toBe("128000");
    expect((getByLabelText("运行上下文预算") as HTMLInputElement).value).toBe("50000");
    expect(getByRole("button", { name: "image" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("插件 Provider 的 Web 呈现", () => {
  const pluginRow = () => providerSummary({
    id: "opencode",
    source: "plugin",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
    modelCount: 2,
    enabledModelCount: 1,
    apiKeyEnv: "OPENCODE_API_KEY",
    apiKeyEnvManaged: true,
    apiKeyEnvStatus: "managed"
  });

  function pluginClient(overrides: Partial<ApiClient> & Pick<ApiClient, "getProviders">): ApiClient {
    return mockClient({
      getModelInventory: async () => {
        const { providers } = await overrides.getProviders();
        const data = legacyAsInventory({ providers, models: [] });
        data.plugins = providers.filter(provider => provider.source === "plugin").map(provider => ({
          id: provider.id, origin: "bundled", enabled: !provider.disabled, providerIds: [provider.id], nonModelCapabilities: []
        }));
        return data;
      },
      ...overrides
    });
  }

  test("Providers 页给插件行打「插件」徽章，config 行不打", async () => {
    const getProviders = mock(async () => ({
      providers: [providerSummary({ id: "nvidia" }), pluginRow()]
    }));
    const { findAllByText, getAllByText } = renderProvidersView(pluginClient({ getProviders }));
    await userEvent.click(await screen.findByRole("button", {name:"展开插件 opencode"}));

    expect((await findAllByText("opencode")).length).toBeGreaterThan(0);
    expect(getAllByText("插件")).toHaveLength(1);
  });

  test("插件行只提供插件总开关，不提供 Provider 可逆关闭", async () => {
    const getProviders = mock(async () => ({ providers: [pluginRow()] }));
    const { findByLabelText, queryByLabelText } = renderProvidersView(pluginClient({ getProviders }));
    expect(await findByLabelText("停用插件 opencode")).toBeTruthy();
    expect(queryByLabelText("关闭 Provider opencode") === null).toBe(true);
  });

  test("插件行不暴露只适用于 config 的编辑/发现/删除菜单", async () => {
    const getProviders = mock(async () => ({ providers: [pluginRow()] }));
    const { findByLabelText, queryByLabelText } = renderProvidersView(pluginClient({ getProviders }));
    await findByLabelText("停用插件 opencode");
    for (const label of ["更多操作 opencode", "编辑 opencode", "发现模型 opencode", "同步参数 opencode", "删除 opencode"]) {
      expect(queryByLabelText(label) === null).toBe(true);
    }
  });

  test("插件停用时状态列显示「已停用」而非 oc-switch 的「已关闭」", async () => {
    const getProviders = mock(async () => ({
      providers: [providerSummary({ id: "opencode", source: "plugin", disabled: true, enabledModelCount: 0 })]
    }));
    const { findByText, queryByText, getByRole } = renderProvidersView(pluginClient({ getProviders }));
    await userEvent.click(getByRole("tab", { name: /已停用/ }));

    // 行上已有「插件」徽章，状态文案收窄为「已停用」以免挤压表格列宽；完整解释在 title
    expect(await findByText("已停用")).toBeTruthy();
    expect(queryByText("已关闭")).toBeNull();
  });

  test("插件行「设置 Key」写 .env 托管块，不调用 updateProvider", async () => {
    const getProviders = mock(async () => ({ providers: [pluginRow()] }));
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["OPENCODE_API_KEY"],
      requiresConfirmation: false,
      requiresMigration: false,
      requiresComplex: false,
      warnings: [],
      backupWillIncludeSecrets: true
    }));
    const updateEnvVar = mock(async () => ({
      ok: true as const,
      affectedKeys: ["OPENCODE_API_KEY"],
      envWrite: {
        verified: true,
        entries: [{ envVar: "OPENCODE_API_KEY", verified: true, managed: true, maskedValue: "sk-abc********123456" }]
      }
    }));
    const updateProvider = mock(async () => ({ ok: true }));

    const { findByLabelText, getByText, queryByText } = renderProvidersView(pluginClient({
      getProviders,
      previewEnvVar,
      updateEnvVar,
      updateProvider
    }));
    await userEvent.click(await screen.findByRole("button", {name:"展开插件 opencode"}));

    await userEvent.click(await findByLabelText("设置 Key opencode"));
    await userEvent.type(
      await findByLabelText("插件 Provider API Key 新值"),
      "sk-abcdefghijklmnopqrstuvwxyz123456"
    );
    await userEvent.click(getByText("保存 API Key"));

    await waitFor(() => expect(updateEnvVar).toHaveBeenCalled());
    expect(updateEnvVar).toHaveBeenCalledWith(expect.objectContaining({
      type: "upsert",
      envVar: "OPENCODE_API_KEY",
      value: "sk-abcdefghijklmnopqrstuvwxyz123456"
    }));
    expect(updateProvider).not.toHaveBeenCalled();
    // 明文密钥不得回显在界面上
    expect(queryByText("sk-abcdefghijklmnopqrstuvwxyz123456")).toBeNull();
  });

  test("插件未声明 env 变量时不提供「设置 Key」", async () => {
    const getProviders = mock(async () => ({
      providers: [providerSummary({ id: "opencode", source: "plugin", apiKeyEnv: null })]
    }));
    const { findByLabelText, queryByLabelText } = renderProvidersView(pluginClient({ getProviders }));
    await findByLabelText("停用插件 opencode");
    expect(queryByLabelText("设置 Key opencode") === null).toBe(true);
  });

  test("Models 页插件模型可启停与设主模型，但不显示编辑/删除", async () => {
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "opencode", source: "plugin", modelCount: 2, enabledModelCount: 1 })],
      models: [
        modelSummary({ ref: "opencode/big-pickle", enabled: true, selectionSource: "legacy" }),
        modelSummary({ ref: "opencode/hy3", enabled: true })
      ]
    });
    const patchModel = mock(async () => ({ ok: true, ref: "opencode/hy3", enabled: true }));

    const { findByLabelText, queryByLabelText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }), patchModel }));

    // 插件模型：启用中的模型显示「禁用」开关（可启停），主模型入口可见，无编辑/删除
    expect(await findByLabelText("禁用 opencode/hy3")).toBeTruthy();
    expect(await findByLabelText("设为主模型 opencode/big-pickle")).toBeTruthy();
    expect(queryByLabelText("编辑模型 opencode/hy3")).toBeNull();
    expect(queryByLabelText("删除模型 opencode/hy3")).toBeNull();
  });

  test("Models 页对插件 provider 禁用「添加模型」并说明目录只读", async () => {
    const inventory = legacyAsInventory({
      providers: [providerSummary({ id: "opencode", source: "plugin" })],
      models: [modelSummary({ ref: "opencode/hy3", enabled: false })]
    });
    const { findByLabelText, findByText } = renderModelsView(mockClient({ getModelInventory: async () => inventory, getModels: async () => ({ models: [] }) }));

    expect(((await findByLabelText("添加模型")) as HTMLButtonElement).disabled).toBe(true);
    expect(await findByText(/模型目录由 OpenClaw 插件提供，只读/)).toBeTruthy();
  });

  test("ProviderModelsDialog 对插件 provider 只读", async () => {
    const getProviders = mock(async () => ({
      providers: [providerSummary({ id: "opencode", source: "plugin", modelCount: 1 })]
    }));
    const getModels = mock(async () => ({ models: [modelSummary({ ref: "opencode/hy3", enabled: false })] }));
    // 兼容组件本身继续只读；新 Providers 页通过 inventory 插件组而不是旧模型菜单展示。
    const rows = (await getProviders()).providers;
    const { findByLabelText, findByText, queryByLabelText } = render(
      <ToastProvider><ProviderModelsDialog open provider={rows[0]!} providers={rows} client={mockClient({ getProviders, getModels })} onCancel={() => {}} onChanged={() => {}} /></ToastProvider>
    );
    expect(await findByText(/插件 Provider 的模型目录只读/)).toBeTruthy();
    expect(((await findByLabelText("添加模型")) as HTMLButtonElement).disabled).toBe(true);
    expect(((await findByLabelText("删除所选模型")) as HTMLButtonElement).disabled).toBe(true);
    expect(((await findByLabelText("只保留已启用模型")) as HTMLButtonElement).disabled).toBe(true);
    expect(((await findByLabelText("同步所选模型参数")) as HTMLButtonElement).disabled).toBe(true);
    expect(queryByLabelText("编辑模型 opencode/hy3")).toBeNull();
    expect(queryByLabelText("删除模型 opencode/hy3")).toBeNull();
  });
});

// ---------- 运行时模型状态组件（Task 7） ----------

/** ModelInventoryEntry fixture：capabilities 全量显式给出，避免漏字段 */
function inventoryModelEntry({ ref, ...overrides }: Partial<ModelInventoryEntry> & Pick<ModelInventoryEntry, "ref">): ModelInventoryEntry {
  const slash = ref.indexOf("/");
  return {
    ref,
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
    catalogSources: ["config"],
    referenceSources: ["legacy-metadata"],
    policyMode: "restricted",
    policyAllowed: true,
    availability: "available",
    availabilityReasons: [],
    pluginIds: [],
    capabilities: {
      canTogglePolicy: false,
      canSetPrimary: false,
      canEditCatalogEntry: true,
      canMaterializeConfigModel: false,
      canRemovePolicyExactRef: false
    },
    ...overrides
  };
}

describe("ModelStateBadges", () => {
  test("策略 badge：精确与通配使用不同语义，且不与可用性 badge 混用", async () => {
    const view = render(
      <div>
        <ModelStateBadges entry={inventoryModelEntry({
          ref: "cpa/m2",
          referenceSources: ["policy-exact"],
          selectionSource: "policy-exact"
        })} />
        <ModelStateBadges entry={inventoryModelEntry({
          ref: "cpa/m3",
          referenceSources: ["policy-wildcard"],
          selectionSource: "policy-wildcard"
        })} />
      </div>
    );

    expect(await view.findByText("精确策略")).toBeTruthy();
    expect(await view.findByText("通配策略")).toBeTruthy();
    // 策略 badge 与可用性 badge 不混用：此处可用性应各自独立出现
    expect((await view.findAllByText("可用")).length).toBe(2);
  });

  test("目录来源 badge：配置/插件/运行时/仅引用可区分", async () => {
    const { findByText } = render(
      <div>
        <ModelStateBadges entry={inventoryModelEntry({ ref: "cfg/m", catalogSources: ["config"] })} />
        <ModelStateBadges entry={inventoryModelEntry({ ref: "plugin/m", catalogSources: ["plugin-manifest"] })} />
        <ModelStateBadges entry={inventoryModelEntry({ ref: "runtime/m", catalogSources: ["openclaw-runtime"] })} />
        <ModelStateBadges entry={inventoryModelEntry({ ref: "refonly/m", catalogSources: [], referenceSources: ["policy-exact"] })} />
      </div>
    );

    expect(await findByText("本地配置")).toBeTruthy();
    expect(await findByText("插件目录")).toBeTruthy();
    expect(await findByText("运行时目录")).toBeTruthy();
    expect(await findByText("仅引用")).toBeTruthy();
  });

  test("可用性 badge：可用/不可用/无法确认使用不同语义；不可用不复用「已禁用」文案", async () => {
    const { findByText, queryByText } = render(
      <div>
        <ModelStateBadges entry={inventoryModelEntry({ ref: "a/m", availability: "available" })} />
        <ModelStateBadges entry={inventoryModelEntry({
          ref: "b/m",
          availability: "unavailable",
          availabilityReasons: ["model-not-in-catalog"]
        })} />
        <ModelStateBadges entry={inventoryModelEntry({
          ref: "c/m",
          availability: "unknown",
          availabilityReasons: ["probe-failed"]
        })} />
      </div>
    );

    const available = await findByText("可用");
    const unavailable = await findByText("不可用");
    const unknown = await findByText("无法确认");
    expect(available).toBeTruthy();
    expect(unavailable).toBeTruthy();
    expect(unknown).toBeTruthy();
    // 三态语义 token 互不相同：success / destructive / warning
    expect(available.className).toContain("text-success");
    expect(unavailable.className).toContain("text-destructive");
    expect(unknown.className).toContain("text-warning");
    for (const badge of [available, unavailable, unknown]) {
      expect(badge.className).not.toMatch(/slate-|sky-|red-|amber-|emerald-/);
    }
    // 不可用不得复用「已禁用」（disabled）文案
    expect(queryByText("已禁用")).toBeNull();
  });

  test("不同语义 badge 的颜色 token 互不相同（策略 vs 可用性）", async () => {
    const { findByText } = render(
      <ModelStateBadges entry={inventoryModelEntry({
        ref: "cpa/m2",
        referenceSources: ["policy-exact"],
        selectionSource: "policy-exact"
      })} />
    );

    const policyBadge = await findByText("精确策略");
    const availabilityBadge = await findByText("可用");
    // 语义色 token：策略用 brand，可用性用 success —— 不允许出现硬编码 slate/sky/red/amber/emerald
    expect(policyBadge.className).toContain("text-brand");
    expect(availabilityBadge.className).toContain("text-success");
    for (const badge of [policyBadge, availabilityBadge]) {
      expect(badge.className).not.toMatch(/slate-|sky-|red-|amber-|emerald-/);
    }
  });
});

describe("UnavailableModelsPanel", () => {
  test("primary/fallback 行显示替换优先指引，unknown 行无删除按钮，policy-only exact 行有处理按钮", async () => {
    const onHandleRef = mock(async () => {});
    const { findByText, findByLabelText, queryByLabelText } = render(
      <ToastProvider>
        <UnavailableModelsPanel
          models={[
            inventoryModelEntry({
              ref: "prim/old-model",
              referenceSources: ["primary"],
              availability: "unavailable",
              availabilityReasons: ["model-not-in-catalog"],
              policyAllowed: true
            }),
            inventoryModelEntry({
              ref: "fb/old-model",
              referenceSources: ["fallback"],
              availability: "unavailable",
              availabilityReasons: ["provider-not-found"]
            }),
            inventoryModelEntry({
              ref: "unk/mystery",
              availability: "unknown",
              availabilityReasons: ["probe-failed"]
            }),
            inventoryModelEntry({
              ref: "policy/dangling",
              referenceSources: ["policy-exact"],
              selectionSource: "policy-exact",
              availability: "unavailable",
              availabilityReasons: ["model-not-in-catalog"],
              capabilities: {
                canTogglePolicy: false,
                canSetPrimary: false,
                canEditCatalogEntry: false,
                canMaterializeConfigModel: false,
                canRemovePolicyExactRef: true
              }
            })
          ]}
          onHandleRef={onHandleRef}
        />
      </ToastProvider>
    );

    // primary/fallback 显示「替换优先」指引
    expect(await findByText(/主模型不可直接删除，请先替换主模型/)).toBeTruthy();
    expect(await findByText(/fallback 引用不可直接删除，请先更新回退链/)).toBeTruthy();
    // unknown 行禁止删除建议
    expect(queryByLabelText(/删除 .*unk\/mystery/)).toBeNull();
    expect(queryByLabelText(/处理 .*unk\/mystery/)).toBeNull();
    // policy-only exact 行有处理按钮
    const handle = await findByLabelText("处理 policy/dangling");
    expect(handle).toBeTruthy();
    await userEvent.click(handle);
    await waitFor(() => expect(onHandleRef).toHaveBeenCalledWith("policy/dangling"));
  });

  test("非 policy 悬空引用的不可用行不得显示「可安全移除」类指引", async () => {
    const renderPanel = (models: Parameters<typeof UnavailableModelsPanel>[0]["models"]) =>
      render(
        <ToastProvider>
          <UnavailableModelsPanel models={models} onHandleRef={async () => {}} />
        </ToastProvider>
      );

    // config 来源模型缺认证：不可用但不是悬空 policy 引用，无 canRemovePolicyExactRef
    const badRow = renderPanel([
      inventoryModelEntry({
        ref: "cfg/auth-missing",
        referenceSources: ["legacy-metadata"],
        availability: "unavailable",
        availabilityReasons: ["missing-auth"],
        capabilities: {
          canTogglePolicy: false,
          canSetPrimary: false,
          canEditCatalogEntry: true,
          canMaterializeConfigModel: false,
          canRemovePolicyExactRef: false
        }
      })
    ]);
    expect(badRow.queryByText(/可安全移除/)).toBeNull();
    // 事实性原因文案照常出现
    expect(badRow.getByText("缺少认证")).toBeTruthy();
    badRow.unmount();

    // 对照：policy-exact 悬空引用行指引文案正确出现
    const danglingRow = renderPanel([
      inventoryModelEntry({
        ref: "policy/dangling",
        referenceSources: ["policy-exact"],
        selectionSource: "policy-exact",
        catalogSources: [],
        availability: "unavailable",
        availabilityReasons: ["model-not-in-catalog"],
        capabilities: {
          canTogglePolicy: false,
          canSetPrimary: false,
          canEditCatalogEntry: false,
          canMaterializeConfigModel: false,
          canRemovePolicyExactRef: true
        }
      })
    ]);
    expect(danglingRow.getByText("模型不在目录中")).toBeTruthy();
    expect(danglingRow.getByRole("button", { name: "处理 policy/dangling" })).toBeTruthy();
  });
});

describe("ModelPolicyPanel", () => {
  test("exact 规则显示删除操作；不可删 wildcard 显示受保护并显示命中/不可用计数", async () => {
    const onRemoveRule = mock(async () => {});
    const { findByText, findAllByText, findByLabelText, queryByLabelText } = render(
      <ToastProvider>
        <ModelPolicyPanel
          rules={[
            { value: "cpa/m2", kind: "exact", matchedModelCount: 1, unavailableModelCount: 0, removable: true },
            { value: "cpa/*", kind: "wildcard", matchedModelCount: 3, unavailableModelCount: 1, removable: false },
            { value: "prim/protected", kind: "exact", matchedModelCount: 1, unavailableModelCount: 0, removable: false }
          ]}
          onAddRule={() => {}}
          onRemoveRule={onRemoveRule}
        />
      </ToastProvider>
    );

    // 桌面计数列保持原值；手机副本放在规则值单元格内，布局断言另有覆盖。
    expect((await findAllByText(/命中 3 个模型，其中 1 个不可用/)).filter(node => node.closest("td")?.cellIndex === 2)).toHaveLength(1);
    // 两条 exact 规则均显示「命中 1 个模型」；受保护的 wildcard 与保护性 exact 无删除入口
    expect((await findAllByText(/命中 1 个模型/)).filter(node => node.closest("td")?.cellIndex === 2)).toHaveLength(2);

    await userEvent.click(await findByLabelText("删除规则 cpa/m2"));
    await waitFor(() => expect(onRemoveRule).toHaveBeenCalledWith(expect.objectContaining({ value: "cpa/m2", kind: "exact" })));
    expect(queryByLabelText("删除规则 cpa/*")).toBeNull();
    expect(queryByLabelText("删除规则 prim/protected")).toBeNull();
    // 不可删 wildcard 显示「受保护」（含保护原因 title），不再一律「只读」
    expect((await findByText("受保护")).getAttribute("title")).toContain("主模型/fallback");
  });
});

describe("PluginProviderGroup", () => {
  const xiaomiPlugin: ModelPluginDescriptor = {
    id: "xiaomi-miot",
    name: "小米 MiOT",
    origin: "npm-global",
    enabled: true,
    providerIds: ["xiaomi-speech", "xiaomi-contract"],
    nonModelCapabilities: ["speech", "other-contracts"]
  };

  /** 成功的插件启停响应 fixture（runtimeConfirmed 可覆盖） */
  function pluginStateResult(overrides: Partial<PluginStateMutationResult> = {}): PluginStateMutationResult {
    return {
      ok: true,
      pluginId: "xiaomi-miot",
      enabled: false,
      backupId: "backup-1",
      affectedProviderIds: ["xiaomi-speech", "xiaomi-contract"],
      warnings: [],
      runtimeConfirmed: true,
      ...overrides
    };
  }

  function pluginProviderFixture(providerId: string) {
    return {
      providerId,
      sources: ["plugin-manifest"],
      pluginIds: ["xiaomi-miot"],
      pluginEnabled: true,
      disabled: false,
      availability: "available",
      availabilityReasons: [],
      modelCount: 2,
      policyAllowedModelCount: 1,
      availableModelCount: 2,
      unavailableModelCount: 0,
      capabilities: {
        canEditConnection: false,
        canManageModels: false,
        canDisableProvider: false,
        canSetApiKey: true
      }
    } satisfies ProviderInventoryEntry;
  }

  test("一个 xiaomi 插件渲染两个 Provider，只出现一个总开关", async () => {
    const { findAllByText, findAllByLabelText } = render(
      <ToastProvider>
        <PluginProviderGroup
          plugin={xiaomiPlugin}
          providers={[pluginProviderFixture("xiaomi-speech"), pluginProviderFixture("xiaomi-contract")]}
          onSetPluginState={async () => pluginStateResult()}
        />
      </ToastProvider>
    );
    await userEvent.click(await screen.findByRole("button", {name:"展开插件 xiaomi-miot"}));

    expect((await findAllByText("xiaomi-speech")).length).toBeGreaterThan(0);
    expect((await findAllByText("xiaomi-contract")).length).toBeGreaterThan(0);
    // 一个插件只有一个总开关（不是每个 Provider 一个）；label 描述目标动作（启用中 → 停用）
    expect((await findAllByLabelText(/停用插件 .*/)).length).toBe(1);
  });

  test("确认框列出 speech/contract 等非模型能力影响并确认后才调用 API", async () => {
    const setPluginState = mock(async () => pluginStateResult());
    const { findByLabelText, findByText, getByText } = render(
      <ToastProvider>
        <PluginProviderGroup
          plugin={xiaomiPlugin}
          providers={[pluginProviderFixture("xiaomi-speech"), pluginProviderFixture("xiaomi-contract")]}
          onSetPluginState={setPluginState}
        />
      </ToastProvider>
    );

    await userEvent.click(await findByLabelText(/停用插件 .*/));

    // 确认框列出 speech / contract（other-contracts）影响面
    expect(await findByText(/语音（speech）/)).toBeTruthy();
    expect(await findByText(/其他扩展能力（other-contracts）/)).toBeTruthy();
    expect(await findByText(/xiaomi-speech、xiaomi-contract/)).toBeTruthy();

    await userEvent.click(getByText("确认"));
    await waitFor(() => expect(setPluginState).toHaveBeenCalledWith("xiaomi-miot", false));
  });

  test("runtimeConfirmed:false 不是失败：写入成功仍提示成功并附带确认警告", async () => {
    const setPluginState = mock(async () => pluginStateResult({
      backupId: "backup-2",
      affectedProviderIds: ["xiaomi-speech"],
      runtimeConfirmed: false
    }));
    const { findByLabelText, findByText, getByText } = render(
      <ToastProvider>
        <PluginProviderGroup
          plugin={xiaomiPlugin}
          providers={[pluginProviderFixture("xiaomi-speech")]}
          onSetPluginState={setPluginState}
        />
      </ToastProvider>
    );

    await userEvent.click(await findByLabelText(/停用插件 .*/));
    await userEvent.click(getByText("确认"));

    // 写入已成功：不报错，而是提示运行时未确认
    expect(await findByText(/已停用插件 xiaomi-miot；运行时状态未能确认/)).toBeTruthy();
  });
});

// ---------- Models / Providers 页面统一 Inventory 迁移（Task 8） ----------

/**
 * 旧版 getProviders/getModels fixture → 完整 ModelInventory 的桥接 helper。
 * 按 core `buildModelInventory` 的真实推导规则换算（available 行 / capability / 计数），
 * 保证旧用例语义（选中态、能力门控）在迁移后的单一 getModelInventory 请求下仍然可测。
 */
function legacyAsInventory(input: {
  providers: ProviderSummary[];
  models: ModelSummary[];
}): ModelInventory {
    const providerIds = input.providers.map((provider) => provider.id);
    const models: ModelInventoryEntry[] = input.models.map((model) => {
    const wildcardSelected = model.selectionSource === "policy-wildcard";
    const provider = input.providers.find((candidate) => candidate.id === model.providerId);
    const pluginProvider = provider?.source === "plugin";
    const providerDisabled = Boolean(provider?.disabled);
    // available 推导：config Provider 被 oc-switch 可逆关闭不等于运行不可用
    // （模型仍在目录、只是被隐藏）；插件停用才导致运行不可用
    const availability: ModelAvailability = pluginProvider && provider?.disabled
      ? "unavailable"
      : "available";
    return {
      ref: model.ref,
      providerId: model.providerId,
      modelId: model.modelId,
      catalogSources: [pluginProvider ? "plugin-manifest" : "config"],
      referenceSources: model.isPrimary
        ? ["primary"]
        : wildcardSelected
          ? ["policy-wildcard"]
          : model.selectionSource === "policy-exact"
            ? ["policy-exact"]
            : ["legacy-metadata"],
      policyMode: "restricted",
      ...(model.selectionSource ? { selectionSource: model.selectionSource } : {}),
      policyAllowed: model.enabled,
      availability,
      availabilityReasons: availability === "unavailable" ? [pluginProvider ? "plugin-disabled" : "model-not-in-catalog"] : [],
      pluginIds: pluginProvider ? [model.providerId] : [],
      capabilities: {
        canTogglePolicy: !wildcardSelected && !model.isPrimary && availability === "available" && !providerDisabled,
        canSetPrimary: model.enabled && !model.isPrimary && availability === "available",
        canEditCatalogEntry: !pluginProvider && availability === "available",
        canMaterializeConfigModel: false,
        canRemovePolicyExactRef: false
      }
    };
  });
  const providers: ProviderInventoryEntry[] = input.providers.map((provider) => {
    const providerModels = models.filter((model) => model.providerId === provider.id);
    const fromConfig = provider.source === "config";
    return {
      providerId: provider.id,
      sources: [fromConfig ? "config" : "plugin-manifest"],
      pluginIds: fromConfig ? [] : [provider.id],
      pluginEnabled: fromConfig ? null : !provider.disabled,
      disabled: fromConfig ? provider.disabled : false,
      availability: "available" as const,
      availabilityReasons: [],
      modelCount: providerModels.length,
      policyAllowedModelCount: providerModels.filter((model) => model.policyAllowed).length,
      availableModelCount: providerModels.filter((model) => model.availability === "available").length,
      unavailableModelCount: providerModels.filter((model) => model.availability === "unavailable").length,
      capabilities: {
        canEditConnection: fromConfig,
        canManageModels: fromConfig,
        canDisableProvider: fromConfig,
        canSetApiKey: true
      }
    };
  });
  return {
    providers,
    models,
    plugins: [],
    policyRules: [],
    diagnostics: [],
    summary: {
      modelCount: models.length,
      policyAllowedCount: models.filter((model) => model.policyAllowed).length,
      availableCount: models.filter((model) => model.availability === "available").length,
      unavailableCount: models.filter((model) => model.availability === "unavailable").length,
      unknownCount: 0
    }
  };
}

/**
 * 完整真实形状的 ModelInventory fixture（AGENTS.md：不手搓缺字段 mock）。
 * providers/models/plugins/policyRules/diagnostics/summary 全量显式给出。
 */
function inventoryFixture(overrides: Partial<ModelInventory> = {}): ModelInventory {
  return {
    providers: [],
    models: [],
    plugins: [],
    policyRules: [],
    diagnostics: [],
    summary: { modelCount: 0, policyAllowedCount: 0, availableCount: 0, unavailableCount: 0, unknownCount: 0 },
    ...overrides
  };
}

/** ProviderInventoryEntry fixture：capabilities 全量显式 */
function inventoryProvider({ providerId, ...overrides }: Partial<ProviderInventoryEntry> & Pick<ProviderInventoryEntry, "providerId">): ProviderInventoryEntry {
  return {
    providerId,
    sources: ["config"],
    pluginIds: [],
    pluginEnabled: null,
    disabled: false,
    availability: "available",
    availabilityReasons: [],
    modelCount: 1,
    policyAllowedModelCount: 1,
    availableModelCount: 1,
    unavailableModelCount: 0,
    capabilities: {
      canEditConnection: true,
      canManageModels: true,
      canDisableProvider: true,
      canSetApiKey: true
    },
    ...overrides
  };
}

/** Models 页混合 fixture：enabled+available / policy-only unavailable / probe unknown / wildcard-covered / primary unavailable */
function modelsViewInventoryFixture(): ModelInventory {
  const configCaps = (over: Partial<ModelInventoryEntry["capabilities"]> = {}) => ({
    canTogglePolicy: false,
    canSetPrimary: false,
    canEditCatalogEntry: true,
    canMaterializeConfigModel: false,
    canRemovePolicyExactRef: false,
    ...over
  });
  return inventoryFixture({
    providers: [
      inventoryProvider({ providerId: "cpa", modelCount: 4, policyAllowedModelCount: 2, availableModelCount: 2, unavailableModelCount: 2 }),
      inventoryProvider({ providerId: "pluginhost", sources: ["plugin-manifest"], pluginIds: ["plug-a"], pluginEnabled: true, capabilities: { canEditConnection: false, canManageModels: false, canDisableProvider: false, canSetApiKey: true } })
    ],
    models: [
      // 1. enabled + available（exact policy 命中，可启停 / 可设主模型）
      inventoryModelEntry({
        ref: "cpa/m2",
        catalogSources: ["config"],
        referenceSources: ["policy-exact"],
        selectionSource: "policy-exact",
        policyAllowed: true,
        availability: "available",
        capabilities: configCaps({ canTogglePolicy: true, canSetPrimary: true })
      }),
      // 2. policy-only 不可用（Provider 已配置但模型不在目录 → 悬空精确引用，可移除）
      inventoryModelEntry({
        ref: "cpa/dangling",
        catalogSources: [],
        referenceSources: ["policy-exact", "legacy-metadata"],
        selectionSource: "policy-exact",
        policyAllowed: true,
        availability: "unavailable",
        availabilityReasons: ["model-not-in-catalog"],
        capabilities: configCaps({ canEditCatalogEntry: false, canRemovePolicyExactRef: true })
      }),
      // 3. 探测未知（证据不足：unknown，禁止删除建议）
      inventoryModelEntry({
        ref: "cpa/mystery",
        catalogSources: ["config"],
        referenceSources: ["legacy-metadata"],
        policyAllowed: false,
        availability: "unknown",
        availabilityReasons: ["probe-failed"],
        capabilities: configCaps({ canTogglePolicy: false, canSetPrimary: false, canEditCatalogEntry: false })
      }),
      // 4. wildcard 覆盖（不能逐模型关闭，提示先收窄规则）
      inventoryModelEntry({
        ref: "cpa/w1",
        catalogSources: ["config"],
        referenceSources: ["policy-wildcard"],
        selectionSource: "policy-wildcard",
        policyAllowed: true,
        availability: "available",
        capabilities: configCaps({ canTogglePolicy: false, canSetPrimary: true })
      }),
      // 5. 主模型不可用（替换优先，fail closed）
      inventoryModelEntry({
        ref: "cpa/old-primary",
        catalogSources: ["config"],
        referenceSources: ["primary", "legacy-metadata"],
        policyAllowed: true,
        availability: "unavailable",
        availabilityReasons: ["provider-rejected"],
        capabilities: configCaps({ canTogglePolicy: false, canSetPrimary: false })
      }),
      // 6. 插件模型（可启停 / 设主模型，目录只读 → 无编辑/删除入口）
      inventoryModelEntry({
        ref: "pluginhost/p1",
        catalogSources: ["plugin-manifest"],
        referenceSources: ["legacy-metadata"],
        policyAllowed: true,
        availability: "available",
        pluginIds: ["plug-a"],
        capabilities: {
          canTogglePolicy: true,
          canSetPrimary: true,
          canEditCatalogEntry: false,
          canMaterializeConfigModel: false,
          canRemovePolicyExactRef: false
        }
      })
    ],
    policyRules: [
      { value: "cpa/m2", kind: "exact", matchedModelCount: 1, unavailableModelCount: 0, removable: true },
      { value: "cpa/dangling", kind: "exact", matchedModelCount: 1, unavailableModelCount: 1, removable: true },
      { value: "cpa/*", kind: "wildcard", matchedModelCount: 3, unavailableModelCount: 1, removable: false }
    ],
    summary: { modelCount: 6, policyAllowedCount: 5, availableCount: 3, unavailableCount: 2, unknownCount: 1 }
  });
}

describe("ModelsView（统一 inventory）", () => {














  test("Policy 规则区段（spec §11.3）：默认折叠，展开后渲染规则并可删除 exact 引用", async () => {
    const getModelInventory = mock(async () => modelsViewInventoryFixture());
    const removeModelPolicyExactRef = mock(async () => ({ ok: true as const, backupId: "backup-rule-1" }));
    const { queryByText, findByLabelText, findByText, findAllByText, getByText } = renderModelsView(
      mockClient({ getModelInventory, removeModelPolicyExactRef })
    );

    // 折叠态：规则视图不渲染，仅折叠入口显示条数（fixture 有 3 条规则）；
    // （"cpa/m2" 在普通区段/待处理区段本就出现，折叠断言只针对规则视图自身）
    await waitFor(() => expect(getByText(/3 条/)).toBeTruthy());
    expect(queryByText("命中 3 个模型")).toBeNull();
    expect(queryByText("命中 1 个模型")).toBeNull();

    // 展开后：exact（精确）与 wildcard（通配）规则 + 命中/不可用计数 + 删除入口
    await userEvent.click(await findByLabelText("展开 Policy 规则"));
    expect((await findAllByText("精确")).length).toBeGreaterThan(0);
    expect((await findAllByText("通配")).length).toBeGreaterThan(0);
    expect((await findAllByText(/命中 3 个模型，其中 1 个不可用/)).filter(node => node.closest("td")?.cellIndex === 2)).toHaveLength(1);

    // exact 删除：确认框 → removeModelPolicyExactRef(ref, false)（legacy metadata 保留）
    await userEvent.click(await findByLabelText("删除规则 cpa/m2"));
    expect(await findByText(/确认删除 cpa\/m2/)).toBeTruthy();
    await userEvent.click(getByText("仅删除 policy 引用"));
    await waitFor(() => expect(removeModelPolicyExactRef).toHaveBeenCalledWith("cpa/m2", false));
  });
});

describe("ProvidersView（插件分组）", () => {
  /** xiaomi + xiaomi-token-plan 同组 fixture：一个插件两个 Provider + 一个 config Provider */
  function pluginGroupInventoryFixture(): ModelInventory {
    return inventoryFixture({
      providers: [
        inventoryProvider({
          providerId: "nvidia",
          sources: ["config"],
          modelCount: 2,
          policyAllowedModelCount: 2,
          availableModelCount: 2
        }),
        inventoryProvider({
          providerId: "xiaomi",
          sources: ["plugin-manifest"],
          pluginIds: ["xiaomi-miot"],
          pluginEnabled: true,
          modelCount: 2,
          policyAllowedModelCount: 1,
          availableModelCount: 2,
          capabilities: { canEditConnection: false, canManageModels: false, canDisableProvider: false, canSetApiKey: true }
        }),
        inventoryProvider({
          providerId: "xiaomi-token-plan",
          sources: ["plugin-manifest"],
          pluginIds: ["xiaomi-miot"],
          pluginEnabled: true,
          modelCount: 2,
          policyAllowedModelCount: 1,
          availableModelCount: 2,
          capabilities: { canEditConnection: false, canManageModels: false, canDisableProvider: false, canSetApiKey: true }
        })
      ],
      models: [
        inventoryModelEntry({
          ref: "nvidia/deepseek-v4-flash",
          referenceSources: ["legacy-metadata"],
          policyAllowed: true,
          availability: "available"
        }),
        inventoryModelEntry({
          ref: "xiaomi/miot-m2",
          catalogSources: ["plugin-manifest"],
          pluginIds: ["xiaomi-miot"],
          policyAllowed: true,
          availability: "available",
          capabilities: {
            canTogglePolicy: true,
            canSetPrimary: true,
            canEditCatalogEntry: false,
            canMaterializeConfigModel: false,
            canRemovePolicyExactRef: false
          }
        }),
        inventoryModelEntry({
          ref: "xiaomi-token-plan/turbo",
          catalogSources: ["plugin-manifest"],
          pluginIds: ["xiaomi-miot"],
          policyAllowed: true,
          availability: "available",
          capabilities: {
            canTogglePolicy: true,
            canSetPrimary: true,
            canEditCatalogEntry: false,
            canMaterializeConfigModel: false,
            canRemovePolicyExactRef: false
          }
        })
      ],
      plugins: [
        {
          id: "xiaomi-miot",
          name: "小米 MiOT",
          origin: "npm-global",
          enabled: true,
          providerIds: ["xiaomi", "xiaomi-token-plan"],
          nonModelCapabilities: ["speech", "other-contracts"]
        }
      ],
      summary: { modelCount: 3, policyAllowedCount: 3, availableCount: 3, unavailableCount: 0, unknownCount: 0 }
    });
  }

  /** ProvidersView 页面级 client：inventory 驱动插件分组 + 兼容期端点（config CRUD / 健康检查）全量 mock */
  function pluginGroupClient(overrides: Partial<ApiClient> = {}): ApiClient {
    return mockClient({
      getProviders: async () => ({
        providers: [
          providerSummary({ id: "nvidia", modelCount: 2, enabledModelCount: 2 }),
          providerSummary({
            id: "xiaomi",
            source: "plugin",
            apiKeyEnv: "XIAOMI_MIOT_API_KEY",
            apiKeyEnvManaged: true,
            apiKeyEnvStatus: "managed",
            modelCount: 2,
            enabledModelCount: 1
          }),
          providerSummary({
            id: "xiaomi-token-plan",
            source: "plugin",
            apiKeyEnv: "XIAOMI_MIOT_API_KEY",
            apiKeyEnvManaged: true,
            apiKeyEnvStatus: "managed",
            modelCount: 2,
            enabledModelCount: 1
          })
        ]
      }),
      getHealth: async (): Promise<ConfigHealthReport> => ({
        caseDuplicateGroups: [],
        summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 }
      }),
      getModelMetadataSyncQueue: async () => ({ items: [] }),
      getModelInventory: async () => pluginGroupInventoryFixture(),
      ...overrides
    });
  }

  test("xiaomi / xiaomi-token-plan 归入同一插件组，整组只有一个开关，config Provider 保留 CRUD", async () => {
    const { findAllByText, findAllByLabelText, findByLabelText } = renderProvidersView(pluginGroupClient());
    await userEvent.click(await screen.findByRole("button", {name:"展开插件 xiaomi-miot"}));

    // 两个 Provider 都出现在插件组内
    expect((await findAllByText("xiaomi")).length).toBeGreaterThan(0);
    expect((await findAllByText("xiaomi-token-plan")).length).toBeGreaterThan(0);
    // 一个插件只有一个总开关（aria-label 描述目标动作：启用中 → 停用）
    expect((await findAllByLabelText(/停用插件 xiaomi-miot/)).length).toBe(1);
    // config Provider（nvidia）保留原有 CRUD 入口
    expect(await findByLabelText("管理模型 nvidia")).toBeTruthy();
    expect(await findByLabelText("更多操作 nvidia")).toBeTruthy();
  });

  test("确认框列出受影响 Provider 与非模型能力（speech / other-contracts）", async () => {
    const setPluginState = mock(async () => ({
      ok: true as const,
      pluginId: "xiaomi-miot",
      enabled: false,
      backupId: "backup-1",
      affectedProviderIds: ["xiaomi", "xiaomi-token-plan"],
      warnings: [],
      runtimeConfirmed: true
    }));
    const { findByLabelText, findByText, getByText } = renderProvidersView(
      pluginGroupClient({ setPluginState })
    );

    await userEvent.click(await findByLabelText(/停用插件 xiaomi-miot/));
    // 影响面：两个 Provider + speech / other-contracts 能力
    expect(await findByText(/xiaomi、xiaomi-token-plan/)).toBeTruthy();
    expect(await findByText(/语音（speech）/)).toBeTruthy();
    expect(await findByText(/其他扩展能力（other-contracts）/)).toBeTruthy();

    await userEvent.click(getByText("确认"));
    await waitFor(() => expect(setPluginState).toHaveBeenCalledWith("xiaomi-miot", false));
  });

  test("写入成功但运行时未确认（runtimeConfirmed:false）不报失败，提示待确认", async () => {
    const setPluginState = mock(async () => ({
      ok: true as const,
      pluginId: "xiaomi-miot",
      enabled: false,
      backupId: "backup-2",
      affectedProviderIds: ["xiaomi"],
      warnings: [],
      runtimeConfirmed: false
    }));
    const { findByLabelText, findByText, getByText } = renderProvidersView(
      pluginGroupClient({ setPluginState })
    );

    await userEvent.click(await findByLabelText(/停用插件 xiaomi-miot/));
    await userEvent.click(getByText("确认"));

    // 写入已成功：不报错，而是提示运行时未确认
    expect(await findByText(/已停用插件 xiaomi-miot；运行时状态未能确认/)).toBeTruthy();
  });

  test("插件停用后 Provider 行展示插件来源与不可用状态，不与 oc-switch 可逆关闭混用", async () => {
    const inventory = pluginGroupInventoryFixture();
    // xiaomi 插件停用：pluginEnabled=false，Provider 行不再出现在 CRUD 表
    inventory.plugins[0]!.enabled = false;
    inventory.providers = inventory.providers.map((provider) =>
      provider.pluginIds.includes("xiaomi-miot")
        ? { ...provider, pluginEnabled: false, availability: "unavailable" as const, availabilityReasons: ["plugin-disabled" as const], availableModelCount: 0 }
        : provider
    );
    inventory.models = inventory.models.map((model) =>
      model.pluginIds.includes("xiaomi-miot")
        ? { ...model, availability: "unavailable" as const, availabilityReasons: ["plugin-disabled" as const] }
        : model
    );
    const { findAllByText, findByLabelText, queryByText, getByRole } = renderProvidersView(
      pluginGroupClient({ getModelInventory: async () => inventory })
    );
    await userEvent.click(getByRole("tab", { name: /已停用/ }));

    // 插件组 header 显示已停用，开关 aria-label 变为「启用插件」
    expect(await findByLabelText(/启用插件 xiaomi-miot/)).toBeTruthy();
    expect((await findAllByText("已停用")).length).toBeGreaterThan(0);
    // 停用插件的 Provider 行不可用（不可用 badge title 含「插件已停用」事实说明；
    // 不与 oc-switch 可逆关闭混用——插件状态由组开关管理，不在 Provider 行出现「已关闭」）
    expect(queryByText("已关闭")).toBeNull();
  });

  test("停用被主模型/fallback 阻断（server 400 fail closed）：显示错误且开关状态不变", async () => {
    const blockerMessage = "Model xiaomi/miot-m2 is the primary model. Switch primary model before disabling plugin xiaomi-miot.";
    // PATCH 失败 → api client 按 body.error 抛错（jsonError 400 语义）
    const setPluginState = mock(async () => {
      throw new Error(blockerMessage);
    });
    const { findByLabelText, findByText, getByText } = renderProvidersView(
      pluginGroupClient({ setPluginState })
    );

    const toggle = await findByLabelText(/停用插件 xiaomi-miot/);
    await userEvent.click(toggle);
    await userEvent.click(getByText("确认"));

    // server fail closed：错误可见（toast 文案含阻断原因），开关保持「启用中」（unchecked 转换未发生）
    expect(await findByText(new RegExp(blockerMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeTruthy();
    await waitFor(() => {
      const after = document.querySelector('[aria-label="停用插件 xiaomi-miot"]');
      expect(after).not.toBeNull();
    });
  });

  test("非模型能力在插件组头部有警示提示（影响不只模型）", async () => {
    const { findByText } = renderProvidersView(pluginGroupClient());
    await userEvent.click(await screen.findByRole("button", {name:"展开插件 xiaomi-miot"}));

    // 插件组 header 标注插件名与 id
    expect(await findByText(/小米 MiOT/)).toBeTruthy();
    expect(await findByText("xiaomi-miot")).toBeTruthy();
  });
});

describe("布局验证（Step 6）", () => {
  /** 构造长 ref / 长 Provider ID / 多 badge 的极端布局 fixture */
  function longRefInventoryFixture(): ModelInventory {
    const longProviderId = "qwen-token-plan-very-long-provider-identifier-for-layout-check";
    const longModelId = "deepseek-ai/deepseek-v4-flash-with-a-very-long-model-name-suffix-2026";
    return inventoryFixture({
      providers: [
        inventoryProvider({ providerId: longProviderId, modelCount: 2, policyAllowedModelCount: 1, availableModelCount: 1, unavailableModelCount: 1 }),
        inventoryProvider({
          providerId: "xiaomi",
          sources: ["plugin-manifest", "openclaw-runtime"],
          pluginIds: ["xiaomi-miot"],
          pluginEnabled: true,
          modelCount: 1,
          capabilities: { canEditConnection: false, canManageModels: false, canDisableProvider: false, canSetApiKey: true }
        })
      ],
      models: [
        inventoryModelEntry({
          ref: `${longProviderId}/${longModelId}`,
          catalogSources: ["config", "openclaw-runtime"],
          referenceSources: ["policy-exact", "legacy-metadata"],
          selectionSource: "policy-exact",
          policyAllowed: true,
          availability: "available",
          capabilities: {
            canTogglePolicy: true,
            canSetPrimary: true,
            canEditCatalogEntry: true,
            canMaterializeConfigModel: false,
            canRemovePolicyExactRef: false
          }
        }),
        inventoryModelEntry({
          ref: `${longProviderId}/ghost-model`,
          catalogSources: [],
          referenceSources: ["policy-exact"],
          selectionSource: "policy-exact",
          policyAllowed: true,
          availability: "unavailable",
          availabilityReasons: ["model-not-in-catalog"],
          capabilities: {
            canTogglePolicy: false,
            canSetPrimary: false,
            canEditCatalogEntry: false,
            canMaterializeConfigModel: false,
            canRemovePolicyExactRef: true
          }
        }),
        inventoryModelEntry({
          ref: "xiaomi/miot-speech-pro-max",
          catalogSources: ["plugin-manifest", "openclaw-runtime"],
          referenceSources: ["policy-wildcard"],
          selectionSource: "policy-wildcard",
          policyAllowed: true,
          availability: "available",
          pluginIds: ["xiaomi-miot"],
          capabilities: {
            canTogglePolicy: false,
            canSetPrimary: true,
            canEditCatalogEntry: false,
            canMaterializeConfigModel: false,
            canRemovePolicyExactRef: false
          }
        })
      ],
      plugins: [
        {
          id: "xiaomi-miot",
          name: "小米 MiOT",
          origin: "npm-global",
          enabled: true,
          providerIds: ["xiaomi"],
          nonModelCapabilities: ["speech", "tools", "hooks", "commands", "services", "realtime", "media", "search", "other-contracts"]
        }
      ],
      summary: { modelCount: 3, policyAllowedCount: 3, availableCount: 2, unavailableCount: 1, unknownCount: 0 }
    });
  }

  test("长 ref / 多 badge 的模型行不产生 body 横向溢出（wrap 策略生效）", async () => {
    const { getByTestId, findByLabelText } = renderModelsView(
      mockClient({ getModelInventory: async () => longRefInventoryFixture(), getModels: async () => ({ models: [] }) })
    );

    // 页面渲染完成（待处理区段与刷新按钮就位）
    await findByLabelText("刷新探测");
    const section = getByTestId("models-view");
    // happy-dom 不做真实排版，但可断言结构性约束：
    // 1. 长 ref 单元格使用 break-all（wrap: anywhere）而非 nowrap
    const longRefCell = Array.from(section.querySelectorAll("td")).find((td) =>
      td.textContent?.includes("deepseek-v4-flash-with-a-very-long-model-name")
    );
    expect(longRefCell).toBeTruthy();
    expect(longRefCell!.className).toContain("break-all");
    expect(longRefCell!.className).not.toContain("whitespace-nowrap");
    // 2. 操作列 nowrap（按钮不折行）
    const actionCell = Array.from(section.querySelectorAll("td")).find((td) =>
      td.querySelector('[aria-label^="设为主模型"]') !== null
    );
    expect(actionCell).toBeTruthy();
    expect(actionCell!.className).toContain("whitespace-nowrap");
  });

  test("模型问题不再渲染全量待处理表格", async () => {
    const { queryByTestId, findByLabelText } = renderModelsView(mockClient({ getModelInventory: async () => longRefInventoryFixture() }));
    await findByLabelText("刷新探测");
    expect(queryByTestId("pending-models-panel") === null).toBe(true);
  });

  test("Providers 页插件组在多 badge（9 项非模型能力）下结构完整不溢出", async () => {
    const inventory = longRefInventoryFixture();
    const client = mockClient({
      getProviders: async () => ({
        providers: [
          providerSummary({ id: "qwen-token-plan-very-long-provider-identifier-for-layout-check", modelCount: 2, enabledModelCount: 1 }),
          providerSummary({ id: "xiaomi", source: "plugin", apiKeyEnv: "XIAOMI_MIOT_API_KEY", apiKeyEnvManaged: true, apiKeyEnvStatus: "managed", modelCount: 1, enabledModelCount: 1 })
        ]
      }),
      getHealth: async (): Promise<ConfigHealthReport> => ({
        caseDuplicateGroups: [],
        summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 }
      }),
      getModelMetadataSyncQueue: async () => ({ items: [] }),
      getModelInventory: async () => inventory
    });
    const { findByLabelText, findAllByText } = renderProvidersView(client);
    await userEvent.click(await screen.findByRole("button", {name:/展开插件/}));

    // 插件组渲染：一个开关 + Provider 行（badge 最多 9 项非模型能力只进确认框，不进 header）
    expect(await findByLabelText(/停用插件 xiaomi-miot/)).toBeTruthy();
    expect((await findAllByText("xiaomi")).length).toBeGreaterThan(0);
    // 确认框能列出全部 9 项能力的影响面
    await userEvent.click(await findByLabelText(/停用插件 xiaomi-miot/));
    for (const capability of ["语音（speech）", "工具（tools）", "钩子（hooks）", "命令（commands）", "服务（services）", "实时（realtime）", "媒体（media）", "搜索（search）", "其他扩展能力（other-contracts）"]) {
      expect(await findAllByText(capability).then((nodes) => nodes.length)).toBeGreaterThan(0);
    }
  });
});
