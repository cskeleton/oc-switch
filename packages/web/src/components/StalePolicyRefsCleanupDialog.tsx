import { useEffect, useState } from "react";
import { ApiRequestError, isPolicyRevisionConflict, type ApiClient } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DataTable, type Column } from "./DataTable";
import { useToast } from "./Toast";
import { Pill } from "./ui/pill";

/**
 * 悬空策略引用批量清理对话框（stale cleanup spec §6）。
 *
 * - 列表来源：config-status 的 unknownProviderRefs ∪ knownProviderUnknownModelRefs ∩ exact 规则（原始字符串）；
 * - 确认时冻结打开对话框时的 policyRevision 作 expectedRevision，单次批量调用（绝不回退逐条 DELETE）；
 * - 400 守卫失败：解析 details.refs 逐条标红并取消勾选，不自动重试；
 * - 409：保留勾选，提示刷新后重新核对；旧后端（缺 revision / 404 / 响应缺 removedCount）显示「版本不支持」。
 */

/** 一条待清理的悬空 exact 规则；reason 由 config-status 的两类列表区分（两者互斥）。 */
export interface StalePolicyRef {
  value: string;
  reason: "unknown-provider" | "unknown-model";
}

interface StalePolicyRefsCleanupDialogProps {
  open: boolean;
  refs: StalePolicyRef[];
  /** 打开对话框时冻结的 policy revision；旧后端缺字段时显示「版本不支持」 */
  policyRevision: string | undefined;
  client: ApiClient;
  onCancel: () => void;
  /** 清理成功后由调用方刷新 inventory 与 config-status */
  onChanged: () => void;
}

function reasonPill(reason: StalePolicyRef["reason"]) {
  return reason === "unknown-provider"
    ? <Pill variant="warning">Provider 不存在</Pill>
    : <Pill variant="warning">模型不在目录</Pill>;
}

export function StalePolicyRefsCleanupDialog({ open, refs, policyRevision, client, onCancel, onChanged }: StalePolicyRefsCleanupDialogProps) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 服务端拒绝（400 details.refs）的规则：标红并取消勾选，等待用户重新核对 */
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /** 旧后端：缺 policyRevision / 404 / 响应缺 removedCount，均不回退逐条删除 */
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 打开对话框时冻结 revision 与默认全选（背景刷新不替换冻结值） */
  const [frozenRevision, setFrozenRevision] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setSelected(new Set(refs.map((ref) => ref.value)));
      setBlocked(new Set());
      setError(null);
      setUnsupported(false);
      setFrozenRevision(policyRevision);
    }
    // 仅响应打开动作重置；refs/policyRevision 在打开期间的背景变化不重置用户选择
  }, [open]);

  function toggle(value: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function confirm() {
    if (busy || unsupported || selected.size === 0 || !frozenRevision) return;
    const values = [...selected];
    setBusy(true);
    setError(null);
    try {
      const result = await client.batchRemoveModelPolicyRules(values, frozenRevision);
      // 旧后端可能返回 200 但缺 removedCount：按版本不支持处理，不回退逐条删除
      if (typeof result.removedCount !== "number") {
        setUnsupported(true);
        return;
      }
      toast.success(`已清理 ${result.removedCount} 条悬空规则（只改 modelPolicy.allow）`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      if (result.runtimeConfirmed === false) toast.warning("配置已保存，运行时未确认");
      onChanged();
      onCancel();
    } catch (err) {
      if (isPolicyRevisionConflict(err)) {
        // 409：保留勾选，提示刷新后重新核对
        setError("策略已变化，请刷新后重新核对。");
      } else if (err instanceof ApiRequestError && err.status === 404) {
        setUnsupported(true);
      } else if (err instanceof ApiRequestError && err.status === 400 && Array.isArray(err.details?.refs)) {
        // 守卫失败：逐条标红并取消勾选，不自动重试（避免部分提交）
        const rejected = new Set(err.details.refs);
        setBlocked(rejected);
        setSelected((prev) => {
          const next = new Set(prev);
          for (const value of rejected) next.delete(value);
          return next;
        });
        setError(`${err.message}（${rejected.size} 条规则已标红并取消勾选，请重新核对后再试）`);
      } else {
        setError(err instanceof Error ? err.message : "清理悬空引用失败");
      }
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<StalePolicyRef>[] = [
    {
      key: "select",
      header: "",
      wrap: "nowrap",
      className: "w-10",
      render: (row) => (
        <input
          type="checkbox"
          aria-label={`选择悬空引用 ${row.value}`}
          checked={selected.has(row.value)}
          disabled={busy}
          onChange={() => toggle(row.value)}
          className="mt-0.5"
        />
      )
    },
    {
      key: "value",
      header: "规则",
      wrap: "anywhere",
      render: (row) => (
        <span className={blocked.has(row.value) ? "font-medium text-destructive" : "font-medium"}>{row.value}</span>
      )
    },
    {
      key: "reason",
      header: "原因",
      wrap: "nowrap",
      render: (row) => reasonPill(row.reason)
    }
  ];

  return (
    <ConfirmDialog
      open={open}
      title="清理悬空引用"
      message="将批量删除选择策略（modelPolicy.allow）中指向不存在 Provider 或不在目录模型的悬空规则。清理只删除选择策略中的悬空规则，不影响目录、metadata 与密钥；有效但无 metadata 的规则不在列表中。此操作将创建备份。"
      danger
      confirmLabel={`清理所选 (${selected.size})`}
      confirmDisabled={busy || unsupported || selected.size === 0 || !frozenRevision}
      onCancel={onCancel}
      onConfirm={() => void confirm()}
    >
      <p className="mb-3 text-xs text-muted-foreground">
        单事务原子删除：任一规则被保护（主模型/fallback 依赖、删后清空策略等）则整体不生效。
      </p>
      {unsupported || !frozenRevision ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          版本不支持：当前后端缺少批量清理端点，请升级 oc-switch 后刷新。不会回退为逐条删除（避免部分提交）。
        </p>
      ) : (
        <DataTable
          rows={refs}
          rowKey={(row) => row.value}
          minWidthClass="min-w-0"
          columns={columns}
        />
      )}
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    </ConfirmDialog>
  );
}
