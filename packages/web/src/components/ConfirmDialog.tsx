import type { ReactNode } from "react";
import { Button } from "./ui/button";
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
          <Button variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "destructive" : "primary"}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
