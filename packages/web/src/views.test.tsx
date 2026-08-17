import "./test-setup.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { DiffSummary } from "./components/DiffSummary";
import { ModelDialog } from "./components/ModelDialog";
import {
  createApiClient,
  type ApiClient,
  type CaseDuplicateKind,
  type ConfigHealthReport,
  type ModelMetadataSuggestionsResponse,
  type ProviderModelInput
} from "./api";
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
  mock.restore();
});

const originalFetch = globalThis.fetch;

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  return { ...base, ...overrides };
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
            allowlistModelCount: 4
          })
        })}
      />
    );

    expect(await findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
    expect(await findByText("3")).toBeTruthy();
    expect(await findByText("5")).toBeTruthy();
    expect(await findByText("4")).toBeTruthy();
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
            allowlistModelCount: 4
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
      <Dashboard client={mockClient({ getStatus: async () => ({ ok: true, providerCount: 2, providerModelCount: 2, allowlistModelCount: 0 }), getDiff: async () => { throw new Error("no backup"); }, getHealth })} />
    );
    expect(await findByText(/发现 1 组 Provider 大小写重复/)).toBeTruthy();
    expect(await findByLabelText("合并 deepseek")).toBeTruthy();
  });
});

describe("ModelsView", () => {
  test("calls setPrimary with slash-containing ref", async () => {
    const setPrimary = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash" }));
    const getProviders = mock(async () => ({ providers: [] }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek"
        })
      ]
    }));

    const { findByLabelText } = render(<ModelsView client={mockClient({ getModels, getProviders, setPrimary })} />);

    await userEvent.click(await findByLabelText("设为主模型 nvidia/deepseek-ai/deepseek-v4-flash"));

    expect(setPrimary).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("enables/disables via PATCH body not URL path", async () => {
    const patchModel = mock(async () => ({ ok: true, ref: "a/b/c", enabled: false }));
    const getProviders = mock(async () => ({ providers: [] }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({ ref: "a/b/c" })
      ]
    }));

    const { findByLabelText } = render(<ModelsView client={mockClient({ getModels, getProviders, patchModel })} />);

    await userEvent.click(await findByLabelText("禁用 a/b/c"));

    expect(patchModel).toHaveBeenCalledWith("a/b/c", false);
  });

  test("filters models by search and provider while marking current primary", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "minimax-portal", api: "anthropic-messages", baseUrl: "https://api.minimax.io", containsPrimary: true }),
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1", modelCount: 2 })
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
          name: "DeepSeek"
        }),
        modelSummary({
          ref: "nvidia/llama-3",
          name: "Llama 3",
          enabled: false
        })
      ]
    }));
    const client = mockClient({ getProviders, getModels });

    const searchView = render(<ModelsView client={client} />);
    expect(await searchView.findByText("当前主模型")).toBeTruthy();
    await userEvent.click(await searchView.findByText("nvidia"));
    await userEvent.type(await searchView.findByLabelText("搜索模型"), "deepseek");
    expect(await searchView.findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
    await waitFor(() => expect(searchView.queryByText("minimax-portal/MiniMax-M3")).toBeNull());
    searchView.unmount();

    const filterView = render(<ModelsView client={client} />);
    await userEvent.click(await filterView.findByText("nvidia"));
    expect(await filterView.findByText("nvidia/llama-3")).toBeTruthy();
    await userEvent.click(await filterView.findByText("minimax-portal"));
    expect(await filterView.findByText("minimax-portal/MiniMax-M3")).toBeTruthy();
    await waitFor(() => expect(filterView.queryByText("nvidia/llama-3")).toBeNull());
  });

  test("matches revamp styling for selected provider, disabled models, and keyboard focus actions", async () => {
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1", modelCount: 2 })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({ ref: "nvidia/enabled-model" }),
        modelSummary({ ref: "nvidia/disabled-model", enabled: false })
      ]
    }));

    const { container, findByLabelText, findByRole } = render(<ModelsView client={mockClient({ getModels, getProviders })} />);

    await findByRole("button", { name: "添加模型" });
    expect(container.querySelector("nav button")?.className).toContain("bg-primary/10");
    expect(container.querySelector(".opacity-60")).toBeTruthy();
    expect(container.querySelector(".grayscale-\\[0\\.2\\]")).toBeTruthy();
    expect((await findByLabelText("设为主模型 nvidia/enabled-model")).parentElement?.className).toContain("group-focus-within:opacity-100");
  });

  test("adds model from global Models page with structured fields", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-pro" }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ]
    }));
    const getModels = mock(async () => ({ models: [] }));

    const { findByLabelText, findByRole, findByText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, createModel })} />
    );

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
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek Flash",
          alias: "flash",
          reasoning: false
        })
      ]
    }));

    const { findByLabelText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, updateModel })} />
    );

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
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          alias: "flash"
        })
      ]
    }));

    const { findByLabelText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, updateModel })} />
    );

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
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          alias: "flash"
        })
      ]
    }));

    const { findByLabelText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, updateModel })} />
    );

    await userEvent.click(await findByLabelText("编辑模型 nvidia/deepseek-ai/deepseek-v4-flash"));
    await userEvent.click(await findByLabelText("Reasoning"));
    await userEvent.click(getByText("保存模型"));

    expect(updateModel.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ reasoning: true })
    );
  });

  test("rejects invalid numeric model fields before submit", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/bad-window" }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({ id: "nvidia", baseUrl: "https://nvidia.example/v1" })
      ]
    }));
    const getModels = mock(async () => ({ models: [] }));

    const { findByLabelText, findByText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, createModel })} />
    );

    await userEvent.click(await findByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "bad-window");
    await userEvent.type(await findByLabelText("原生上下文窗口"), "abc");
    await userEvent.click(getByText("保存模型"));

    expect(await findByText("原生上下文窗口 必须是正整数")).toBeTruthy();
    expect(createModel).not.toHaveBeenCalled();
  });

  test("侧栏对大小写重复 Provider 标注推荐/重复而非并列两项", async () => {
    const getProviders = mock(async () => ({ providers: [
      providerSummary({ id: "9R", baseUrl: "http://h/v1", modelCount: 2, enabledModelCount: 0 }),
      providerSummary({ id: "9r", baseUrl: "http://h/v1", modelCount: 2, enabledModelCount: 0 })
    ] }));
    const getModels = mock(async () => ({ models: [
      modelSummary({ ref: "9R/v3", enabled: false }),
      modelSummary({ ref: "9r/v3" })
    ] }));
    const getHealth = mock(async (): Promise<ConfigHealthReport> => ({
      caseDuplicateGroups: [{
        groupKey: "9r", ids: ["9R", "9r"], kinds: ["provider-duplicate"] as CaseDuplicateKind[], confidence: "high", sameOrigin: true,
        mergeable: true, mergeBlockers: [], canonicalId: "9R", duplicateIds: ["9r"], reasons: [],
        details: { baseUrls: {}, allowlistCounts: {}, modelCounts: {}, envVars: {} }
      }],
      summary: { duplicateGroupCount: 1, affectedProviderCount: 2, affectedAllowlistCount: 1 }
    }));
    const { findByText } = render(<ModelsView client={mockClient({ getProviders, getModels, getHealth })} />);
    expect(await findByText("（推荐）")).toBeTruthy();
    expect(await findByText("（重复）")).toBeTruthy();
  });

  test("marks disabled provider and disables model enable controls", async () => {
    const patchModel = mock(async () => ({ ok: true, ref: "nvidia/llama-3", enabled: true }));
    const getProviders = mock(async () => ({
      providers: [
        providerSummary({
          id: "nvidia",
          baseUrl: "https://nvidia.example/v1",
          enabledModelCount: 0,
          disabled: true
        })
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        modelSummary({ ref: "nvidia/llama-3", enabled: false })
      ]
    }));

    const { findByLabelText, findAllByText } = render(
      <ModelsView client={mockClient({ getProviders, getModels, patchModel })} />
    );

    expect((await findAllByText(/已关闭/)).length).toBeGreaterThan(0);
    expect((await findByLabelText("启用 nvidia/llama-3") as HTMLButtonElement).disabled).toBe(true);
    expect((await findByLabelText("添加模型") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ProvidersView", () => {
  test("shows provider id, api type, counts, and primary marker", async () => {
    const { findAllByText, findByText } = render(
      <ProvidersView
        client={mockClient({
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
        })}
      />
    );

    expect(await findByText("nvidia ★")).toBeTruthy();
    expect(await findByText("openai-completions")).toBeTruthy();
    expect(await findByText("2 / 1")).toBeTruthy();
  });

  test("requires a new primary instead of forcing deletion for provider containing primary", async () => {
    const deleteProvider = mock(async () => ({ ok: true }));
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

    const { findByLabelText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels, deleteProvider })} />
    );

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

    const { findByLabelText, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels, createModel })} />
    );

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
    const deleteModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash" }));
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

    const { findByLabelText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels, deleteModel })} />
    );

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByLabelText("删除模型 nvidia/deepseek-ai/deepseek-v4-flash"));
    await userEvent.click(getByText("确认"));

    expect(deleteModel).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash", {
      newPrimary: "minimax-portal/MiniMax-M3"
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

    const { findByLabelText, findAllByLabelText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels })} />
    );

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
      removedModelIds: ["vendor/model-b"]
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

    const { findByLabelText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels, batchRemoveProviderModels })} />
    );

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
      removedModelIds: ["idle-model"]
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

    const { findByLabelText, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels, batchRemoveProviderModels })} />
    );

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
      removedModelIds: ["idle-model"]
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

    const { findByLabelText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, getModels, batchRemoveProviderModels })} />
    );

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

    const { findByLabelText, findByRole, findByText, getByText, queryByText } = render(
      <ProvidersView client={mockClient({ getProviders, previewCustomProvider, addCustomProvider })} />
    );

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

    const { findByLabelText, findByRole, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders })} />
    );

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

    const { findByLabelText, findByRole, findByText, queryByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders })} />
    );

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

    const { findByRole, findByText, queryByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders })} />
    );

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

    const { findByLabelText, findByRole, queryByLabelText } = render(
      <ProvidersView client={mockClient({ getProviders })} />
    );

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
    const { findByLabelText, findByRole, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, discoverProviderPreview })} />
    );

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

    const { findByLabelText, findByText, getByText, queryByText } = render(
      <ProvidersView client={mockClient({ getProviders, previewUpdateProvider, updateProvider })} />
    );

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

    const { findByLabelText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, updateProvider })} />
    );

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

    const { findByLabelText, findByTestId, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, previewUpdateProvider, updateProvider, restartGateway })} />
    );

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

    const { findByLabelText, findByText, getByText } = render(<ProvidersView client={mockClient({
      getProviders: async () => ({ providers: [{
        id: "nvidia",
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: false,
        disabled: false,
        apiKeyEnv: "NVIDIA_API_KEY",
        apiKeyEnvManaged: false,
        apiKeyEnvStatus: "unmanaged"
      }] }),
      getHealth: async () => ({ caseDuplicateGroups: [], summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 } }),
      previewUpdateProvider,
      updateProvider
    })} />);

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

    const { findByLabelText, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, discoverProvider, batchAddProviderModels })} />
    );

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
    const { findAllByText, findAllByLabelText } = render(<ProvidersView client={mockClient({ getProviders, getHealth })} />);
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

    const { findByLabelText, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, patchProviderState })} />
    );

    expect(await findByText("已启用")).toBeTruthy();
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

    const { findByLabelText, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders, patchProviderState })} />
    );

    expect(await findByText("已关闭")).toBeTruthy();
    await userEvent.click(await findByLabelText("恢复 Provider nvidia"));
    expect(await findByText("恢复 nvidia？")).toBeTruthy();
    await userEvent.click(getByText("确认"));
    expect(patchProviderState).toHaveBeenCalledWith("nvidia", true);

    const closePrimary = await findByLabelText("关闭 Provider minimax-portal");
    expect((closePrimary as HTMLButtonElement).disabled).toBe(true);
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

    const { findByLabelText, findByText, getByText, queryByText } = render(
      <PresetsView client={mockClient({ getPresets, getDiff, previewAddProvider, addProvider })} />
    );

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
    const { findByText, getByLabelText, getByText, queryByText } = render(
      <BackupsView
        client={mockClient({
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
        })}
      />
    );

    await findByText("test write");
    await userEvent.click(getByLabelText("恢复备份 2024-01-01T00-00-00"));
    expect(getByText("恢复备份")).toBeTruthy();
    await userEvent.click(getByText("取消"));
    await waitFor(() => expect(queryByText("恢复备份")).toBeNull());
  });

  test("offers restore target choices when backup paths differ from active paths", async () => {
    const restoreBackup = mock(async () => ({ ok: true, id: "backup-a" }));
    const { findByLabelText, getAllByText, getByLabelText, getByText } = render(
      <BackupsView
        client={mockClient({
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
        })}
      />
    );

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
    const { findByLabelText, findByText, getAllByText } = render(
      <BackupsView
        client={mockClient({
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
        })}
      />
    );

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
    const { findByLabelText, findByText, getAllByText, queryByText } = render(
      <BackupsView
        client={mockClient({
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
        })}
      />
    );

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
            allowlistModelCount: 1
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
    const { findAllByText, findByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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
    const { findByLabelText, findByText, getByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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
    const { findByText, getByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

    expect(await findByText("OLD_API_KEY")).toBeTruthy();
    await userEvent.click(getByText("清理 orphan keys"));
    expect(cleanupOrphanEnvKeys).toHaveBeenCalled();
  });

  test("shows path candidates and switches selected paths", async () => {
    const putPaths = mock(async () => ({ ok: true, paths: { openclawPath: "/next/openclaw.json", envPath: "/next/.env", stateDir: "/state" } }));
    const { findByText, getByLabelText, getByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

    await userEvent.click(await findByText("路径"));
    expect(await findByText(/\/next\/openclaw\.json/)).toBeTruthy();
    await userEvent.selectOptions(getByLabelText("openclaw.json 路径"), "/next/openclaw.json");
    await userEvent.selectOptions(getByLabelText(".env 路径"), "/next/.env");
    await userEvent.click(getByText("切换路径"));
    expect(putPaths).toHaveBeenCalledWith("/next/openclaw.json", "/next/.env");
  });

  test("allows manual path entry and explains when no running instance is found", async () => {
    const putPaths = mock(async () => ({ ok: true, paths: { openclawPath: "/manual/openclaw.json", envPath: "/manual/.env", stateDir: "/state" } }));
    const { findByLabelText, findByText, getByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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
    const { findByLabelText, findByText, getByText, queryByText, rerender } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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
      rerender(<SettingsView baseUrl="http://127.0.0.1:7420" client={client} />);
      await userEvent.click(await findByText("路径"));
      const statusNode = await findByText(item.expectText);
      expect(statusNode).toBeTruthy();
      if (item.amber) {
        expect(statusNode.className).toMatch(/amber/);
      } else {
        expect(statusNode.className).not.toMatch(/amber/);
      }
    }
  });

  test("renders env variables without secret values", async () => {
    const { findByText, queryByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

    await userEvent.click(await findByText("环境变量"));
    expect(await findByText("NVIDIA_API_KEY")).toBeTruthy();
    expect(queryByText("sk-test-secret")).toBeNull();
  });

  test("advanced env section is collapsed by default", async () => {
    const { findByText, queryByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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

    const { findByText, findByLabelText, getByText, queryByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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

    const { findByLabelText, findByText, getByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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

    const { findByLabelText, findByText, getByText, queryByText } = render(
      <SettingsView
        baseUrl="http://127.0.0.1:7420"
        client={mockClient({
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
        })}
      />
    );

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
        ok: true,
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
      expect(navLabels).toEqual(["仪表盘", "Providers", "模型", "备份", "设置", "预设"]);
    } finally {
      // 恢复全局 fetch，避免污染同进程后续包测试（如 cli waitForHttp）
      globalThis.fetch = originalFetch;
    }
  });
});

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
    expect(await findByText(/低置信匹配/)).toBeTruthy();

    await userEvent.click(getByLabelText("应用建议的原生上下文 200000"));
    expect((getByLabelText("原生上下文窗口") as HTMLInputElement).value).toBe("200000");
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
    const getProviders = mock(async () => ({ providers: [providerSummary({ id: "nvidia" })] }));
    const getModels = mock(async () => ({ models: [] }));

    const { findByLabelText, findByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, getModelMetadataSuggestions })} />
    );

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

    const { findByLabelText, findByText } = render(
      <ProvidersView client={mockClient({ getModels, getProviders, getModelMetadataSuggestions })} />
    );

    await userEvent.click(await findByLabelText("管理模型 nvidia"));
    await userEvent.click(await findByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "openai/gpt-5.2");
    await userEvent.click(await findByLabelText("查询参考参数"));

    await waitFor(() => expect(getModelMetadataSuggestions).toHaveBeenCalledWith("nvidia", "gpt-5.2"));
  });
});
