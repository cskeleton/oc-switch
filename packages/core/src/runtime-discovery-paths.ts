import { isAbsolute, join, normalize } from "node:path";

/** 展开已知 HOME 下的波浪号路径，并拒绝无基准相对路径 */
export function canonicalizeRuntimePath(
  value: string | undefined,
  homeDir: string | undefined
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const expanded = trimmed === "~"
    ? homeDir
    : trimmed.startsWith("~/") && homeDir
      ? join(homeDir, trimmed.slice(2))
      : trimmed;
  if (!expanded || !isAbsolute(expanded)) return undefined;
  return normalize(expanded);
}
