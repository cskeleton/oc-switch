import { Cpu, Edit3, MoreHorizontal, Plus, Power, PowerOff, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GatewayApplyBanner } from "../components/GatewayApplyBanner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { DataTable } from "../components/DataTable";
import { EnvMigrationConfirmDialog } from "../components/EnvMigrationConfirmDialog";
import { MergeCaseDuplicateDialog } from "../components/MergeCaseDuplicateDialog";
import { ProviderDiscoverDialog } from "../components/ProviderDiscoverDialog";
import { ProviderModelsDialog } from "../components/ProviderModelsDialog";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Pill } from "../components/ui/pill";
import { formatEnvWriteSuccess } from "../env-feedback";
import type {
  ApiClient,
  ApiType,
  CaseDuplicateGroup,
  EnvWriteVerification,
  GatewayEnvSyncResult,
  ModelSummary,
  ProviderSecretRefMigrationBlocker,
  ProviderSecretRefMigrationPreview,
  ProviderSummary
} from "../api";

const EDITABLE_API_TYPES: ApiType[] = [
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai"
];

function isEditableApiType(value: string): value is ApiType {
  return EDITABLE_API_TYPES.includes(value as ApiType);
}

interface ProvidersViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** Provider 列表与管理：搜索 + 排序（已关闭沉底）+ 操作收敛为 2+1 */
export function ProvidersView({ client, onRefresh }: ProvidersViewProps) {
  const toast = useToast();
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<CaseDuplicateGroup[]>([]);
  const [mergeTarget, setMergeTarget] = useState<CaseDuplicateGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | null>(null);
  const [editTarget, setEditTarget] = useState<ProviderSummary | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApi, setEditApi] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [newPrimaryCandidates, setNewPrimaryCandidates] = useState<ModelSummary[]>([]);
  const [selectedNewPrimary, setSelectedNewPrimary] = useState("");
  const [gatewayApply, setGatewayApply] = useState<{
    envWrite: EnvWriteVerification;
    gatewayEnvSync?: GatewayEnvSyncResult;
  } | null>(null);
  const [modelTarget, setModelTarget] = useState<ProviderSummary | null>(null);
  const [discoverTarget, setDiscoverTarget] = useState<ProviderSummary | null>(null);
  const [stateTarget, setStateTarget] = useState<ProviderSummary | null>(null);
  const [pendingEnvConfirm, setPendingEnvConfirm] = useState<{
    providerId: string;
    changes: { baseUrl?: string; api?: ApiType; apiKey?: string };
    warnings: string[];
    confirmMigration?: boolean;
    confirmComplex?: boolean;
  } | null>(null);
  const [secretRefMigrations, setSecretRefMigrations] = useState<ProviderSecretRefMigrationPreview | null>(null);
  const [showSecretRefMigration, setShowSecretRefMigration] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ providers: list }, health, migrationPreview] = await Promise.all([
        client.getProviders(),
        client.getHealth().catch(() => null),
        client.getProviderSecretRefMigrations().catch(() => null)
      ]);
      setProviders(list);
      setDuplicateGroups(health?.caseDuplicateGroups ?? []);
      setSecretRefMigrations(
        migrationPreview?.summary && Array.isArray(migrationPreview.candidates)
          ? migrationPreview
          : null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  const groupByProviderId = useMemo(() => {
    const map = new Map<string, CaseDuplicateGroup>();
    for (const group of duplicateGroups) for (const id of group.ids) map.set(id, group);
    return map;
  }, [duplicateGroups]);

  // 客户端搜索：匹配 Provider ID 与 baseUrl
  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter(
      (row) => row.id.toLowerCase().includes(q) || (row.baseUrl ?? "").toLowerCase().includes(q)
    );
  }, [providers, query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDelete(row: ProviderSummary) {
    setError(null);
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
      toast.error("删除包含 primary 的 Provider 前请选择新的主模型");
      return;
    }
    try {
      await client.deleteProvider(deleteTarget.id, {
        ...(deleteTarget.containsPrimary ? { newPrimary: selectedNewPrimary } : {})
      });
      setDeleteTarget(null);
      setNewPrimaryCandidates([]);
      setSelectedNewPrimary("");
      toast.success(`Provider ${deleteTarget.id} 已删除`);
      await load();
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
      setDeleteTarget(null);
    }
  }

  function openEdit(row: ProviderSummary) {
    setError(null);
    setEditError(null);
    setEditTarget(row);
    setEditBaseUrl(row.baseUrl ?? "");
    setEditApi(row.api ?? "openai-completions");
    setEditApiKey("");
  }

  function closeEdit() {
    setEditTarget(null);
    setEditApi("");
    setEditApiKey("");
    setEditError(null);
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

  async function submitProviderUpdate(providerId: string, changes: { baseUrl?: string; api?: ApiType; apiKey?: string; confirmMigration?: boolean; confirmComplex?: boolean }) {
    const result = await client.updateProvider(providerId, changes);
    closeEdit();
    setPendingEnvConfirm(null);
    if (changes.apiKey) {
      toast.success(formatEnvWriteSuccess({
        label: `Provider ${providerId} 的 API Key`,
        envWrite: result.envWrite,
        gatewayEnvSync: result.gatewayEnvSync,
        fallback: changes.confirmMigration
          ? `Provider ${providerId} 的 API Key 已迁入托管块并更新`
          : changes.confirmComplex
            ? `Provider ${providerId} 的 API Key 已改写为标准格式并更新`
            : `Provider ${providerId} 的 API Key 已更新`
      }));
      showGatewayApply(result);
    } else {
      setGatewayApply(null);
      toast.success(`Provider ${providerId} 已更新`);
    }
    await load();
    onRefresh?.();
  }

  async function confirmEdit() {
    if (!editTarget) return;
    const changes: { baseUrl?: string; api?: ApiType; apiKey?: string } = {};
    const nextBaseUrl = editBaseUrl.trim();
    if (nextBaseUrl) changes.baseUrl = nextBaseUrl;
    const currentApi = editTarget.api ?? "openai-completions";
    if (editApi !== currentApi) {
      if (!isEditableApiType(editApi)) {
        setEditError("请选择支持的 API 类型");
        return;
      }
      changes.api = editApi;
    }
    if (editApiKey) changes.apiKey = editApiKey;
    if (!changes.baseUrl && !changes.api && !changes.apiKey) {
      setEditError("请输入 baseUrl、API 类型或 API Key 新值");
      return;
    }
    setEditError(null);
    try {
      if (changes.apiKey) {
        const preview = await client.previewUpdateProvider(editTarget.id, {
          ...(changes.baseUrl ? { baseUrl: changes.baseUrl } : {}),
          ...(changes.api ? { api: changes.api } : {}),
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
      // 表单内错误留在弹窗中展示
      setEditError(err instanceof Error ? err.message : "保存失败");
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
      toast.error(err instanceof Error ? err.message : "保存失败");
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
      toast.success(stateTarget.disabled ? `Provider ${stateTarget.id} 已恢复` : `Provider ${stateTarget.id} 已关闭`);
      await load();
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新 Provider 状态失败");
      setStateTarget(null);
    }
  }

  async function confirmSecretRefMigration() {
    const providerIds = secretRefMigrations?.candidates
      .filter((candidate) => candidate.status === "ready")
      .map((candidate) => candidate.providerId) ?? [];
    if (providerIds.length === 0) return;
    setError(null);
    try {
      const result = await client.migrateProviderSecretRefs(providerIds);
      setShowSecretRefMigration(false);
      toast.success(
        `已将 ${result.migratedProviderIds.length} 个 Provider API Key 引用迁移为 SecretRef；请重启 Gateway 使运行时快照生效。`
      );
      await load();
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "SecretRef 迁移失败");
      setShowSecretRefMigration(false);
    }
  }

  function secretRefBlockerLabel(blocker: ProviderSecretRefMigrationBlocker): string {
    switch (blocker) {
      case "source-env-missing": return ".env 中缺少变量";
      case "source-env-empty": return ".env 中的变量为空";
      case "source-env-duplicate": return ".env 中存在重复变量";
      case "source-env-complex": return ".env 值是复杂表达式";
      case "gateway-target-unavailable": return "无法确认 Gateway 服务环境";
      case "gateway-env-drift": return "Gateway 服务环境中的值与 .env 不一致";
    }
  }

  return (
    <section data-testid="providers-view">
      {/* 页头：标题 + 描述，右侧操作 */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Providers</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">管理 OpenClaw Provider 连接与 API 密钥</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索 Provider"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 ID / Base URL"
              className="h-8 w-44 pl-8 text-xs sm:w-52"
            />
          </div>
          <Button size="sm" onClick={() => setAddingProvider(true)}>
            <Plus className="h-4 w-4" />
            添加 Provider
          </Button>
          <Button variant="outline" size="icon" aria-label="刷新" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}
      {gatewayApply ? (
        <GatewayApplyBanner
          client={client}
          envWrite={gatewayApply.envWrite}
          {...(gatewayApply.gatewayEnvSync ? { gatewayEnvSync: gatewayApply.gatewayEnvSync } : {})}
          onDismiss={() => setGatewayApply(null)}
        />
      ) : null}
      {secretRefMigrations && secretRefMigrations.summary.candidateCount > 0 ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm">
          <div>
            <p className="font-medium text-foreground">
              发现 {secretRefMigrations.summary.candidateCount} 个旧环境变量引用
            </p>
            <p className="text-muted-foreground">
              {secretRefMigrations.summary.readyCount} 个可迁移，{secretRefMigrations.summary.blockedCount} 个需要先处理环境问题。
            </p>
          </div>
          <Button size="sm" onClick={() => setShowSecretRefMigration(true)}>
            查看并迁移
          </Button>
        </div>
      ) : null}

      <DataTable
        rows={filteredProviders}
        rowKey={(row) => row.id}
        emptyMessage={query ? "没有匹配的 Provider" : "暂无 Provider"}
        pinnedBottom={(row) => row.disabled}
        defaultSort={{ key: "id" }}
        rowClassName={(row) => (row.disabled ? "opacity-60" : undefined)}
        columns={[
          {
            key: "id",
            header: "ID",
            sortable: true,
            sortValue: (row) => row.id,
            render: (row) => (
              <span className="inline-flex items-center gap-1.5">
                {row.containsPrimary ? (
                  <Star aria-label="包含当前主模型" className="h-3.5 w-3.5 fill-brand text-brand" />
                ) : null}
                <span className={row.containsPrimary ? "font-medium" : undefined}>{row.id}</span>
                {groupByProviderId.has(row.id) ? (
                  <span className="ml-1 inline-flex items-center gap-2">
                    <Pill variant="warning">⚠ 重复</Pill>
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
          {
            key: "baseUrl",
            header: "Base URL",
            render: (row) => <span className="font-mono text-xs">{row.baseUrl ?? "—"}</span>
          },
          {
            key: "models",
            header: "模型数",
            sortable: true,
            sortValue: (row) => row.modelCount,
            align: "right",
            render: (row) => row.modelCount
          },
          {
            key: "enabled",
            header: "已启用",
            align: "right",
            render: (row) => row.enabledModelCount
          },
          {
            key: "status",
            header: "状态",
            sortable: true,
            // 升序时已启用(0)在前、已关闭(1)在后
            sortValue: (row) => (row.disabled ? 1 : 0),
            render: (row) =>
              row.disabled ? <Pill variant="muted">已关闭</Pill> : <Pill variant="success">已启用</Pill>
          },
          {
            key: "actions",
            header: "操作",
            render: (row) => (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`管理模型 ${row.id}`}
                  title="模型"
                  onClick={() => setModelTarget(row)}
                >
                  <Cpu className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${row.disabled ? "恢复" : "关闭"} Provider ${row.id}`}
                  disabled={!row.disabled && row.containsPrimary}
                  title={!row.disabled && row.containsPrimary ? "该 Provider 包含当前主模型，请先切换主模型后再关闭" : row.disabled ? "恢复" : "关闭"}
                  onClick={() => setStateTarget(row)}
                >
                  {row.disabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`更多操作 ${row.id}`}>
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem aria-label={`编辑 ${row.id}`} onSelect={() => openEdit(row)}>
                      <Edit3 className="mr-2 h-3.5 w-3.5" />
                      编辑
                    </DropdownMenuItem>
                    <DropdownMenuItem aria-label={`发现模型 ${row.id}`} onSelect={() => setDiscoverTarget(row)}>
                      <Search className="mr-2 h-3.5 w-3.5" />
                      发现模型
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      aria-label={`删除 ${row.id}`}
                      className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                      onSelect={() => void openDelete(row)}
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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

      <ProviderDiscoverDialog
        open={Boolean(discoverTarget)}
        provider={discoverTarget}
        client={client}
        onCancel={() => setDiscoverTarget(null)}
        onAdded={({ addedCount, enabled }) => {
          setDiscoverTarget(null);
          toast.success(
            enabled
              ? `已添加并启用 ${addedCount} 个模型`
              : `已添加 ${addedCount} 个模型`
          );
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
          toast.success(formatEnvWriteSuccess({
            label: `Provider ${result.providerId} 的 API Key`,
            envWrite: result.envWrite,
            gatewayEnvSync: result.gatewayEnvSync,
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

      {/* 编辑 Provider：统一使用 Radix Dialog */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(val) => { if (!val) closeEdit(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑 Provider</DialogTitle>
            <DialogDescription className="break-all">{editTarget?.id}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">baseUrl</span>
              <Input
                aria-label="Provider baseUrl"
                value={editBaseUrl}
                onChange={(event) => setEditBaseUrl(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">API 类型</span>
              <select
                aria-label="Provider API 类型"
                value={editApi}
                onChange={(event) => setEditApi(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              >
                {editTarget?.api && !isEditableApiType(editTarget.api) ? (
                  <option value={editTarget.api}>{editTarget.api}（当前值）</option>
                ) : null}
                {EDITABLE_API_TYPES.map((api) => <option key={api} value={api}>{api}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">API Key 新值</span>
              <Input
                type="password"
                aria-label="Provider API Key 新值"
                value={editApiKey}
                onChange={(event) => setEditApiKey(event.target.value)}
                autoComplete="off"
              />
            </label>
            {editTarget?.apiKeyEnvStatus === "unmanaged" && editTarget.apiKeyEnv ? (
              <p className="text-sm text-warning">
                {editTarget.apiKeyEnv} 当前在托管块外；保存新 API Key 时会迁移到 oc-switch 托管区。
              </p>
            ) : null}
            {editError ? <p className="text-sm text-destructive">{editError}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit}>
              取消
            </Button>
            <Button onClick={() => void confirmEdit()}>保存 Provider</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EnvMigrationConfirmDialog
        open={Boolean(pendingEnvConfirm)}
        warnings={pendingEnvConfirm?.warnings ?? []}
        {...(pendingEnvConfirm?.confirmMigration ? { confirmMigration: true } : {})}
        {...(pendingEnvConfirm?.confirmComplex ? { confirmComplex: true } : {})}
        title="确认 API Key 写入"
        onCancel={() => setPendingEnvConfirm(null)}
        onConfirm={() => void confirmEnvMigration()}
      />

      <ConfirmDialog
        open={showSecretRefMigration}
        title="迁移 Provider API Key 引用"
        message="只修改 openclaw.json 中的引用格式，不改动 .env 中的 Key；写入前会创建备份。"
        confirmLabel={`迁移 ${secretRefMigrations?.summary.readyCount ?? 0} 项`}
        confirmDisabled={!secretRefMigrations?.summary.readyCount}
        onCancel={() => setShowSecretRefMigration(false)}
        onConfirm={() => void confirmSecretRefMigration()}
      >
        <ul className="space-y-2 text-sm">
          {secretRefMigrations?.candidates.map((candidate) => (
            <li key={candidate.providerId} className="rounded border border-border px-3 py-2 text-foreground">
              {candidate.providerId} · {candidate.envVar} · {candidate.status === "ready"
                ? "可迁移"
                : candidate.blockers.map(secretRefBlockerLabel).join("；")}
            </li>
          ))}
        </ul>
      </ConfirmDialog>

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
