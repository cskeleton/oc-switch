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
  return { ...createApiClient({ baseUrl: "http://fixture.invalid", token: "test", fetchImpl: async () => { throw new Error("Unexpected request"); } }), getModelAttention: async () => ({ pending: [issue], ignored: [] }), ...overrides };
}
async function openIssue() {
  await userEvent.click(await screen.findByRole("button", { name: "需处理 1" }));
  await userEvent.click(screen.getByRole("button", { name: `处理问题 ${issue.ownerId}` }));
  return within(screen.getByRole("dialog"));
}

test("共享面板默认只有摘要，暂不处理不产生忽略写入", async () => {
  const save = mock(async () => ({ pending: [], ignored: [issue] }));
  render(<ModelAttentionPanel client={client({ setAttentionIgnored: save })} inventory={inventory} />);
  await screen.findByRole("button", { name: "需处理 1" });
  expect(screen.queryByText(issue.title) === null).toBe(true);
  const dialog = await openIssue();
  await userEvent.click(dialog.getByRole("button", { name: "暂不处理" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog") === null).toBe(true);
});

test("不再提醒写入决定，重开从已忽略读取并可恢复提醒", async () => {
  let report: ModelAttentionReport = { pending: [issue], ignored: [] };
  const api = client({ getModelAttention: async () => report, setAttentionIgnored: async (_issue, ignored) => report = ignored ? { pending: [], ignored: [issue] } : { pending: [issue], ignored: [] } });
  const view = render(<ModelAttentionPanel client={api} inventory={inventory} />);
  await userEvent.click((await openIssue()).getByRole("button", { name: "本问题不再提醒" }));
  await screen.findByRole("button", { name: "需处理 0" });
  view.unmount();
  render(<ModelAttentionPanel client={api} inventory={inventory} />);
  await userEvent.click(await screen.findByRole("button", { name: "已忽略 1" }));
  await userEvent.click(screen.getByRole("button", { name: `处理问题 ${issue.ownerId}` }));
  await userEvent.click(screen.getByRole("button", { name: "恢复提醒" }));
  await screen.findByRole("button", { name: "需处理 1" });
});

test("精确停用默认保留 metadata，清理须独立勾选；失败留在原面板", async () => {
  const remove = mock(async () => { throw new Error("配置已变化"); });
  const metadataInventory: ModelInventory = { ...inventory, models: [{ ref: "idle/one", providerId: "idle", modelId: "one", catalogSources: [], referenceSources: ["policy-exact", "legacy-metadata"], policyMode: "restricted", policyAllowed: true, availability: "unavailable", availabilityReasons: [], pluginIds: [], capabilities: { canTogglePolicy: false, canSetPrimary: false, canEditCatalogEntry: false, canMaterializeConfigModel: false, canRemovePolicyExactRef: true } }] };
  render(<ModelAttentionPanel client={client({ removeModelPolicyExactRef: remove })} inventory={metadataInventory} />);
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
  render(<ModelAttentionPanel client={client({ getModelAttention: async () => ({ pending: [critical], ignored: [] }) })} inventory={inventory} onConfigure={configure} />);
  const dialog = await openIssue();
  expect(dialog.queryByRole("button", { name: "本问题不再提醒" }) === null).toBe(true);
  expect(dialog.queryByRole("button", { name: "不再使用，保留 Key" }) === null).toBe(true);
  await userEvent.click(dialog.getByRole("button", { name: "配置 idle" }));
  expect(configure).toHaveBeenCalledWith("idle");
});

test("过时决定被拒绝时不伪装成已忽略", async () => {
  render(<ModelAttentionPanel client={client({ setAttentionIgnored: async () => { throw new Error("问题已变化，请刷新"); } })} inventory={inventory} />);
  const dialog = await openIssue();
  await userEvent.click(dialog.getByRole("button", { name: "本问题不再提醒" }));
  expect(await dialog.findByText("问题已变化，请刷新")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "已忽略 1" }) === null).toBe(true);
});

test("批量插件停用保留 Key，未确认仅报告一次待应用，不称写入失败", async () => {
  const grouped = { ...issue, ownerType: "plugin" as const, ownerId: "shelved", refs: ["idle/one", "idle/two"] };
  const stop = mock(async () => ({ ok: true as const, pluginId: "shelved", enabled: false, runtimeConfirmed: false, backupId: "backup", warnings: [], affectedProviderIds: ["idle"] }));
  render(<ModelAttentionPanel client={client({ getModelAttention: async () => ({ pending: [grouped], ignored: [] }), setPluginState: stop })} inventory={inventory} />);
  await userEvent.click(await screen.findByRole("button", { name: "需处理 1" }));
  await userEvent.click(screen.getByRole("button", { name: "处理问题 shelved" }));
  await userEvent.click(screen.getByRole("button", { name: "不再使用，保留 Key" }));
  expect(await screen.findByText(/配置已保存，等待 Gateway/)).toBeTruthy();
  expect(stop).toHaveBeenCalledWith("shelved", false, false);
});
