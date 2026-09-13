import "./test-setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createApiClient,
  type ApiClient,
  type ModelInventory,
  type ModelInventoryEntry,
  type ModelPluginDescriptor,
  type PluginStateMutationResult,
  type ProviderInventoryEntry
} from "./api";
import { ToastProvider } from "./components/Toast";
import { ModelPolicyPanel } from "./components/ModelPolicyPanel";
import { ModelStateBadges } from "./components/ModelStateBadges";
import { UnavailableModelsPanel } from "./components/UnavailableModelsPanel";
import { PluginProviderGroup } from "./components/PluginProviderGroup";
import { ModelsView } from "./views/ModelsView";
import { ProvidersView } from "./views/ProvidersView";
import { modelSummary, providerSummary } from "./test-fixtures";

afterEach(() => {
  cleanup();
  mock.restore();
});

// 显式给定 Core 能力，不在 fixture 中重新实现 policy / runtime 协调算法。
function model(ref: string, overrides: Partial<ModelInventoryEntry> = {}): ModelInventoryEntry {
  const slash = ref.indexOf("/");
  return {
    ref,
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
    catalogSources: [],
    referenceSources: ["policy-exact"],
    policyMode: "restricted",
    selectionSource: "policy-exact",
    policyAllowed: true,
    availability: "unavailable",
    availabilityReasons: ["model-not-in-catalog"],
    pluginIds: [],
    capabilities: {
      canTogglePolicy: false,
      canSetPrimary: false,
      canEditCatalogEntry: false,
      canMaterializeConfigModel: false,
      canRemovePolicyExactRef: false
    },
    ...overrides
  };
}

function provider(providerId: string, overrides: Partial<ProviderInventoryEntry> = {}): ProviderInventoryEntry {
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
    capabilities: { canEditConnection: true, canManageModels: true, canDisableProvider: true, canSetApiKey: true },
    ...overrides
  };
}

function inventory(models: ModelInventoryEntry[] = [], overrides: Partial<ModelInventory> = {}): ModelInventory {
  return {
    models,
    providers: [provider("local")],
    plugins: [],
    policyRules: [],
    diagnostics: [],
    summary: {
      modelCount: models.length,
      policyAllowedCount: models.filter(row => row.policyAllowed).length,
      availableCount: models.filter(row => row.availability === "available").length,
      unavailableCount: models.filter(row => row.availability === "unavailable").length,
      unknownCount: models.filter(row => row.availability === "unknown").length
    },
    ...overrides
  };
}

function clientFor(data: ModelInventory, overrides: Partial<ApiClient> = {}): ApiClient {
  // 任何未声明请求直接失败；没有网络、Server、CLI 或真实 OpenClaw 路径。
  const client = createApiClient({
    baseUrl: "http://fixture.invalid",
    token: "fixture-token",
    fetchImpl: async input => { throw new Error(`Unexpected fixture request: ${input}`); }
  });
  return {
    ...client,
    getModelInventory: async () => data,
    refreshModelInventory: async () => data,
    getProviders: async () => ({ providers: [providerSummary({ id: "local" })] }),
    ...overrides
  };
}

function renderModels(data: ModelInventory, overrides: Partial<ApiClient> = {}) {
  return render(<ToastProvider><ModelsView client={clientFor(data, overrides)} /></ToastProvider>);
}

function renderProviders(data: ModelInventory, overrides: Partial<ApiClient> = {}) {
  return render(<ToastProvider><ProvidersView client={clientFor(data, overrides)} /></ToastProvider>);
}

test("插件默认紧凑折叠，已停用标签原位替换结果", async () => {
  const active = { id: "alpha", enabled: true, origin: "bundled", providerIds: ["one"], nonModelCapabilities: [] };
  const stopped = { ...active, id: "beta", enabled: false, providerIds: ["two"] };
  const data = inventory([], { schemaVersion: 2, pickerSource: "gateway", plugins: [active, stopped], providers: [provider("one", { pluginIds: ["alpha"], sources: ["plugin-manifest"], pickerModelCount: 2 }), provider("two", { pluginIds: ["beta"], pluginEnabled: false, sources: ["plugin-manifest"], pickerModelCount: 0 })] });
  const view = renderProviders(data, { getProviders: async () => ({ providers: [] }), getModelAttention: async () => ({ pending: [], ignored: [] }) });
  const expand = await view.findByRole("button", { name: "展开插件 alpha" });
  expect(view.queryByText("one", { exact: true }) === null).toBe(true);
  await userEvent.click(expand);
  expect(await view.findByText("one", { exact: true })).toBeTruthy();
  await userEvent.click(view.getByRole("tab", { name: /已停用/ }));
  expect(await view.findByRole("button", { name: "展开插件 beta" })).toBeTruthy();
  expect(view.queryByRole("button", { name: /插件 alpha/ }) === null).toBe(true);
});

test("插件启用但 Provider 已关闭：状态可见且归入已停用", async () => {
  const data = inventory([], {
    schemaVersion: 2,
    pickerSource: "gateway",
    plugins: [{ id: "nvidia", origin: "bundled", enabled: true, providerIds: ["nvidia"], nonModelCapabilities: [] }],
    providers: [provider("nvidia", {
      sources: ["config", "plugin-manifest", "openclaw-runtime"],
      pluginIds: ["nvidia"],
      pluginEnabled: true,
      disabled: true,
      pickerModelCount: 0,
      modelCount: 16,
      policyAllowedModelCount: 0
    })]
  });
  const view = renderProviders(data, {
    getProviders: async () => ({ providers: [providerSummary({ id: "nvidia", disabled: true, modelCount: 16, enabledModelCount: 0 })] }),
    getModelAttention: async () => ({ pending: [], ignored: [] })
  });

  // 默认「当前使用」不出现：插件启用但 Provider 已关闭不算在用
  expect(view.queryByRole("button", { name: /插件 nvidia/ }) === null).toBe(true);

  await userEvent.click(view.getByRole("tab", { name: /已停用/ }));
  const expand = await view.findByRole("button", { name: "展开插件 nvidia" });
  // 组头同时呈现两个维度：插件「已启用」+「Provider 已关闭」
  expect(await view.findByText("Provider 已关闭")).toBeTruthy();
  await userEvent.click(expand);
  const group = expand.closest("section")!;
  // Provider 行状态列显示「已关闭」，不再只显示「可用」运行状态
  expect(within(group).getByText("已关闭")).toBeTruthy();
  expect(within(group).queryByText("可用") === null).toBe(true);
});

test("默认模型列表仅显示 IM 可见选项，闲置配置不列待处理", async () => {
  const data = inventory([
    model("local/visible", { availability: "available", pickerVisible: true, needsAttention: false }),
    model("idle/unused", { availability: "unavailable", pickerVisible: false, inactive: true, needsAttention: false })
  ], { pickerSource: "gateway", providers: [provider("local"), provider("idle")] });
  const view = renderModels(data);
  await view.findByText("local/visible");
  expect(view.queryByText("idle/unused") === null).toBe(true);
  expect(view.queryByTestId("pending-models-panel") === null).toBe(true);
});

function removableModel(ref = "local/retired") {
  const entry = model(ref, { referenceSources: ["policy-exact", "legacy-metadata"] });
  entry.capabilities.canRemovePolicyExactRef = true;
  return entry;
}

const plugin: ModelPluginDescriptor = {
  id: "shared-plugin",
  name: "Shared Plugin",
  origin: "bundled",
  enabled: true,
  providerIds: ["local", "token-plan"],
  nonModelCapabilities: ["tools", "speech", "hooks"]
};

function pluginResult(overrides: Partial<PluginStateMutationResult> = {}): PluginStateMutationResult {
  return {
    ok: true,
    backupId: "fixture-backup",
    pluginId: plugin.id,
    enabled: false,
    affectedProviderIds: plugin.providerIds,
    runtimeConfirmed: true,
    warnings: [],
    ...overrides
  };
}

test("已停用插件的残留选择规则可整组移出，无需展开模型目录", async () => {
  const change = mock(async () => pluginResult());
  const view = render(<ToastProvider><PluginProviderGroup plugin={{ ...plugin, enabled: false }} providers={[]}
    models={[model("local/residual", { pickerVisible: true })]} onSetPluginState={change} /></ToastProvider>);
  expect(view.queryByText("local/residual") === null).toBe(true);
  await userEvent.click(view.getByRole("button", { name: `移出残留模型选项 ${plugin.id}` }));
  await userEvent.click(within(view.getByRole("dialog")).getByRole("button", { name: "确认" }));
  await waitFor(() => expect(change).toHaveBeenCalledWith(plugin.id, false));
});

describe("runtime Web review regressions", () => {
  test("Provider 导航和目录编辑折叠 Provider 大小写，但不折叠 model ID", async () => {
    const upper = model("mixedvendor/Vendor/Model", { catalogSources: ["config"], availability: "available", availabilityReasons: [] });
    const lower = model("mixedvendor/vendor/model", { catalogSources: ["config"], availability: "available", availabilityReasons: [] });
    upper.capabilities.canEditCatalogEntry = true;
    const view = renderModels(inventory([upper, lower], { providers: [provider("MixedVendor", { modelCount: 2 })] }), {
      getModels: async () => ({ models: [
        modelSummary({ ref: "MixedVendor/vendor/model", name: "Wrong case" }),
        modelSummary({ ref: "MixedVendor/Vendor/Model", name: "Right model" })
      ] })
    });
    const navigation = await view.findByRole("button", { name: /^MixedVendor/ });
    expect(within(navigation).getByLabelText("模型数 2")).toBeTruthy();
    expect(await view.findByText(upper.ref)).toBeTruthy();
    expect(await view.findByText(lower.ref)).toBeTruthy();
    expect(view.queryByRole("button", { name: /^补全 Provider 配置 / }) === null).toBe(true);
    await userEvent.click(view.getByRole("button", { name: `编辑模型 ${upper.ref}` }));
    expect((await view.findByLabelText("Name") as HTMLInputElement).value).toBe("Right model");
  });

  test("available 但未获策略允许的 primary/fallback 允许安全开启，开启后仍不可关闭", async () => {
    let data = inventory(["primary", "fallback"].map(source => {
      const row = model(`local/${source}`, {
        catalogSources: ["config"], referenceSources: [source as "primary" | "fallback"],
        policyAllowed: false, availability: "available", availabilityReasons: []
      });
      delete row.selectionSource;
      row.capabilities.canTogglePolicy = true;
      row.capabilities.canEditCatalogEntry = true;
      return row;
    }));
    const patch = mock(async (ref: string, enabled: boolean) => {
      data = inventory(data.models.map(row => row.ref === ref ? {
        ...row, policyAllowed: enabled, selectionSource: "policy-exact",
        capabilities: { ...row.capabilities, canTogglePolicy: false }
      } : row));
      return { ok: true, ref, enabled };
    });
    const view = renderModels(data, { getModelInventory: async () => data, patchModel: patch });
    for (const ref of ["local/primary", "local/fallback"]) {
      await userEvent.click(await view.findByRole("switch", { name: `启用 ${ref}` }));
      await waitFor(() => expect(patch).toHaveBeenCalledWith(ref, true));
      await waitFor(() => expect(view.queryByRole("switch", { name: `启用 ${ref}` }) === null).toBe(true));
      expect(view.queryByRole("switch", { name: `禁用 ${ref}` }) === null).toBe(true);
      expect(view.queryByRole("button", { name: `删除模型 ${ref}` }) === null).toBe(true);
    }
  });

  test("available 且策略不允许的 runtime-only 行可以开启策略，再设主模型", async () => {
    const row = model("local/runtime-only", {
      catalogSources: ["openclaw-runtime"], referenceSources: [],
      availability: "available", availabilityReasons: [], policyAllowed: false
    });
    delete row.selectionSource;
    row.capabilities.canTogglePolicy = true;
    let data = inventory([row]);
    const patchModel = mock(async (ref: string, enabled: boolean) => {
      data = inventory([{ ...row, policyAllowed: enabled, selectionSource: "policy-exact", capabilities: { ...row.capabilities, canSetPrimary: true } }]);
      return { ok: true, ref, enabled };
    });
    const setPrimary = mock(async (ref: string) => ({ ok: true, ref }));
    const view = renderModels(data, { getModelInventory: async () => data, patchModel, setPrimary });
    const toggle = await view.findByRole("switch", { name: "启用 local/runtime-only" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(toggle);
    await waitFor(() => expect(patchModel).toHaveBeenCalledWith(row.ref, true));
    await userEvent.click(await view.findByRole("button", { name: `设为主模型 ${row.ref}` }));
    await waitFor(() => expect(setPrimary).toHaveBeenCalledWith(row.ref));
    expect(view.queryByRole("button", { name: `编辑模型 ${row.ref}` }) === null).toBe(true);
    expect(view.queryByRole("button", { name: `删除模型 ${row.ref}` }) === null).toBe(true);
  });



  test("合法但信息不足的 unknown 不一概描述为 CLI 失败，无原因 unavailable 不伪称 Provider 拒绝", () => {
    const unknown = model("local/nullable", { availability: "unknown", availabilityReasons: ["probe-failed"] });
    const view = render(<ModelStateBadges entry={unknown} />);
    expect(view.getByText("无法确认").getAttribute("title")).toContain("信息不足");
    view.rerender(<UnavailableModelsPanel models={[model("local/unexplained", { availabilityReasons: [] })]} onHandleRef={() => {}} />);
    expect(view.getByText("运行时标记为不可用")).toBeTruthy();
    expect(view.queryByText(/Provider 拒绝/) === null).toBe(true);
  });

  test("Provider 模型管理也阻止 unknown 清理，但可以显式选择其它已知模型", async () => {
    const unknown = model("local/unknown", { catalogSources: ["config"], availability: "unknown", availabilityReasons: ["probe-failed"] });
    const known = model("local/known", { catalogSources: ["config"], availability: "available", availabilityReasons: [], referenceSources: [], policyAllowed: false });
    known.capabilities.canEditCatalogEntry = true;
    const remove = mock(async () => ({ ok: true, removedModelIds: ["known"], warnings: [] as string[] }));
    const view = renderProviders(inventory([unknown, known]), {
      getModels: async () => ({ models: [modelSummary({ ref: unknown.ref, enabled: false }), modelSummary({ ref: known.ref, enabled: false })] }),
      batchRemoveProviderModels: remove
    });
    await userEvent.click(await view.findByRole("button", { name: "管理模型 local" }));
    const unknownSelect = await view.findByRole("checkbox", { name: "选择本地模型 unknown" }) as HTMLInputElement;
    expect(unknownSelect.disabled).toBe(true);
    expect(view.queryByRole("button", { name: `删除模型 ${unknown.ref}` }) === null).toBe(true);
    expect((view.getByRole("button", { name: "只保留已启用模型" }) as HTMLButtonElement).disabled).toBe(true);
    const knownSelect = view.getByRole("checkbox", { name: "选择本地模型 known" }) as HTMLInputElement;
    expect(knownSelect.disabled).toBe(false);
    await userEvent.click(knownSelect);
    await userEvent.click(view.getByRole("button", { name: "删除所选模型" }));
    await userEvent.click(view.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("local", { modelIds: ["known"] }));
  });

  test("可编辑目录不等于可删除：保护主模型、fallback 和最后 exact；wildcard 覆盖行可删（仅 warning）", async () => {
    const rows = ["primary", "fallback", "policy-wildcard", "policy-exact"].map((source, i) => {
      const row = model(`local/protected-${i}`, {
        catalogSources: ["config"], referenceSources: [source as ModelInventoryEntry["referenceSources"][number]],
        availability: "available", availabilityReasons: []
      });
      if (source === "policy-wildcard") row.selectionSource = "policy-wildcard";
      row.capabilities.canEditCatalogEntry = true;
      return row;
    });
    const view = renderModels(inventory(rows));
    await view.findByText(rows[0]!.ref);
    for (const row of rows) {
      expect(view.getByRole("button", { name: `编辑模型 ${row.ref}` })).toBeTruthy();
    }
    // primary / fallback / policy-exact（未获 exact 删除许可）仍无删除入口
    for (const row of [rows[0]!, rows[1]!, rows[3]!]) {
      expect(view.queryByRole("button", { name: `删除模型 ${row.ref}` }) === null).toBe(true);
    }
    // wildcard 覆盖行服务端已放宽：显示删除入口（删除后 warning 提示）
    expect(view.getByRole("button", { name: `删除模型 ${rows[2]!.ref}` })).toBeTruthy();
  });













  test("删除模型对话框默认临时移除（仅目录层），可勾选使用配置与精确放行", async () => {
    const row = model("local/gone", { catalogSources: ["config"], referenceSources: ["policy-exact"], availability: "available", availabilityReasons: [] });
    row.capabilities.canEditCatalogEntry = true;
    row.capabilities.canRemovePolicyExactRef = true;
    const deleteModel = mock(async () => ({ ok: true as const, ref: row.ref, warnings: [] as string[] }));
    const view = renderModels(inventory([row]), { deleteModel });

    // 默认「临时移除」：只删目录条目
    await userEvent.click(await view.findByRole("button", { name: `删除模型 ${row.ref}` }));
    let dialog = within(view.getByRole("dialog"));
    expect((dialog.getByRole("checkbox", { name: /连同使用配置/ }) as HTMLInputElement).checked).toBe(false);
    expect((dialog.getByRole("checkbox", { name: /连同精确放行/ }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(dialog.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith(row.ref, { layers: { metadata: false, policyExact: false } }));

    // 勾选两个层级后：三层全删
    await userEvent.click(await view.findByRole("button", { name: `删除模型 ${row.ref}` }));
    dialog = within(view.getByRole("dialog"));
    await userEvent.click(dialog.getByRole("checkbox", { name: /连同使用配置/ }));
    await userEvent.click(dialog.getByRole("checkbox", { name: /连同精确放行/ }));
    await userEvent.click(dialog.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith(row.ref, { layers: { metadata: true, policyExact: true } }));
  });

  test("wildcard 覆盖行可删除：精确放行置灰并附说明，响应 warnings 经 toast 展示", async () => {
    const row = model("local/w1", { catalogSources: ["config"], referenceSources: ["policy-wildcard"], selectionSource: "policy-wildcard", availability: "available", availabilityReasons: [] });
    row.capabilities.canEditCatalogEntry = true;
    const warning = "Model local/w1 is still covered by policy wildcard local/*: re-adding it to the catalog restores pickability.";
    const deleteModel = mock(async () => ({ ok: true as const, ref: row.ref, warnings: [warning] }));
    const view = renderModels(inventory([row]), { deleteModel });

    await userEvent.click(await view.findByRole("button", { name: `删除模型 ${row.ref}` }));
    const dialog = within(view.getByRole("dialog"));
    expect((dialog.getByRole("checkbox", { name: /连同精确放行/ }) as HTMLInputElement).disabled).toBe(true);
    expect(dialog.getByText(/已被通配规则覆盖/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleteModel).toHaveBeenCalledWith(row.ref, { layers: { metadata: false, policyExact: false } }));
    expect(await view.findByText(warning)).toBeTruthy();
  });

  test("删除 Provider 对话框默认保留 wildcard 规则，显式勾选才传 removePolicyWildcard", async () => {
    const warning = "Policy wildcard local/* still references provider local; it is now dangling and can be removed explicitly.";
    const deleteProvider = mock(async () => ({ ok: true as const, warnings: [warning] }));
    const data = inventory([model("local/m1", { availability: "available", availabilityReasons: [] })]);
    const view = renderProviders(data, {
      deleteProvider,
      getModelAttention: async () => ({ pending: [], ignored: [] })
    });

    // 默认不勾选：请求体不含 removePolicyWildcard；残留 wildcard warning 经 toast 展示
    await userEvent.click(await view.findByRole("button", { name: "更多操作 local" }));
    await userEvent.click(await view.findByLabelText("删除 local"));
    let dialog = within(await view.findByRole("dialog"));
    const wildcardCheckbox = dialog.getByRole("checkbox", { name: /同时删除 policy 中该 Provider 的通配规则/ }) as HTMLInputElement;
    expect(wildcardCheckbox.checked).toBe(false);
    await userEvent.click(dialog.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleteProvider).toHaveBeenCalledWith("local", {}));
    expect(await view.findByText(warning)).toBeTruthy();

    // 显式勾选：透传 removePolicyWildcard: true
    await userEvent.click(await view.findByRole("button", { name: "更多操作 local" }));
    await userEvent.click(await view.findByLabelText("删除 local"));
    dialog = within(await view.findByRole("dialog"));
    await userEvent.click(dialog.getByRole("checkbox", { name: /同时删除 policy 中该 Provider 的通配规则/ }));
    await userEvent.click(dialog.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(deleteProvider).toHaveBeenCalledWith("local", { removePolicyWildcard: true }));
  });

  test("原始 Policy 规则的 Provider 大小写不影响 metadata 复选项，删除提交原始 ref", async () => {
    const row = removableModel();
    const ruleRef = "LOCAL/retired";
    const remove = mock(async () => ({ ok: true as const, backupId: "fixture-backup" }));
    const view = renderModels(inventory([row], {
      policyRules: [{ value: ruleRef, kind: "exact", matchedModelCount: 1, unavailableModelCount: 1, removable: true }]
    }), { removeModelPolicyExactRef: remove });
    await userEvent.click(await view.findByRole("button", { name: "展开 Policy 规则" }));
    await userEvent.click(view.getByRole("button", { name: `删除规则 ${ruleRef}` }));
    const checkbox = view.getByRole("checkbox", { name: /同时清理 metadata/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await userEvent.click(checkbox);
    await userEvent.click(view.getByRole("button", { name: "删除引用并清理 metadata" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(ruleRef, true));
  });

  test("materialize 只有一个提交入口，失败显示在预览内且可重试", async () => {
    const row = model("local/runtime-new", { catalogSources: ["openclaw-runtime"], availability: "available", availabilityReasons: [] });
    row.capabilities.canMaterializeConfigModel = true;
    const materialize = mock(async () => { throw new Error("Provider is now disabled"); });
    const view = renderModels(inventory([row]), { materializeRuntimeModel: materialize });
    await userEvent.click(await view.findByRole("button", { name: `补全到目录 ${row.ref}` }));
    const dialog = within(view.getByRole("dialog"));
    expect(dialog.getAllByRole("button", { name: /补全到|^确认$/ }).length).toBe(1);
    await userEvent.click(dialog.getByRole("button", { name: "补全到本 Provider 目录" }));
    expect(await dialog.findByText("Provider is now disabled")).toBeTruthy();
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledWith(row.ref, { id: "runtime-new", enabled: false });
    expect((dialog.getByRole("button", { name: "补全到本 Provider 目录" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("Core 未提供 materialize 能力时不开放补全，即使 runtime 行 available", async () => {
    const row = model("local/runtime-disabled", { catalogSources: ["openclaw-runtime"], availability: "available", availabilityReasons: [] });
    const view = renderModels(inventory([row], { providers: [provider("local", { disabled: true })] }));
    await view.findByText(row.ref);
    expect(view.queryByRole("button", { name: `补全到目录 ${row.ref}` }) === null).toBe(true);
    expect(view.queryByRole("button", { name: `补全 Provider 配置 ${row.ref}` }) === null).toBe(true);
  });

  test("readonly Policy 不开放删除：primary、fallback、最后 exact、unknown 与受保护 wildcard", async () => {
    const refs = ["local/primary", "local/fallback", "local/last", "local/unknown"];
    const view = render(<ModelPolicyPanel rules={[
      ...refs.map(value => ({ value, kind: "exact" as const, matchedModelCount: 1, unavailableModelCount: 0, removable: false })),
      { value: "local/*", kind: "wildcard", matchedModelCount: 4, unavailableModelCount: 0, removable: false }
    ]} onAddRule={() => {}} onRemoveRule={async () => { throw new Error("Must not remove readonly rules"); }} />);
    expect(view.queryAllByRole("button", { name: /^删除规则 / }).length).toBe(0);
    // 不可删的 wildcard 显示「受保护」而非删除入口
    expect(view.getByText("受保护").getAttribute("title")).toContain("主模型/fallback");
  });

  describe("Policy 规则编辑", () => {
    const editableRules = [
      { value: "local/safe", kind: "exact" as const, matchedModelCount: 1, unavailableModelCount: 0, removable: true },
      { value: "local/*", kind: "wildcard" as const, matchedModelCount: 2, unavailableModelCount: 1, removable: true }
    ];

    test("policyMode=restricted 显示「添加规则」入口（busy 时禁用）；legacy/unrestricted/缺失只显示提示", async () => {
      const onAddRule = mock(() => {});
      const restricted = render(<ModelPolicyPanel rules={editableRules} policyMode="restricted" onAddRule={onAddRule} onRemoveRule={async () => {}} />);
      await userEvent.click(restricted.getByRole("button", { name: "添加规则" }));
      expect(onAddRule).toHaveBeenCalledTimes(1);
      restricted.unmount();

      const busyView = render(<ModelPolicyPanel rules={editableRules} policyMode="restricted" busy onAddRule={onAddRule} onRemoveRule={async () => {}} />);
      expect((busyView.getByRole("button", { name: "添加规则" }) as HTMLButtonElement).disabled).toBe(true);
      busyView.unmount();

      // 其它模式与旧后端（缺 policyMode）都不渲染添加入口，只显示 muted 提示
      for (const mode of ["legacy", "unrestricted", undefined] as const) {
        const view = render(<ModelPolicyPanel rules={editableRules} {...(mode ? { policyMode: mode } : {})} onAddRule={onAddRule} onRemoveRule={async () => {}} />);
        expect(view.queryByRole("button", { name: "添加规则" }) === null).toBe(true);
        expect(view.getByText(/规则编辑仅适用于 restricted 模式/)).toBeTruthy();
        view.unmount();
      }
    });

    test("wildcard 行 removable=true 显示删除按钮，false 显示「受保护」；区段提示已更新", async () => {
      const onRemoveRule = mock(async () => {});
      const view = render(<ModelPolicyPanel rules={[
        { value: "local/*", kind: "wildcard", matchedModelCount: 2, unavailableModelCount: 0, removable: true },
        { value: "prim/*", kind: "wildcard", matchedModelCount: 1, unavailableModelCount: 0, removable: false }
      ]} onAddRule={() => {}} onRemoveRule={onRemoveRule} />);
      expect(view.getByText(/通配规则可显式删除；oc-switch 绝不自动改写/)).toBeTruthy();
      await userEvent.click(view.getByRole("button", { name: "删除规则 local/*" }));
      expect(onRemoveRule).toHaveBeenCalledWith(expect.objectContaining({ value: "local/*", kind: "wildcard" }));
      expect(view.queryByRole("button", { name: "删除规则 prim/*" }) === null).toBe(true);
      expect(view.getByText("受保护").getAttribute("title")).toContain("主模型/fallback");
    });

    test("添加规则对话框：提交 exact 成功后 toast 展示 warnings 并重新加载", async () => {
      const data = inventory([], { policyMode: "restricted", policyRules: editableRules });
      const warning = "已被通配 local/* 覆盖，该精确规则当前冗余";
      const addRule = mock(async (rule: string) => ({
        ok: true as const, rule, kind: "exact" as const, backupId: "fixture-backup",
        warnings: [warning], runtimeConfirmed: true
      }));
      const loadInventory = mock(async () => data);
      const view = renderModels(data, { addModelPolicyRule: addRule, getModelInventory: loadInventory });

      await userEvent.click(await view.findByRole("button", { name: "展开 Policy 规则" }));
      await userEvent.click(view.getByRole("button", { name: "添加规则" }));
      const dialog = within(view.getByRole("dialog"));
      expect(dialog.getByText(/只改 modelPolicy.allow/)).toBeTruthy();
      expect(dialog.getByText(/服务端为权威校验/)).toBeTruthy();
      await userEvent.type(dialog.getByLabelText("规则"), "local/new-model");
      await userEvent.click(dialog.getByRole("button", { name: "添加规则" }));
      await waitFor(() => expect(addRule).toHaveBeenCalledWith("local/new-model"));
      expect(await view.findByText(/已添加精确规则 local\/new-model/)).toBeTruthy();
      expect(await view.findByText(warning)).toBeTruthy();
      await waitFor(() => expect(loadInventory.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    test("添加规则被服务端拒绝时错误内联展示，对话框保持打开", async () => {
      const data = inventory([], { policyMode: "restricted", policyRules: editableRules });
      const addRule = mock(async () => { throw new Error("Rule already exists in modelPolicy.allow (duplicate-rule)."); });
      const view = renderModels(data, { addModelPolicyRule: addRule });

      await userEvent.click(await view.findByRole("button", { name: "展开 Policy 规则" }));
      await userEvent.click(view.getByRole("button", { name: "添加规则" }));
      const dialog = within(view.getByRole("dialog"));
      await userEvent.type(dialog.getByLabelText("规则"), "local/safe");
      await userEvent.click(dialog.getByRole("button", { name: "添加规则" }));
      expect(await dialog.findByText(/duplicate-rule/)).toBeTruthy();
      // 失败不关对话框，可修正后重试
      expect(view.getByRole("dialog")).toBeTruthy();
      expect(addRule).toHaveBeenCalledTimes(1);
    });

    test("删除 wildcard：确认框展示命中计数与影响文案，确认后调用 API、toast warnings 并重新加载", async () => {
      const data = inventory([], {
        policyMode: "restricted",
        policyRules: [{ value: "local/*", kind: "wildcard", matchedModelCount: 3, unavailableModelCount: 1, removable: true }]
      });
      const warning = "删除后 2 个模型将失去策略放行";
      const remove = mock(async (value: string) => ({
        ok: true as const, value, removedCount: 1, backupId: "fixture-backup", warnings: [warning], runtimeConfirmed: true
      }));
      const loadInventory = mock(async () => data);
      const view = renderModels(data, { removeModelPolicyWildcard: remove, getModelInventory: loadInventory });

      await userEvent.click(await view.findByRole("button", { name: "展开 Policy 规则" }));
      await userEvent.click(view.getByRole("button", { name: "删除规则 local/*" }));
      const dialog = within(view.getByRole("dialog"));
      expect(dialog.getByText(/只改 modelPolicy.allow/)).toBeTruthy();
      expect(dialog.getByText(/命中 3 个模型，其中 1 个不可用/)).toBeTruthy();
      expect(dialog.getByText(/将从选择器消失；目录、metadata 与 API Key 不变/)).toBeTruthy();
      await userEvent.click(dialog.getByRole("button", { name: "删除通配规则" }));
      await waitFor(() => expect(remove).toHaveBeenCalledWith("local/*"));
      expect(await view.findByText(/已删除通配规则 local\/\*/)).toBeTruthy();
      expect(await view.findByText(warning)).toBeTruthy();
      await waitFor(() => expect(loadInventory.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    test("删除 wildcard 确认前重查 removable：规则变为不可删时禁用确认按钮", async () => {
      let removable = true;
      const data = () => inventory([], {
        policyMode: "restricted",
        policyRules: [{ value: "local/*", kind: "wildcard" as const, matchedModelCount: 1, unavailableModelCount: 0, removable }]
      });
      const remove = mock(async () => ({
        ok: true as const, value: "local/*", removedCount: 1, backupId: "fixture-backup", warnings: [] as string[], runtimeConfirmed: true
      }));
      const view = renderModels(data(), {
        getModelInventory: async () => data(),
        refreshModelInventory: async () => data(),
        removeModelPolicyWildcard: remove
      });

      await userEvent.click(await view.findByRole("button", { name: "展开 Policy 规则" }));
      await userEvent.click(view.getByRole("button", { name: "删除规则 local/*" }));
      expect((within(view.getByRole("dialog")).getByRole("button", { name: "删除通配规则" }) as HTMLButtonElement).disabled).toBe(false);

      // 确认前 inventory 变化（如另一处写入后的 load 把最新守卫结果带回来）：
      // modal 对话框使背景按钮不可及，这里用 fireEvent 触发刷新作为测试扳手
      removable = false;
      fireEvent.click(view.getByText("刷新探测").closest("button")!);
      await waitFor(() => {
        const dialog = within(view.getByRole("dialog"));
        expect((dialog.getByRole("button", { name: "删除通配规则" }) as HTMLButtonElement).disabled).toBe(true);
      });
      expect(within(view.getByRole("dialog")).getByText(/该规则当前不可删除/)).toBeTruthy();
      expect(remove).not.toHaveBeenCalled();
    });
  });



  test("目录详情读取失败必须阻止编辑，不得降级为空参数后保存", async () => {
    const row = model("local/configured", { catalogSources: ["config"], availability: "available", availabilityReasons: [] });
    row.capabilities.canEditCatalogEntry = true;
    const view = renderModels(inventory([row]), { getModels: async () => { throw new Error("Catalog read failed"); } });
    await userEvent.click(await view.findByRole("button", { name: `编辑模型 ${row.ref}` }));
    expect(await view.findByText("Catalog read failed")).toBeTruthy();
    expect(view.queryByRole("dialog") === null).toBe(true);
  });

  test("刷新删除已选 Provider 后自动选择仍存在的 Provider", async () => {
    const row = model("local/old", { availability: "available", availabilityReasons: [] });
    const next = model("replacement/new", { availability: "available", availabilityReasons: [] });
    const view = renderModels(inventory([row]), {
      refreshModelInventory: async () => inventory([next], { providers: [provider("replacement")] })
    });
    await view.findByText(row.ref);
    await userEvent.click(view.getByRole("button", { name: "刷新探测" }));
    expect(await view.findByText(next.ref)).toBeTruthy();
    expect(view.queryByRole("heading", { name: "local" }) === null).toBe(true);
  });

  test("未加载和加载失败都不能宣称全部可用", async () => {
    let reject!: (error: Error) => void;
    const view = renderModels(inventory(), {
      getModelInventory: () => new Promise<ModelInventory>((_, fail) => { reject = fail; })
    });
    expect(view.queryByText("全部可用") === null).toBe(true);
    reject(new Error("Inventory unavailable"));
    expect(await view.findByText("Inventory unavailable")).toBeTruthy();
    expect(view.queryByText("全部可用") === null).toBe(true);
  });

  test("状态徽章保留全部目录来源，策略允许不等于插件开启或运行可用", () => {
    const row = model("local/mixed", {
      catalogSources: ["config", "plugin-manifest", "openclaw-runtime"],
      availability: "available", availabilityReasons: [], pluginIds: [plugin.id], policyAllowed: false
    });
    delete row.selectionSource;
    const view = render(<ModelStateBadges entry={row} plugins={[{ ...plugin, enabled: false }]} />);
    expect(view.getByText("本地配置")).toBeTruthy();
    expect(view.getByText("插件目录")).toBeTruthy();
    expect(view.getByText("运行时目录")).toBeTruthy();
    expect(view.getByText("策略未允许")).toBeTruthy();
    expect(view.getByText(/shared-plugin.*已停用/)).toBeTruthy();
    expect(view.getByText("可用", { exact: true })).toBeTruthy();
  });

  test("Policy exact/wildcard 分组并显著标记零命中，invalid 不回显", () => {
    const onRemove = mock(async () => {});
    const view = render(<ModelPolicyPanel rules={[
      { value: "local/safe", kind: "exact", matchedModelCount: 1, unavailableModelCount: 1, removable: true },
      { value: "missing/*", kind: "wildcard", matchedModelCount: 0, unavailableModelCount: 0, removable: false },
      { value: "fixture-secret-do-not-display", kind: "invalid", invalidIndex: 2, matchedModelCount: 0, unavailableModelCount: 0, removable: false }
    ]} onAddRule={() => {}} onRemoveRule={onRemove} />);
    expect(view.getByRole("region", { name: "精确规则" })).toBeTruthy();
    expect(view.getByRole("region", { name: "通配规则" })).toBeTruthy();
    expect(within(view.getByText("missing/*").closest("td")!).getByText("零命中")).toBeTruthy();
    expect(view.queryByText("fixture-secret-do-not-display") === null).toBe(true);
    expect(view.queryByRole("button", { name: "删除规则 missing/*" }) === null).toBe(true);
  });

  test("Policy 手机表保留完整规则和操作，重复类型隐藏，计数移至规则下方；桌面仍为四列", async () => {
    const ref = "long-provider/namespace/model-with-a-long-id";
    const remove = mock(async () => {});
    const exactRule = { value: ref, kind: "exact" as const, matchedModelCount: 17, unavailableModelCount: 2, removable: true };
    const view = render(<ModelPolicyPanel rules={[exactRule]} onAddRule={() => {}} onRemoveRule={remove} />);
    const table = within(view.getByRole("region", { name: "精确规则" })).getByRole("table");
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.length).toBe(4);
    for (const header of headers.slice(1, 3)) {
      expect(header.classList.contains("hidden")).toBe(true);
      expect(header.classList.contains("md:table-cell")).toBe(true);
    }
    expect(table.classList.contains("table-fixed")).toBe(true);
    expect(table.classList.contains("md:table-auto")).toBe(true);
    expect(table.classList.contains("min-w-0")).toBe(true);

    const rule = within(table).getByText(ref);
    const valueCell = rule.closest("td")!;
    expect(valueCell.classList.contains("hidden")).toBe(false);
    expect(rule.className).not.toMatch(/truncate|line-clamp|hidden/);
    const mobileCounts = valueCell.querySelector(".md\\:hidden")!;
    expect(Boolean(mobileCounts)).toBe(true);
    expect(mobileCounts.textContent).toContain("命中 17 个模型，其中 2 个不可用");
    const desktopCounts = table.querySelector("tbody td:nth-child(3)")!;
    expect(desktopCounts.classList.contains("hidden")).toBe(true);
    expect(desktopCounts.classList.contains("md:table-cell")).toBe(true);
    expect(desktopCounts.textContent).toBe(mobileCounts.textContent);

    await userEvent.click(within(rule.closest("tr")!).getByRole("button", { name: `删除规则 ${ref}` }));
    expect(remove).toHaveBeenCalledWith(exactRule);
  });

  test("插件分组不遗漏与 config 同名的 Provider，并列出全部受影响模型", async () => {
    const data = inventory([
      model("local/config-model", { catalogSources: ["config"], referenceSources: ["primary"] }),
      model("token-plan/plugin-model", { catalogSources: ["plugin-manifest"], pluginIds: [plugin.id] })
    ], {
      plugins: [plugin],
      providers: [
        provider("local", { sources: ["config", "plugin-manifest"], pluginIds: [plugin.id], pluginEnabled: true }),
        provider("token-plan", { sources: ["plugin-manifest"], pluginIds: [plugin.id], pluginEnabled: true })
      ]
    });
    const view = renderProviders(data, { getModelAttention: async () => ({ pending: [], ignored: [] }) });
    await userEvent.click(await screen.findByRole("button", {name:"展开插件 shared-plugin"}));
    const toggle = await view.findByRole("switch", { name: "停用插件 shared-plugin" });
    const group = toggle.closest("section")!;
    expect(within(group).getByText("local", { exact: true })).toBeTruthy();
    expect(within(group).getByText("token-plan", { exact: true })).toBeTruthy();
    expect(within(group).getAllByRole("switch")).toHaveLength(1);
    await userEvent.click(toggle);
    const dialog = within(view.getByRole("dialog"));
    expect((dialog.getByRole("button", { name: "确认" }) as HTMLButtonElement).disabled).toBe(true);
    expect(dialog.getByText("local/config-model")).toBeTruthy();
    expect(dialog.getByText("token-plan/plugin-model")).toBeTruthy();
    expect(dialog.getByText(/工具（tools）/)).toBeTruthy();
    expect(dialog.getByText(/语音（speech）/)).toBeTruthy();
    expect(dialog.getByText(/钩子（hooks）/)).toBeTruthy();
    expect(dialog.getByText(/未勾选清理时.*保留/)).toBeTruthy();
  });

  test("config 可用与同名插件停用同时展示，不误称全部模型需先启用插件", async () => {
    const row = model("local/configured", { catalogSources: ["config"], availability: "available", availabilityReasons: [] });
    row.capabilities.canTogglePolicy = true;
    const view = renderModels(inventory([row], {
      providers: [provider("local", { sources: ["config", "plugin-manifest"], pluginIds: [plugin.id], pluginEnabled: false })],
      plugins: [{ ...plugin, enabled: false }]
    }));
    expect(await view.findByRole("switch", { name: `禁用 ${row.ref}` })).toBeTruthy();
    expect(view.queryByText(/请先在 Providers 页启用该插件后再启用其模型/) === null).toBe(true);
  });

  test("config Provider 关闭时添加模型提示恢复 Provider，不误指向同名已停用插件", async () => {
    const view = renderModels(inventory([], {
      providers: [provider("local", { sources: ["config", "plugin-manifest"], pluginIds: [plugin.id], pluginEnabled: false, disabled: true })],
      plugins: [{ ...plugin, enabled: false }]
    }));
    await userEvent.click(view.getByRole("button", { name: "管理配置目录" }));
    await view.findByRole("heading", { name: "local" });
    const add = view.getByRole("button", { name: "添加模型" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain("恢复 Provider");
  });

  test("Providers 展示 runtime-only Provider，而 inventory 请求错误明确提示", async () => {
    const data = inventory([], { providers: [provider("local"), provider("runtime-only", { sources: ["openclaw-runtime"], pickerModelCount: 1 })] });
    const view = renderProviders(data);
    expect(await view.findByText("runtime-only", { exact: true })).toBeTruthy();
    cleanup();
    const failed = renderProviders(data, { getModelInventory: async () => { throw new Error("Inventory probe unavailable"); } });
    expect(await failed.findByText(/Inventory probe unavailable/)).toBeTruthy();
  });

  test("插件写入成功但未确认：保留 warnings/diagnostics 和设置入口，刷新失败不冒充写入失败", async () => {
    const onSet = mock(async () => pluginResult({
      runtimeConfirmed: false,
      warnings: ["Policy references preserved"],
      diagnostics: [{ command: "list", code: "timeout", message: "Runtime list timed out" }]
    }));
    const onSettings = mock(() => {});
    const view = render(<ToastProvider><PluginProviderGroup
      plugin={plugin}
      providers={[provider("local")]}
      models={[model("local/example")]}
      onSetPluginState={onSet}
      onMutated={async () => { throw new Error("Reload unavailable"); }}
      onOpenSettings={onSettings}
    /></ToastProvider>);
    await userEvent.click(view.getByRole("switch", { name: "停用插件 shared-plugin" }));
    await userEvent.click(view.getByRole("button", { name: "确认" }));
    expect(await view.findByText("Policy references preserved")).toBeTruthy();
    expect(await view.findByText("Runtime list timed out")).toBeTruthy();
    expect(await view.findByText(/配置已写入.*刷新失败.*Reload unavailable/)).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "前往设置" }));
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  test("Providers 写后刷新失败不能卸载插件组并丢掉已写入结果", async () => {
    const data = inventory([], {
      providers: [provider("local", { pluginIds: [plugin.id], pluginEnabled: true })], plugins: [plugin]
    });
    let written = false;
    const view = renderProviders(data, {
      getModelInventory: async () => {
        if (written) throw new Error("Inventory reload unavailable");
        return data;
      },
      setPluginState: async () => { written = true; return pluginResult(); }
    });
    await userEvent.click(await view.findByRole("switch", { name: "停用插件 shared-plugin" }));
    await userEvent.click(view.getByRole("button", { name: "确认" }));
    expect(await view.findByText("Inventory reload unavailable")).toBeTruthy();
    expect(await view.findByText(/配置已写入.*刷新失败.*Inventory reload unavailable/)).toBeTruthy();
  });
});
