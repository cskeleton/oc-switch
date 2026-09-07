import { Download, Plus, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable } from "../components/DataTable";
import { DiffSummary } from "../components/DiffSummary";
import { EnvMigrationConfirmDialog } from "../components/EnvMigrationConfirmDialog";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui/button";
import { Pill } from "../components/ui/pill";
import { formatEnvWriteSuccess } from "../env-feedback";
import type { ApiClient, ConfigDiffSummary, EnvPreview, PresetEntry } from "../api";

interface PresetsViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** 预设管理：从预设添加 Provider、导入/导出 */
export function PresetsView({ client, onRefresh }: PresetsViewProps) {
  const toast = useToast();
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<string>("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [envPreview, setEnvPreview] = useState<EnvPreview | null>(null);
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
      toast.success("当前配置已导入为自定义预设。");
      await load();
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导入失败");
    }
  }

  async function handleExport(providerId: string) {
    try {
      await client.exportPreset(providerId);
      toast.success(`Provider ${providerId} 已导出为自定义预设。`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "导出失败");
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
      setEnvPreview(currentDiff.envPreview ?? null);
      setConfirmAdd(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    }
  }

  async function confirmAddProvider(flags?: { confirmMigration?: boolean; confirmComplex?: boolean }) {
    if (!selectedPreset || !apiKeyInput) return;
    try {
      const result = await client.addProvider(selectedPreset, apiKeyInput, undefined, flags);
      setSubmittedKey("");
      setApiKeyInput("");
      setConfirmAdd(false);
      setEnvPreview(null);
      toast.success(formatEnvWriteSuccess({
        label: `Provider ${selectedPreset} 的 API Key`,
        envWrite: result.envWrite,
        gatewayEnvSync: result.gatewayEnvSync,
        fallback: `Provider ${selectedPreset} 已添加`
      }));
      await load();
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加失败");
    }
  }

  function envConfirmFlags(preview: EnvPreview | null) {
    if (!preview?.requiresConfirmation) return undefined;
    return {
      ...(preview.requiresMigration ? { confirmMigration: true } : {}),
      ...(preview.requiresComplex ? { confirmComplex: true } : {})
    };
  }

  return (
    <section data-testid="presets-view">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold">预设</h1>
        <Pill
          variant="warning"
          title="预设流程计划重构：迁移与共享优先使用导入/导出与备份"
        >
          待改进
        </Pill>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        列表来自内置/自定义模板文件，不是当前 openclaw.json 的实时镜像。日常管理请用 Providers 与模型页；迁移与共享请优先使用「导入当前配置」或备份恢复。
      </p>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void handleImport()}>
            <Upload className="h-4 w-4" />
            导入当前配置
          </Button>
          <Button variant="outline" size="icon" aria-label="刷新" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
      </div>

      {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}

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
          <Button onClick={() => void previewAdd()}>
            <Plus className="h-4 w-4" />
            预览并添加
          </Button>
        </div>
        {submittedKey ? <p data-testid="leaked-key">{submittedKey}</p> : null}
      </div>

      <DataTable
        rows={presets}
        rowKey={(row) => row.id}
        // 5 列都是短字段，无需默认的 40rem（会让窄屏白白横滚）
        minWidthClass="min-w-[19rem] sm:min-w-[28rem]"
        columns={[
          { key: "id", header: "ID", render: (row) => row.id },
          { key: "name", header: "名称", render: (row) => row.name },
          { key: "source", header: "来源", wrap: "nowrap", className: "hidden sm:table-cell", render: (row) => row.source },
          { key: "models", header: "模型数", wrap: "nowrap", render: (row) => String(row.modelCount) },
          {
            key: "export",
            header: "导出",
            wrap: "nowrap",
            render: (row) =>
              row.source === "custom" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`导出 ${row.id}`}
                  onClick={() => void handleExport(row.id)}
                  className="text-brand hover:text-brand"
                >
                  <Download className="h-3 w-3" />
                  导出
                </Button>
              ) : (
                "—"
              )
          }
        ]}
      />

      {envPreview?.requiresConfirmation ? (
        <EnvMigrationConfirmDialog
          open={confirmAdd}
          warnings={envPreview.warnings}
          confirmMigration={envPreview.requiresMigration}
          confirmComplex={envPreview.requiresComplex}
          title="确认添加 Provider"
          onCancel={() => setConfirmAdd(false)}
          onConfirm={() => {
            setSubmittedKey("");
            void confirmAddProvider(envConfirmFlags(envPreview));
          }}
        />
      ) : (
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
      )}
      {confirmAdd && diff ? (
        <div className="mt-3">
          <DiffSummary diff={diff} />
        </div>
      ) : null}
    </section>
  );
}
