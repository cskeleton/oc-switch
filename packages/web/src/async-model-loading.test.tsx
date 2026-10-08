import "./test-setup";
import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApiClient, type ApiClient, type ModelInventory, type ModelInventoryEntry, type PluginExtensionsSnapshot, type StaticModelConfigSnapshot } from "./api";
import { ProviderModelsDialog } from "./components/ProviderModelsDialog";
import { Dashboard } from "./views/Dashboard";
import { ModelsView } from "./views/ModelsView";
import { ProvidersView } from "./views/ProvidersView";
import { ToastProvider } from "./components/Toast";
import { emptyExtensions, providerSummary, staticModel, staticSnapshot } from "./test-fixtures";

afterEach(cleanup);

const omenEntry: ModelInventoryEntry = { ref: "opencode/omen-alpha", providerId: "opencode", modelId: "omen-alpha", pickerVisible: true, inactive: false, needsAttention: false,
  catalogSources: ["openclaw-runtime"], referenceSources: ["legacy-metadata", "policy-exact"], policyMode: "restricted", selectionSource: "policy-exact", policyAllowed: true,
  availability: "available", availabilityReasons: [], pluginIds: ["opencode"], capabilities: { canTogglePolicy: true, canSetPrimary: true, canEditCatalogEntry: false, canMaterializeConfigModel: true, canRemovePolicyExactRef: true, canRemoveDanglingMetadata: false } };

test("同步参数保留已读取的插件运行视图，不切回manifest表或重复探测", async () => {
  const inventory = { ...runtime(), plugins: [{ id: "cpa-plugin", enabled: true, providerIds: ["cpa"], origin: "bundled", nonModelCapabilities: [] }],
    providers: [{ providerId: "cpa", sources: ["config", "plugin-manifest"], pluginIds: ["cpa-plugin"], pluginEnabled: true, disabled: false, availability: "available", availabilityReasons: [], modelCount: 1, pickerModelCount: 1, policyAllowedModelCount: 1, availableModelCount: 1, unavailableModelCount: 0, capabilities: { canEditConnection: true, canManageModels: true, canDisableProvider: true, canSetApiKey: true } }] } as ModelInventory;
  const readRuntime = mock(async () => inventory);
  const api = client({ getModelInventory: readRuntime, syncProviderModelMetadata: async () => ({ ok: true, providerId: "cpa", updated: [], queued: [], unmatched: [], skipped: [], warnings: [] }) });
  const view = render(<ToastProvider><ProvidersView client={api} /></ToastProvider>);
  await userEvent.click(await view.findByRole("button", { name: "展开插件 cpa-plugin" }));
  await view.findByText("1 选项 / 1 目录");
  await userEvent.click(view.getAllByRole("button", { name: "更多操作 cpa" })[0]!);
  await userEvent.click(await view.findByRole("menuitem", { name: "同步参数 cpa" }));
  await view.findByText(/已回填 0/);
  await waitFor(() => expect(view.getByText("1 选项 / 1 目录")).toBeTruthy());
  expect(view.queryByText("目录模型")).toBeNull();
  expect(readRuntime).toHaveBeenCalledTimes(1);
});

test("运行时omen模型不能删目录，但可明确移除精确放行与metadata引用", async () => {
  const providers = [providerSummary({ id: "opencode" })];
  let removed = false;
  const removeRef = mock(async () => { removed = true; return { ok: true as const, backupId: "fixture", warnings: [], ref: "opencode/omen-alpha" }; });
  const api = client({ getModelConfig: async () => staticSnapshot({ providers, models: removed ? [] : [staticModel({ ref: "opencode/omen-alpha", enabled: true }, { catalogConfigured: false })] }), removeModelPolicyExactRef: removeRef });
  const view = render(<ToastProvider><ProviderModelsDialog open provider={providers[0]!} providers={providers} client={api} inventoryModels={[omenEntry]} onCancel={() => {}} onChanged={() => {}} /></ToastProvider>);
  await view.findByText("使用引用");
  expect(view.queryByLabelText("删除模型 opencode/omen-alpha")).toBeNull();
  await userEvent.click(view.getByRole("button", { name: "移除使用引用 opencode/omen-alpha" }));
  const dialog = within(view.getAllByRole("dialog").find(element => element.textContent?.includes("确认移除"))!);
  expect(dialog.getByText(/插件与运行时目录中的模型保留/)).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "移除引用" }));
  await waitFor(() => expect(removeRef).toHaveBeenCalledWith("opencode/omen-alpha", true));
  await waitFor(() => expect(view.queryByText("opencode/omen-alpha")).toBeNull());
});

test("引用证据未读取时不伪装为启用，只在明确检查后开放引用清理", async () => {
  const providers = [providerSummary({ id: "opencode" })];
  const refresh = mock(async () => ({ ...runtime(), models: [omenEntry] }));
  const api = client({ getModelConfig: async () => staticSnapshot({ providers, models: [staticModel({ ref: "opencode/omen-alpha", enabled: true }, { catalogConfigured: false })] }), refreshModelInventory: refresh });
  const view = render(<ToastProvider><ProviderModelsDialog open provider={providers[0]!} providers={providers} client={api} onCancel={() => {}} onChanged={() => {}} /></ToastProvider>);
  await view.findByText("使用引用");
  expect(refresh).not.toHaveBeenCalled();
  await userEvent.click(view.getByRole("button", { name: "检查引用 opencode/omen-alpha" }));
  await view.findByRole("button", { name: "移除使用引用 opencode/omen-alpha" });
  expect(refresh).toHaveBeenCalledTimes(1);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const local = () => staticSnapshot({
  providers: [providerSummary({ id: "cpa", containsPrimary: false })],
  models: [staticModel({ ref: "cpa/model", enabled: true })],
  status: { primaryModel: "cpa/model", providerCount: 1, providerModelCount: 1, allowlistModelCount: 1, modelPolicyMode: "restricted", effectiveModelCount: 1 }
});
const runtime = (): ModelInventory => ({ schemaVersion: 2, pickerSource: "gateway", policyMode: "restricted", policyRevision: "v1:fixture", models: [], providers: [], plugins: [], policyRules: [], diagnostics: [], summary: { modelCount: 0, policyAllowedCount: 0, availableCount: 0, unavailableCount: 0, unknownCount: 0 } });
function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    ...createApiClient({ baseUrl: "http://fixture.invalid", token: "fixture", fetchImpl: async () => { throw new Error("Unexpected fixture request"); } }),
    getModelConfig: async () => local(), getModelExtensions: async () => emptyExtensions(), getModelInventory: async () => runtime(), refreshModelInventory: async () => runtime(), getModelAttention: async () => ({ pending: [], ignored: [] }),
    getHealth: async () => ({ caseDuplicateGroups: [], summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 } }),
    getDiff: async () => ({ providersAdded: [], providersRemoved: [], providersChanged: [], modelsEnabled: [], modelsDisabled: [], primaryChanged: null, credentialsChanged: [], providerStateChanges: [], providerFieldChanges: [] }),
    getProviderSecretRefMigrations: async () => ({ candidates: [], summary: { candidateCount: 0, readyCount: 0, blockedCount: 0 } }), getModelMetadataSyncQueue: async () => ({ items: [] }),
    ...overrides
  };
}
function models(api: ApiClient) { return render(<ToastProvider><ModelsView client={api} /></ToastProvider>); }

test("三个页面的本地配置不等待插件/运行时，失败保留配置和明确提示", async () => {
  for (const kind of ["models", "providers", "dashboard"] as const) {
    const probe = deferred<ModelInventory>();
    const extensions = deferred<PluginExtensionsSnapshot>();
    const api = client({ getModelInventory: () => probe.promise, getModelExtensions: () => extensions.promise });
    const view = render(<ToastProvider>{kind === "models" ? <ModelsView client={api} /> : kind === "providers" ? <ProvidersView client={api} /> : <Dashboard client={api} />}</ToastProvider>);
    await view.findByText(kind === "providers" ? "cpa" : "cpa/model");
    expect(await view.findByText("正在检查 OpenClaw / Gateway…")).toBeTruthy();
    expect(await view.findByText("正在读取插件目录…")).toBeTruthy();
    await act(async () => { probe.reject(new Error("probe timed out")); extensions.reject(new Error("plugin timed out")); });
    expect(await view.findByText(/运行时未确认：probe timed out/)).toBeTruthy();
    expect(await view.findByText(/插件目录未取得：plugin timed out/)).toBeTruthy();
    expect(view.getByText(kind === "providers" ? "cpa" : "cpa/model")).toBeTruthy();
    view.unmount();
  }
});

test("模型保存有可读进度，只重读静态配置，旧runtime响应不能盖过新保存", async () => {
  const probe = deferred<ModelInventory>();
  const write = deferred<{ ok: boolean; ref: string; enabled: boolean }>();
  let enabled = true;
  const config = mock(async () => ({ ...local(), models: [staticModel({ ref: "cpa/model", enabled })] }));
  const readRuntime = mock(() => probe.promise);
  const attention = mock(async () => ({ pending: [], ignored: [] }));
  const view = models(client({ getModelConfig: config, getModelInventory: readRuntime, getModelAttention: attention, patchModel: () => write.promise }));
  await userEvent.click(await view.findByRole("switch", { name: "禁用 cpa/model" }));
  const working = await view.findByText("正在保存本地配置…");
  expect(working.closest('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
  expect((view.getByRole("switch", { name: "禁用 cpa/model" }) as HTMLButtonElement).disabled).toBe(true);
  enabled = false;
  await act(async () => { write.resolve({ ok: true, ref: "cpa/model", enabled: false }); });
  await view.findByRole("switch", { name: "启用 cpa/model" });
  expect(config).toHaveBeenCalledTimes(2);
  expect(readRuntime).toHaveBeenCalledTimes(1);
  expect(attention).not.toHaveBeenCalled();
  await act(async () => { probe.resolve({ ...runtime(), diagnostics: [{ command: "list", code: "invalid-json", message: "OLD DIAGNOSTIC" }] }); });
  expect(view.queryByText(/OLD DIAGNOSTIC/) === null).toBe(true);
  expect((await view.findAllByText(/在线状态待确认/)).length).toBeGreaterThan(0);
});

test("显式检查只发一次refresh和attention，Gateway未确认及诊断不会视为成功", async () => {
  const force = deferred<ModelInventory>();
  const refresh = mock(() => force.promise);
  const attention = mock(async () => ({ pending: [], ignored: [] }));
  const view = models(client({ refreshModelInventory: refresh, getModelAttention: attention }));
  await view.findByText("cpa/model");
  await waitFor(() => expect(attention).toHaveBeenCalledTimes(1));
  await userEvent.click(view.getByRole("button", { name: "检查并确认" }));
  expect((view.getByRole("button", { name: "检查并确认" }) as HTMLButtonElement).disabled).toBe(true);
  expect(view.getByText("正在检查 OpenClaw / Gateway…")).toBeTruthy();
  await act(async () => { force.resolve({ ...runtime(), pickerSource: "inferred", diagnostics: [{ command: "list", code: "invalid-json", message: "CLI JSON invalid" }] }); });
  expect(await view.findByText(/CLI JSON invalid/)).toBeTruthy();
  expect(await view.findByText(/尚未确认与在线 Gateway 一致/)).toBeTruthy();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(attention).toHaveBeenCalledTimes(2);
});

test("Provider保存进度在对话框中可见，保存后不会重新读完整inventory", async () => {
  const write = deferred<{ ok: boolean; id: string }>();
  const readRuntime = mock(async () => runtime());
  const api = client({ getModelInventory: readRuntime, updateProvider: () => write.promise });
  const view = render(<ToastProvider><ProvidersView client={api} /></ToastProvider>);
  await userEvent.click(await view.findByRole("button", { name: "更多操作 cpa" }));
  await userEvent.click(await view.findByLabelText("编辑 cpa"));
  const dialog = within(view.getByRole("dialog"));
  await userEvent.click(dialog.getByRole("button", { name: "保存 Provider" }));
  expect(await dialog.findByText("正在保存本地配置…")).toBeTruthy();
  expect((dialog.getByRole("button", { name: "保存中…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { write.resolve({ ok: true, id: "cpa" }); });
  await waitFor(() => expect(view.queryByRole("dialog") === null).toBe(true));
  expect(readRuntime).toHaveBeenCalledTimes(1);
  expect((await view.findAllByText(/在线状态待确认/)).length).toBeGreaterThan(0);
});

test("插件同名贡献加载后仍保留本地CPA Provider", async () => {
  const extension = deferred<PluginExtensionsSnapshot>();
  const probe = deferred<ModelInventory>();
  const view = render(<ToastProvider><ProvidersView client={client({ getModelInventory: () => probe.promise, getModelExtensions: () => extension.promise })} /></ToastProvider>);
  const staticTable = within(await view.findByTestId("static-providers"));
  expect(await staticTable.findByText("cpa")).toBeTruthy();
  await act(async () => { extension.resolve({ ...emptyExtensions(), providers: [{ pluginId: "cpa-plugin", providerId: "cpa", origin: "bundled", enabled: true, models: [{ id: "plugin-model" }], apiKeyEnvVars: [] }], plugins: [{ id: "cpa-plugin", origin: "bundled", enabled: true, providerIds: ["cpa"], nonModelCapabilities: ["tools"] }] }); });
  await view.findByRole("button", { name: "展开插件 cpa-plugin" });
  expect(staticTable.getByText("cpa")).toBeTruthy();
});


test("跨页定位插件Provider等待插件声明后打开正确Key表单", async () => {
  const extension = deferred<PluginExtensionsSnapshot>();
  const handled = mock(() => {});
  const view = render(<ToastProvider><ProvidersView requestedProviderId="plugin-channel" onRequestHandled={handled} client={client({ getModelExtensions: () => extension.promise })} /></ToastProvider>);
  await view.findByText("cpa");
  expect(handled).not.toHaveBeenCalled();
  expect(view.queryByRole("dialog") === null).toBe(true);
  await act(async () => { extension.resolve({ ...emptyExtensions(), providers: [{ pluginId: "channel", providerId: "plugin-channel", origin: "bundled", enabled: true, models: [], apiKeyEnvVars: ["CHANNEL_API_KEY"] }], plugins: [{ id: "channel", origin: "bundled", enabled: true, providerIds: ["plugin-channel"], nonModelCapabilities: [] }] }); });
  expect(await view.findByText("设置插件 Provider 的 API Key")).toBeTruthy();
  expect(await view.findByText(/plugin-channel → CHANNEL_API_KEY/)).toBeTruthy();
  expect(handled).toHaveBeenCalled();
});
