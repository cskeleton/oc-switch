import { Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient, ApiType, ConfigDiffSummary, CustomProviderInput, CustomProviderModelInput, EnvPreview, EnvWriteVerification, GatewayEnvSyncResult, RemoteModelInfo } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { EnvMigrationConfirmDialog } from "./EnvMigrationConfirmDialog";
import { DiffSummary } from "./DiffSummary";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface CustomProviderDialogProps {
  open: boolean;
  client: ApiClient;
  /** 打开时预填的 Provider ID（spec §8.1：Provider 缺失的补全路径） */
  initialProviderId?: string | undefined;
  /** 打开时预填的模型行（首行优先回填，其余行留空） */
  initialModels?: CustomProviderModelInput[] | undefined;
  onCancel: () => void;
  onSaved: (result: { providerId: string; envWrite?: EnvWriteVerification | undefined; gatewayEnvSync?: GatewayEnvSyncResult }) => void;
}

interface ModelRow {
  id: string;
  name: string;
  alias: string;
}

const emptyModelRows = (): ModelRow[] => [
  { id: "", name: "", alias: "" },
  { id: "", name: "", alias: "" },
  { id: "", name: "", alias: "" }
];
const MAX_PROVIDER_MODELS = 100;

function providerIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function envNameFromProviderId(providerId: string): string {
  const normalized = providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  if (normalized.length === 0) return "";
  return `${normalized}_API_KEY`;
}

function modelsFromRows(rows: ModelRow[]): CustomProviderModelInput[] {
  return rows
    .map((row) => ({
      id: row.id.trim(),
      name: row.name.trim(),
      alias: row.alias.trim()
    }))
    .filter((row) => row.id.length > 0)
    .map((row) => ({
      id: row.id,
      ...(row.name ? { name: row.name } : {}),
      ...(row.alias ? { alias: row.alias } : {})
    }));
}

function updateModelRow(rows: ModelRow[], index: number, key: keyof ModelRow, value: string): ModelRow[] {
  return rows.map((row, rowIndex) =>
    rowIndex === index ? { ...row, [key]: value } : row
  );
}

function isRowEmpty(row: ModelRow): boolean {
  return row.id.trim().length === 0 && row.name.trim().length === 0 && row.alias.trim().length === 0;
}

function isFormDirty(state: {
  displayName: string;
  providerId: string;
  apiKeyEnv: string;
  notes: string;
  websiteUrl: string;
  api: ApiType;
  baseUrl: string;
  apiKey: string;
  isFullUrl: boolean;
  enableAllModels: boolean;
  modelRows: ModelRow[];
}): boolean {
  if (state.displayName.trim()) return true;
  if (state.providerId.trim()) return true;
  if (state.apiKeyEnv.trim()) return true;
  if (state.notes.trim()) return true;
  if (state.websiteUrl.trim()) return true;
  if (state.baseUrl.trim()) return true;
  if (state.apiKey.trim()) return true;
  if (state.api !== "openai-completions") return true;
  if (state.isFullUrl) return true;
  if (!state.enableAllModels) return true;
  return state.modelRows.some((row) => !isRowEmpty(row));
}

function mergeDiscoveredModelsIntoRows(rows: ModelRow[], selected: RemoteModelInfo[]): ModelRow[] {
  const existingIds = new Set(
    rows
      .map((row) => row.id.trim())
      .filter((id) => id.length > 0)
  );
  const toMerge = selected.filter((model) => {
    const trimmedId = model.id.trim();
    if (!trimmedId || existingIds.has(trimmedId)) return false;
    existingIds.add(trimmedId);
    return true;
  });
  if (toMerge.length === 0) return rows;
  const nextRows = rows.map((row) => ({ ...row }));
  const emptyIndices: number[] = [];
  for (let i = 0; i < nextRows.length; i += 1) {
    const currentRow = nextRows[i];
    if (currentRow && isRowEmpty(currentRow)) emptyIndices.push(i);
  }
  for (const model of toMerge) {
    const nextModelRow: ModelRow = {
      id: model.id,
      name: model.name ?? "",
      alias: ""
    };
    const targetIndex = emptyIndices.shift();
    if (targetIndex !== undefined) nextRows[targetIndex] = nextModelRow;
    else nextRows.push(nextModelRow);
  }
  return nextRows;
}

/** 手工添加自定义 Provider 的模态表单 */
export function CustomProviderDialog({ open, client, initialProviderId, initialModels, onCancel, onSaved }: CustomProviderDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [providerId, setProviderId] = useState("");
  const [providerIdTouched, setProviderIdTouched] = useState(false);
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [apiKeyEnvTouched, setApiKeyEnvTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [api, setApi] = useState<ApiType>("openai-completions");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [isFullUrl, setIsFullUrl] = useState(false);
  const [enableAllModels, setEnableAllModels] = useState(true);
  const [modelRows, setModelRows] = useState<ModelRow[]>(emptyModelRows);
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [envPreview, setEnvPreview] = useState<EnvPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);

  useEffect(() => {
    if (!providerIdTouched) setProviderId(providerIdFromName(displayName));
  }, [displayName, providerIdTouched]);

  useEffect(() => {
    if (!apiKeyEnvTouched) setApiKeyEnv(envNameFromProviderId(providerId));
  }, [providerId, apiKeyEnvTouched]);

  // 打开时预填（spec §8.1 Provider 缺失的补全路径）：providerId 锁定为用户已知值，
  // 模型行优先回填到空行；只在 open 上升沿应用一次，避免覆盖用户后续编辑
  useEffect(() => {
    if (!open) return;
    if (initialProviderId !== undefined && initialProviderId !== "") {
      setProviderIdTouched(true);
      setProviderId(initialProviderId);
    }
    if (initialModels && initialModels.length > 0) {
      setModelRows((rows) => {
        const nextRows = rows.map((row) => ({ ...row }));
        const emptyIndices: number[] = [];
        for (let i = 0; i < nextRows.length; i += 1) {
          if (isRowEmpty(nextRows[i]!)) emptyIndices.push(i);
        }
        for (const model of initialModels) {
          const nextRow: ModelRow = { id: model.id, name: model.name ?? "", alias: model.alias ?? "" };
          const targetIndex = emptyIndices.shift();
          if (targetIndex !== undefined) nextRows[targetIndex] = nextRow;
          else nextRows.push(nextRow);
        }
        return nextRows;
      });
    }
    // 预填只在打开时应用一次；open 变化触发（initialModels 引用不进依赖，防止重复注入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function resetForm() {
    setDisplayName("");
    setProviderId("");
    setProviderIdTouched(false);
    setApiKeyEnv("");
    setApiKeyEnvTouched(false);
    setNotes("");
    setWebsiteUrl("");
    setApi("openai-completions");
    setBaseUrl("");
    setApiKey("");
    setIsFullUrl(false);
    setEnableAllModels(true);
    setModelRows(emptyModelRows());
    setDiff(null);
    setEnvPreview(null);
    setConfirming(false);
    setConfirmingClose(false);
    setDiscoverOpen(false);
    setError(null);
  }

  function cancel() {
    resetForm();
    onCancel();
  }

  function requestClose() {
    if (isFormDirty({
      displayName,
      providerId,
      apiKeyEnv,
      notes,
      websiteUrl,
      api,
      baseUrl,
      apiKey,
      isFullUrl,
      enableAllModels,
      modelRows
    })) {
      setConfirmingClose(true);
      return;
    }
    cancel();
  }

  const input = (): CustomProviderInput => {
    const parsed: CustomProviderInput = {
      providerId,
      displayName,
      api,
      baseUrl,
      isFullUrl,
      apiKeyEnv,
      models: modelsFromRows(modelRows),
      enableAllModels
    };
    if (notes) parsed.notes = notes;
    if (websiteUrl) parsed.websiteUrl = websiteUrl;
    return parsed;
  };

  async function preview() {
    setError(null);
    try {
      const nextInput = input();
      const nextDiff = await client.previewCustomProvider(nextInput);
      setDiff(nextDiff);
      setEnvPreview(nextDiff.envPreview ?? null);
      setConfirming(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    }
  }

  async function confirm(flags?: { confirmMigration?: boolean; confirmComplex?: boolean }) {
    setError(null);
    try {
      const result = await client.addCustomProvider(input(), apiKey, flags);
      const savedProviderId = providerId;
      resetForm();
      onSaved({
        providerId: savedProviderId,
        ...(result.envWrite ? { envWrite: result.envWrite } : {}),
        ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    }
  }

  function envConfirmFlags(preview: EnvPreview | null) {
    if (!preview?.requiresConfirmation) return undefined;
    return {
      ...(preview.requiresMigration ? { confirmMigration: true } : {}),
      ...(preview.requiresComplex ? { confirmComplex: true } : {})
    };
  }

  const selectClassName = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

  return (
    <>
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          className="max-w-4xl max-h-[90vh] overflow-y-auto"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader className="flex-row items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-muted text-xl font-semibold text-muted-foreground shrink-0">
              {(providerId || "P").slice(0, 1).toUpperCase()}
            </div>
            <div className="flex flex-col space-y-1.5 text-left">
              <DialogTitle>添加 Provider</DialogTitle>
              <DialogDescription>
                填写自定义 Provider 信息，确认前会预览配置差异。
              </DialogDescription>
            </div>
          </DialogHeader>

          {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

          <div className="grid gap-4 py-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>供应商名称</Label>
              <Input aria-label="供应商名称" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>Provider ID</Label>
              <Input aria-label="Provider ID" value={providerId} onChange={(event) => { setProviderIdTouched(true); setProviderId(event.target.value); }} />
            </div>
            <div className="grid gap-2">
              <Label>官网链接</Label>
              <Input aria-label="官网链接" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>备注</Label>
              <Input aria-label="备注" value={notes} onChange={(event) => setNotes(event.target.value)} />
            </div>

            <div className="grid gap-2 md:col-span-2 mt-2">
              <Label>API Key</Label>
              <Input aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" />
            </div>

            <div className="grid gap-2 mt-2">
              <Label>请求地址</Label>
              <Input aria-label="请求地址" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">
                OpenAI-compatible 通常使用 `/v1` 结尾；Anthropic/Gemini 兼容端点按服务商说明填写。
              </p>
            </div>
            <div className="grid gap-2 mt-2 content-start">
              <Label>API 类型</Label>
              <select aria-label="API 类型" value={api} onChange={(event) => setApi(event.target.value as ApiType)} className={selectClassName}>
                <option value="openai-completions">openai-completions</option>
                <option value="anthropic-messages">anthropic-messages</option>
                <option value="google-generative-ai">google-generative-ai</option>
              </select>
              <div className="flex items-center space-x-2 mt-1">
                <input
                  id="is-full-url"
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={isFullUrl}
                  onChange={(event) => setIsFullUrl(event.target.checked)}
                  aria-label="完整 URL"
                />
                <Label htmlFor="is-full-url">
                  完整 URL
                </Label>
              </div>
            </div>

            <div className="grid gap-2 md:col-span-2 mt-2">
              <div className="flex items-center justify-between gap-3">
                <Label>模型列表</Label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDiscoverOpen(true)}
                    aria-label="发现模型"
                    className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
                  >
                    发现模型
                  </button>
                  <button
                    type="button"
                    onClick={() => setModelRows((rows) => [...rows, { id: "", name: "", alias: "" }])}
                    aria-label="添加模型行"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto rounded-md border border-border">
                <div className="grid min-w-[760px] grid-cols-[minmax(220px,1.4fr)_minmax(180px,1fr)_minmax(160px,0.8fr)_72px] border-b border-border bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <div>模型 ID</div>
                  <div>模型名称</div>
                  <div>Alias</div>
                  <div className="text-center">操作</div>
                </div>
                <div className="divide-y divide-border">
                  {modelRows.map((row, index) => (
                    <div key={index} className="grid min-w-[760px] grid-cols-[minmax(220px,1.4fr)_minmax(180px,1fr)_minmax(160px,0.8fr)_72px] gap-3 px-3 py-2">
                      <Input
                        aria-label={`模型 ID ${index + 1}`}
                        value={row.id}
                        onChange={(event) => setModelRows((rows) => updateModelRow(rows, index, "id", event.target.value))}
                        placeholder="vendor/model-a"
                      />
                      <Input
                        aria-label={`模型名称 ${index + 1}`}
                        value={row.name}
                        onChange={(event) => setModelRows((rows) => updateModelRow(rows, index, "name", event.target.value))}
                        placeholder="Vendor Model A"
                      />
                      <Input
                        aria-label={`模型 Alias ${index + 1}`}
                        value={row.alias}
                        onChange={(event) => setModelRows((rows) => updateModelRow(rows, index, "alias", event.target.value))}
                        placeholder="a"
                      />
                      <div className="flex items-center justify-center">
                        <button
                          type="button"
                          aria-label={`删除模型行 ${index + 1}`}
                          onClick={() => setModelRows((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <details open className="md:col-span-2 mt-2 rounded border p-3 group">
              <summary className="cursor-pointer text-sm font-medium text-foreground">高级选项</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>API Key env 名</Label>
                  <Input aria-label="API Key env 名" value={apiKeyEnv} onChange={(event) => { setApiKeyEnvTouched(true); setApiKeyEnv(event.target.value); }} />
                </div>
                {envPreview?.requiresConfirmation ? (
                  <p className="md:col-span-2 text-sm text-warning">
                    {apiKeyEnv} 当前在托管块外或存在复杂语法；确认添加后将迁移到 oc-switch 托管区。
                  </p>
                ) : null}
              </div>
              <div className="flex items-center space-x-2 mt-4">
                <input
                  id="enable-all-models"
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  checked={enableAllModels}
                  onChange={(event) => setEnableAllModels(event.target.checked)}
                  aria-label="默认启用全部模型"
                />
                <Label htmlFor="enable-all-models">
                  默认启用全部模型
                </Label>
              </div>
            </details>

            {diff ? <div className="md:col-span-2 mt-2"><DiffSummary diff={diff} /></div> : null}
          </div>

          <DialogFooter>
            <button type="button" onClick={requestClose} className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              取消
            </button>
            <button type="button" onClick={() => void preview()} className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" />
              预览并添加
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {envPreview?.requiresConfirmation ? (
        <EnvMigrationConfirmDialog
          open={confirming}
          warnings={envPreview.warnings}
          confirmMigration={envPreview.requiresMigration}
          confirmComplex={envPreview.requiresComplex}
          title="确认添加 Provider"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirm(envConfirmFlags(envPreview))}
        />
      ) : (
        <ConfirmDialog
          open={confirming}
          title="确认添加 Provider"
          message="以下变更将在确认后写入配置，并自动创建备份。"
          onCancel={() => setConfirming(false)}
          onConfirm={() => void confirm()}
        />
      )}
      <ConfirmDialog
        open={confirmingClose}
        title="放弃已填写内容？"
        message="取消后表单数据将被清除。"
        onCancel={() => setConfirmingClose(false)}
        onConfirm={() => {
          setConfirmingClose(false);
          cancel();
        }}
      />
      <CustomProviderDiscoverDialog
        open={discoverOpen}
        api={api}
        baseUrl={baseUrl}
        apiKey={apiKey}
        isFullUrl={isFullUrl}
        alreadyAddedIds={modelsFromRows(modelRows).map((row) => row.id)}
        currentModelCount={modelsFromRows(modelRows).length}
        client={client}
        onCancel={() => setDiscoverOpen(false)}
        onConfirm={(selectedModels) => {
          setModelRows((rows) => mergeDiscoveredModelsIntoRows(rows, selectedModels));
          setDiscoverOpen(false);
        }}
      />
    </>
  );
}

interface CustomProviderDiscoverDialogProps {
  open: boolean;
  api: ApiType;
  baseUrl: string;
  apiKey: string;
  isFullUrl: boolean;
  alreadyAddedIds: string[];
  currentModelCount: number;
  client: ApiClient;
  onCancel: () => void;
  onConfirm: (selectedModels: RemoteModelInfo[]) => void;
}

function CustomProviderDiscoverDialog({
  open,
  api,
  baseUrl,
  apiKey,
  isFullUrl,
  alreadyAddedIds,
  currentModelCount,
  client,
  onCancel,
  onConfirm
}: CustomProviderDiscoverDialogProps) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModelInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);

  function reset() {
    setLoading(false);
    setSubmitting(false);
    setError(null);
    setRemoteModels([]);
    setSelectedIds(new Set());
    setSearch("");
    setUnsupportedReason(null);
  }

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    setError(null);
  }, [open]);

  async function loadDiscover() {
    if (!open) return;
    if (!baseUrl.trim() || !apiKey.trim()) {
      setError("请先填写请求地址与 API Key，再执行发现模型。");
      return;
    }
    if (api === "google-generative-ai") {
      setUnsupportedReason("google-generative-ai 暂不支持自动发现，请手动填写模型。");
      return;
    }
    setLoading(true);
    setError(null);
    setUnsupportedReason(null);
    try {
      const result = await client.discoverProviderPreview({
        api,
        baseUrl,
        apiKey,
        isFullUrl,
        alreadyAddedIds
      });
      setRemoteModels(result.remoteModels);
      if (result.unsupportedReason) setUnsupportedReason(result.unsupportedReason);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发现模型失败");
    } finally {
      setLoading(false);
    }
  }

  const filteredModels = remoteModels.filter((model) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return model.id.toLowerCase().includes(query) || (model.name?.toLowerCase().includes(query) ?? false);
  });
  const selectedCount = selectedIds.size;
  const remainingSlots = Math.max(0, MAX_PROVIDER_MODELS - currentModelCount);
  const overCapacity = currentModelCount + selectedCount > MAX_PROVIDER_MODELS;

  function toggleSelect(id: string) {
    if (alreadyAddedIds.includes(id)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>发现模型</DialogTitle>
          <DialogDescription>基于当前表单凭证临时拉取模型，勾选后仅回填表单，不会写入配置。</DialogDescription>
        </DialogHeader>
        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
        {unsupportedReason ? <p className="text-sm text-warning">{unsupportedReason}</p> : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadDiscover()}
            disabled={loading}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-3 py-1 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            {loading ? "发现中…" : "开始发现"}
          </button>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="搜索发现模型"
              placeholder="搜索 id 或名称…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-8"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {filteredModels.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{loading ? "正在发现远端模型…" : "暂无可选模型"}</p>
          ) : (
            <ul className="divide-y divide-border">
              {filteredModels.map((model) => {
                const added = alreadyAddedIds.includes(model.id);
                const checked = added || selectedIds.has(model.id);
                return (
                  <li key={model.id}>
                    <label className={`flex items-start gap-3 px-3 py-2 text-sm ${added ? "cursor-not-allowed opacity-60" : "hover:bg-accent/50"}`}>
                      <input
                        type="checkbox"
                        aria-label={`选择发现模型 ${model.id}`}
                        checked={checked}
                        disabled={added}
                        onChange={() => toggleSelect(model.id)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="break-all font-medium">{model.id}</span>
                        {model.name ? <span className="ml-2 text-muted-foreground">{model.name}</span> : null}
                        {added ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已在表单</span> : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
          <p className="text-xs text-muted-foreground">
            已选 {selectedCount} 个，当前已填 {currentModelCount} 个，最多 {MAX_PROVIDER_MODELS} 个
            {overCapacity ? "（已超出上限）" : ""}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
            >
              取消
            </button>
            <button
              type="button"
              disabled={selectedCount === 0 || overCapacity || submitting}
              onClick={() => {
                setSubmitting(true);
                const selectedModels = remoteModels.filter((model) => selectedIds.has(model.id));
                onConfirm(selectedModels);
                setSubmitting(false);
              }}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            >
              回填到模型列表
            </button>
          </div>
          <p className="text-xs text-muted-foreground">本流程仅回填表单，不写盘；最终写入仍以“预览并添加”提交为准。</p>
          <p className="text-xs text-muted-foreground">本次最多还可新增 {remainingSlots} 个模型。</p>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
