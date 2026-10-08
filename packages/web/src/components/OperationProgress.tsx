import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";

export type OperationPhase = "idle" | "saving" | "loading-plugin" | "checking-runtime" | "success" | "partial" | "error";

const messages: Record<Exclude<OperationPhase, "idle">, string> = {
  saving: "正在保存本地配置…",
  "loading-plugin": "正在读取插件目录…",
  "checking-runtime": "正在检查 OpenClaw / Gateway…",
  success: "运行时检查已完成",
  partial: "配置已保存，在线状态待确认",
  error: "运行时未确认"
};

/** 只报告真实阶段；后台检查失败不覆盖已保存的本地状态。 */
export function OperationProgress({ phase, message, className }: { phase: OperationPhase; message?: string | undefined; className?: string | undefined }) {
  if (phase === "idle") return null;
  const working = phase === "saving" || phase === "loading-plugin" || phase === "checking-runtime";
  return (
    <div data-testid="operation-progress" role="status" aria-live="polite" aria-busy={working} className={cn("flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm", phase === "partial" || phase === "error" ? "text-warning" : "text-muted-foreground", className)}>
      {working ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
      <span className="break-words">{message ?? messages[phase]}</span>
    </div>
  );
}
