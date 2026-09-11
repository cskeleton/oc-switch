import "./test-setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor, within } from "@testing-library/react";
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

  test("unknown exact 只展示探测失败事实，不建议安全移除", async () => {
    const row = model("local/unknown", { availability: "unknown", availabilityReasons: ["probe-failed"] });
    const view = renderModels(inventory([row], {
      diagnostics: [{ command: "list", code: "timeout", message: "Runtime list timed out" }]
    }));
    const pending = within(await view.findByTestId("pending-models-panel"));
    await pending.findByText(row.ref);
    expect(pending.queryByText(/可安全移除/) === null).toBe(true);
    expect(pending.queryByRole("button", { name: `处理 ${row.ref}` }) === null).toBe(true);
    expect(await view.findByText("Runtime list timed out")).toBeTruthy();
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
    const remove = mock(async () => ({ ok: true, removedModelIds: ["known"] }));
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

  test("可编辑目录不等于可删除：保护主模型、fallback、wildcard 和最后 exact", async () => {
    const rows = ["primary", "fallback", "policy-wildcard", "policy-exact"].map((source, i) => {
      const row = model(`local/protected-${i}`, {
        catalogSources: ["config"], referenceSources: [source as ModelInventoryEntry["referenceSources"][number]],
        availability: "available", availabilityReasons: []
      });
      row.capabilities.canEditCatalogEntry = true;
      return row;
    });
    const view = renderModels(inventory(rows));
    await view.findByText(rows[0]!.ref);
    for (const row of rows) {
      expect(view.getByRole("button", { name: `编辑模型 ${row.ref}` })).toBeTruthy();
      expect(view.queryByRole("button", { name: `删除模型 ${row.ref}` }) === null).toBe(true);
    }
  });

  test("缺 Provider 的最后 exact 仍可打开手动补全向导，但不能删引用", async () => {
    // missing:true 占位既不是 catalog 来源，也不会产生 Provider 行。
    const row = model("missing/vendor/model", { availabilityReasons: ["provider-not-found"] });
    const view = renderModels(inventory([row]));
    await userEvent.click(await view.findByRole("button", { name: `处理 ${row.ref}` }));
    expect(view.queryByRole("button", { name: "仅删除 policy 引用" }) === null).toBe(true);
    await userEvent.click(view.getByRole("button", { name: "创建 Provider 并补全模型" }));
    expect((await view.findByLabelText("Provider ID") as HTMLInputElement).value).toBe("missing");
    expect((view.getByLabelText("模型 ID 1") as HTMLInputElement).value).toBe("vendor/model");
    expect((view.getByLabelText("请求地址") as HTMLInputElement).value).toBe("");
  });

  test("缺 Provider 且可删 exact 时同时给出补全、删除和保留选项", async () => {
    const row = removableModel("missing/retired");
    row.availabilityReasons = ["provider-not-found"];
    const remove = mock(async () => ({ ok: true as const, backupId: "fixture-backup" }));
    const view = renderModels(inventory([row]), { removeModelPolicyExactRef: remove });
    await userEvent.click(await view.findByRole("button", { name: `处理 ${row.ref}` }));
    expect(view.getByRole("button", { name: "创建 Provider 并补全模型" })).toBeTruthy();
    expect(view.getByRole("button", { name: "仅删除 policy 引用" })).toBeTruthy();
    await userEvent.click(view.getByRole("button", { name: "保留" }));
    expect(view.queryByRole("dialog") === null).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  test("下架插件模型不提供伪造 config 快捷入口，仍可保留", async () => {
    const row = model("retired-plugin/removed", {
      catalogSources: ["plugin-manifest"], pluginIds: ["retired-plugin"], availabilityReasons: ["model-not-in-catalog"]
    });
    const view = renderModels(inventory([row]));
    await userEvent.click(await view.findByRole("button", { name: `处理 ${row.ref}` }));
    const dialog = within(view.getByRole("dialog"));
    expect(dialog.queryByRole("button", { name: /创建 Provider|补全到/ }) === null).toBe(true);
    expect(dialog.getByText(/插件目录.*不可伪造/)).toBeTruthy();
    await userEvent.click(dialog.getByRole("button", { name: "保留" }));
    expect(view.queryByRole("dialog") === null).toBe(true);
  });

  test("metadata 清理是独立未勾选复选项；取消后重新打开恢复默认", async () => {
    const row = removableModel();
    const remove = mock(async () => ({ ok: true as const, backupId: "fixture-backup" }));
    const view = renderModels(inventory([row]), { removeModelPolicyExactRef: remove });
    await userEvent.click(await view.findByRole("button", { name: `处理 ${row.ref}` }));
    const checkbox = view.getByRole("checkbox", { name: /同时清理 metadata/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await userEvent.click(checkbox);
    await userEvent.click(view.getByRole("button", { name: "保留" }));
    await userEvent.click(view.getByRole("button", { name: `处理 ${row.ref}` }));
    expect((view.getByRole("checkbox", { name: /同时清理 metadata/ }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(view.getByRole("button", { name: "仅删除 policy 引用" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(row.ref, false));
  });

  test("只有显式勾选才提交 removeMetadata=true；提交期间不能再次点击", async () => {
    const row = removableModel();
    let resolve!: (value: { ok: true; backupId: string }) => void;
    const remove = mock(() => new Promise<{ ok: true; backupId: string }>(done => { resolve = done; }));
    const view = renderModels(inventory([row]), { removeModelPolicyExactRef: remove });
    await userEvent.click(await view.findByRole("button", { name: `处理 ${row.ref}` }));
    await userEvent.click(view.getByRole("checkbox", { name: /同时清理 metadata/ }));
    const submit = view.getByRole("button", { name: "删除引用并清理 metadata" }) as HTMLButtonElement;
    await userEvent.click(submit);
    expect(submit.disabled).toBe(true);
    await userEvent.click(submit);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(row.ref, true);
    resolve({ ok: true, backupId: "fixture-backup" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("无 legacy metadata 的引用不显示清理复选项，失败保留向导并显示错误", async () => {
    const row = removableModel();
    row.referenceSources = ["policy-exact"];
    const remove = mock(async () => { throw new Error("Policy changed; refresh required"); });
    const view = renderModels(inventory([row]), { removeModelPolicyExactRef: remove });
    await userEvent.click(await view.findByRole("button", { name: `处理 ${row.ref}` }));
    expect(view.queryByRole("checkbox", { name: /metadata/ }) === null).toBe(true);
    await userEvent.click(view.getByRole("button", { name: "仅删除 policy 引用" }));
    expect(await within(view.getByRole("dialog")).findByText("Policy changed; refresh required")).toBeTruthy();
    expect(view.queryByText(/已删除.*policy/) === null).toBe(true);
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

  test("readonly Policy 不开放删除：primary、fallback、最后 exact、unknown 与 wildcard", async () => {
    const refs = ["local/primary", "local/fallback", "local/last", "local/unknown"];
    const view = render(<ModelPolicyPanel rules={[
      ...refs.map(value => ({ value, kind: "exact" as const, matchedModelCount: 1, unavailableModelCount: 0, removable: false })),
      { value: "local/*", kind: "wildcard", matchedModelCount: 4, unavailableModelCount: 0, removable: false }
    ]} onRemoveRule={async () => { throw new Error("Must not remove readonly rules"); }} />);
    expect(view.queryAllByRole("button", { name: /^删除规则 / }).length).toBe(0);
  });

  test("不可用主模型可以选择允许的替代模型；fallback 不会被误写为主模型", async () => {
    const primary = model("local/primary", { referenceSources: ["primary", "policy-exact"] });
    const fallback = model("local/fallback", { referenceSources: ["fallback"] });
    const available = model("local/replacement", { catalogSources: ["openclaw-runtime"], availability: "available", availabilityReasons: [] });
    available.capabilities.canSetPrimary = true;
    const unavailable = model("local/not-a-replacement");
    const setPrimary = mock(async (ref: string) => ({ ok: true, ref }));
    const view = renderModels(inventory([primary, fallback, available, unavailable]), { setPrimary });
    await userEvent.click(await view.findByRole("button", { name: `替换主模型 ${primary.ref}` }));
    const select = view.getByRole("combobox", { name: "替代主模型" });
    expect(within(select).queryByRole("option", { name: unavailable.ref }) === null).toBe(true);
    await userEvent.selectOptions(select, available.ref);
    await userEvent.click(view.getByRole("button", { name: "确认替换主模型" }));
    await waitFor(() => expect(setPrimary).toHaveBeenCalledWith(available.ref));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    await userEvent.click(view.getByRole("button", { name: `查看替换指引 ${fallback.ref}` }));
    expect(view.getByRole("dialog").textContent).toContain("回退链只读");
    expect(view.queryByRole("button", { name: "确认替换主模型" }) === null).toBe(true);
    expect(setPrimary).toHaveBeenCalledTimes(1);
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
    ]} onRemoveRule={onRemove} />);
    expect(view.getByRole("region", { name: "精确规则" })).toBeTruthy();
    expect(view.getByRole("region", { name: "通配规则" })).toBeTruthy();
    expect(within(view.getByText("missing/*").closest("td")!).getByText("零命中")).toBeTruthy();
    expect(view.queryByText("fixture-secret-do-not-display") === null).toBe(true);
    expect(view.queryByRole("button", { name: "删除规则 missing/*" }) === null).toBe(true);
  });

  test("Policy 手机表保留完整规则和操作，重复类型隐藏，计数移至规则下方；桌面仍为四列", async () => {
    const ref = "long-provider/namespace/model-with-a-long-id";
    const remove = mock(async () => {});
    const view = render(<ModelPolicyPanel rules={[
      { value: ref, kind: "exact", matchedModelCount: 17, unavailableModelCount: 2, removable: true }
    ]} onRemoveRule={remove} />);
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
    expect(remove).toHaveBeenCalledWith(ref);
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
    const view = renderProviders(data);
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
    expect(dialog.getByText(/policy.*保留/)).toBeTruthy();
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
    await view.findByRole("heading", { name: "local" });
    const add = view.getByRole("button", { name: "添加模型" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain("恢复 Provider");
  });

  test("Providers 展示 runtime-only Provider，而 inventory 请求错误明确提示", async () => {
    const data = inventory([], { providers: [provider("local"), provider("runtime-only", { sources: ["openclaw-runtime"] })] });
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
