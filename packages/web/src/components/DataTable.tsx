import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Inbox } from "lucide-react";
import { cn } from "../lib/utils";
import { EmptyState } from "./EmptyState";

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
  /** 是否允许点击表头排序（需配合 sortValue 才有实际排序效果） */
  sortable?: boolean;
  /** 排序取值：数字按数值比较，字符串按 zh localeCompare */
  sortValue?: (row: T) => string | number;
  /** 列对齐；right 会自动加 tabular-nums 供数字列使用 */
  align?: "left" | "right" | "center";
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  emptyMessage?: string;
  /** 命中行永远沉底（如已关闭 Provider），组内再按当前排序列排序 */
  pinnedBottom?: (row: T) => boolean;
  /** 未点击表头时的默认排序 */
  defaultSort?: { key: string; dir?: "asc" | "desc" };
  /** 行级附加 className（如已关闭行 opacity-60） */
  rowClassName?: (row: T) => string | undefined;
}

type SortDir = "asc" | "desc";

const alignClass: Record<NonNullable<Column<unknown>["align"]>, string> = {
  left: "text-left",
  right: "text-right tabular-nums",
  center: "text-center",
};

/** 按列取值比较：数字数值比较，其余按中文字符串比较 */
function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh");
}

/** 响应式数据表格：支持表头点击排序与沉底分组；窄屏保持 40rem 最小宽度并横向滚动，长文本在单元格内换行 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = "暂无数据",
  pinnedBottom,
  defaultSort,
  rowClassName,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);

  // 生效排序：用户选择优先，否则回退 defaultSort
  const activeSort =
    sort ?? (defaultSort ? { key: defaultSort.key, dir: defaultSort.dir ?? "asc" } : null);
  const activeColumn = activeSort ? columns.find((c) => c.key === activeSort.key) : undefined;

  const handleSort = (col: Column<T>) => {
    if (!col.sortable) return;
    setSort((prev) => {
      // 首次点击固定 asc；同列再点 asc/desc 往返
      if (prev?.key !== col.key) return { key: col.key, dir: "asc" };
      return { key: col.key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  // 稳定排序：附带原始下标，比较相等时保持原顺序
  const sortGroup = (group: T[]): T[] => {
    if (!activeColumn?.sortValue || !activeSort) return group;
    const dirFactor = activeSort.dir === "asc" ? 1 : -1;
    return group
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const cmp = compareValues(activeColumn.sortValue!(a.row), activeColumn.sortValue!(b.row));
        return cmp !== 0 ? cmp * dirFactor : a.index - b.index;
      })
      .map((entry) => entry.row);
  };

  let sortedRows: T[];
  if (pinnedBottom) {
    // 沉底分组：普通行与 pin 行各自排序，pin 行永远在后
    const normal = rows.filter((row) => !pinnedBottom(row));
    const pinned = rows.filter((row) => pinnedBottom(row));
    sortedRows = [...sortGroup(normal), ...sortGroup(pinned)];
  } else {
    sortedRows = sortGroup([...rows]);
  }

  if (rows.length === 0) {
    return <EmptyState icon={Inbox} title={emptyMessage} />;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="bg-muted/80 text-left text-muted-foreground">
          <tr>
            {columns.map((col) => {
              const isActive = activeSort?.key === col.key;
              const ariaSort = isActive
                ? activeSort.dir === "asc"
                  ? "ascending"
                  : "descending"
                : undefined;
              return (
                <th
                  key={col.key}
                  aria-sort={ariaSort}
                  className={cn(
                    "px-3 py-2 font-medium",
                    col.align ? alignClass[col.align] : undefined,
                    col.className,
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col)}
                      className={cn(
                        "group inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        col.align === "right" && "flex-row-reverse",
                        isActive && "text-foreground",
                      )}
                    >
                      {col.header}
                      {isActive ? (
                        activeSort.dir === "asc" ? (
                          <ArrowUp className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowDown className="h-3.5 w-3.5" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <tr key={rowKey(row)} className={cn("border-t border-border/80 hover:bg-accent/50 group", rowClassName?.(row))}>
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    "px-3 py-2 align-top break-all",
                    col.align ? alignClass[col.align] : undefined,
                    col.className,
                  )}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
