import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./command-context";

/** 解析 Web 静态根：OC_SWITCH_WEB_DIST 优先，否则 packages/web/dist */
export function resolveWebDistDir(): string {
  const override = process.env.OC_SWITCH_WEB_DIST?.trim();
  if (override) return override;
  return join(repoRoot, "packages/web/dist");
}

/** dist 存在且含 index.html */
export function webDistReady(dir: string = resolveWebDistDir()): boolean {
  return existsSync(join(dir, "index.html"));
}
