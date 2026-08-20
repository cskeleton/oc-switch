import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

interface EmptyStateProps {
  /** 可选图标（lucide） */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** 可选操作区（如「添加」按钮） */
  action?: ReactNode;
  className?: string;
}

/** 通用空态：图标 + 标题 + 说明 + 可选操作 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 text-center", className)}>
      {Icon ? <Icon className="mb-3 h-8 w-8 text-muted-foreground/60" /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
