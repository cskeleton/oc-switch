import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "../../lib/utils"

// 状态徽章：10% 透明度底色 + 实色文字，双主题自适应
const pillVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        success: "bg-success/10 text-success",
        muted: "bg-muted text-muted-foreground",
        warning: "bg-warning/10 text-warning",
        destructive: "bg-destructive/10 text-destructive",
        brand: "bg-brand/10 text-brand",
      },
    },
    defaultVariants: {
      variant: "muted",
    },
  }
)

export interface PillProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {}

function Pill({ className, variant, ...props }: PillProps) {
  return (
    <span className={cn(pillVariants({ variant }), className)} {...props} />
  )
}

export { Pill, pillVariants }
