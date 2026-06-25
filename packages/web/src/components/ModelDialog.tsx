import { useEffect, useState } from "react";
import type { ApiType, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";

interface ModelDialogProps {
  open: boolean;
  mode: "create" | "edit";
  providers: ProviderSummary[];
  fixedProviderId?: string;
  model?: ModelSummary;
  onCancel: () => void;
  onSave: (providerId: string, model: ProviderModelInput) => Promise<void>;
}

const API_OPTIONS: Array<{ value: ApiType; label: string }> = [
  { value: "openai-completions", label: "openai-completions" },
  { value: "anthropic-messages", label: "anthropic-messages" },
  { value: "google-generative-ai", label: "google-generative-ai" }
];

function splitInputModes(value: string): string[] | undefined {
  const modes = value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return modes.length ? modes : undefined;
}

function optionalPositiveInteger(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }
  return parsed;
}

/** 新增/编辑模型的共用表单 */
export function ModelDialog({ open, mode, providers, fixedProviderId, model, onCancel, onSave }: ModelDialogProps) {
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [api, setApi] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProviderId(fixedProviderId ?? model?.providerId ?? providers[0]?.id ?? "");
    setModelId(model?.modelId ?? "");
    setName(model?.name ?? "");
    setAlias(model?.alias ?? "");
    setEnabled(model?.enabled ?? true);
    setApi(model?.api ?? "");
    setReasoning(model?.reasoning === undefined ? "" : String(model.reasoning));
    setContextWindow(model?.contextWindow ? String(model.contextWindow) : "");
    setMaxTokens(model?.maxTokens ? String(model.maxTokens) : "");
    setInput(model?.input?.join("\n") ?? "");
    setError(null);
  }, [fixedProviderId, model, open, providers]);

  if (!open) return null;

  async function submit() {
    setError(null);
    const selectedProviderId = fixedProviderId ?? providerId;
    if (!selectedProviderId) {
      setError("请选择 Provider");
      return;
    }
    if (!modelId.trim()) {
      setError("请输入 Model ID");
      return;
    }
    const next: ProviderModelInput = {
      id: modelId.trim(),
      enabled
    };
    if (name.trim()) next.name = name.trim();
    if (alias.trim()) next.alias = alias.trim();
    if (api) next.api = api as ApiType;
    if (reasoning) next.reasoning = reasoning === "true";
    let parsedContextWindow: number | undefined;
    let parsedMaxTokens: number | undefined;
    try {
      parsedContextWindow = optionalPositiveInteger(contextWindow, "Context Window");
      parsedMaxTokens = optionalPositiveInteger(maxTokens, "Max Tokens");
    } catch (err) {
      setError(err instanceof Error ? err.message : "数字字段格式不正确");
      return;
    }
    if (parsedContextWindow !== undefined) next.contextWindow = parsedContextWindow;
    if (parsedMaxTokens !== undefined) next.maxTokens = parsedMaxTokens;
    const inputModes = splitInputModes(input);
    if (inputModes) next.input = inputModes;

    setSaving(true);
    try {
      await onSave(selectedProviderId, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存模型失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-600 bg-slate-900 p-4 shadow-xl">
        <h2 className="text-lg font-semibold text-slate-100">{mode === "create" ? "添加模型" : "编辑模型"}</h2>
        {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Provider</span>
            <select
              aria-label="Provider"
              value={fixedProviderId ?? providerId}
              disabled={Boolean(fixedProviderId) || mode === "edit"}
              onChange={(event) => setProviderId(event.target.value)}
              className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100"
            >
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.id}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Model ID</span>
            <input aria-label="Model ID" value={modelId} onChange={(event) => setModelId(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Name</span>
            <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Alias</span>
            <input aria-label="Alias" value={alias} onChange={(event) => setAlias(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">API</span>
            <select aria-label="API" value={api} onChange={(event) => setApi(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100">
              <option value="">继承 Provider</option>
              {API_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 self-end text-sm text-slate-200">
            <input aria-label="Enabled" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            已启用
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Reasoning</span>
            <select aria-label="Reasoning" value={reasoning} onChange={(event) => setReasoning(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100">
              <option value="">继承 Provider</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Context Window</span>
            <input aria-label="Context Window" inputMode="numeric" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Max Tokens</span>
            <input aria-label="Max Tokens" inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100" />
          </label>
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block text-slate-400">Input</span>
            <textarea aria-label="Input" value={input} onChange={(event) => setInput(event.target.value)} className="min-h-20 w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100" />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">取消</button>
          <button type="button" disabled={saving} onClick={() => void submit()} className="rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-40">保存模型</button>
        </div>
      </div>
    </div>
  );
}
