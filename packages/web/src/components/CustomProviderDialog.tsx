import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient, ApiType, ConfigDiffSummary, CustomProviderInput, CustomProviderModelInput } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffSummary } from "./DiffSummary";

interface CustomProviderDialogProps {
  open: boolean;
  client: ApiClient;
  onCancel: () => void;
  onSaved: () => void;
}

function providerIdFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function envNameFromProviderId(providerId: string): string {
  return `${providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_API_KEY`;
}

function parseModels(value: string): CustomProviderModelInput[] {
  return value.split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      const idPart = parts[0] ?? "";
      const aliasPart = parts[1];
      const parsed: CustomProviderModelInput = { id: idPart };
      if (aliasPart) parsed.alias = aliasPart;
      return parsed;
    });
}

/** 手工添加自定义 Provider 的模态表单 */
export function CustomProviderDialog({ open, client, onCancel, onSaved }: CustomProviderDialogProps) {
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
  const [modelText, setModelText] = useState("");
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerIdTouched) setProviderId(providerIdFromName(displayName));
  }, [displayName, providerIdTouched]);

  useEffect(() => {
    if (!apiKeyEnvTouched) setApiKeyEnv(envNameFromProviderId(providerId));
  }, [providerId, apiKeyEnvTouched]);

  if (!open) return null;

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
    setModelText("");
    setDiff(null);
    setConfirming(false);
    setError(null);
  }

  function cancel() {
    resetForm();
    onCancel();
  }

  const input = (): CustomProviderInput => {
    const parsed: CustomProviderInput = {
      providerId,
      displayName,
      api,
      baseUrl,
      isFullUrl,
      apiKeyEnv,
      models: parseModels(modelText),
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
      setConfirming(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    }
  }

  async function confirm() {
    setError(null);
    try {
      await client.addCustomProvider(input(), apiKey);
      resetForm();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加失败");
    }
  }

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="mx-auto w-full max-w-4xl rounded-lg border border-slate-700 bg-slate-950 p-5 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-xl font-semibold text-slate-300">
            {(providerId || "P").slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h2 className="text-lg font-semibold">添加 Provider</h2>
            <p className="text-sm text-slate-400">填写自定义 Provider 信息，确认前会预览配置差异。</p>
          </div>
        </div>

        {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}

        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-slate-400">供应商名称</span>
            <input aria-label="供应商名称" value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-400">Provider ID</span>
            <input aria-label="Provider ID" value={providerId} onChange={(event) => { setProviderIdTouched(true); setProviderId(event.target.value); }} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-400">官网链接</span>
            <input aria-label="官网链接" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-slate-400">备注</span>
            <input aria-label="备注" value={notes} onChange={(event) => setNotes(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" />
          </label>
        </div>

        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-slate-400">API Key</span>
          <input aria-label="API Key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" autoComplete="off" />
        </label>

        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <label className="text-sm">
            <span className="mb-1 block text-slate-400">请求地址</span>
            <input aria-label="请求地址" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input aria-label="完整 URL" type="checkbox" checked={isFullUrl} onChange={(event) => setIsFullUrl(event.target.checked)} />
            完整 URL
          </label>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          OpenAI-compatible 通常使用 `/v1` 结尾；Anthropic/Gemini 兼容端点按服务商说明填写。
        </p>

        <label className="mt-3 block text-sm">
          <span className="mb-1 block text-slate-400">模型列表</span>
          <textarea aria-label="模型列表" value={modelText} onChange={(event) => setModelText(event.target.value)} rows={5} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm" placeholder={"model-a | a\nvendor/model-b | b"} />
        </label>

        <details className="mt-4 rounded border border-slate-700 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-300">高级选项</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-slate-400">API 类型</span>
              <select aria-label="API 类型" value={api} onChange={(event) => setApi(event.target.value as ApiType)} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2">
                <option value="openai-completions">openai-completions</option>
                <option value="anthropic-messages">anthropic-messages</option>
                <option value="google-generative-ai">google-generative-ai</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-slate-400">API Key env 名</span>
              <input aria-label="API Key env 名" value={apiKeyEnv} onChange={(event) => { setApiKeyEnvTouched(true); setApiKeyEnv(event.target.value); }} className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2" />
            </label>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <input aria-label="默认启用全部模型" type="checkbox" checked={enableAllModels} onChange={(event) => setEnableAllModels(event.target.checked)} />
            默认启用全部模型
          </label>
        </details>

        {diff ? <div className="mt-4"><DiffSummary diff={diff} /></div> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={cancel} className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">取消</button>
          <button type="button" onClick={() => void preview()} className="inline-flex items-center gap-1 rounded-md bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500">
            <Plus className="h-4 w-4" />
            预览并添加
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title="确认添加 Provider"
        message="以下变更将在确认后写入配置，并自动创建备份。"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}
