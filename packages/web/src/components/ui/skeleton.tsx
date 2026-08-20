import * as React from "react"
import { cn } from "../../lib/utils"

// 加载骨架：替换「加载中…」纯文本
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />
  )
}

export { Skeleton }
