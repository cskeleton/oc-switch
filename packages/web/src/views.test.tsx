import "./test-setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { DiffSummary } from "./components/DiffSummary";
import { createApiClient, type ApiClient } from "./api";
import { Dashboard } from "./views/Dashboard";
import { ModelsView } from "./views/ModelsView";
import { ProvidersView } from "./views/ProvidersView";
import { PresetsView } from "./views/PresetsView";
import { BackupsView } from "./views/BackupsView";
import { SettingsView } from "./views/SettingsView";

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  mock.restore();
});

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
            primaryChanged: null
          })
        })}
      />
    );

    expect(await findByText("配置健康")).toBeTruthy();
    expect(await findByText("与最近备份有 1 项差异")).toBeTruthy();
    expect(await findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
  });
});

describe("ModelsView", () => {
  test("calls setPrimary with slash-containing ref", async () => {
    const setPrimary = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash" }));
    const getProviders = mock(async () => ({ providers: [] }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          providerId: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek",
          alias: undefined,
          enabled: true,
          isPrimary: false
        }
      ]
    }));

    const { findByLabelText } = render(<ModelsView client={mockClient({ getModels, getProviders, setPrimary })} />);

    const btn = await findByLabelText("设为主模型 nvidia/deepseek-ai/deepseek-v4-flash");
    await userEvent.click(btn);

    expect(setPrimary).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("enables/disables via PATCH body not URL path", async () => {
    const patchModel = mock(async () => ({ ok: true, ref: "a/b/c", enabled: false }));
    const getProviders = mock(async () => ({ providers: [] }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "a/b/c",
          providerId: "a",
          modelId: "b/c",
          name: undefined,
          alias: undefined,
          enabled: true,
          isPrimary: false
        }
      ]
    }));

    const { findByLabelText } = render(<ModelsView client={mockClient({ getModels, getProviders, patchModel })} />);

    const btn = await findByLabelText("禁用 a/b/c");
    await userEvent.click(btn);

    expect(patchModel).toHaveBeenCalledWith("a/b/c", false);
  });

  test("filters models by search and provider while marking current primary", async () => {
    const getProviders = mock(async () => ({
      providers: [
        { id: "minimax-portal", api: "anthropic-messages", baseUrl: "https://api.minimax.io", modelCount: 1, enabledModelCount: 1, containsPrimary: true },
        { id: "nvidia", api: "openai-completions", baseUrl: "https://nvidia.example/v1", modelCount: 2, enabledModelCount: 1, containsPrimary: false }
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "minimax-portal/MiniMax-M3",
          providerId: "minimax-portal",
          modelId: "MiniMax-M3",
          name: "MiniMax M3",
          alias: "mm3",
          enabled: true,
          isPrimary: true
        },
        {
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          providerId: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek",
          alias: undefined,
          enabled: true,
          isPrimary: false
        },
        {
          ref: "nvidia/llama-3",
          providerId: "nvidia",
          modelId: "llama-3",
          name: "Llama 3",
          alias: undefined,
          enabled: false,
          isPrimary: false
        }
      ]
    }));
    const client = mockClient({ getProviders, getModels });

    const searchView = render(<ModelsView client={client} />);
    expect(await searchView.findByText("当前主模型")).toBeTruthy();
    await userEvent.type(await searchView.findByLabelText("搜索模型"), "deepseek");
    expect(await searchView.findByText("nvidia/deepseek-ai/deepseek-v4-flash")).toBeTruthy();
    await waitFor(() => expect(searchView.queryByText("minimax-portal/MiniMax-M3")).toBeNull());
    searchView.unmount();

    const filterView = render(<ModelsView client={client} />);
    await userEvent.selectOptions(await filterView.findByLabelText("Provider 筛选"), "minimax-portal");
    expect(await filterView.findByText("minimax-portal/MiniMax-M3")).toBeTruthy();
    await waitFor(() => expect(filterView.queryByText("nvidia/llama-3")).toBeNull());
  });

  test("adds model from global Models page with structured fields", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-pro" }));
    const getProviders = mock(async () => ({
      providers: [
        { id: "nvidia", api: "openai-completions", baseUrl: "https://nvidia.example/v1", modelCount: 1, enabledModelCount: 1, containsPrimary: false }
      ]
    }));
    const getModels = mock(async () => ({ models: [] }));

    const { findByLabelText, findByText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, createModel })} />
    );

    await userEvent.click(await findByText("添加模型"));
    await userEvent.selectOptions(await findByLabelText("Provider"), "nvidia");
    await userEvent.type(await findByLabelText("Model ID"), "deepseek-ai/deepseek-v4-pro");
    await userEvent.type(await findByLabelText("Name"), "DeepSeek V4 Pro");
    await userEvent.type(await findByLabelText("Alias"), "ds-pro");
    await userEvent.selectOptions(await findByLabelText("API"), "openai-completions");
    await userEvent.selectOptions(await findByLabelText("Reasoning"), "true");
    await userEvent.type(await findByLabelText("Context Window"), "128000");
    await userEvent.type(await findByLabelText("Max Tokens"), "8192");
    await userEvent.type(await findByLabelText("Input"), "text\nimage");
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
        { id: "nvidia", api: "openai-completions", baseUrl: "https://nvidia.example/v1", modelCount: 1, enabledModelCount: 1, containsPrimary: false }
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          providerId: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek Flash",
          alias: "flash",
          enabled: true,
          isPrimary: false,
          reasoning: false
        }
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

  test("rejects invalid numeric model fields before submit", async () => {
    const createModel = mock(async () => ({ ok: true, ref: "nvidia/bad-window" }));
    const getProviders = mock(async () => ({
      providers: [
        { id: "nvidia", api: "openai-completions", baseUrl: "https://nvidia.example/v1", modelCount: 1, enabledModelCount: 1, containsPrimary: false }
      ]
    }));
    const getModels = mock(async () => ({ models: [] }));

    const { findByLabelText, findByText, getByText } = render(
      <ModelsView client={mockClient({ getModels, getProviders, createModel })} />
    );

    await userEvent.click(await findByText("添加模型"));
    await userEvent.type(await findByLabelText("Model ID"), "bad-window");
    await userEvent.type(await findByLabelText("Context Window"), "abc");
    await userEvent.click(getByText("保存模型"));

    expect(await findByText("Context Window 必须是正整数")).toBeTruthy();
    expect(createModel).not.toHaveBeenCalled();
  });
});

describe("ProvidersView", () => {
  test("shows provider id, api type, counts, and primary marker", async () => {
    const { findAllByText, findByText } = render(
      <ProvidersView
        client={mockClient({
          getProviders: async () => ({
            providers: [
              {
                id: "nvidia",
                api: "openai-completions",
                baseUrl: "https://integrate.api.nvidia.com/v1",
                modelCount: 2,
                enabledModelCount: 1,
                containsPrimary: true
              }
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
        {
          id: "minimax-portal",
          api: "anthropic-messages",
          baseUrl: "https://api.minimax.io",
          modelCount: 1,
          enabledModelCount: 1,
          containsPrimary: true
        }
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "minimax-portal/MiniMax-M3",
          providerId: "minimax-portal",
          modelId: "MiniMax-M3",
          name: "MiniMax M3",
          alias: "mm3",
          enabled: true,
          isPrimary: true
        },
        {
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          providerId: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek",
          alias: "nv",
          enabled: true,
          isPrimary: false
        }
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
        {
          id: "nvidia",
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 1,
          enabledModelCount: 1,
          containsPrimary: false
        }
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          providerId: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek Flash",
          alias: "flash",
          enabled: true,
          isPrimary: false
        }
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
      enabled: true
    });
  });

  test("deleting primary model from provider manager defaults to a different new primary", async () => {
    const deleteModel = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash" }));
    const getProviders = mock(async () => ({
      providers: [
        {
          id: "nvidia",
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 1,
          enabledModelCount: 1,
          containsPrimary: true
        }
      ]
    }));
    const getModels = mock(async () => ({
      models: [
        {
          ref: "nvidia/deepseek-ai/deepseek-v4-flash",
          providerId: "nvidia",
          modelId: "deepseek-ai/deepseek-v4-flash",
          name: "DeepSeek Flash",
          alias: "flash",
          enabled: true,
          isPrimary: true
        },
        {
          ref: "minimax-portal/MiniMax-M3",
          providerId: "minimax-portal",
          modelId: "MiniMax-M3",
          name: "MiniMax M3",
          alias: "mm3",
          enabled: true,
          isPrimary: false
        }
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

  test("adds custom provider through preview and confirm without rendering api key", async () => {
    const previewCustomProvider = mock(async () => ({
      providersAdded: ["custom-openai"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["custom-openai/model-a", "custom-openai/vendor/model-b"],
      modelsDisabled: [],
      primaryChanged: null
    }));
    const addCustomProvider = mock(async () => ({ ok: true }));
    const getProviders = mock(async () => ({
      providers: [
        {
          id: "nvidia",
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          enabledModelCount: 1,
          containsPrimary: false
        }
      ]
    }));

    const { findByLabelText, findByText, getByText, queryByText } = render(
      <ProvidersView client={mockClient({ getProviders, previewCustomProvider, addCustomProvider })} />
    );

    await userEvent.click(await findByText("添加 Provider"));
    await userEvent.type(await findByLabelText("供应商名称"), "Custom OpenAI");
    const providerIdInput = await findByLabelText("Provider ID");
    await userEvent.clear(providerIdInput);
    await userEvent.type(providerIdInput, "custom-openai");
    await userEvent.type(await findByLabelText("官网链接"), "https://custom.example");
    await userEvent.type(await findByLabelText("备注"), "Company account");
    await userEvent.type(await findByLabelText("API Key"), "sk-test-custom-secret");
    await userEvent.type(await findByLabelText("请求地址"), "https://api.custom.example");
    await userEvent.type(await findByLabelText("模型列表"), "model-a | a\nvendor/model-b | b");
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
        { id: "model-a", alias: "a" },
        { id: "vendor/model-b", alias: "b" }
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
        { id: "model-a", alias: "a" },
        { id: "vendor/model-b", alias: "b" }
      ],
      enableAllModels: true
    }, "sk-test-custom-secret");
    expect(queryByText("sk-test-custom-secret")).toBeNull();
  });

  test("clears custom provider api key when dialog is cancelled", async () => {
    const getProviders = mock(async () => ({
      providers: [
        {
          id: "nvidia",
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          enabledModelCount: 1,
          containsPrimary: false
        }
      ]
    }));

    const { findByLabelText, findByText, getByText } = render(
      <ProvidersView client={mockClient({ getProviders })} />
    );

    await userEvent.click(await findByText("添加 Provider"));
    const keyInput = await findByLabelText("API Key", { exact: true }) as HTMLInputElement;
    await userEvent.type(keyInput, "sk-test-custom-secret");
    await userEvent.click(getByText("取消"));

    await userEvent.click(getByText("添加 Provider"));
    expect((await findByLabelText("API Key", { exact: true }) as HTMLInputElement).value).toBe("");
  });

  test("edits provider base URL and API key without rendering the key", async () => {
    const updateProvider = mock(async () => ({ ok: true }));
    const getProviders = mock(async () => ({
      providers: [
        {
          id: "nvidia",
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          enabledModelCount: 1,
          containsPrimary: false
        }
      ]
    }));

    const { findByLabelText, getByText, queryByText } = render(
      <ProvidersView client={mockClient({ getProviders, updateProvider })} />
    );

    await userEvent.click(await findByLabelText("编辑 nvidia"));
    const baseUrlInput = await findByLabelText("Provider baseUrl");
    await userEvent.clear(baseUrlInput);
    await userEvent.type(baseUrlInput, "https://new-nvidia.example/v1");
    await userEvent.type(await findByLabelText("Provider API Key 新值"), "sk-new-secret");
    await userEvent.click(getByText("保存 Provider"));

    expect(updateProvider).toHaveBeenCalledWith("nvidia", {
      baseUrl: "https://new-nvidia.example/v1",
      apiKey: "sk-new-secret"
    });
    expect(queryByText("sk-new-secret")).toBeNull();
  });

  test("syncs provider models and shows added model count", async () => {
    const syncProvider = mock(async () => ({ ok: true, addedModelIds: ["remote-model-a"] }));
    const getProviders = mock(async () => ({
      providers: [
        {
          id: "nvidia",
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          modelCount: 2,
          enabledModelCount: 1,
          containsPrimary: false
        }
      ]
    }));

    const { findByLabelText, findByText } = render(
      <ProvidersView client={mockClient({ getProviders, syncProvider })} />
    );

    await userEvent.click(await findByLabelText("同步 nvidia"));

    expect(syncProvider).toHaveBeenCalledWith("nvidia");
    expect(await findByText("同步完成：新增 1 个模型")).toBeTruthy();
  });
});

describe("PresetsView", () => {
  test("sends apiKey only in request body and never renders it after submit", async () => {
    const addProvider = mock(async () => ({ ok: true }));
    const previewAddProvider = mock(async () => ({
      providersAdded: ["nvidia"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["nvidia/deepseek-ai/deepseek-v4-flash"],
      modelsDisabled: [],
      primaryChanged: null
    }));
    const getPresets = mock(async () => ({
      presets: [{ id: "nvidia", name: "NVIDIA", source: "builtin" as const, tags: [], modelCount: 1 }]
    }));
    const getDiff = mock(async () => { throw new Error("getDiff should not be used for preset preview"); });

    const { findByLabelText, findByText, getByText, queryByText } = render(
      <PresetsView client={mockClient({ getPresets, getDiff, previewAddProvider, addProvider })} />
    );

    const keyInput = await findByLabelText("API Key");
    await userEvent.type(keyInput, "sk-test-secret-key");
    await userEvent.click(getByText("预览并添加"));
    await userEvent.click(getByText("确认"));

    expect(previewAddProvider).toHaveBeenCalledWith("nvidia");
    expect(addProvider).toHaveBeenCalledWith("nvidia", "sk-test-secret-key");
    expect(getDiff).not.toHaveBeenCalled();
    expect(queryByText("sk-test-secret-key")).toBeNull();
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
          primaryChanged: { before: "x/y", after: "a/b" }
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
    envPaths: []
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
    expect(await findByText("openclaw gateway restart")).toBeTruthy();
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
            envPaths: [{ path: "/default/.env", source: "openclaw-default", label: "OpenClaw 默认路径", recommended: false, exists: true, readable: true, writable: true, parentWritable: true }]
          }),
          updatePathSettings: putPaths,
          getEnvIndex: async () => ({ variables: [], warnings: [] })
        })}
      />
    );

    expect(await findByText(/未能确认运行中 OpenClaw 使用的 env 文件/)).toBeTruthy();
    await userEvent.type(await findByLabelText("手动 openclaw.json 路径"), "/manual/openclaw.json");
    await userEvent.type(await findByLabelText("手动 .env 路径"), "/manual/.env");
    await userEvent.click(getByText("使用手动路径"));
    await userEvent.click(getByText("切换路径"));

    expect(putPaths).toHaveBeenCalledWith("/manual/openclaw.json", "/manual/.env");
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

    expect(await findByText(/高级：额外托管变量/)).toBeTruthy();
    expect(queryByText("SOME_MCP_EPID")).toBeNull();
  });

  test("updates provider env var and clears input after submit", async () => {
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["NVIDIA_API_KEY"],
      requiresConfirmation: false,
      warnings: [],
      backupWillIncludeSecrets: true
    }));
    const updateEnvVar = mock(async () => ({ ok: true as const, affectedKeys: ["NVIDIA_API_KEY"] }));
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

    const { findByLabelText, getByText } = render(
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

    const input = await findByLabelText("NVIDIA_API_KEY 新值");
    await userEvent.type(input, "brand-new-secret");
    await userEvent.click(getByText("重填"));
    await waitFor(() => expect(updateEnvVar).toHaveBeenCalled());
    expect(updateEnvVar).toHaveBeenCalledWith({
      type: "upsert",
      envVar: "NVIDIA_API_KEY",
      value: "brand-new-secret"
    });
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  });

  test("shows migration confirmation for unmanaged provider env var", async () => {
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["NVIDIA_API_KEY"],
      requiresConfirmation: true,
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
  });

  test("renames advanced managed env var without rendering its secret", async () => {
    const previewEnvVar = mock(async () => ({
      affectedKeys: ["SOME_MCP_EPID", "SOME_MCP_EPID_NEXT"],
      requiresConfirmation: false,
      warnings: [],
      backupWillIncludeSecrets: true
    }));
    const renameEnvVar = mock(async () => ({ ok: true as const, affectedKeys: ["SOME_MCP_EPID", "SOME_MCP_EPID_NEXT"] }));

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

    await userEvent.click(await findByText(/高级：额外托管变量/));
    await userEvent.type(await findByLabelText("SOME_MCP_EPID 新变量名"), "SOME_MCP_EPID_NEXT");
    await userEvent.click(getByText("重命名"));
    await waitFor(() => expect(renameEnvVar).toHaveBeenCalledWith({
      type: "rename",
      fromEnvVar: "SOME_MCP_EPID",
      toEnvVar: "SOME_MCP_EPID_NEXT",
      note: "MCP endpoint id"
    }));
    expect(queryByText("epid-secret")).toBeNull();
  });
});

describe("App shell", () => {
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
  });
});
