import { Download, Plus, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable } from "../components/DataTable";
import { DiffSummary } from "../components/DiffSummary";
import type { ApiClient, ConfigDiffSummary, PresetEntry } from "../api";

interface PresetsViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** 预设管理：从预设添加 Provider、导入/导出 */
export function PresetsView({ client, onRefresh }: PresetsViewProps) {
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [confirmAdd, setConfirmAdd] = useState(false);
  const [submittedKey, setSubmittedKey] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const { presets: list } = await client.getPresets();
      setPresets(list);
      if (!selectedPreset && list[0]) setSelectedPreset(list[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client, selectedPreset]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleImport() {
    try {
      await client.importPresets();
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败");
    }
  }

  async function handleExport(providerId: string) {
    try {
      await client.exportPreset(providerId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "导出失败");
    }
  }

  async function previewAdd() {
    if (!selectedPreset || !apiKeyInput) {
      setError("请选择预设并输入 API Key");
      return;
    }
    setError(null);
    try {
      const currentDiff = await client.previewAddProvider(selectedPreset);
      setDiff(currentDiff);
      setConfirmAdd(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    }
  }

  async function confirmAddProvider() {
    if (!selectedPreset || !apiKeyInput) return;
    try {
      await client.addProvider(selectedPreset, apiKeyInput);
      setSubmittedKey("");
      setApiKeyInput("");
      setConfirmAdd(false);
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    }
  }

  return (
    <section data-testid="presets-view">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">预设</h1>
        <span
          className="rounded border border-amber-600/50 bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-200"
          title="预设流程计划重构：迁移与共享优先使用导入/导出与备份"
        >
          待改进
        </span>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        列表来自内置/自定义模板文件，不是当前 openclaw.json 的实时镜像。日常管理请用 Providers 与模型页；迁移与共享请优先使用「导入当前配置」或备份恢复。
      </p>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void handleImport()}
            className="inline-flex items-center gap-1 rounded border border-input px-3 py-1.5 text-sm hover:bg-accent hover:text-foreground"
          >
            <Upload className="h-4 w-4" />
            导入当前配置
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

      {error ? <p className="mb-3 text-destructive">{error}</p> : null}

      <div className="mb-6 rounded-lg border border-border bg-muted/40 p-4">
        <h2 className="mb-3 text-sm font-medium text-foreground">从预设添加 Provider</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-muted-foreground">预设</span>
            <select
              value={selectedPreset}
              onChange={(e) => setSelectedPreset(e.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.source})
                </option>
              ))}
            </select>
          </label>
          <label className="flex-1 text-sm">
            <span className="mb-1 block text-muted-foreground">API Key（仅提交，不展示）</span>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
              autoComplete="off"
              aria-label="API Key"
            />
          </label>
          <button
            type="button"
            onClick={() => void previewAdd()}
            className="inline-flex items-center justify-center gap-1 rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            预览并添加
          </button>
        </div>
        {submittedKey ? <p data-testid="leaked-key">{submittedKey}</p> : null}
      </div>

      <DataTable
        rows={presets}
        rowKey={(row) => row.id}
        columns={[
          { key: "id", header: "ID", render: (row) => row.id },
          { key: "name", header: "名称", render: (row) => row.name },
          { key: "source", header: "来源", render: (row) => row.source },
          { key: "models", header: "模型数", render: (row) => String(row.modelCount) },
          {
            key: "export",
            header: "导出",
            render: (row) =>
              row.source === "custom" ? (
                <button
                  type="button"
                  aria-label={`导出 ${row.id}`}
                  onClick={() => void handleExport(row.id)}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Download className="h-3 w-3" />
                  导出
                </button>
              ) : (
                "—"
              )
          }
        ]}
      />

      <ConfirmDialog
        open={confirmAdd}
        title="确认添加 Provider"
        message="以下变更将在确认后写入配置（自动备份）。"
        onCancel={() => setConfirmAdd(false)}
        onConfirm={() => {
          setSubmittedKey("");
          void confirmAddProvider();
        }}
      />
      {confirmAdd && diff ? (
        <div className="mt-3">
          <DiffSummary diff={diff} />
        </div>
      ) : null}
    </section>
  );
}
