import "./test-setup";
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelAttentionPanel } from "./components/ModelAttentionPanel";
import { createApiClient, type ApiClient, type ModelAttentionIssue, type ModelAttentionReport, type ModelInventory } from "./api";

afterEach(cleanup);
const issue: ModelAttentionIssue = { id: "model:idle/one:unavailable", revision: "v1", kind: "unavailable", ownerType: "model", ownerId: "idle/one", providerIds: ["idle"], refs: ["idle/one"], protectedRefs: [], title: "idle 的模型未就绪", detail: "可配置或不再使用", canIgnore: true, canDisable: true };
const inventory: ModelInventory = { schemaVersion: 2, pickerSource: "gateway", models: [], providers: [], plugins: [], policyRules: [], diagnostics: [], summary: { modelCount: 0, policyAllowedCount: 0, availableCount: 0, unavailableCount: 0, unknownCount: 0 } };
function client(overrides: Partial<ApiClient> = {}): ApiClient {
  return { ...createApiClient({ baseUrl: "http://fixture.invalid", token: "test", fetchImpl: async () => { throw new Error("Unexpected request"); } }), ...overrides };
}
/** 面板只消费 report：getModelAttention 由父页面负责，面板不得自行请求 */
function renderPanel(overrides: Partial<ApiClient> = {}, props: Partial<Parameters<typeof ModelAttentionPanel>[0]> = {}) {
  const getModelAttention = mock(async (): Promise<ModelAttentionReport> => ({ pending: [issue], ignored: [] }));
  const api = client({ getModelAttention, ...overrides });
  const view = render(<ModelAttentionPanel client={api} inventory={inventory} report={{ pending: [issue], ignored: [] }} {...props} />);
  return { view, getModelAttention };
}
async function openIssue() {
  await userEvent.click(await screen.findByRole("button", { name: "需处理 1" }));
  await userEvent.click(screen.getByRole("button", { name: `处理问题 ${issue.ownerId}` }));
  return within(screen.getByRole("dialog"));
}

test("面板消费 report 渲染摘要，不自行请求 attention", async () => {
  const { getModelAttention } = renderPanel();
  await screen.findByRole("button", { name: "需处理 1" });
  expect(screen.queryByText(issue.title) === null).toBe(true);
  expect(getModelAttention).not.toHaveBeenCalled();
});

test("父页面读取失败的 loadError 在面板中可见", async () => {
  renderPanel({}, { report: { pending: [], ignored: [] }, loadError: "无法读取问题状态" });
  expect((await screen.findByRole("alert")).textContent).toContain("无法读取问题状态");
});

test("默认只有摘要，暂不处理不产生忽略写入", async () => {
  const save = mock(async () => ({ pending: [], ignored: [issue] }));
  const { getModelAttention } = renderPanel({ setAttentionIgnored: save });
  await screen.findByRole("button", { name: "需处理 1" });
  expect(screen.queryByText(issue.title) === null).toBe(true);
  const dialog = await openIssue();
  await userEvent.click(dialog.getByRole("button", { name: "暂不处理" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog") === null).toBe(true);
  expect(getModelAttention).not.toHaveBeenCalled();
});

test("不再提醒写入决定并交给父页面刷新一轮", async () => {
  const save = mock(async () => ({ pending: [], ignored: [issue] }));
  const onChanged = mock(() => {});
  renderPanel({ setAttentionIgnored: save }, { onChanged });
  await userEvent.click((await openIssue()).getByRole("button", { name: "本问题不再提醒" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(issue, true));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  await screen.findByRole("button", { name: "需处理 1" });
});

test("精确停用默认保留 metadata，清理须独立勾选；失败留在原面板", async () => {
  const remove = mock(async () => { throw new Error("配置已变化"); });
  const metadataInventory: ModelInventory = { ...inventory, models: [{ ref: "idle/one", providerId: "idle", modelId: "one", catalogSources: [], referenceSources: ["policy-exact", "legacy-metadata"], policyMode: "restricted", policyAllowed: true, availability: "unavailable", availabilityReasons: [], pluginIds: [], capabilities: { canTogglePolicy: false, canSetPrimary: false, canEditCatalogEntry: false, canMaterializeConfigModel: false, canRemovePolicyExactRef: true } }] };
  renderPanel({ removeModelPolicyExactRef: remove }, { inventory: metadataInventory });
  const dialog = await openIssue();
  const check = dialog.getByRole("checkbox") as HTMLInputElement;
  expect(check.checked).toBe(false);
  await userEvent.click(dialog.getByRole("button", { name: "不再使用，保留 Key" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("idle/one", false));
  expect(await dialog.findByText("配置已变化")).toBeTruthy();
  await userEvent.click(check);
  await userEvent.click(dialog.getByRole("button", { name: "不再使用，保留 Key" }));
  await waitFor(() => expect(remove).toHaveBeenLastCalledWith("idle/one", true));
});

test("关键依赖没有忽略和直接停用入口，配置动作带准确 Provider ID", async () => {
  const configure = mock(() => {});
  const critical = { ...issue, canIgnore: false, canDisable: false, protectedRefs: ["idle/one"] };
  renderPanel({}, { report: { pending: [critical], ignored: [] }, onConfigure: configure });
  const dialog = await openIssue();
  expect(dialog.queryByRole("button", { name: "本问题不再提醒" }) === null).toBe(true);
  expect(dialog.queryByRole("button", { name: "不再使用，保留 Key" }) === null).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: "配置 idle" }));
  expect(configure).toHaveBeenCalledWith("idle");
});

test("过时决定被拒绝时不伪装成已忽略", async () => {
  renderPanel({ setAttentionIgnored: async () => { throw new Error("问题已变化，请刷新"); } });
  const dialog = await openIssue();
  await userEvent.click(dialog.getByRole("button", { name: "本问题不再提醒" }));
  expect(await dialog.findByText("问题已变化，请刷新")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "已忽略 1" }) === null).toBe(true);
});

test("批量插件停用保留 Key，未确认仅报告一次待应用，不称写入失败", async () => {
  const grouped = { ...issue, ownerType: "plugin" as const, ownerId: "shelved", refs: ["idle/one", "idle/two"] };
  const stop = mock(async () => ({ ok: true as const, pluginId: "shelved", enabled: false, runtimeConfirmed: false, backupId: "backup", warnings: [], affectedProviderIds: ["idle"] }));
  renderPanel({ setPluginState: stop }, { report: { pending: [grouped], ignored: [] } });
  await userEvent.click(await screen.findByRole("button", { name: "需处理 1" }));
  await userEvent.click(screen.getByRole("button", { name: "处理问题 shelved" }));
  await userEvent.click(screen.getByRole("button", { name: "不再使用，保留 Key" }));
  expect(await screen.findByText(/配置已保存，等待 Gateway/)).toBeTruthy();
  expect(stop).toHaveBeenCalledWith("shelved", false, false);
});

test("显式重探测只发一个 refresh，并把 inventory 交给父页面消费", async () => {
  const probe = { ...issue, kind: "probe" as const };
  const refreshed: ModelInventory = { ...inventory, pickerSource: "inferred" };
  const refreshModelInventory = mock(async () => refreshed);
  const onChanged = mock(() => {});
  renderPanel({ refreshModelInventory }, { report: { pending: [probe], ignored: [] }, onChanged });
  await userEvent.click(await screen.findByRole("button", { name: "需处理 1" }));
  await userEvent.click(screen.getByRole("button", { name: "处理问题 idle/one" }));
  await userEvent.click(screen.getByRole("button", { name: "重新探测" }));
  await waitFor(() => expect(refreshModelInventory).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(refreshed));
});
