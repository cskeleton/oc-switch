import { useEffect, useState } from "react";
import type { ApiType, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

interface ModelDialogProps {
  open: boolean;
  mode: "create" | "edit";
  providers: ProviderSummary[];
  fixedProviderId?: string | undefined;
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

  const selectClassName = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onCancel(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "添加模型" : "编辑模型"}</DialogTitle>
          <DialogDescription>
            {mode === "create" ? "在下方填入要添加的模型详情。" : "修改模型配置。"}
          </DialogDescription>
        </DialogHeader>

        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

        <div className="grid gap-4 py-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label>Provider</Label>
            <select
              aria-label="Provider"
              value={fixedProviderId ?? providerId}
              disabled={Boolean(fixedProviderId) || mode === "edit"}
              onChange={(event) => setProviderId(event.target.value)}
              className={selectClassName}
            >
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.id}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label>Model ID</Label>
            <Input aria-label="Model ID" value={modelId} onChange={(event) => setModelId(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Name</Label>
            <Input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. GPT-4o" />
          </div>
          <div className="grid gap-2">
            <Label>Alias</Label>
            <Input aria-label="Alias" value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="e.g. gpt-4o" />
          </div>
          <div className="grid gap-2">
            <Label>API</Label>
            <select aria-label="API" value={api} onChange={(event) => setApi(event.target.value)} className={selectClassName}>
              <option value="">继承 Provider</option>
              {API_OPTIONS.map((entry) => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-2">
            <Label>Reasoning</Label>
            <select aria-label="Reasoning" value={reasoning} onChange={(event) => setReasoning(event.target.value)} className={selectClassName}>
              <option value="">继承 Provider</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </div>
          <div className="grid gap-2">
            <Label>Context Window</Label>
            <Input aria-label="Context Window" inputMode="numeric" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="e.g. 128000" />
          </div>
          <div className="grid gap-2">
            <Label>Max Tokens</Label>
            <Input aria-label="Max Tokens" inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder="e.g. 4096" />
          </div>
          <div className="grid gap-2 md:col-span-2">
            <Label>Input Modes (每行一个)</Label>
            <Textarea aria-label="Input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="text\nimage\nvideo" />
          </div>
          <div className="flex items-center space-x-2 md:col-span-2 mt-2">
            <input
              id="model-enabled"
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              aria-label="Enabled"
            />
            <Label htmlFor="model-enabled" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
              已启用
            </Label>
          </div>
        </div>

        <DialogFooter>
          <button type="button" onClick={onCancel} className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
            取消
          </button>
          <button type="button" disabled={saving} onClick={() => void submit()} className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            保存模型
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
