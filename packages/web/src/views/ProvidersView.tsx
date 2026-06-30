import { Cpu, Edit3, Plus, Power, PowerOff, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GatewayApplyBanner } from "../components/GatewayApplyBanner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { DataTable } from "../components/DataTable";
import { EnvMigrationConfirmDialog } from "../components/EnvMigrationConfirmDialog";
import { MergeCaseDuplicateDialog } from "../components/MergeCaseDuplicateDialog";
import { ProviderModelsDialog } from "../components/ProviderModelsDialog";
import { formatEnvWriteSuccess } from "../env-feedback";
import type { ApiClient, CaseDuplicateGroup, EnvWriteVerification, GatewayEnvSyncResult, ModelSummary, ProviderSummary } from "../api";

interface ProvidersViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** Provider 列表与管理 */
export function ProvidersView({ client, onRefresh }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<CaseDuplicateGroup[]>([]);
  const [mergeTarget, setMergeTarget] = useState<CaseDuplicateGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | null>(null);
  const [editTarget, setEditTarget] = useState<ProviderSummary | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [newPrimaryCandidates, setNewPrimaryCandidates] = useState<ModelSummary[]>([]);
  const [selectedNewPrimary, setSelectedNewPrimary] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [gatewayApply, setGatewayApply] = useState<{
    envWrite: EnvWriteVerification;
    gatewayEnvSync?: GatewayEnvSyncResult;
  } | null>(null);
  const [modelTarget, setModelTarget] = useState<ProviderSummary | null>(null);
  const [stateTarget, setStateTarget] = useState<ProviderSummary | null>(null);
  const [pendingEnvConfirm, setPendingEnvConfirm] = useState<{
    providerId: string;
    changes: { baseUrl?: string; apiKey?: string };
    warnings: string[];
    confirmMigration?: boolean;
    confirmComplex?: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ providers: list }, health] = await Promise.all([
        client.getProviders(),
        client.getHealth().catch(() => null)
      ]);
      setProviders(list);
      setDuplicateGroups(health?.caseDuplicateGroups ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  const groupByProviderId = useMemo(() => {
    const map = new Map<string, CaseDuplicateGroup>();
    for (const group of duplicateGroups) for (const id of group.ids) map.set(id, group);
    return map;
  }, [duplicateGroups]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDelete(row: ProviderSummary) {
    setError(null);
    setSuccessMessage(null);
    setDeleteTarget(row);
    setNewPrimaryCandidates([]);
    setSelectedNewPrimary("");
    if (!row.containsPrimary) return;
    try {
      const { models } = await client.getModels();
      const candidates = models.filter((model) => model.providerId !== row.id);
      setNewPrimaryCandidates(candidates);
      setSelectedNewPrimary(candidates[0]?.ref ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载可选主模型失败");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.containsPrimary && !selectedNewPrimary) {
      setError("删除包含 primary 的 Provider 前请选择新的主模型");
      return;
    }
    try {
      await client.deleteProvider(deleteTarget.id, {
        ...(deleteTarget.containsPrimary ? { newPrimary: selectedNewPrimary } : {})
      });
      setDeleteTarget(null);
      setNewPrimaryCandidates([]);
      setSelectedNewPrimary("");
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      setDeleteTarget(null);
    }
  }

  function openEdit(row: ProviderSummary) {
    setError(null);
    setSuccessMessage(null);
    setEditTarget(row);
    setEditBaseUrl(row.baseUrl ?? "");
    setEditApiKey("");
  }

  function showGatewayApply(result: { envWrite?: EnvWriteVerification | undefined; gatewayEnvSync?: GatewayEnvSyncResult }) {
    if (!result.envWrite?.verified) {
      setGatewayApply(null);
      return;
    }
    setGatewayApply({
      envWrite: result.envWrite,
      ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
    });
  }

  async function submitProviderUpdate(providerId: string, changes: { baseUrl?: string; apiKey?: string; confirmMigration?: boolean; confirmComplex?: boolean }) {
    const result = await client.updateProvider(providerId, changes);
    setEditTarget(null);
    setEditApiKey("");
    setPendingEnvConfirm(null);
    if (changes.apiKey) {
      setSuccessMessage(formatEnvWriteSuccess({
        label: `Provider ${providerId} 的 API Key`,
        envWrite: result.envWrite,
        fallback: changes.confirmMigration
          ? `Provider ${providerId} 的 API Key 已迁入托管块并更新`
          : changes.confirmComplex
            ? `Provider ${providerId} 的 API Key 已改写为标准格式并更新`
            : `Provider ${providerId} 的 API Key 已更新`
      }));
      showGatewayApply(result);
    } else {
      setGatewayApply(null);
      setSuccessMessage(`Provider ${providerId} 已更新`);
    }
    await load();
    onRefresh?.();
  }

  async function confirmEdit() {
    if (!editTarget) return;
    const changes: { baseUrl?: string; apiKey?: string } = {};
    const nextBaseUrl = editBaseUrl.trim();
    if (nextBaseUrl) changes.baseUrl = nextBaseUrl;
    if (editApiKey) changes.apiKey = editApiKey;
    if (!changes.baseUrl && !changes.apiKey) {
      setError("请输入 baseUrl 或 API Key 新值");
      return;
    }
    setError(null);
    setSuccessMessage(null);
    try {
      if (changes.apiKey) {
        const preview = await client.previewUpdateProvider(editTarget.id, {
          ...(changes.baseUrl ? { baseUrl: changes.baseUrl } : {}),
          includeApiKeyEnv: true
        });
        const envPreview = preview.envPreview;
        if (envPreview?.requiresConfirmation) {
          setPendingEnvConfirm({
            providerId: editTarget.id,
            changes,
            warnings: envPreview.warnings,
            ...(envPreview.requiresMigration ? { confirmMigration: true } : {}),
            ...(envPreview.requiresComplex ? { confirmComplex: true } : {})
          });
          return;
        }
      }
      await submitProviderUpdate(editTarget.id, changes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function confirmEnvMigration() {
    if (!pendingEnvConfirm) return;
    setError(null);
    try {
      await submitProviderUpdate(pendingEnvConfirm.providerId, {
        ...pendingEnvConfirm.changes,
        ...(pendingEnvConfirm.confirmMigration ? { confirmMigration: true } : {}),
        ...(pendingEnvConfirm.confirmComplex ? { confirmComplex: true } : {})
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
      setPendingEnvConfirm(null);
    }
  }

  async function confirmProviderStateChange() {
    if (!stateTarget) return;
    setError(null);
    try {
      // stateTarget.disabled 为 true 时恢复（enabled: true），为 false 时关闭（enabled: false）
      await client.patchProviderState(stateTarget.id, stateTarget.disabled);
      setStateTarget(null);
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新 Provider 状态失败");
      setStateTarget(null);
    }
  }

  async function handleSync(row: ProviderSummary) {
    setSyncing(row.id);
    setSyncMessage(null);
    setError(null);
    setSuccessMessage(null);
    try {
      const result = await client.syncProvider(row.id);
      if (result.unsupportedReason) {
        setSyncMessage(`同步未执行：${result.unsupportedReason}`);
      } else {
        setSyncMessage(`同步完成：新增 ${result.addedModelIds?.length ?? 0} 个模型`);
      }
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步失败");
    } finally {
      setSyncing(null);
    }
  }

  return (
    <section data-testid="providers-view">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Providers</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAddingProvider(true)}
            className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            添加 Provider
          </button>
          <button
            type="button"
            aria-label="刷新"
            onClick={() => void load()}
            className="rounded-md border border-input p-2 hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? <p className="mb-3 text-destructive">{error}</p> : null}
      {gatewayApply ? (
        <GatewayApplyBanner
          client={client}
          envWrite={gatewayApply.envWrite}
          {...(gatewayApply.gatewayEnvSync ? { gatewayEnvSync: gatewayApply.gatewayEnvSync } : {})}
          onDismiss={() => setGatewayApply(null)}
        />
      ) : null}
      {successMessage ? <p className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">{successMessage}</p> : null}
      {syncMessage ? <p className="mb-3 text-sm text-emerald-500 dark:text-emerald-400">{syncMessage}</p> : null}

      <DataTable
        rows={providers}
        rowKey={(row) => row.id}
        columns={[
          {
            key: "id",
            header: "ID",
            render: (row) => (
              <span className={row.containsPrimary ? "font-medium text-amber-500 dark:text-amber-400" : ""}>
                {row.id}
                {row.containsPrimary ? " ★" : ""}
                {groupByProviderId.has(row.id) ? (
                  <span className="ml-2 inline-flex items-center gap-2">
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">⚠ 重复</span>
                    {(() => {
                      const group = groupByProviderId.get(row.id)!;
                      return group.mergeable ? (
                        <button
                          type="button"
                          aria-label={`合并 ${group.groupKey}`}
                          onClick={() => setMergeTarget(group)}
                          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent"
                        >
                          合并到 {group.canonicalId}
                        </button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">建议保留 {group.canonicalId}</span>
                      );
                    })()}
                  </span>
                ) : null}
              </span>
            )
          },
          { key: "api", header: "API 类型", render: (row) => row.api ?? "—" },
          { key: "baseUrl", header: "Base URL", render: (row) => row.baseUrl ?? "—" },
          {
            key: "models",
            header: "模型 / 已启用",
            render: (row) => `${row.modelCount} / ${row.enabledModelCount}`
          },
          {
            key: "status",
            header: "状态",
            render: (row) => row.disabled ? (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">已关闭</span>
            ) : (
              <span className="rounded bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">已启用</span>
            )
          },
          {
            key: "actions",
            header: "操作",
            render: (row) => (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label={`管理模型 ${row.id}`}
                  onClick={() => setModelTarget(row)}
                  className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
                >
                  <Cpu className="h-3 w-3" />
                  模型
                </button>
                <button
                  type="button"
                  aria-label={`${row.disabled ? "恢复" : "关闭"} Provider ${row.id}`}
                  disabled={!row.disabled && row.containsPrimary}
                  title={!row.disabled && row.containsPrimary ? "该 Provider 包含当前主模型，请先切换主模型后再关闭" : undefined}
                  onClick={() => setStateTarget(row)}
                  className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {row.disabled ? <Power className="h-3 w-3" /> : <PowerOff className="h-3 w-3" />}
                  {row.disabled ? "恢复" : "关闭"}
                </button>
                <button
                  type="button"
                  aria-label={`编辑 ${row.id}`}
                  onClick={() => openEdit(row)}
                  className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
                >
                  <Edit3 className="h-3 w-3" />
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`同步 ${row.id}`}
                  disabled={syncing === row.id}
                  onClick={() => void handleSync(row)}
                  className="inline-flex items-center gap-1 rounded border border-primary/50 px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-40"
                >
                  <RotateCw className="h-3 w-3" />
                  同步
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${row.id}`}
                  onClick={() => void openDelete(row)}
                  className="inline-flex items-center gap-1 rounded border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <Trash2 className="h-3 w-3" />
                  删除
                </button>
              </div>
            )
          }
        ]}
      />

      <ProviderModelsDialog
        open={Boolean(modelTarget)}
        provider={modelTarget}
        providers={providers}
        client={client}
        onCancel={() => setModelTarget(null)}
        onChanged={() => {
          void load();
          onRefresh?.();
        }}
      />

      <CustomProviderDialog
        open={addingProvider}
        client={client}
        onCancel={() => setAddingProvider(false)}
        onSaved={(result) => {
          setAddingProvider(false);
          setSuccessMessage(formatEnvWriteSuccess({
            label: `Provider ${result.providerId} 的 API Key`,
            envWrite: result.envWrite,
            fallback: `Provider ${result.providerId} 已添加`
          }));
          showGatewayApply(result);
          void load();
          onRefresh?.();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 Provider"
        message={`确认删除 ${deleteTarget?.id ?? ""}？此操作将创建备份。`}
        danger
        onCancel={() => {
          setDeleteTarget(null);
          setNewPrimaryCandidates([]);
          setSelectedNewPrimary("");
        }}
        onConfirm={() => void confirmDelete()}
      >
        {deleteTarget?.containsPrimary ? (
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">新主模型</span>
            <select
              aria-label="新主模型"
              value={selectedNewPrimary}
              onChange={(event) => setSelectedNewPrimary(event.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
            >
              {newPrimaryCandidates.map((model) => (
                <option key={model.ref} value={model.ref}>
                  {model.ref}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(stateTarget)}
        title={`${stateTarget?.disabled ? "恢复" : "关闭"} ${stateTarget?.id ?? ""}？`}
        message={
          stateTarget?.disabled
            ? `将恢复关闭前保存的 ${stateTarget.modelCount} 个模型启用状态。`
            : `该 Provider 的 ${stateTarget?.enabledModelCount ?? 0} 个已启用模型将从 OpenClaw 菜单中隐藏。Provider 配置和模型目录会保留，可稍后恢复。`
        }
        onCancel={() => setStateTarget(null)}
        onConfirm={() => void confirmProviderStateChange()}
      />

      {editTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground">编辑 Provider</h2>
            <p className="mt-1 break-all text-xs text-muted-foreground">{editTarget.id}</p>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">baseUrl</span>
                <input
                  aria-label="Provider baseUrl"
                  value={editBaseUrl}
                  onChange={(event) => setEditBaseUrl(event.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">API Key 新值</span>
                <input
                  type="password"
                  aria-label="Provider API Key 新值"
                  value={editApiKey}
                  onChange={(event) => setEditApiKey(event.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
                  autoComplete="off"
                />
              </label>
              {editTarget.apiKeyEnvStatus === "unmanaged" && editTarget.apiKeyEnv ? (
                <p className="text-sm text-amber-500">
                  {editTarget.apiKeyEnv} 当前在托管块外；保存新 API Key 时会迁移到 oc-switch 托管区。
                </p>
              ) : null}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditTarget(null);
                  setEditApiKey("");
                }}
                className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmEdit()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
              >
                保存 Provider
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <EnvMigrationConfirmDialog
        open={Boolean(pendingEnvConfirm)}
        warnings={pendingEnvConfirm?.warnings ?? []}
        {...(pendingEnvConfirm?.confirmMigration ? { confirmMigration: true } : {})}
        {...(pendingEnvConfirm?.confirmComplex ? { confirmComplex: true } : {})}
        title="确认 API Key 写入"
        onCancel={() => setPendingEnvConfirm(null)}
        onConfirm={() => void confirmEnvMigration()}
      />

      <MergeCaseDuplicateDialog
        open={Boolean(mergeTarget)}
        group={mergeTarget}
        client={client}
        onCancel={() => setMergeTarget(null)}
        onMerged={() => { setMergeTarget(null); void load(); }}
      />
    </section>
  );
}
