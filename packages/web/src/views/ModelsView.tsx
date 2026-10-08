import { runtimeConfirmationIssue } from "../api";
import { OperationProgress } from "../components/OperationProgress";
import { ModelAttentionPanel } from "../components/ModelAttentionPanel";
import { StalePolicyRefsCleanupDialog, type StalePolicyRef } from "../components/StalePolicyRefsCleanupDialog";
import { Edit3, Inbox, Plus, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { LoadingNotice } from "../components/LoadingNotice";
import { ModelDialog } from "../components/ModelDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { ModelDeleteLayers } from "../components/ModelDeleteLayers";
import { ModelPolicyPanel } from "../components/ModelPolicyPanel";
import { PageHeader } from "../components/PageHeader";
import { AVAILABILITY_REASON_LABELS, ModelStateBadges } from "../components/ModelStateBadges";
import { UnavailableModelsPanel } from "../components/UnavailableModelsPanel";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { Pill } from "../components/ui/pill";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import {
  inventoryFromWriteResponse,
  isPolicyRevisionConflict,
  type ApiClient,
  type ConfigStatusReport,
  type ModelAttentionReport,
  type ModelInventory,
  type ModelInventoryEntry,
  type ModelPolicyRuleEntry,
  type ModelSummary,
  type ProviderModelInput,
  type StaticModelConfigSnapshot,
  type StaticModelSummary,
  type StaticModelPolicyRuleEntry,
  type PluginExtensionsSnapshot,
  type ProviderSummary
} from "../api";

interface ModelsViewProps {
  client: ApiClient;
  onOpenProviders?: (providerId?: string) => void;
}

/** 处理向导只记录目标；权限始终读取当前 inventory，不复制策略算法。 */
interface PendingModelAction {
  kind: "handle" | "remove-policy-ref" | "materialize" | "replace" | "add-policy-rule" | "remove-policy-rule" | "edit-policy-rule" | "clean-dangling";
  ref: string;
  /** 打开对话框时冻结的 policy revision（背景刷新不替换），用于写入冲突校验 */
  ruleRevision?: string | undefined;
  /** 打开对话框时冻结的相同规则副本数（仅用于提示） */
  ruleCopies?: number | undefined;
}

/** 编辑能力不等于删除能力：引用保护与 exact 删除许可均使用 Core 返回的事实。 */
type LocalOrRuntimeModel = StaticModelSummary | ModelInventoryEntry;
type PolicyRule = StaticModelPolicyRuleEntry | ModelPolicyRuleEntry;
function wildcardCovered(entry: LocalOrRuntimeModel): boolean { return "referenceSources" in entry ? entry.referenceSources.includes("policy-wildcard") : entry.selectionSource === "policy-wildcard"; }
function canDeleteCatalogEntry(entry: LocalOrRuntimeModel): boolean {
  if ("catalogConfigured" in entry) return entry.capabilities.canRemoveCatalogEntry;
  if (!entry.capabilities.canEditCatalogEntry || entry.availability === "unknown") return false;
  if (entry.referenceSources.includes("primary") || entry.referenceSources.includes("fallback")) return false;
  // wildcard 覆盖不再阻止删除（服务端已放宽，删除后仅以 warning 提示）；
  // 仅 policy-exact 引用仍要求 Core 许可（防清空 guard 等）
  if (entry.referenceSources.includes("policy-exact")) return entry.capabilities.canRemovePolicyExactRef;
  return true;
}

/** 待处理行的严重性权重（小者在前）：主模型 > fallback > 悬空精确引用 > 其余不可用 > 探测未知 */
function pendingSeverity(entry: ModelInventoryEntry): number {
  if (entry.availability === "unknown") return 5;
  if (entry.referenceSources.includes("primary")) return 0;
  if (entry.referenceSources.includes("fallback")) return 1;
  if (entry.referenceSources.includes("policy-exact")) return 2;
  if (entry.availability === "unavailable") return 3;
  return 4;
}

/** 悬空引用行优先按 ref 字典序排（与待处理区段整体稳定排序配合） */
function comparePendingModels(a: ModelInventoryEntry, b: ModelInventoryEntry): number {
  const severityDiff = pendingSeverity(a) - pendingSeverity(b);
  return severityDiff !== 0 ? severityDiff : a.ref.localeCompare(b.ref);
}

/** 编辑保存前的客户端预检（服务端仍是权威）：trim 后折叠 exact 的 provider 段大小写，判断是否真有变化 */
function ruleEditUnchanged(oldValue: string, input: string): boolean {
  const trimmed = input.trim();
  const slash = trimmed.indexOf("/");
  const normalized = slash > 0 && !trimmed.endsWith("*")
    ? trimmed.slice(0, slash).toLowerCase() + trimmed.slice(slash)
    : trimmed;
  return normalized === oldValue;
}

export function ModelsView({ client, onOpenProviders }: ModelsViewProps) {
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<StaticModelConfigSnapshot | null>(null);
  const [extensions, setExtensions] = useState<PluginExtensionsSnapshot | null>(null);
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [onlinePending, setOnlinePending] = useState(false);
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [creating, setCreating] = useState(false);
  /** 打开 Custom Provider 向导（Provider 缺失的补全路径）并预填首行模型 */
  const [customPrefill, setCustomPrefill] = useState<{ providerId: string; modelId: string } | null>(null);
  const [editTarget, setEditTarget] = useState<LocalOrRuntimeModel | null>(null);
  /** 编辑对话框的目录定义（打开编辑时经兼容期 GET /api/models 补全） */
  const [editSummary, setEditSummary] = useState<ModelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalOrRuntimeModel | null>(null);
  /** 删除分级（三层写模型）：默认全 false = 临时移除，仅删目录条目 */
  const [deleteLayers, setDeleteLayers] = useState({ metadata: false, policyExact: false });
  const [newPrimary, setNewPrimary] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 一轮加载是否进行中；首轮（inventory 尚未取得）据此展示加载提示 */
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [manageCatalog, setManageCatalog] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  /** 处理向导（待处理区段「处理」入口）：补全 / 替换 / 独立 metadata 复选 / 保留 */
  const [pendingAction, setPendingAction] = useState<PendingModelAction | null>(null);
  /** policy 规则视图（spec §11.3）：默认折叠，展开后渲染 inventory.policyRules */
  const [showPolicyRules, setShowPolicyRules] = useState(false);
  /** config-status 报告：悬空策略引用清理（stale cleanup spec §6）的 stale 集来源 */
  const [configStatus, setConfigStatus] = useState<ConfigStatusReport | null>(null);
  /** config-status 读取失败：清理入口保持禁写并明示「不可用」，不伪装成「没有悬空项」 */
  const [configStatusUnavailable, setConfigStatusUnavailable] = useState(false);
  /** 问题报告由本页统一读取（每轮一次），面板只消费 report 与事件回调 */
  const [attention, setAttention] = useState<ModelAttentionReport>({ pending: [], ignored: [] });
  const [attentionError, setAttentionError] = useState<string | null>(null);
  /** 「清理悬空引用」对话框开关 */
  const [staleCleanupOpen, setStaleCleanupOpen] = useState(false);
  const [removeMetadata, setRemoveMetadata] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** 添加 policy 规则对话框的受控输入（格式由服务端权威校验） */
  const [policyRuleInput, setPolicyRuleInput] = useState("");

  /** config-status 只按当前 inventory 的需要读取；失败标记为不可用（保留禁写，不伪装成无悬空项） */
  const configStatusSeq = useRef(0);
  const refreshConfigStatus = useCallback(async (next: ModelInventory) => {
    const seq = ++configStatusSeq.current;
    if (next.policyMode === "restricted" && next.policyRules.length > 0) {
      try {
        const report = await client.getConfigStatus();
        // 乱序响应：新一轮已启动时，旧 config-status 不得覆盖
        if (seq !== configStatusSeq.current) return;
        setConfigStatus(report);
        setConfigStatusUnavailable(false);
      } catch {
        if (seq !== configStatusSeq.current) return;
        setConfigStatus(null);
        setConfigStatusUnavailable(true);
      }
    } else {
      setConfigStatus(null);
      setConfigStatusUnavailable(false);
    }
  }, [client]);

  const loadSeq = useRef(0);
  const loadStatic = useCallback(async (seq: number) => {
    setLoading(true);
    setError(null);
    try {
      const next = await client.getModelConfig();
      if (seq === loadSeq.current) setSnapshot(next);
    } catch (err) {
      if (seq === loadSeq.current) setError(err instanceof Error ? err.message : "本地配置读取失败");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [client]);
  const loadExtensions = useCallback(async (seq: number) => {
    setExtensionsLoading(true);
    setExtensionsError(null);
    try {
      const next = await client.getModelExtensions();
      if (seq === loadSeq.current) setExtensions(next);
    } catch (err) {
      if (seq === loadSeq.current) setExtensionsError(err instanceof Error ? err.message : "插件目录读取失败");
    } finally {
      if (seq === loadSeq.current) setExtensionsLoading(false);
    }
  }, [client]);
  const loadRuntime = useCallback(async (seq: number, preset?: ModelInventory, force = false) => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const next = preset ?? await (force ? client.refreshModelInventory() : client.getModelInventory());
      if (seq !== loadSeq.current) return;
      setInventory(next);
      const confirmationIssue = runtimeConfirmationIssue(next);
      setOnlinePending(confirmationIssue !== null);
      setRuntimeError(confirmationIssue);
      const [report] = await Promise.all([client.getModelAttention().catch(err => { if (seq === loadSeq.current) setAttentionError(err instanceof Error ? err.message : "无法读取问题状态"); return null; }), refreshConfigStatus(next)]);
      if (!report) return;
      if (seq !== loadSeq.current) return;
      if (Array.isArray(report.pending) && Array.isArray(report.ignored)) { setAttention(report); setAttentionError(null); }
      else setAttentionError("提醒协议不兼容，请重启服务。");
    } catch (err) {
      if (seq === loadSeq.current) setRuntimeError(err instanceof Error ? err.message : "运行时状态未确认");
    } finally {
      if (seq === loadSeq.current) setRuntimeLoading(false);
    }
  }, [client, refreshConfigStatus]);
  const load = useCallback(async (preset?: ModelInventory) => {
    const seq = ++loadSeq.current;
    configStatusSeq.current += 1;
    await Promise.all([loadStatic(seq), loadExtensions(seq), loadRuntime(seq, preset)]);
  }, [loadStatic, loadExtensions, loadRuntime]);
  const saved = useCallback(async (next?: ModelInventory) => {
    const seq = ++loadSeq.current;
    configStatusSeq.current += 1;
    setInventory(next ?? null);
    setConfigStatus(null);
    setAttention({ pending: [], ignored: [] });
    setAttentionError(null);
    setRuntimeLoading(false);
    setExtensionsLoading(false);
    setRuntimeError(null);
    setOnlinePending(!next);
    toast.success(next ? "本地配置已保存" : "本地配置已保存，在线状态待确认");
    await loadStatic(seq);
    if (next) await loadRuntime(seq, next);
  }, [loadStatic, loadRuntime, toast]);
  const applyWriteInventory = saved;

  useEffect(() => { void load(); return () => { loadSeq.current += 1; configStatusSeq.current += 1; }; }, [load]);

  async function refreshProbe() {
    if (refreshing || busy) return;
    setRefreshing(true);
    const seq = ++loadSeq.current;
    configStatusSeq.current += 1;
    try {
      await Promise.all([loadStatic(seq), loadExtensions(seq), loadRuntime(seq, undefined, true)]);
    } finally { if (seq === loadSeq.current) setRefreshing(false); }
  }

  async function handleSetPrimary(ref: string) {
    if (busy) return;
    setBusy(ref);
    try {
      const result = await client.setPrimary(ref);
      toast.success(`已切换主模型为 ${ref}`);
      await saved(inventoryFromWriteResponse(result) ?? undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "设置主模型失败");
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(ref: string, enabled: boolean) {
    if (busy) return;
    setBusy(ref);
    try {
      const result = await client.patchModel(ref, !enabled);
      toast.success(!enabled ? `已启用 ${ref}` : `已禁用 ${ref}`);
      await saved(inventoryFromWriteResponse(result) ?? undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新模型状态失败");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate(providerId: string, model: ProviderModelInput) {
    setError(null);
    try {
      const result = await client.createModel(providerId, model);
      setCreating(false);
      toast.success(`已添加模型 ${providerId}/${model.id}`);
      await saved(inventoryFromWriteResponse(result) ?? undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function handleEdit(_providerId: string, model: ProviderModelInput) {
    if (!editTarget) return;
    setError(null);
    try {
      const result = await client.updateModel(editTarget.ref, model);
      setEditTarget(null);
      toast.success(`模型 ${editTarget.ref} 已更新`);
      await saved(inventoryFromWriteResponse(result) ?? undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    }
  }

  /** 编辑必须取得原始目录定义；读取失败不能以空参数覆盖现有配置。 */
  async function openEdit(row: LocalOrRuntimeModel) {
    if (busy) return;
    const matches = (snapshot?.models ?? []).filter(model => model.providerId.toLowerCase() === row.providerId.toLowerCase() && model.modelId === row.modelId && model.catalogConfigured);
    if (matches.length !== 1) { toast.error("模型目录已变化，请刷新后再编辑。"); return; }
    setEditTarget(row);
    setEditSummary(matches[0]!);
  }

  async function confirmDelete() {
    if (!deleteTarget || busy || !canDeleteCatalogEntry(deleteTarget)) return;
    setBusy(deleteTarget.ref);
    // wildcard 覆盖行不存在可删的 exact 条目，policyExact 恒为 false
    const covered = wildcardCovered(deleteTarget);
    try {
      const result = await client.deleteModel(deleteTarget.ref, {
        layers: { metadata: deleteLayers.metadata, policyExact: covered ? false : deleteLayers.policyExact }
      });
      setDeleteTarget(null);
      toast.success(`已删除模型 ${deleteTarget.ref}`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      await saved(inventoryFromWriteResponse(result) ?? undefined);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除模型失败");
    } finally {
      setBusy(null);
    }
  }

  function openAction(action: PendingModelAction) {
    if (busy) return;
    setRemoveMetadata(false);
    setActionError(null);
    setPolicyRuleInput("");
    setPendingAction(action);
  }

  function closeAction() {
    if (!busy) setPendingAction(null);
  }

  function openPendingAction(ref: string) {
    const entry = inventory?.models.find(model => model.ref === ref);
    if (!entry || (entry.availability === "unknown" && !entry.capabilities.canRemovePolicyExactRef)) return;
    const protectedRef = entry.referenceSources.includes("primary") || entry.referenceSources.includes("fallback");
    setNewPrimary(inventory?.models.find(model => model.capabilities.canSetPrimary)?.ref ?? "");
    openAction({ kind: protectedRef ? "replace" : "handle", ref });
  }

  const policyRules = inventory?.policyRules ?? snapshot?.policyRules ?? [];
  const policyMode = inventory?.policyMode ?? snapshot?.policyMode;
  const policyRevision = inventory?.policyRevision ?? snapshot?.policyRevision;

  // 原始规则值可能保留 Provider 大小写；这里只关联 DTO 行，不重新匹配或计算 policy。
  const pendingEntry = inventory?.models.find(model => {
    if (!pendingAction) return false;
    const slash = pendingAction.ref.indexOf("/");
    return model.providerId.toLowerCase() === pendingAction.ref.slice(0, slash).toLowerCase() &&
      model.modelId === pendingAction.ref.slice(slash + 1);
  });
  const canRemovePendingRef = pendingAction?.kind === "remove-policy-ref"
    ? policyRules.some(rule => rule.kind === "exact" && rule.value === pendingAction.ref && rule.removable) === true
    : pendingEntry?.capabilities.canRemovePolicyExactRef === true;

  /** 纯规则删除的 gating 在确认前从当前 inventory 重查（find 不到或不可删则禁用确认） */
  const pendingPolicyRule = pendingAction?.kind === "remove-policy-rule"
    ? policyRules.find(rule => rule.kind !== "invalid" && rule.value === pendingAction.ref)
    : undefined;

  /** 仅决定是否打开人工填写表单，不声明模型可运行或可写；创建仍走 Core 预检。 */
  function needsProviderForm(entry: ModelInventoryEntry): boolean {
    return entry.availability !== "unknown" && entry.pluginIds.length === 0 &&
      !entry.catalogSources.includes("plugin-manifest") &&
      !entry.referenceSources.includes("primary") && !entry.referenceSources.includes("fallback") &&
      !inventory?.providers.some(provider => provider.providerId.toLowerCase() === entry.providerId.toLowerCase() && provider.sources.includes("config"));
  }

  async function confirmRemovePolicyRef() {
    if (!pendingAction || busy || !canRemovePendingRef) return;
    setBusy(pendingAction.ref);
    setActionError(null);
    const cleanMetadata = removeMetadata && pendingEntry?.referenceSources.includes("legacy-metadata") === true;
    try {
      const result = await client.removeModelPolicyExactRef(pendingAction.ref, cleanMetadata);
      setPendingAction(null);
      toast.success(`已删除 ${pendingAction.ref} 的 policy 引用（legacy metadata ${cleanMetadata ? "已清理" : "保留"}）`);
      // 写响应带有效 inventory 时直接消费；确认失败仅提示「保存成功、未取得新视图」，不自动重试
      const next = inventoryFromWriteResponse(result);
      if (next) await applyWriteInventory(next);
      else await saved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "删除引用失败");
    } finally {
      setBusy(null);
    }
  }

  /** 添加 policy 规则：exact/wildcard 由服务端权威识别；错误内联，成功 toast 并应用写响应 inventory */
  async function confirmAddPolicyRule() {
    if (pendingAction?.kind !== "add-policy-rule" || busy) return;
    const rule = policyRuleInput.trim();
    if (!rule) return;
    setBusy(rule);
    setActionError(null);
    try {
      const result = await client.addModelPolicyRule(rule);
      setPendingAction(null);
      toast.success(`已添加${result.kind === "wildcard" ? "通配" : "精确"}规则 ${result.rule}（只改 modelPolicy.allow）`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      const next = inventoryFromWriteResponse(result);
      if (next) await applyWriteInventory(next);
      else await saved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "添加规则失败");
    } finally {
      setBusy(null);
    }
  }

  /** 打开纯规则删除确认框：冻结当前 revision 与相同副本数 */
  function openRemovePolicyRule(rule: PolicyRule) {
    openAction({
      kind: "remove-policy-rule",
      ref: rule.value,
      ruleRevision: policyRevision,
      ruleCopies: policyRules.filter(item => item.value === rule.value).length
    });
  }

  /** 打开规则编辑对话框：预填旧值，冻结当前 revision 与相同副本数 */
  function openEditPolicyRule(rule: PolicyRule) {
    openAction({
      kind: "edit-policy-rule",
      ref: rule.value,
      ruleRevision: policyRevision,
      ruleCopies: policyRules.filter(item => item.value === rule.value).length
    });
    setPolicyRuleInput(rule.value);
  }

  /** 纯规则删除：只改 modelPolicy.allow，不改目录/metadata；守卫失败（400）与 revision 冲突（409）内联展示 */
  async function confirmRemovePolicyRule() {
    if (pendingAction?.kind !== "remove-policy-rule" || busy || pendingPolicyRule?.removable !== true) return;
    if (!pendingAction.ruleRevision) return;
    const value = pendingAction.ref;
    setBusy(value);
    setActionError(null);
    try {
      const result = await client.removeModelPolicyRule(value, pendingAction.ruleRevision);
      setPendingAction(null);
      toast.success(`已删除${result.removedCount > 1 ? ` ${result.removedCount} 条相同` : ""}规则 ${value}（只改 modelPolicy.allow）`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      if (result.runtimeConfirmed === false) toast.warning("配置已保存，运行时未确认");
      const next = inventoryFromWriteResponse(result);
      if (next) await applyWriteInventory(next);
      else await saved();
    } catch (err) {
      setActionError(isPolicyRevisionConflict(err)
        ? "策略已变化，请刷新后重新核对规则再试。"
        : err instanceof Error ? err.message : "删除规则失败");
    } finally {
      setBusy(null);
    }
  }

  /** 编辑规则：原子替换（无中间删除态）；409 保留输入不自动重试 */
  async function confirmEditPolicyRule() {
    if (pendingAction?.kind !== "edit-policy-rule" || busy) return;
    if (!pendingAction.ruleRevision) return;
    const rule = policyRuleInput.trim();
    if (!rule || rule === pendingAction.ref) return;
    setBusy(pendingAction.ref);
    setActionError(null);
    try {
      const result = await client.replaceModelPolicyRule(pendingAction.ref, rule, pendingAction.ruleRevision);
      setPendingAction(null);
      toast.success(`已把规则 ${pendingAction.ref} 替换为 ${result.rule}（只改 modelPolicy.allow）`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      if (result.runtimeConfirmed === false) toast.warning("配置已保存，运行时未确认");
      const next = inventoryFromWriteResponse(result);
      if (next) await applyWriteInventory(next);
      else await saved();
    } catch (err) {
      setActionError(isPolicyRevisionConflict(err)
        ? "策略已变化，请刷新后重新核对规则再试。"
        : err instanceof Error ? err.message : "编辑规则失败");
    } finally {
      setBusy(null);
    }
  }

  async function confirmMaterialize() {
    if (!pendingEntry?.capabilities.canMaterializeConfigModel || busy) return;
    setBusy(pendingEntry.ref);
    setActionError(null);
    try {
      const result = await client.materializeRuntimeModel(pendingEntry.ref, { id: pendingEntry.modelId, enabled: false });
      setPendingAction(null);
      toast.success(`已把 ${pendingEntry.ref} 补入 Provider ${pendingEntry.providerId} 的本地目录`);
      const next = inventoryFromWriteResponse(result);
      if (next) await applyWriteInventory(next);
      else await saved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "补全配置失败");
    } finally {
      setBusy(null);
    }
  }

  /**
   * 清理悬空 metadata 残留：该 ref 只存在于 agents.defaults.models（别名/参数），
   * 任何目录来源都没有它。只删 metadata 层，不动目录、策略与 API Key。
   */
  async function confirmCleanDangling() {
    if (busy || pendingEntry?.capabilities.canRemoveDanglingMetadata !== true) return;
    setBusy(pendingEntry.ref);
    setActionError(null);
    try {
      const result = await client.removeDanglingModelMetadata(pendingEntry.ref);
      setPendingAction(null);
      toast.success(`已清理 ${pendingEntry.ref} 的残留引用（别名/参数）`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      await saved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "清理残留引用失败");
    } finally {
      setBusy(null);
    }
  }

  function openCreateProvider() {
    if (!pendingEntry || !needsProviderForm(pendingEntry)) return;
    setCustomPrefill({ providerId: pendingEntry.providerId, modelId: pendingEntry.modelId });
    setPendingAction(null);
  }
  async function confirmReplacePrimary() {
    if (busy || !pendingEntry?.referenceSources.includes("primary")) return;
    if (!inventory?.models.some(model => model.ref === newPrimary && model.capabilities.canSetPrimary)) return;
    setBusy(newPrimary);
    setActionError(null);
    try {
      await client.setPrimary(newPrimary);
      setPendingAction(null);
      toast.success(`已切换主模型为 ${newPrimary}；回退链保持不变`);
      await saved();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "替换主模型失败");
    } finally {
      setBusy(null);
    }
  }

  // 左侧 Provider 导航：未关闭在前、已关闭沉底，组内按 id localeCompare。
  // pickerVisible 为 v2 必填布尔（API 边界已校验），不再回退猜测。
  const providerIds = useMemo(() => {
    const local = (snapshot?.providers ?? []).map(provider => ({ id: provider.id, disabled: provider.disabled }));
    const seen = new Set(local.map(provider => provider.id.toLowerCase()));
    const runtime = (inventory?.providers ?? []).filter(provider => !seen.has(provider.providerId.toLowerCase()) && (manageCatalog || (inventory?.models ?? []).some(model => model.providerId.toLowerCase() === provider.providerId.toLowerCase() && model.pickerVisible))).map(provider => ({ id: provider.providerId, disabled: provider.disabled }));
    const plugin = (extensions?.providers ?? []).filter(provider => !seen.has(provider.providerId.toLowerCase()) && !runtime.some(row => row.id.toLowerCase() === provider.providerId.toLowerCase())).map(provider => ({ id: provider.providerId, disabled: !provider.enabled }));
    return [...local, ...runtime, ...plugin].sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.id.localeCompare(b.id)).map(provider => provider.id);
  }, [snapshot, extensions, inventory, manageCatalog]);

  useEffect(() => {
    setSelectedProviderId(previous => providerIds.find(id => id.toLowerCase() === previous?.toLowerCase()) ?? providerIds[0] ?? null);
  }, [providerIds]);

  const filteredProviderIds = useMemo(() => {
    const normalized = providerQuery.trim().toLowerCase();
    if (!normalized) return providerIds;
    return providerIds.filter((pId) => pId.toLowerCase().includes(normalized));
  }, [providerIds, providerQuery]);

  /**
   * 默认完整呈现选择器选项（pickerVisible 为 v2 必填布尔，非法 DTO 已在 API 边界拒绝）；
   * 管理视图另外显示闲置目录，问题行集中在待处理区。
   * 例外：可清理的悬空 metadata 残留在管理视图必须可达——legacy 模式下这类行是
   * `policyAllowed=true` + 不可用 ⇒ `needsAttention=true` 且 `pickerVisible=false`，
   * 沿用同一过滤会让它在两个视图里都看不见，清理入口形同虚设。
   */
  const selectableModels = useMemo(() => {
    const models = (inventory?.models ?? []).filter(model => !(snapshot?.models ?? []).some(local => local.catalogConfigured && local.providerId.toLowerCase() === model.providerId.toLowerCase() && local.modelId === model.modelId));
    return models.filter((model) => manageCatalog
      ? (!model.needsAttention || model.capabilities.canRemoveDanglingMetadata === true)
      : model.pickerVisible);
  }, [inventory, snapshot, manageCatalog]);

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const model of [...selectableModels, ...(snapshot?.models ?? []).filter(model => model.catalogConfigured)]) {
      const providerId = model.providerId.toLowerCase();
      counts[providerId] = (counts[providerId] || 0) + 1;
    }
    if (!inventory) for (const provider of extensions?.providers ?? []) { const id = provider.providerId.toLowerCase(); if (!(id in counts)) counts[id] = provider.models.length; }
    return counts;
  }, [selectableModels, snapshot, inventory, extensions]);

  const activeModels = useMemo(() => {
    if (!selectedProviderId) return [];
    const pModels = selectableModels.filter((m) => m.providerId.toLowerCase() === selectedProviderId.toLowerCase());
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return pModels;
    return pModels.filter((m) => {
      const haystack = [m.ref, m.modelId].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [selectableModels, selectedProviderId, query]);

  // 可用模型按 ref 排序（区段固定，不提供表头排序）。
  // 策略未允许（policyAllowed=false）的 available 行也必须可达，开关用于安全启用策略，
  // capability.canTogglePolicy 为 false 时无开关（如通配覆盖行）——不拆独立「已禁用」区段
  const activeAvailableModels = useMemo(
    () => activeModels.slice().sort((a, b) => a.ref.localeCompare(b.ref)),
    [activeModels]
  );

  // 待处理区段：unavailable / unknown 全量（跨 Provider 汇总入口），按严重性排序
  const pendingModels = useMemo(() => {
    const models = (inventory?.models ?? []).filter(
      (model) => model.needsAttention === true
    );
    return models.slice().sort(comparePendingModels);
  }, [inventory]);

  /**
   * 悬空策略引用（stale cleanup spec §6）：stale 集 = unknownProviderRefs ∪ knownProviderUnknownModelRefs，
   * 与 policyRules 中 kind==="exact" 规则按原始字符串求交。policyOnlyExactRefs 的有效子集绝不进列表。
   */
  const staleRefs = useMemo<StalePolicyRef[]>(() => {
    const rules = policyRules;
    const policy = configStatus?.modelPolicy;
    if (inventory?.policyMode !== "restricted" || rules.length === 0 || !policy) return [];
    const unknownProviders = new Set(policy.unknownProviderRefs);
    const exactValues = new Set(rules.filter((rule) => rule.kind === "exact").map((rule) => rule.value));
    const result: StalePolicyRef[] = [];
    const seen = new Set<string>();
    for (const value of [...policy.unknownProviderRefs, ...policy.knownProviderUnknownModelRefs]) {
      if (!exactValues.has(value) || seen.has(value)) continue;
      seen.add(value);
      result.push({ value, reason: unknownProviders.has(value) ? "unknown-provider" : "unknown-model" });
    }
    return result;
  }, [inventory, configStatus]);

  const staticProvider = snapshot?.providers.find(provider => provider.id.toLowerCase() === selectedProviderId?.toLowerCase());
  const localModels = (snapshot?.models ?? []).filter(model => model.catalogConfigured && model.providerId.toLowerCase() === selectedProviderId?.toLowerCase() && (!query.trim() || [model.ref, model.alias ?? ""].join(" ").toLowerCase().includes(query.trim().toLowerCase())));
  const extensionProvider = extensions?.providers.find(provider => provider.providerId.toLowerCase() === selectedProviderId?.toLowerCase());
  const extensionModels = inventory === null ? (extensionProvider?.models ?? []).filter(model => !query.trim() || model.id.toLowerCase().includes(query.trim().toLowerCase())) : [];
  const activeProvider = (inventory?.providers ?? []).find((p) => p.providerId.toLowerCase() === selectedProviderId?.toLowerCase());
  const activeProviderDisabled = Boolean(staticProvider?.disabled ?? activeProvider?.disabled);
  const activeProviderFromConfig = Boolean(staticProvider || activeProvider?.sources.includes("config"));
  const activeProviderPluginDisabled = activeProvider?.pluginEnabled === false;
  const pluginOnlyProvider = activeProvider?.sources.includes("plugin-manifest") && !activeProviderFromConfig;
  const providerDisabledHint = "该 Provider 已关闭，请先恢复 Provider 后再启用模型";

  const unavailableCount = pendingModels.filter(model => model.availability === "unavailable").length;
  const unknownCount = pendingModels.filter(model => model.availability === "unknown").length;

  function renderModelTable(list: ModelInventoryEntry[], opacityClass: string = "") {
    return (
      <div className={opacityClass}>
        <DataTable
          rows={list}
          rowKey={(row) => row.ref}
          emptyMessage="没有匹配的模型"
          minWidthClass="min-w-[20rem] sm:min-w-[34rem]"
          columns={[
            {
              key: "ref",
              header: "引用",
              // ref 是长路径（provider/vendor/model），允许任意位置断行
              wrap: "anywhere",
              render: (row) => (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {row.referenceSources.includes("primary") ? (
                    <Star aria-label="当前主模型" className="h-3.5 w-3.5 shrink-0 fill-brand text-brand" />
                  ) : null}
                  <span className={row.referenceSources.includes("primary") ? "font-semibold" : "font-medium"}>
                    {row.ref}
                  </span>
                  {row.referenceSources.includes("primary") ? <Pill variant="brand">当前主模型</Pill> : null}
                  <ModelStateBadges entry={row} plugins={inventory?.plugins ?? []} />
                </div>
              )
            },
            {
              key: "actions",
              header: "操作",
              wrap: "nowrap",
              className: "w-40 text-right pr-4",
              render: (row) => {
                // 普通区段只渲染 available 行；不可用 / 未知行走待处理区段（无普通启停开关）
                const wildcardSelected = row.selectionSource === "policy-wildcard";
                // 能力门控（binding）：开关 / 主模型 / 编辑 / 删除入口全部由 capability 决定。
                // capability 拒绝的启停不渲染开关（unavailable 行无普通开关；wildcard 行不可逐模型关闭）
                const canToggle = row.capabilities.canTogglePolicy;
                const canPrimary = row.capabilities.canSetPrimary;
                const canEdit = row.capabilities.canEditCatalogEntry;
                const canDelete = canDeleteCatalogEntry(row);
                // runtime-only 可用模型可补全进 config Provider 目录（spec §8.1 补全配置）
                const canMaterialize = row.capabilities.canMaterializeConfigModel;
                // 悬空 metadata 残留（仅引用、无目录条目）：清理入口由 Core 事实推导，不由 UI 猜
                const canCleanDangling = row.capabilities.canRemoveDanglingMetadata === true;
                return (
                <div className="flex items-center justify-end gap-1.5 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
                  {canPrimary ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy !== null}
                      onClick={() => { if (!row.referenceSources.includes("primary")) void handleSetPrimary(row.ref); }}
                      aria-label={`设为主模型 ${row.ref}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Star className="h-3.5 w-3.5 fill-none" />
                    </Button>
                  ) : null}
                  {canToggle ? (
                    <Switch
                      checked={row.policyAllowed}
                      disabled={busy !== null}
                      onCheckedChange={() => void handleToggle(row.ref, row.policyAllowed)}
                      aria-label={`${row.policyAllowed ? "禁用" : "启用"} ${row.ref}`}
                      title={activeProviderDisabled ? providerDisabledHint : undefined}
                    />
                  ) : null}
                  {/* 通配覆盖行：无逐模型开关，但「先收窄规则」提示必须可达（spec §11.2） */}
                  {wildcardSelected ? (
                    <span
                      className="text-xs text-muted-foreground whitespace-nowrap"
                      title="该模型由通配策略启用；请先收窄 policy 后再单独禁用"
                    >
                      通配覆盖
                    </span>
                  ) : null}
                  {canMaterialize ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`补全到目录 ${row.ref}`}
                      title="把该运行时模型补入本 Provider 的本地目录"
                      disabled={busy !== null}
                      onClick={() => openAction({ kind: "materialize", ref: row.ref })}
                    >
                      补全到目录
                    </Button>
                  ) : null}
                  {canCleanDangling ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`清理残留引用 ${row.ref}`}
                      title="该引用只存在于 agents.defaults.models（别名/参数），目录里没有它；清理只摘掉这条残留"
                      disabled={busy !== null}
                      onClick={() => openAction({ kind: "clean-dangling", ref: row.ref })}
                    >
                      清理残留
                    </Button>
                  ) : null}
                  {needsProviderForm(row) ? (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => openAction({ kind: "handle", ref: row.ref })} aria-label={`补全 Provider 配置 ${row.ref}`}>
                      补全 Provider
                    </Button>
                  ) : null}
                  {canEdit ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy !== null}
                        onClick={() => void openEdit(row)}
                        aria-label={`编辑模型 ${row.ref}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                  ) : null}
                  {canDelete ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy !== null}
                        onClick={() => { setDeleteLayers({ metadata: false, policyExact: false }); setDeleteTarget(row); }}
                        aria-label={`删除模型 ${row.ref}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                  ) : null}
                </div>
                );
              }
            }
          ]}
        />
      </div>
    );
  }

  function renderStaticModels() {
    return <div data-testid="static-models" className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">本地配置模型 ({localModels.length})</h3>
      <DataTable rows={localModels} rowKey={row => row.ref} minWidthClass="min-w-[20rem] sm:min-w-[34rem]" columns={[
        { key: "ref", header: "引用", wrap: "anywhere", render: row => <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{row.ref}</span>{row.isPrimary ? <Pill variant="brand">当前主模型</Pill> : null}<Pill variant={row.enabled ? "success" : "muted"}>{row.enabled ? "策略允许" : "未启用"}</Pill><Pill variant="muted">配置</Pill>{inventory?.models.find(entry => entry.ref === row.ref) ? <ModelStateBadges entry={inventory.models.find(entry => entry.ref === row.ref)!} plugins={inventory.plugins} /> : <span className="text-xs text-muted-foreground">在线状态待确认</span>}</div> },
        { key: "actions", header: "操作", wrap: "nowrap", render: row => <div className="flex items-center justify-end gap-1.5">
          {row.capabilities.canSetPrimary && !row.isPrimary ? <Button variant="ghost" size="icon" disabled={busy !== null} aria-label={`设为主模型 ${row.ref}`} onClick={() => void handleSetPrimary(row.ref)}><Star className="h-3.5 w-3.5" /></Button> : null}
          {row.capabilities.canTogglePolicy ? <Switch checked={row.enabled} disabled={busy !== null} aria-label={`${row.enabled ? "禁用" : "启用"} ${row.ref}`} onCheckedChange={() => void handleToggle(row.ref, row.enabled)} /> : row.selectionSource === "policy-wildcard" ? <span className="text-xs text-muted-foreground">通配覆盖</span> : null}
          {row.capabilities.canEditCatalogEntry ? <Button variant="ghost" size="icon" disabled={busy !== null} aria-label={`编辑模型 ${row.ref}`} onClick={() => void openEdit(row)}><Edit3 className="h-3.5 w-3.5" /></Button> : null}
          {row.capabilities.canRemoveCatalogEntry ? <Button variant="ghost" size="icon" disabled={busy !== null} aria-label={`删除模型 ${row.ref}`} onClick={() => { setDeleteLayers({ metadata: false, policyExact: false }); setDeleteTarget(row); }}><Trash2 className="h-3.5 w-3.5" /></Button> : null}
        </div> }
      ]} />
    </div>;
  }

  return (
    <section data-testid="models-view" className="flex flex-col gap-6 min-h-[calc(100vh-4rem)]">
      <PageHeader
        title="模型"
        description={inventory === null ? "本地配置可立即管理；插件与在线状态在后台加载。" : manageCatalog ? "配置目录：保留参数不代表启用。" : inventory?.pickerSource === "gateway" ? "当前 Gateway 模型选项（默认 Agent）；独立策略的 Agent 可能不同。" : "本地推算的模型选项；尚未确认与运行中的 IM 一致。"}
        actions={
          <>
            <Button variant="outline" size="sm" aria-label="检查并确认" disabled={refreshing || busy !== null} onClick={() => void refreshProbe()}>{refreshing ? "检查中…" : "检查并确认"}</Button>
            <Button variant="outline" onClick={() => setManageCatalog(value => !value)}>{manageCatalog ? "返回 IM 模型选项" : "管理配置目录"}</Button>
          </>
        }
      />
      <div className="space-y-2">
        <OperationProgress phase={busy ? "saving" : runtimeLoading ? "checking-runtime" : onlinePending ? "partial" : runtimeError ? "error" : inventory ? "success" : "idle"} message={!busy && !runtimeLoading && runtimeError ? `运行时未确认：${runtimeError}` : undefined} />
        <OperationProgress phase={extensionsLoading ? "loading-plugin" : extensionsError ? "error" : "idle"} message={extensionsError ? `插件目录未取得：${extensionsError}` : undefined} />
        {extensions?.diagnostics.length ? <p className="text-xs text-warning">插件目录提示：{extensions.diagnostics.join("；")}</p> : null}
      </div>
      <ModelAttentionPanel client={client} inventory={inventory} report={attention} onReport={setAttention} onSaved={async (result) => { await saved(inventoryFromWriteResponse(result && typeof result === "object" ? result : {}) ?? undefined); }} loadError={attentionError} onChanged={(next) => load(next)} onConfigure={onOpenProviders ? id => onOpenProviders(id) : undefined} />
      {/* 主体：左 Provider 导航 + 右模型区段 */}
      <div className="flex flex-col md:flex-row gap-6">
        {/* Left Column: Provider List */}
        <div className="w-full md:w-[260px] shrink-0 border-b md:border-b-0 md:border-r border-border pb-4 md:pb-0 md:pr-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-wider text-muted-foreground">服务商</h2>
            <Button
              variant="outline"
              size="icon"
              aria-label="刷新"
              title={loading ? "正在加载…" : undefined}
              onClick={() => void load()}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </Button>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              aria-label="搜索 Provider"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="过滤 Providers..."
              className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-2.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <nav className="space-y-1">
            {/* 加载中导航本体给提示,不显示空列表 */}
            {snapshot === null ? (
              <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <RefreshCw aria-hidden className="h-3.5 w-3.5 animate-spin text-brand" />
                正在加载…
              </div>
            ) : filteredProviderIds.map((pId) => {
              const isSelected = pId === selectedProviderId;
              const navProvider = (inventory?.providers ?? []).find((provider) => provider.providerId === pId);
              const isDisabled = Boolean(navProvider?.disabled);
              const isPluginStopped = navProvider?.pluginEnabled === false;
              const navSuffix = isPluginStopped
                ? "插件·已停用"
                : isDisabled
                  ? "已关闭"
                  : "";
              return (
                <button
                  key={pId}
                  type="button"
                  onClick={() => setSelectedProviderId(pId)}
                  className={cn(
                    "relative flex w-full items-center justify-between rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isSelected
                      ? "bg-brand/10 text-brand"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    (isDisabled || isPluginStopped) && "opacity-60"
                  )}
                >
                  {isSelected ? (
                    <span className="absolute left-0.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                  ) : null}
                  <span className="flex min-w-0 items-center gap-1">
                    {/* provider id 可能很长（qwen-token-plan），截断而不是折行——完整值给 title */}
                    <span className="truncate" title={pId}>{pId}</span>
                    {/* 来源与状态合并成单个后缀：两个括号会把 260px 侧栏挤到折行 */}
                    {navSuffix ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">（{navSuffix}）</span>
                    ) : null}
                  </span>
                  <Badge variant="secondary" className="ml-1 shrink-0 px-1.5 py-0 text-[10px] font-normal leading-none" aria-label={`模型数 ${providerCounts[pId.toLowerCase()] || 0}`}>
                    {providerCounts[pId.toLowerCase()] || 0}
                  </Badge>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right Column: Models Pane */}
        <div className="min-w-0 flex-1 max-w-4xl space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2 break-all">
                <span>{selectedProviderId || "选择 Provider"}</span>
              </h1>
            </div>
            {/* 添加模型：仅 config 来源 Provider（目录可写）；插件 / 已关闭 Provider 一律禁用 */}
            <Button
              size="sm"
              aria-label="添加模型"
              disabled={!activeProviderFromConfig || activeProviderDisabled}
              title={
                !activeProviderFromConfig
                  ? "插件 provider 的模型目录只读，无法在 oc-switch 添加模型"
                  : activeProviderDisabled ? providerDisabledHint : undefined
              }
              onClick={() => setCreating(true)}
            >
              <Plus className="h-4 w-4" />
              添加模型
            </Button>
          </div>

          {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

          {activeProviderPluginDisabled && pluginOnlyProvider ? (
            <p className="text-sm text-muted-foreground">
              该插件已在 OpenClaw 的 plugins.entries 中停用；请先在 Providers 页启用该插件后再启用其模型。
            </p>
          ) : null}
          {pluginOnlyProvider && !activeProviderPluginDisabled ? (
            <p className="text-sm text-muted-foreground">
              插件 Provider 的模型目录由 OpenClaw 插件提供，只读；可启停模型与设为主模型，不能增删改。
            </p>
          ) : null}
          {activeProviderPluginDisabled && activeProviderFromConfig ? (
            <p className="text-sm text-muted-foreground">该 Provider 的插件来源已停用；本地配置模型仍按各自的策略和运行可用性管理。</p>
          ) : null}
          {activeProvider && !activeProviderFromConfig && !pluginOnlyProvider ? (
            <p className="text-sm text-muted-foreground">运行时目录只读；可用模型按 Core 能力管理策略和主模型，不会自动写入本地目录。</p>
          ) : null}
          {activeProviderDisabled ? (
            <p className="text-sm text-muted-foreground">
              该 Provider 已关闭，请先在 Providers 页恢复后再启用模型。
            </p>
          ) : null}

          {/* 首轮加载提示：inventory 未取得前不渲染空模型区，避免把「读取中」误显为空态 */}
          {snapshot === null ? (
            error ? null : (
              <LoadingNotice
                title="正在读取本地模型配置…"
                description="读取本地配置文件。"
              />
            )
          ) : selectedProviderId ? (
            <>
              {/* Search filter for selected Provider */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  aria-label="搜索模型"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索引用或别名..."
                  className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>

              {renderStaticModels()}
              {extensionModels.length > 0 ? <div className="space-y-2">
                <h3 className="text-xs font-semibold tracking-wider text-muted-foreground">插件目录模型 ({extensionModels.length})</h3>
                <DataTable rows={extensionModels} rowKey={row => row.id} minWidthClass="min-w-[20rem]" columns={[
                  { key: "ref", header: "引用", wrap: "anywhere", render: row => `${extensionProvider!.providerId}/${row.id}` },
                  { key: "source", header: "来源 / 状态", wrap: "nowrap", render: () => <div className="flex gap-2"><Pill variant="muted">插件目录</Pill><span className="text-xs text-muted-foreground">在线状态待确认</span></div> }
                ]} />
              </div> : null}
              {activeModels.length === 0 && localModels.length === 0 && extensionModels.length === 0 ? (
                extensionsLoading || runtimeLoading ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">该 Provider 的扩展目录与在线状态正在加载…</p> : <EmptyState icon={Inbox} title="没有匹配的模型" />
              ) : (
                <div className="space-y-6">
                  {activeAvailableModels.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold text-success uppercase tracking-wider">
                        {manageCatalog ? "目录模型" : "模型选项"} ({activeAvailableModels.length})
                      </h3>
                      {renderModelTable(activeAvailableModels)}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">请在左侧选择一个 Provider 进行管理。</p>
          )}
        </div>
      </div>

      {/* Policy 规则视图（spec §11.3 + 规则编辑 spec §6）：modelPolicy.allow 原始规则投影，默认折叠的次级区段。
          editable 规则可编辑（原子替换对话框）；removable 规则可纯规则删除（ConfirmDialog，exact/wildcard 统一入口）；
          restricted 模式提供「添加规则」入口 */}
      <section aria-label="Policy 规则">
        <button
          type="button"
          aria-expanded={showPolicyRules}
          aria-label={showPolicyRules ? "收起 Policy 规则" : "展开 Policy 规则"}
          onClick={() => setShowPolicyRules((prev) => !prev)}
          className="flex w-full items-center justify-between rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/50"
        >
          <span>Policy 规则（modelPolicy.allow）</span>
          <span className="text-xs text-muted-foreground">
            {showPolicyRules ? "收起" : `展开（${policyRules.length} 条）`}
          </span>
        </button>
        {showPolicyRules ? (
          <div className="mt-3">
            <ModelPolicyPanel
              rules={policyRules}
              policyMode={policyMode}
              policyRevision={policyRevision}
              busy={busy !== null}
              onAddRule={() => openAction({ kind: "add-policy-rule", ref: "" })}
              onEditRule={openEditPolicyRule}
              onRemoveRule={openRemovePolicyRule}
              staleRefs={staleRefs}
              onCleanupStaleRefs={() => setStaleCleanupOpen(true)}
            />
            {/* config-status 读取失败：清理入口保持禁写并明示不可用，不伪装成「没有悬空项」，也不回退逐条删除 */}
            {configStatusUnavailable ? (
              <p role="status" className="mt-2 text-xs text-warning">
                悬空引用检查不可用（config-status 读取失败）；「清理悬空引用」入口已禁用，请点击「刷新」重试。
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* 同一个处理向导提供可用选项，而不是把「处理」直接等同于删除。 */}
      <Dialog open={pendingAction?.kind === "handle" || pendingAction?.kind === "remove-policy-ref"} onOpenChange={open => { if (!open) closeAction(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{pendingAction?.kind === "remove-policy-ref" ? "删除 Policy 规则" : "处理模型引用"}</DialogTitle>
            <DialogDescription className="break-all">
              {pendingAction?.kind === "remove-policy-ref"
                ? `确认删除 ${pendingAction.ref} 的 modelPolicy.allow 精确引用？此操作将创建备份。`
                : pendingAction?.ref}
            </DialogDescription>
          </DialogHeader>
          {pendingEntry ? <ModelStateBadges entry={pendingEntry} plugins={inventory?.plugins ?? []} /> : null}
          {pendingEntry?.availabilityReasons.length ? (
            <p className="text-sm text-muted-foreground">{pendingEntry.availabilityReasons.map(reason => AVAILABILITY_REASON_LABELS[reason] ?? reason).join("、")}</p>
          ) : null}
          {pendingEntry && needsProviderForm(pendingEntry) ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Provider 不在本地配置中。请在向导中填写并确认 baseUrl、API 类型及凭据，不会自动猜测连接信息。</p>
              <Button variant="outline" disabled={busy !== null} aria-label="创建 Provider 并补全模型" onClick={openCreateProvider}>创建 Provider 并补全模型</Button>
            </div>
          ) : null}
          {pendingEntry?.capabilities.canMaterializeConfigModel ? (
            <Button variant="outline" disabled={busy !== null} onClick={() => openAction({ kind: "materialize", ref: pendingEntry.ref })}>预览补全到目录</Button>
          ) : null}
          {pendingEntry && (pendingEntry.pluginIds.length > 0 || pendingEntry.catalogSources.includes("plugin-manifest")) ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>插件目录由 OpenClaw 管理；已下架模型不可伪造为本地配置。插件停用或缺少认证时，请到 Providers 页检查插件状态与凭据。</p>
              {onOpenProviders ? <Button variant="outline" disabled={busy !== null} onClick={() => onOpenProviders?.(pendingEntry?.providerId)}>前往 Providers</Button> : null}
            </div>
          ) : null}
          {canRemovePendingRef ? (
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void confirmRemovePolicyRef(); }}>
              <p className="text-sm text-muted-foreground">默认仅删除 policy 精确引用；不会修改 wildcard，也不会删除认证 Profile。写入前由 Core 重新预检并创建备份。</p>
              {pendingEntry?.referenceSources.includes("legacy-metadata") ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="removeMetadata" checked={removeMetadata} disabled={busy !== null} onChange={event => setRemoveMetadata(event.target.checked)} />
                  <span>同时清理 metadata（agents.defaults.models 同名条目；默认保留）</span>
                </label>
              ) : null}
              <Button type="submit" variant="destructive" disabled={busy !== null} aria-label={removeMetadata ? "删除引用并清理 metadata" : "仅删除 policy 引用"}>
                {removeMetadata ? "删除引用并清理 metadata" : "仅删除 policy 引用"}
              </Button>
            </form>
          ) : <p className="text-sm text-muted-foreground">当前引用不能安全删除；可保留配置，等待恢复或先处理受保护的引用。</p>}
          {busy ? <OperationProgress phase="saving" /> : null}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          <DialogFooter><Button variant="outline" disabled={busy !== null} onClick={closeAction}>暂不处理</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加 policy 规则（restricted 模式）：单输入框，格式与守卫均由服务端权威校验 */}
      <Dialog open={pendingAction?.kind === "add-policy-rule"} onOpenChange={open => { if (!open) closeAction(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 Policy 规则</DialogTitle>
            <DialogDescription>只改 modelPolicy.allow；目录、metadata 与 API Key 不变。此操作将创建备份。</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={event => { event.preventDefault(); void confirmAddPolicyRule(); }}>
            <label className="grid gap-2 text-sm">
              规则
              <input
                aria-label="规则"
                name="rule"
                value={policyRuleInput}
                disabled={busy !== null}
                onChange={event => setPolicyRuleInput(event.target.value)}
                placeholder="provider/model 或 provider/*"
                className="w-full min-w-0 rounded-md border border-input bg-background p-2"
              />
            </label>
            <p className="text-xs text-muted-foreground">provider/model 精确规则或 provider/* 通配规则；服务端为权威校验。</p>
            {busy ? <OperationProgress phase="saving" /> : null}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
            <DialogFooter>
              <Button variant="outline" disabled={busy !== null} onClick={closeAction}>取消</Button>
              <Button type="submit" disabled={busy !== null || policyRuleInput.trim() === ""}>添加规则</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 纯规则删除（exact / wildcard 统一入口）：只改 modelPolicy.allow，不改目录/metadata；确认前从当前 inventory 重查 removable */}
      <ConfirmDialog
        open={pendingAction?.kind === "remove-policy-rule"}
        title="删除 Policy 规则"
        message={`确认删除${pendingPolicyRule?.kind === "wildcard" ? "通配" : "精确"}规则 ${pendingAction?.kind === "remove-policy-rule" ? pendingAction.ref : ""}？只改 modelPolicy.allow。此操作将创建备份。`}
        danger
        confirmLabel={busy ? "保存中…" : "删除规则"}
        confirmDisabled={busy !== null || pendingPolicyRule?.removable !== true || !pendingAction?.ruleRevision}
        onCancel={closeAction}
        onConfirm={() => void confirmRemovePolicyRule()}
      >
        {busy ? <OperationProgress phase="saving" /> : null}
        <p className="text-sm text-muted-foreground">
          {pendingPolicyRule && "matchedModelCount" in pendingPolicyRule ? `命中 ${pendingPolicyRule.matchedModelCount} 个模型` : "在线命中情况待确认"}
          {pendingPolicyRule && "unavailableModelCount" in pendingPolicyRule && typeof pendingPolicyRule.unavailableModelCount === "number" && pendingPolicyRule.unavailableModelCount > 0 ? `，其中 ${pendingPolicyRule.unavailableModelCount} 个不可用` : ""}
        </p>
        {(pendingAction?.ruleCopies ?? 0) > 1 ? (
          <p className="mt-2 text-sm text-muted-foreground">该规则有 {pendingAction?.ruleCopies} 条相同副本，将一并删除。</p>
        ) : null}
        <p className="mt-2 text-sm text-muted-foreground">删除后仅由该规则放行的模型将从选择器消失；目录、metadata 与 API Key 不变。删除冗余规则不一定会停用模型。</p>
        {pendingPolicyRule?.removable !== true ? (
          <p className="mt-2 text-sm text-muted-foreground">该规则当前不可删除：被主模型/fallback 依赖，或为避免清空策略。</p>
        ) : null}
        {actionError ? <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p> : null}
      </ConfirmDialog>

      {/* 编辑 policy 规则：原子替换（无中间删除态）；无变化禁用保存，409 保留输入 */}
      <Dialog open={pendingAction?.kind === "edit-policy-rule"} onOpenChange={open => { if (!open) closeAction(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑 Policy 规则</DialogTitle>
            <DialogDescription className="break-all">
              将规则 {pendingAction?.kind === "edit-policy-rule" ? pendingAction.ref : ""} 原子替换为新规则；只改 modelPolicy.allow，目录、metadata 与 API Key 不变。此操作将创建备份。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={event => { event.preventDefault(); void confirmEditPolicyRule(); }}>
            <label className="grid gap-2 text-sm">
              新规则
              <input
                aria-label="新规则"
                name="rule"
                value={policyRuleInput}
                disabled={busy !== null}
                onChange={event => setPolicyRuleInput(event.target.value)}
                placeholder="provider/model 或 provider/*"
                className="w-full min-w-0 rounded-md border border-input bg-background p-2"
              />
            </label>
            {(pendingAction?.ruleCopies ?? 0) > 1 ? (
              <p className="text-xs text-muted-foreground">将同时修改 {pendingAction?.ruleCopies} 条相同规则。</p>
            ) : null}
            <p className="text-xs text-muted-foreground">provider/model 精确规则或 provider/* 通配规则；服务端为权威校验。规则编辑只修改选择策略，不一定改变模型启用状态。</p>
            {busy ? <OperationProgress phase="saving" /> : null}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
            <DialogFooter>
              <Button variant="outline" disabled={busy !== null} onClick={closeAction}>取消</Button>
              <Button
                type="submit"
                disabled={busy !== null || !pendingAction?.ruleRevision || policyRuleInput.trim() === "" || (pendingAction ? ruleEditUnchanged(pendingAction.ref, policyRuleInput) : true)}
              >
                {busy ? "保存中…" : "保存规则"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 悬空策略引用批量清理（stale cleanup spec §6）：确认冻结 revision 单次批量调用；成功应用写响应 inventory 并重算 config-status */}
      <StalePolicyRefsCleanupDialog
        open={staleCleanupOpen}
        refs={staleRefs}
        policyRevision={policyRevision}
        client={client}
        onCancel={() => setStaleCleanupOpen(false)}
        onChanged={(next) => {
          if (next) void applyWriteInventory(next);
          else void saved();
        }}
      />

      <ConfirmDialog
        open={pendingAction?.kind === "materialize"}
        title="补全模型配置"
        message={`把 ${pendingAction?.ref ?? ""} 补入 Provider 本地目录（不主动启用策略）。此操作将创建备份。`}
        confirmLabel="补全到本 Provider 目录"
        confirmDisabled={busy !== null || !pendingEntry?.capabilities.canMaterializeConfigModel}
        onCancel={closeAction}
        onConfirm={() => void confirmMaterialize()}
      >
        <dl className="space-y-2 break-all text-sm">
          <div><dt className="text-muted-foreground">Provider</dt><dd>{pendingEntry?.providerId}</dd></div>
          <div><dt className="text-muted-foreground">模型 ID</dt><dd>{pendingEntry?.modelId}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">本次提交仅包含模型 ID，不猜测 contextWindow、maxTokens 或 API；已有策略保持不变。</p>
        {actionError ? <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p> : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingAction?.kind === "clean-dangling"}
        title="清理残留引用"
        message={`确认清理 ${pendingAction?.ref ?? ""} 的残留引用？此操作将创建备份。`}
        confirmLabel="清理残留引用"
        danger
        confirmDisabled={busy !== null || pendingEntry?.capabilities.canRemoveDanglingMetadata !== true}
        onCancel={closeAction}
        onConfirm={() => void confirmCleanDangling()}
      >
        <dl className="space-y-2 break-all text-sm">
          <div><dt className="text-muted-foreground">Provider</dt><dd>{pendingEntry?.providerId}</dd></div>
          <div><dt className="text-muted-foreground">模型 ID</dt><dd>{pendingEntry?.modelId}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">
          该引用只存在于 agents.defaults.models（别名 / 模型参数），Provider 目录、插件与运行时目录都没有它。
          本次只删除这条残留，不改 modelPolicy.allow、不删目录条目、不删 API Key。
          若 modelPolicy.allow 仍有同名精确引用，会保留并可在「清理悬空引用」中处理。
        </p>
        {actionError ? <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p> : null}
      </ConfirmDialog>

      <Dialog open={pendingAction?.kind === "replace"} onOpenChange={open => { if (!open) closeAction(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{pendingEntry?.referenceSources.includes("primary") ? "替换主模型" : "替换 fallback 指引"}</DialogTitle>
            <DialogDescription className="break-all">{pendingAction?.ref} 的引用受保护；本操作不会删除目录或修改回退链。</DialogDescription>
          </DialogHeader>
          {pendingEntry?.referenceSources.includes("primary") ? (
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void confirmReplacePrimary(); }}>
              <label className="grid gap-2 text-sm">
                替代主模型
                <select aria-label="替代主模型" name="replacement" className="w-full min-w-0 rounded-md border border-input bg-background p-2" value={newPrimary} disabled={busy !== null} onChange={event => setNewPrimary(event.target.value)}>
                  <option value="">请选择可用且策略允许的模型</option>
                  {(inventory?.models ?? []).filter(model => model.capabilities.canSetPrimary).map(model => <option key={model.ref} value={model.ref}>{model.ref}</option>)}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">列表仅包含 Core 允许设为主模型的条目；没有候选时，请先启用其它可用模型的策略。</p>
              <Button type="submit" disabled={busy !== null || !inventory?.models.some(model => model.ref === newPrimary && model.capabilities.canSetPrimary)}>确认替换主模型</Button>
            </form>
          ) : (
            <div className="space-y-2 text-sm">
              <p>回退链只读：请在 OpenClaw 配置中更新 agents.defaults.model.fallbacks 后刷新。这里不会把 fallback 的替换误操作为切换主模型。</p>
              <p className="text-muted-foreground">可用的替代候选：</p>
              <ul className="list-inside list-disc break-all">{(inventory?.models ?? []).filter(model => model.capabilities.canSetPrimary).map(model => <li key={model.ref}>{model.ref}</li>)}</ul>
            </div>
          )}
          {busy ? <OperationProgress phase="saving" /> : null}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          <DialogFooter><Button variant="outline" disabled={busy !== null} onClick={closeAction}>暂不处理</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {customPrefill ? (
        <CustomProviderDialog
          open
          client={client}
          initialProviderId={customPrefill.providerId}
          initialModels={[{ id: customPrefill.modelId }]}
          onCancel={() => setCustomPrefill(null)}
          onSaved={() => {
            setCustomPrefill(null);
            toast.success("Provider 已创建；请刷新后复核运行时模型状态。");
            void saved();
          }}
        />
      ) : null}

      <ModelDialog
        open={creating}
        mode="create"
        providers={snapshot?.providers ?? configProviderSummaries(inventory)}
        fixedProviderId={selectedProviderId || undefined}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        onLookupMetadata={client.getModelMetadataSuggestions}
      />
      <ModelDialog
        open={Boolean(editTarget)}
        mode="edit"
        providers={snapshot?.providers ?? configProviderSummaries(inventory)}
        fixedProviderId={editSummary?.providerId}
        {...(editTarget && editSummary ? { model: editSummary } : {})}
        onCancel={() => { setEditTarget(null); setEditSummary(null); }}
        onSave={handleEdit}
        onLookupMetadata={client.getModelMetadataSuggestions}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除模型"
        message={`确认删除 ${deleteTarget?.ref ?? ""}？此操作将创建备份。`}
        danger
        confirmDisabled={busy !== null}
        confirmLabel={busy ? "保存中…" : "确认"}
        onCancel={() => { if (!busy) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      >
        {busy ? <OperationProgress phase="saving" /> : null}
        {deleteTarget ? (
          <ModelDeleteLayers
            metadata={deleteLayers.metadata}
            policyExact={deleteLayers.policyExact}
            wildcardCovered={wildcardCovered(deleteTarget)}
            disabled={busy !== null}
            onChange={setDeleteLayers}
          />
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

/** config 来源 Provider → ModelDialog 的 Provider 选项（目录可写的 Provider 才可添加/编辑模型） */
function configProviderSummaries(inventory: ModelInventory | null): ProviderSummary[] {
  return (inventory?.providers ?? [])
    .filter((provider) => provider.sources.includes("config"))
    .map((provider) => ({
      id: provider.providerId,
      api: undefined,
      baseUrl: undefined,
      modelCount: provider.modelCount,
      enabledModelCount: provider.policyAllowedModelCount,
      containsPrimary: false,
      disabled: provider.disabled,
      source: "config" as const,
      apiKeyEnv: null,
      apiKeyEnvManaged: false,
      apiKeyEnvStatus: "missing" as const
    }));
}
