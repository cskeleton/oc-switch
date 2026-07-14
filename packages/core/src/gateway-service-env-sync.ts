import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { readOpenClawServiceManagedEnvKeys } from "./gateway-systemd-unit";

const START = "# oc-switch:start";
const END = "# oc-switch:end";

export type GatewayServiceEnvTargetKind = "systemd" | "launchd";

export interface GatewayServiceEnvTarget {
  targetKind: GatewayServiceEnvTargetKind;
  targetPath: string;
  /** 关联的 runtime 候选组；由 resolveGatewayRuntimeTarget 填充 */
  candidateId?: string;
}

export interface GatewayServiceEnvSyncResult {
  ok: boolean;
  targetKind?: GatewayServiceEnvTargetKind;
  targetPath: string;
  syncedKeys: string[];
  removedKeys: string[];
  warnings: string[];
  candidateId?: string;
}

export class GatewayServiceEnvTargetError extends Error {
  readonly targetKind?: GatewayServiceEnvTargetKind;
  readonly targetPath: string;

  constructor(message: string, targetKind?: GatewayServiceEnvTargetKind, targetPath = "") {
    super(message);
    this.name = "GatewayServiceEnvTargetError";
    if (targetKind) this.targetKind = targetKind;
    this.targetPath = targetPath;
  }
}

export function isGatewayServiceEnvTargetError(error: unknown): error is GatewayServiceEnvTargetError {
  return error instanceof GatewayServiceEnvTargetError;
}

export function gatewayServiceEnvTargetErrorToSyncResult(error: GatewayServiceEnvTargetError): GatewayServiceEnvSyncResult {
  return {
    ok: false,
    ...(error.targetKind ? { targetKind: error.targetKind } : {}),
    targetPath: error.targetPath,
    syncedKeys: [],
    removedKeys: [],
    warnings: [error.message]
  };
}

/** 从 .env / 服务 env 内容解析 oc-switch 托管块条目 */
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

/** 解析 launchd service-env 文件中的 export 行（不含托管块内条目） */
export function readLaunchdServiceEnv(content: string): Record<string, string> {
  const lines = content.length ? content.split(/\n/) : [];
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const entries: Record<string, string> = {};
  lines.forEach((line, index) => {
    const insideBlock = hasBlock && index > startIndex && index < endIndex;
    if (insideBlock) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match?.[1]) return;
    entries[match[1]] = unquoteEnvValue(match[2] ?? "");
  });
  return entries;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value;
}

function posixEscapeSingleQuoted(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function formatLaunchdExportLine(key: string, value: string): string {
  return `export ${key}='${posixEscapeSingleQuoted(value)}'`;
}

function assertServiceFriendlyValue(key: string, value: string): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`env var ${key} contains multiline value; refusing gateway service env sync`);
  }
  if (value.length === 0) {
    throw new Error(`env var ${key} is empty; refusing gateway service env sync`);
  }
}

function managedSystemdBlockLines(managed: Record<string, string>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(managed)) {
    result.push(`${key}=${value}`);
  }
  return result.length ? [START, ...result, END] : [];
}

function managedLaunchdBlockLines(managed: Record<string, string>): string[] {
  const result: string[] = [];
  for (const [key, value] of Object.entries(managed)) {
    result.push(formatLaunchdExportLine(key, value));
  }
  return result.length ? [START, ...result, END] : [];
}

function mergeServiceEnvContent(
  existingContent: string,
  managed: Record<string, string>,
  targetKind: GatewayServiceEnvTargetKind
): string {
  const lines = existingContent.length ? existingContent.split(/\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const block = targetKind === "launchd" ? managedLaunchdBlockLines(managed) : managedSystemdBlockLines(managed);
  const result = hasBlock
    ? [...lines.slice(0, startIndex), ...block, ...lines.slice(endIndex + 1)]
    : [...lines, ...block];
  if (result.length === 0) return "";
  return `${result.join("\n")}\n`;
}

function collectOutsideKeyConflicts(
  existingContent: string,
  managedKeys: string[],
  targetPath: string
): string[] {
  const lines = existingContent.length ? existingContent.split(/\n/) : [];
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const managedSet = new Set(managedKeys);
  const conflicts = new Set<string>();
  const targetName = basename(targetPath);
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
    .map((key) => `${key} also exists outside oc-switch block in ${targetName}`);
}

function collectManagedKeyWarnings(syncedKeys: string[]): string[] {
  const managedKeys = readOpenClawServiceManagedEnvKeys();
  if (managedKeys.length === 0) return [];
  const managedSet = new Set(managedKeys);
  return syncedKeys
    .filter((key) => !managedSet.has(key))
    .map((key) => `${key} is not listed in OPENCLAW_SERVICE_MANAGED_ENV_KEYS; run openclaw gateway install to refresh the unit`);
}

function assertTargetParentExists(target: GatewayServiceEnvTarget): void {
  const parentDir = dirname(target.targetPath);
  if (!existsSync(parentDir)) {
    throw new GatewayServiceEnvTargetError(
      `Gateway service env parent directory does not exist: ${parentDir}`,
      target.targetKind,
      target.targetPath
    );
  }
}

/** 将托管块 merge 写入已校验的 Gateway 服务环境文件（禁止平台猜测） */
export function syncManagedBlockToGatewayServiceEnv(input: {
  envPath: string;
  target: GatewayServiceEnvTarget;
  removedKeys?: string[];
}): GatewayServiceEnvSyncResult {
  const target = input.target;
  if (!target.targetPath?.trim()) {
    throw new GatewayServiceEnvTargetError(
      "Gateway service env target path is required",
      target.targetKind
    );
  }
  assertTargetParentExists(target);

  const removedKeys = input.removedKeys ?? [];
  const envContent = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";
  const managed = readManagedBlockEntries(envContent);

  for (const [key, value] of Object.entries(managed)) {
    assertServiceFriendlyValue(key, value);
  }

  const existingContent = existsSync(target.targetPath) ? readFileSync(target.targetPath, "utf8") : "";
  const existingManaged = readManagedBlockEntries(existingContent);
  const merged = mergeServiceEnvContent(existingContent, managed, target.targetKind);

  const tmpPath = `${target.targetPath}.tmp`;
  writeFileSync(tmpPath, merged, { mode: 0o600 });
  renameSync(tmpPath, target.targetPath);

  const syncedKeys = Object.keys(managed).filter((key) => !removedKeys.includes(key));
  const removedSet = new Set([
    ...Object.keys(existingManaged).filter((key) => managed[key] === undefined),
    ...removedKeys.filter((key) => existingManaged[key] !== undefined)
  ]);
  return {
    ok: true,
    targetKind: target.targetKind,
    targetPath: target.targetPath,
    syncedKeys,
    removedKeys: Array.from(removedSet).sort(),
    warnings: [
      ...collectOutsideKeyConflicts(existingContent, syncedKeys, target.targetPath),
      ...collectManagedKeyWarnings(syncedKeys)
    ],
    ...(target.candidateId ? { candidateId: target.candidateId } : {})
  };
}
