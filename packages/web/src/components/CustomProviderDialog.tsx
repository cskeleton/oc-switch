import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient, ApiType, ConfigDiffSummary, CustomProviderInput, CustomProviderModelInput } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffSummary } from "./DiffSummary";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

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

  const selectClassName = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

  return (
    <>
      <Dialog open={open} onOpenChange={(val) => { if (!val) cancel(); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
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
            <div className="flex items-center space-x-2 mt-8 md:mt-10 md:ml-4">
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

            <div className="grid gap-2 md:col-span-2 mt-2">
              <Label>模型列表</Label>
              <Textarea aria-label="模型列表" value={modelText} onChange={(event) => setModelText(event.target.value)} rows={5} className="font-mono" placeholder={"model-a | a\nvendor/model-b | b"} />
            </div>

            <details className="md:col-span-2 mt-2 rounded border p-3 group">
              <summary className="cursor-pointer text-sm font-medium text-foreground">高级选项</summary>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="grid gap-2">
                  <Label>API 类型</Label>
                  <select aria-label="API 类型" value={api} onChange={(event) => setApi(event.target.value as ApiType)} className={selectClassName}>
                    <option value="openai-completions">openai-completions</option>
                    <option value="anthropic-messages">anthropic-messages</option>
                    <option value="google-generative-ai">google-generative-ai</option>
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>API Key env 名</Label>
                  <Input aria-label="API Key env 名" value={apiKeyEnv} onChange={(event) => { setApiKeyEnvTouched(true); setApiKeyEnv(event.target.value); }} />
                </div>
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
            <button type="button" onClick={cancel} className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
              取消
            </button>
            <button type="button" onClick={() => void preview()} className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" />
              预览并添加
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        title="确认添加 Provider"
        message="以下变更将在确认后写入配置，并自动创建备份。"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      />
    </>
  );
}
