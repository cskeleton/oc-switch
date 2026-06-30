import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认 OpenClaw Gateway systemd user unit 路径 */
export function resolveGatewaySystemdUnitPath(): string {
  return join(homedir(), ".config/systemd/user/openclaw-gateway.service");
}

/** best-effort 解析 unit 中的 OPENCLAW_SERVICE_MANAGED_ENV_KEYS */
export function readOpenClawServiceManagedEnvKeys(unitPath?: string): string[] {
  const path = unitPath ?? resolveGatewaySystemdUnitPath();
  if (!existsSync(path)) return [];

  const content = readFileSync(path, "utf8");
  const match = content.match(/OPENCLAW_SERVICE_MANAGED_ENV_KEYS=(["']?)([^\n"']+)\1/);
  if (!match?.[2]) return [];

  return match[2]
    .split(/[\s,]+/)
    .map((key) => key.trim())
    .filter(Boolean);
}
