import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * 全站统一页头：标题 + 可选描述/徽标 + 右侧操作区。
 * 移动端操作区折行到标题下方，右对齐。
 */
export function PageHeader({
  title,
  description,
  badge,
  actions,
  className
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 标题旁的状态徽标（如 Pill） */
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
          {badge}
        </div>
        {description ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
