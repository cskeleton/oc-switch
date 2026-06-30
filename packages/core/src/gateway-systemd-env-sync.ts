import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readOpenClawServiceManagedEnvKeys } from "./gateway-systemd-unit";

const START = "# oc-switch:start";
const END = "# oc-switch:end";

export interface GatewaySystemdEnvSyncResult {
  ok: boolean;
  syncedKeys: string[];
  removedKeys: string[];
  warnings: string[];
}

/** 从 .env 内容解析 oc-switch 托管块条目 */
export function readManagedBlockEntries(envContent: string): Record<string, string> {
  const lines = envContent.length ? envContent.split(/\n/) : [];
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  if (startIndex < 0 || endIndex <= startIndex) return {};

  const entries: Record<string, string> = {};
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match?.[1]) continue;
    entries[match[1]] = unquoteEnvValue(match[2] ?? "");
  }
  return entries;
}

/** 解析 gateway.systemd.env（简单 KEY=VALUE，忽略 # 注释行） */
export function readGatewaySystemdEnv(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const rawLine of content.split(/\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match?.[1]) continue;
    entries[match[1]] = unquoteEnvValue(match[2] ?? "");
  }
  return entries;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function assertSystemdFriendlyValue(key: string, value: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`env var ${key} contains multiline value; refusing gateway systemd sync`);
  }
  if (value.length === 0) {
    throw new Error(`env var ${key} is empty; refusing gateway systemd sync`);
  }
}

function mergeGatewayEnvContent(
  existingContent: string,
  managed: Record<string, string>
): string {
  const lines = existingContent.length ? existingContent.split(/\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const block = managedBlockLines(managed);
  const result = hasBlock
    ? [...lines.slice(0, startIndex), ...block, ...lines.slice(endIndex + 1)]
    : [...lines, ...block];
  if (result.length === 0) return "";
  return `${result.join("\n")}\n`;
}

function managedBlockLines(managed: Record<string, string>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(managed)) {
    result.push(`${key}=${value}`);
  }
  return result.length ? [START, ...result, END] : [];
}

function collectOutsideKeyConflicts(existingContent: string, managedKeys: string[]): string[] {
  const lines = existingContent.length ? existingContent.split(/\n/) : [];
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const managedSet = new Set(managedKeys);
  const conflicts = new Set<string>();
  lines.forEach((line, index) => {
    const insideBlock = hasBlock && index > startIndex && index < endIndex;
    if (insideBlock) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match?.[1] && managedSet.has(match[1])) conflicts.add(match[1]);
  });
  return Array.from(conflicts)
    .sort()
    .map((key) => `${key} also exists outside oc-switch block in gateway.systemd.env`);
}

function collectManagedKeyWarnings(syncedKeys: string[]): string[] {
  const managedKeys = readOpenClawServiceManagedEnvKeys();
  if (managedKeys.length === 0) return [];
  const managedSet = new Set(managedKeys);
  return syncedKeys
    .filter((key) => !managedSet.has(key))
    .map((key) => `${key} is not listed in OPENCLAW_SERVICE_MANAGED_ENV_KEYS; run openclaw gateway install to refresh the unit`);
}

/** 将托管块 merge 写入 gateway.systemd.env */
export function syncManagedBlockToGatewaySystemdEnv(input: {
  envPath: string;
  gatewaySystemdEnvPath?: string;
  removedKeys?: string[];
}): GatewaySystemdEnvSyncResult {
  const gatewaySystemdEnvPath = input.gatewaySystemdEnvPath ?? join(dirname(input.envPath), "gateway.systemd.env");
  const removedKeys = input.removedKeys ?? [];
  const envContent = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";
  const managed = readManagedBlockEntries(envContent);

  for (const [key, value] of Object.entries(managed)) {
    assertSystemdFriendlyValue(key, value);
  }

  const existingContent = existsSync(gatewaySystemdEnvPath) ? readFileSync(gatewaySystemdEnvPath, "utf8") : "";
  const existingManaged = readManagedBlockEntries(existingContent);
  const merged = mergeGatewayEnvContent(existingContent, managed);

  mkdirSync(dirname(gatewaySystemdEnvPath), { recursive: true });
  const tmpPath = `${gatewaySystemdEnvPath}.tmp`;
  writeFileSync(tmpPath, merged, { mode: 0o600 });
  renameSync(tmpPath, gatewaySystemdEnvPath);

  const syncedKeys = Object.keys(managed).filter((key) => !removedKeys.includes(key));
  const removedSet = new Set([
    ...Object.keys(existingManaged).filter((key) => managed[key] === undefined),
    ...removedKeys.filter((key) => existingManaged[key] !== undefined)
  ]);
  return {
    ok: true,
    syncedKeys,
    removedKeys: Array.from(removedSet).sort(),
    warnings: [
      ...collectOutsideKeyConflicts(existingContent, syncedKeys),
      ...collectManagedKeyWarnings(syncedKeys)
    ]
  };
}
