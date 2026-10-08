import { staticSnapshot, emptyExtensions } from "./test-fixtures";
import "./test-setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ApiRequestError,
  createApiClient,
  type ApiClient,
  type ConfigStatusReport,
  type ModelInventory
} from "./api";
import { ToastProvider } from "./components/Toast";
import { StalePolicyRefsCleanupDialog, type StalePolicyRef } from "./components/StalePolicyRefsCleanupDialog";
import { ModelsView } from "./views/ModelsView";

afterEach(() => {
  cleanup();
  mock.restore();
});

/** 与 views.test.tsx 同款：真实 client 为底，按需覆盖方法；未覆盖的端点返回最小 {ok:true} */
function baseClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  return { ...client, getModelConfig: async () => staticSnapshot(), getModelExtensions: async () => emptyExtensions(), ...overrides };
}

const STALE_REFS: StalePolicyRef[] = [
  { value: "ghost/m1", reason: "unknown-provider" },
  { value: "cpa/dangling", reason: "unknown-model" }
];

function renderDialog(client: ApiClient, overrides: Partial<Parameters<typeof StalePolicyRefsCleanupDialog>[0]> = {}) {
  return render(
    <ToastProvider>
      <StalePolicyRefsCleanupDialog
        open
        refs={STALE_REFS}
        policyRevision="v1:fixture"
        client={client}
        onCancel={() => {}}
        onChanged={() => {}}
        {...overrides}
      />
    </ToastProvider>
  );
}

describe("StalePolicyRefsCleanupDialog", () => {
  test("渲染悬空引用列表与原因 Pill，默认全选，文案明确不影响目录/metadata/密钥", async () => {
    const client = baseClient({
      batchRemoveModelPolicyRules: mock(async () => ({ ok: true as const, removedCount: 2, backupId: "b1", warnings: [] }))
    });
    const { findByLabelText, getByLabelText, getByText } = renderDialog(client);

    expect(((await findByLabelText("选择悬空引用 ghost/m1")) as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText("选择悬空引用 cpa/dangling") as HTMLInputElement).checked).toBe(true);
    expect(getByText("Provider 不存在")).toBeTruthy();
    expect(getByText("模型不在目录")).toBeTruthy();
    expect(getByText(/不影响目录、metadata 与密钥/)).toBeTruthy();
  });

  test("确认冻结 revision 单次批量调用；成功 toast 并回调刷新", async () => {
    const batchRemoveModelPolicyRules = mock(async () => ({ ok: true as const, removedCount: 2, backupId: "b1", warnings: [] }));
    const onChanged = mock(() => {});
    const onCancel = mock(() => {});
    const { findByRole, getByText } = renderDialog(baseClient({ batchRemoveModelPolicyRules }), { onChanged, onCancel });

    await userEvent.click(await findByRole("button", { name: "清理所选 (2)" }));

    await waitFor(() => expect(batchRemoveModelPolicyRules).toHaveBeenCalledWith(["ghost/m1", "cpa/dangling"], "v1:fixture"));
    expect(batchRemoveModelPolicyRules).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(getByText(/已清理 2 条悬空规则/)).toBeTruthy();
  });

  test("400 守卫失败：details.refs 逐条标红并取消勾选，不自动重试", async () => {
    const batchRemoveModelPolicyRules = mock(async () => {
      throw new ApiRequestError(
        "primary model references cpa/dangling (primary-model-referenced).",
        400,
        "primary-model-referenced",
        { refs: ["cpa/dangling"] }
      );
    });
    const { findByLabelText, getByLabelText, findByRole } = renderDialog(baseClient({ batchRemoveModelPolicyRules }));

    await userEvent.click((await findByRole("button", { name: "清理所选 (2)" })));

    // 触发违规的规则标红并取消勾选；未违规的保留勾选
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain("已标红并取消勾选");
    expect(getByLabelText("选择悬空引用 cpa/dangling").closest("tr")!.textContent).toContain("cpa/dangling");
    expect((getByLabelText("选择悬空引用 cpa/dangling") as HTMLInputElement).checked).toBe(false);
    expect((getByLabelText("选择悬空引用 ghost/m1") as HTMLInputElement).checked).toBe(true);
    // 标红样式：规则文本使用 text-destructive
    const refCell = getByLabelText("选择悬空引用 cpa/dangling").closest("tr")!.querySelector("span.font-medium");
    expect(refCell!.className).toContain("text-destructive");
    // 单次调用，不自动重试
    expect(batchRemoveModelPolicyRules).toHaveBeenCalledTimes(1);
  });

  test("409 revision 冲突：保留勾选并提示刷新后重新核对", async () => {
    const batchRemoveModelPolicyRules = mock(async () => {
      throw new ApiRequestError("modelPolicy.allow 已被其他写入修改", 409, "policy-revision-conflict");
    });
    const { findByLabelText, getByLabelText, findByRole } = renderDialog(baseClient({ batchRemoveModelPolicyRules }));

    await userEvent.click((await findByRole("button", { name: "清理所选 (2)" })));

    expect((await findByRole("alert")).textContent).toContain("策略已变化，请刷新后重新核对");
    expect((getByLabelText("选择悬空引用 ghost/m1") as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText("选择悬空引用 cpa/dangling") as HTMLInputElement).checked).toBe(true);
    expect(batchRemoveModelPolicyRules).toHaveBeenCalledTimes(1);
  });

  test("旧后端版本不支持：缺 policyRevision、404 与响应缺 removedCount 均不回退逐条删除", async () => {
    // 缺 policyRevision：确认禁用 + 版本不支持提示
    const first = renderDialog(baseClient(), { policyRevision: undefined });
    expect(((await first.findByRole("button", { name: /清理所选/ })) as HTMLButtonElement).disabled).toBe(true);
    expect((await first.findByRole("alert")).textContent).toContain("版本不支持");
    first.unmount();

    // 404：旧后端无批量端点
    const notFound = mock(async () => { throw new ApiRequestError("Request failed: 404", 404); });
    const second = renderDialog(baseClient({ batchRemoveModelPolicyRules: notFound }));
    await userEvent.click(await second.findByRole("button", { name: "清理所选 (2)" }));
    expect((await second.findByRole("alert")).textContent).toContain("版本不支持");
    expect(((await second.findByRole("button", { name: /清理所选/ })) as HTMLButtonElement).disabled).toBe(true);
    second.unmount();

    // 200 但缺 removedCount：同样按版本不支持处理
    const legacy = mock(async () => ({ ok: true as const, backupId: "b1", warnings: [] }) as never);
    const third = renderDialog(baseClient({ batchRemoveModelPolicyRules: legacy }));
    await userEvent.click(await third.findByRole("button", { name: "清理所选 (2)" }));
    expect((await third.findByRole("alert")).textContent).toContain("版本不支持");
  });
});

/** 完整真实形状的 ModelInventory fixture（AGENTS.md：不手搓缺字段 mock）。 */
function cleanupInventoryFixture(): ModelInventory {
  return {
    schemaVersion: 2,
    pickerSource: "gateway",
    providers: [],
    models: [],
    plugins: [],
    policyRules: [
      { value: "ghost/m1", kind: "exact", matchedModelCount: 0, unavailableModelCount: 0, removable: true, editable: true },
      { value: "cpa/dangling", kind: "exact", matchedModelCount: 0, unavailableModelCount: 0, removable: true, editable: true },
      // 有效但无 metadata 的规则：policyOnlyExactRefs 的有效子集，绝不进清理列表
      { value: "cpa/valid-no-metadata", kind: "exact", matchedModelCount: 1, unavailableModelCount: 0, removable: true, editable: true },
      { value: "cpa/*", kind: "wildcard", matchedModelCount: 0, unavailableModelCount: 0, removable: true, editable: true }
    ],
    diagnostics: [],
    policyMode: "restricted",
    policyRevision: "v1:cleanup",
    summary: { modelCount: 0, policyAllowedCount: 0, availableCount: 0, unavailableCount: 0, unknownCount: 0 }
  };
}

/** 完整真实形状的 ConfigStatusReport fixture：stale 集 = unknownProviderRefs ∪ knownProviderUnknownModelRefs */
function configStatusFixture(): ConfigStatusReport {
  return {
    version: 1,
    health: {
      caseDuplicateGroups: [],
      summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 }
    },
    disabledProviders: [],
    orphanEnvKeys: [],
    envWarnings: [],
    modelPolicy: {
      mode: "restricted",
      policyEntryCount: 4,
      effectiveCatalogCount: 1,
      unknownProviderRefs: ["ghost/m1"],
      policyOnlyExactRefs: ["cpa/valid-no-metadata"],
      knownProviderUnknownModelRefs: ["cpa/dangling"]
    },
    issues: [],
    summary: {
      issueCount: 0,
      blockingIssueCount: 0,
      warningIssueCount: 0,
      duplicateGroupCount: 0,
      disabledProviderCount: 0,
      orphanEnvKeyCount: 0
    }
  };
}

describe("ModelsView 悬空引用清理入口（stale cleanup spec §6）", () => {
  test("stale 集 ∩ exact 规则驱动入口；确认后单次批量调用并应用写响应 inventory（不再 GET）", async () => {
    const getModelInventory = mock(async () => cleanupInventoryFixture());
    const getConfigStatus = mock(async () => configStatusFixture());
    const batchRemoveModelPolicyRules = mock(async () => ({ ok: true as const, removedCount: 2, backupId: "b1", warnings: [], inventory: cleanupInventoryFixture() }));
    const client = baseClient({ getModelInventory, getConfigStatus, batchRemoveModelPolicyRules });

    const { findByLabelText, findByRole, getByLabelText, queryByLabelText, getByText } = render(
      <ToastProvider>
        <ModelsView client={client} />
      </ToastProvider>
    );

    // 入口出现在 Policy 规则区段顶部（aria-label 为「清理悬空引用」，计数在文本里）
    await userEvent.click(await findByLabelText("展开 Policy 规则"));
    await userEvent.click(await findByRole("button", { name: "清理悬空引用" }));
    expect(getByText("清理悬空引用 (2)")).toBeTruthy();

    // 对话框仅列出 stale 两条（默认全选）；policyOnly 有效子集与 wildcard 不在列表
    expect(((await findByLabelText("选择悬空引用 ghost/m1")) as HTMLInputElement).checked).toBe(true);
    expect((getByLabelText("选择悬空引用 cpa/dangling") as HTMLInputElement).checked).toBe(true);
    expect(queryByLabelText("选择悬空引用 cpa/valid-no-metadata")).toBeNull();

    await userEvent.click(getByText("清理所选 (2)"));

    await waitFor(() => expect(batchRemoveModelPolicyRules).toHaveBeenCalledWith(["ghost/m1", "cpa/dangling"], "v1:cleanup"));
    // O3：写后不再 GET inventory（写响应中的有效 v2 视图被直接消费，GET 仍只有首屏一次）；
    // config-status 被重算一次（stale 集来源，initial + 写后）
    await waitFor(() => expect(getConfigStatus).toHaveBeenCalledTimes(2));
    expect(getModelInventory).toHaveBeenCalledTimes(1);
  });

  test("批量清理写后确认失败（inventory 为 {}）：静态保存后提示在线状态待确认，不自动 GET 重试", async () => {
    const getModelInventory = mock(async () => cleanupInventoryFixture());
    const getConfigStatus = mock(async () => configStatusFixture());
    const batchRemoveModelPolicyRules = mock(async () => ({ ok: true as const, removedCount: 2, backupId: "b1", warnings: [], runtimeConfirmed: false, inventory: {} }));
    const client = baseClient({ getModelInventory, getConfigStatus, batchRemoveModelPolicyRules });

    const { findByLabelText, findByRole, findByText, getByText } = render(
      <ToastProvider>
        <ModelsView client={client} />
      </ToastProvider>
    );

    await userEvent.click(await findByLabelText("展开 Policy 规则"));
    await userEvent.click(await findByRole("button", { name: "清理悬空引用" }));
    await userEvent.click(getByText("清理所选 (2)"));

    await waitFor(() => expect(batchRemoveModelPolicyRules).toHaveBeenCalledTimes(1));
    expect(await findByText("本地配置已保存，在线状态待确认")).toBeTruthy();
    // 不自动 GET inventory：后续读取交给用户手动刷新
    expect(getModelInventory).toHaveBeenCalledTimes(1);
  });

  test("stale 集为空时不显示清理入口", async () => {
    const getModelInventory = mock(async () => cleanupInventoryFixture());
    const getConfigStatus = mock(async () => ({
      ...configStatusFixture(),
      modelPolicy: {
        ...configStatusFixture().modelPolicy,
        unknownProviderRefs: [],
        knownProviderUnknownModelRefs: []
      }
    }));
    const client = baseClient({ getModelInventory, getConfigStatus });

    const { findByLabelText, queryByRole } = render(
      <ToastProvider>
        <ModelsView client={client} />
      </ToastProvider>
    );

    await userEvent.click(await findByLabelText("展开 Policy 规则"));
    await waitFor(() => expect(getConfigStatus).toHaveBeenCalled());
    expect(queryByRole("button", { name: /清理悬空引用/ })).toBeNull();
  });

  test("config-status 读取失败：明示「不可用」且不渲染清理入口（不伪装成没有悬空项）", async () => {
    const getModelInventory = mock(async () => cleanupInventoryFixture());
    const getConfigStatus = mock(async () => { throw new Error("config-status backend down"); });
    const client = baseClient({ getModelInventory, getConfigStatus });

    const { findByLabelText, findByText, queryByRole } = render(
      <ToastProvider>
        <ModelsView client={client} />
      </ToastProvider>
    );

    await userEvent.click(await findByLabelText("展开 Policy 规则"));
    // 明确「不可用」提示；清理入口保持禁写（不渲染），不回退逐条删除
    expect(await findByText(/悬空引用检查不可用（config-status 读取失败）/)).toBeTruthy();
    expect(queryByRole("button", { name: /清理悬空引用/ }) === null).toBe(true);
  });
});
