import "./test-setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffSummary } from "./components/DiffSummary";
import { createApiClient, type ApiClient } from "./api";
import { Dashboard } from "./views/Dashboard";
import { ModelsView } from "./views/ModelsView";
import { ProvidersView } from "./views/ProvidersView";
import { PresetsView } from "./views/PresetsView";
import { BackupsView } from "./views/BackupsView";
import { SettingsView } from "./views/SettingsView";

afterEach(() => cleanup());

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
    const { findByText } = render(
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
});

describe("ModelsView", () => {
  test("calls setPrimary with slash-containing ref", async () => {
    const setPrimary = mock(async () => ({ ok: true, ref: "nvidia/deepseek-ai/deepseek-v4-flash" }));
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

    const { findByLabelText } = render(<ModelsView client={mockClient({ getModels, setPrimary })} />);

    const btn = await findByLabelText("设为主模型 nvidia/deepseek-ai/deepseek-v4-flash");
    await userEvent.click(btn);

    expect(setPrimary).toHaveBeenCalledWith("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("enables/disables via PATCH body not URL path", async () => {
    const patchModel = mock(async () => ({ ok: true, ref: "a/b/c", enabled: false }));
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

    const { findByLabelText } = render(<ModelsView client={mockClient({ getModels, patchModel })} />);

    const btn = await findByLabelText("禁用 a/b/c");
    await userEvent.click(btn);

    expect(patchModel).toHaveBeenCalledWith("a/b/c", false);
  });
});

describe("ProvidersView", () => {
  test("shows provider id, api type, counts, and primary marker", async () => {
    const { findByText } = render(
      <ProvidersView
        client={mockClient({
          getProviders: async () => ({
            providers: [
              {
                id: "nvidia",
                api: "openai-completions",
                modelCount: 2,
                enabledModelCount: 1,
                containsPrimary: true
              }
            ]
          })
        })}
      />
    );

    expect(await findByText(/nvidia/)).toBeTruthy();
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

    const { findByLabelText, getByText, queryByText } = render(
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
            backups: [{ id: "2024-01-01T00-00-00", createdAt: "2024-01-01", reason: "test write" }]
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
  test("shows non-secret settings", async () => {
    const { findByText } = render(
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
          })
        })}
      />
    );

    expect(await findByText(/openclaw\.json/)).toBeTruthy();
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
          cleanupOrphanEnvKeys
        })}
      />
    );

    expect(await findByText("OLD_API_KEY")).toBeTruthy();
    await userEvent.click(getByText("清理 orphan keys"));
    expect(cleanupOrphanEnvKeys).toHaveBeenCalled();
  });
});
