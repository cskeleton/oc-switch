import { useEffect, useRef, useState } from "react";
import type {
  ApiType,
  ModelMetadataSourceStatus,
  ModelMetadataSuggestion,
  ModelMetadataSuggestionsResponse,
  ModelSummary,
  ProviderModelInput,
  ProviderSummary
} from "../api";
import { ModelMetadataSuggestionCard } from "./ModelMetadataSuggestionCard";
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
  /** 查询 Models.dev 参考参数建议（只读；由入口注入同一个 client method） */
  onLookupMetadata: (
    providerId: string,
    modelId: string,
    options?: { refresh?: boolean }
  ) => Promise<ModelMetadataSuggestionsResponse>;
}

const API_OPTIONS: Array<{ value: ApiType; label: string }> = [
  { value: "openai-completions", label: "openai-completions" },
  { value: "anthropic-messages", label: "anthropic-messages" },
  { value: "google-generative-ai", label: "google-generative-ai" }
];

const K = 1024;

/** 快捷值只作为输入便利，点击后输入框显示完整整数（例如 1M → 1048576） */
const CONTEXT_WINDOW_QUICK_VALUES = [
  { label: "32K", value: 32 * K },
  { label: "64K", value: 64 * K },
  { label: "128K", value: 128 * K },
  { label: "200K", value: 200 * K },
  { label: "256K", value: 256 * K },
  { label: "1M", value: 1024 * K }
];
const CONTEXT_TOKENS_QUICK_VALUES = CONTEXT_WINDOW_QUICK_VALUES.filter((entry) => entry.label !== "1M");
const MAX_TOKENS_QUICK_VALUES = [
  { label: "4K", value: 4 * K },
  { label: "8K", value: 8 * K },
  { label: "16K", value: 16 * K },
  { label: "32K", value: 32 * K },
  { label: "64K", value: 64 * K },
  { label: "128K", value: 128 * K }
];

type LookupStatus = "idle" | "loading" | "matched" | "multiple" | "not-found" | "stale" | "error";

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

function QuickValues({
  values,
  ariaPrefix,
  onPick
}: {
  values: Array<{ label: string; value: number }>;
  ariaPrefix: string;
  onPick: (value: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((entry) => (
        <button
          key={entry.label}
          type="button"
          aria-label={`${ariaPrefix}快捷值 ${entry.label}`}
          onClick={() => onPick(entry.value)}
          className="rounded border border-input bg-background px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

export function ModelDialog({
  open,
  mode,
  providers,
  fixedProviderId,
  model,
  onCancel,
  onSave,
  onLookupMetadata
}: ModelDialogProps) {
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [api, setApi] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [contextTokens, setContextTokens] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [lookupStatus, setLookupStatus] = useState<LookupStatus>("idle");
  const [lookupSuggestions, setLookupSuggestions] = useState<ModelMetadataSuggestion[]>([]);
  const [lookupSources, setLookupSources] = useState<ModelMetadataSourceStatus[]>([]);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const lookupRequestIdRef = useRef(0);

  function resetLookupState() {
    setLookupStatus("idle");
    setLookupSuggestions([]);
    setLookupSources([]);
    setLookupMessage(null);
  }
  // 当前表单身份（Provider/Model ID），用于响应返回时核对是否过期
  const currentIdentityRef = useRef({ providerId: "", modelId: "" });
  currentIdentityRef.current = { providerId: fixedProviderId ?? providerId, modelId: modelId.trim() };

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
    setContextTokens(model?.contextTokens ? String(model.contextTokens) : "");
    setMaxTokens(model?.maxTokens ? String(model.maxTokens) : "");
    setInput(model?.input?.join("\n") ?? "");
    setError(null);
    // 重新打开时不残留上次候选、提示或加载状态
    resetLookupState();
    lookupRequestIdRef.current += 1;
  }, [fixedProviderId, model, open, providers]);

  const selectedProviderId = fixedProviderId ?? providerId;
  const lookupReady = Boolean(selectedProviderId) && Boolean(modelId.trim());
  const lookupLoading = lookupStatus === "loading";

  async function lookupMetadata() {
    if (!lookupReady || lookupLoading) return;
    const requestProviderId = selectedProviderId;
    const requestModelId = modelId.trim();
    const requestId = ++lookupRequestIdRef.current;
    resetLookupState();
    setLookupStatus("loading");
    try {
      const response = await onLookupMetadata(requestProviderId, requestModelId);
      // 过期响应丢弃：请求返回时 Provider/Model ID 必须与发起时一致
      if (requestId !== lookupRequestIdRef.current) return;
      const current = currentIdentityRef.current;
      if (current.providerId !== requestProviderId || current.modelId !== requestModelId) {
        // 请求已过期（用户在查询期间改了输入）：恢复可编辑状态，避免永久卡在 loading
        resetLookupState();
        return;
      }

      const hasStaleSource = response.sources.some((source) => source.stale);
      setLookupSuggestions(response.suggestions);
      setLookupSources(response.sources);
      if (response.suggestions.length === 0) {
        if (hasStaleSource) {
          setLookupStatus("stale");
          setLookupMessage("目录刷新失败，缓存数据中未找到匹配的参考模型；可以继续手动填写或留空。");
        } else if (response.sources.length === 0) {
          // 两个目录源都不可用（且无缓存）：这是目录故障，不是“未找到模型”
          setLookupStatus("error");
          setLookupMessage(`模型目录加载失败：${response.warnings[0] ?? "目录不可用"}`);
        } else {
          setLookupStatus("not-found");
          setLookupMessage("未找到匹配的参考模型。可以继续手动填写，也可以留空。");
        }
      } else {
        // 有建议时不做全局 stale 标注：逐源 stale 状态由建议卡按候选来源单独展示
        setLookupStatus(response.suggestions.length === 1 ? "matched" : "multiple");
        setLookupMessage(
          response.suggestions.length === 1
            ? "已找到参考模型；需要时点击下方按钮应用，不会自动修改输入。"
            : `找到 ${response.suggestions.length} 个候选参考模型，请先选择再应用。`
        );
      }
    } catch (err) {
      if (requestId !== lookupRequestIdRef.current) return;
      const current = currentIdentityRef.current;
      if (current.providerId !== requestProviderId || current.modelId !== requestModelId) {
        // 过期请求的错误与当前输入无关：恢复可编辑状态
        resetLookupState();
        return;
      }
      setLookupStatus("error");
      setLookupSuggestions([]);
      setLookupMessage(`查询参考参数失败：${err instanceof Error ? err.message : "未知错误"}`);
    }
  }

  async function submit() {
    setError(null);
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
    let parsedContextTokens: number | undefined;
    let parsedMaxTokens: number | undefined;
    try {
      parsedContextWindow = optionalPositiveInteger(contextWindow, "原生上下文窗口");
      parsedContextTokens = optionalPositiveInteger(contextTokens, "运行上下文预算");
      parsedMaxTokens = optionalPositiveInteger(maxTokens, "最大输出长度");
    } catch (err) {
      setError(err instanceof Error ? err.message : "数字字段格式不正确");
      return;
    }
    if (
      parsedContextTokens !== undefined &&
      parsedContextWindow !== undefined &&
      parsedContextTokens > parsedContextWindow
    ) {
      setError("运行上下文预算不能大于原生上下文窗口：预算是运行时上限，原生窗口是模型能力元数据");
      return;
    }
    if (parsedContextWindow !== undefined) next.contextWindow = parsedContextWindow;
    if (parsedContextTokens !== undefined) next.contextTokens = parsedContextTokens;
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
  const helpClassName = "text-xs text-muted-foreground";

  function parsedNumberOrUndefined(value: string): number | undefined {
    const parsed = Number(value.trim());
    return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
  }

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

          <div className="md:col-span-2 grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                可从 Models.dev 查询参考参数；查询不会发送 Provider、Model ID 或密钥。
              </span>
              <button
                type="button"
                aria-label="查询参考参数"
                disabled={!lookupReady || lookupLoading}
                onClick={() => void lookupMetadata()}
                className="shrink-0 rounded border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                {lookupLoading ? "查询中…" : "查询参考参数"}
              </button>
            </div>

            {lookupStatus !== "idle" && lookupMessage ? (
              <p
                role={lookupStatus === "error" ? "alert" : "status"}
                className={
                  lookupStatus === "error"
                    ? "text-sm font-medium text-destructive"
                    : lookupStatus === "stale"
                      ? "text-sm font-medium text-amber-600 dark:text-amber-400"
                      : "text-sm text-muted-foreground"
                }
              >
                {lookupMessage}
              </p>
            ) : null}

            {lookupSuggestions.length > 0 ? (
              <ModelMetadataSuggestionCard
                suggestions={lookupSuggestions}
                sources={lookupSources}
                {...(parsedNumberOrUndefined(contextWindow) !== undefined
                  ? { currentContextWindow: parsedNumberOrUndefined(contextWindow) }
                  : {})}
                {...(parsedNumberOrUndefined(maxTokens) !== undefined
                  ? { currentMaxTokens: parsedNumberOrUndefined(maxTokens) }
                  : {})}
                onApplyContextWindow={(value) => setContextWindow(String(value))}
                onApplyMaxTokens={(value) => setMaxTokens(String(value))}
              />
            ) : null}
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
            <Label>原生上下文窗口（可选）</Label>
            <Input
              aria-label="原生上下文窗口"
              aria-describedby="help-context-window"
              inputMode="numeric"
              value={contextWindow}
              onChange={(event) => setContextWindow(event.target.value)}
              placeholder="e.g. 128000"
            />
            <QuickValues values={CONTEXT_WINDOW_QUICK_VALUES} ariaPrefix="原生上下文" onPick={(value) => setContextWindow(String(value))} />
            <p id="help-context-window" className={helpClassName}>
              模型原生支持的最大上下文，仅作元数据记录；不确定可以留空。
            </p>
          </div>
          <div className="grid gap-2">
            <Label>运行上下文预算（可选）</Label>
            <Input
              aria-label="运行上下文预算"
              aria-describedby="help-context-tokens"
              inputMode="numeric"
              value={contextTokens}
              onChange={(event) => setContextTokens(event.target.value)}
              placeholder="e.g. 128000"
            />
            <QuickValues values={CONTEXT_TOKENS_QUICK_VALUES} ariaPrefix="运行预算" onPick={(value) => setContextTokens(String(value))} />
            <p id="help-context-tokens" className={helpClassName}>
              实际运行时允许占用的上下文预算；不会从建议值自动推导，也不能大于原生上下文窗口。不确定可以留空。
            </p>
          </div>
          <div className="grid gap-2 md:col-span-2">
            <Label>最大输出长度（可选）</Label>
            <Input
              aria-label="最大输出长度"
              aria-describedby="help-max-tokens"
              inputMode="numeric"
              value={maxTokens}
              onChange={(event) => setMaxTokens(event.target.value)}
              placeholder="e.g. 4096"
            />
            <QuickValues values={MAX_TOKENS_QUICK_VALUES} ariaPrefix="最大输出" onPick={(value) => setMaxTokens(String(value))} />
            <p id="help-max-tokens" className={helpClassName}>
              单次回复的最大输出 token 数；不确定可以留空。
            </p>
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
