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

/** Settings 与 Provider 流程共用的 env 迁移确认弹窗 */
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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-label={title}>
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <h3 className="text-lg font-semibold leading-none tracking-tight">{title}</h3>
        <p className="mt-4 text-sm text-muted-foreground">
          {confirmMigration
            ? "该变量当前不在 oc-switch 托管区。更新后会迁移到托管块；旧值不会显示。"
            : confirmComplex
              ? "该变量存在重复或复杂 .env 语法。迁移会写成标准 KEY=<新值>，可能改变 OpenClaw 解析结果。"
              : "请确认继续此环境变量操作。备份将包含 .env 明文。"}
        </p>
        {warnings.length ? (
          <ul className="mt-4 list-inside list-disc text-sm font-medium text-amber-500">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {children}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
