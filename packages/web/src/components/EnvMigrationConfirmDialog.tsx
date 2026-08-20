import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "./ui/dialog";

interface EnvMigrationConfirmDialogProps {
  open: boolean;
  warnings: string[];
  confirmMigration?: boolean;
  confirmComplex?: boolean;
  title?: string;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}

/** Settings 与 Provider 流程共用的 env 迁移确认弹窗（Radix Dialog） */
export function EnvMigrationConfirmDialog({
  open,
  warnings,
  confirmMigration,
  confirmComplex,
  title = "确认操作",
  onCancel,
  onConfirm,
  children
}: EnvMigrationConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onCancel(); }}>
      <DialogContent className="max-w-md" aria-label={title}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {confirmMigration
              ? "该变量当前不在 oc-switch 托管区。更新后会迁移到托管块；旧值不会显示。"
              : confirmComplex
                ? "该变量存在重复或复杂 .env 语法。迁移会写成标准 KEY=<新值>，可能改变 OpenClaw 解析结果。"
                : "请确认继续此环境变量操作。备份将包含 .env 明文。"}
          </DialogDescription>
        </DialogHeader>
        {warnings.length ? (
          <ul className="list-inside list-disc text-sm font-medium text-warning">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={onConfirm}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
