import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  confirmDisabled?: boolean;
  children?: ReactNode;
}

/** 确认对话框，用于破坏性操作 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
  danger = false,
  confirmDisabled = false,
  children
}: ConfirmDialogProps) {
  const scrollableBody = Boolean(children);

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onCancel(); }}>
      <DialogContent
        className={
          scrollableBody
            ? "flex max-h-[min(90vh,42rem)] max-w-md flex-col gap-0 overflow-hidden p-0"
            : "max-w-md"
        }
      >
        <DialogHeader className={scrollableBody ? "shrink-0 px-6 pt-6" : undefined}>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        {children ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        ) : null}
        <DialogFooter className={scrollableBody ? "shrink-0 border-t border-border px-6 pb-6 pt-4" : undefined}>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 ${
              danger ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground" : "bg-primary hover:bg-primary/90"
            }`}
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
