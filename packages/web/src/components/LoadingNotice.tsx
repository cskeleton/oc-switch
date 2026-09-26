import { Loader2 } from "lucide-react";
import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";

/**
 * 列表首轮加载提示：旋转指示 + 文案 + 骨架占位。
 * role="status" 让辅助技术朗读文案；骨架不参与朗读（aria-hidden）。
 * 固定容器减少加载完成后的内容跳变。
 */
export function LoadingNotice({
  title,
  description,
  className
}: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("rounded-xl border border-dashed border-border bg-card/50 px-6 py-12", className)}
    >
      <div className="mx-auto flex max-w-xs flex-col items-center gap-3 text-center">
        <Loader2 aria-hidden className="h-6 w-6 animate-spin text-brand" />
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        <div aria-hidden className="mt-2 flex w-full flex-col gap-2">
          <Skeleton className="h-3 w-2/3 self-center" />
          <Skeleton className="h-3 w-1/2 self-center" />
        </div>
      </div>
    </div>
  );
}
