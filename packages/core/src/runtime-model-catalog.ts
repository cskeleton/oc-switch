import { spawnSync } from "node:child_process";
import { parseModelRef } from "./model-ref";
import { runCatalogCommand } from "./catalog-command";
import { resolve } from "node:path";

/**
 * OpenClaw 运行时模型探测（只读、脱敏）。
 *
 * 通过固定白名单命令（`openclaw --version` / `models status --json` /
 * `models list --json` / `models list --all --json`）抓取 OpenClaw 运行时
 * 的模型事实（默认模型、fallback、expanded allowed、目录条目）。
 *
 * `models status --json` 的原始输出包含 auth 详情（可能有密钥值），本模块
 * 只按白名单字段提取必要信息，未知字段（尤其 auth）一律丢弃，绝不透传、
 * 缓存或写进 diagnostics。任何命令失败都降级为部分 snapshot +
 * diagnostics，绝不抛错；diagnostics 只记录命令名与数值退出码，不含 stdout/stderr 原文。
 */

export interface RuntimeModelEntry {
  ref: string;
  name?: string;
  available?: boolean;
  missing?: boolean;
  tags: string[];
}

export interface RuntimeProbeCompleteness {
  status: boolean;
  configuredList: boolean;
  allList: boolean;
}

export interface RuntimeModelDiagnostic {
  command: "version" | "status" | "list" | "list-all" | "plugins" | "picker";
  code: "missing" | "timeout" | "non-zero-exit" | "invalid-json" | "invalid-shape";
  message: string;
}

export interface RuntimeModelCommandResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface RuntimeModelCatalogDependencies {
  configPath?: string;
  runCommand?: (
    command: string,
    args: string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ) => RuntimeModelCommandResult;
  now?: () => Date;
}

export interface RuntimeModelSnapshot {
  /** Gateway 默认选择器；缺失时只能推算，不能声称与在线 IM 一致。 */
  pickerModels?: RuntimeModelEntry[];
  pickerSource?: "gateway" | "inferred";
  openClawVersion?: string;
  agentDir?: string;
  defaultModel?: string;
  fallbackRefs: string[];
  allowedRefs: string[];
  configuredModels: RuntimeModelEntry[];
  allModels: RuntimeModelEntry[];
  completeness: RuntimeProbeCompleteness;
  diagnostics: RuntimeModelDiagnostic[];
  capturedAt: string;
}

/** 单命令防护参数：8 秒超时、1 MiB 输出上限（与插件发现保持一致）。 */
const PROBE_OPTIONS = { timeoutMs: 8_000, maxOutputBytes: 1_048_576 };

/** 白名单命令与 diagnostic 命令名的固定映射，runner 只执行这里列出的命令。 */
const PROBE_COMMANDS = {
  version: { command: "openclaw", args: ["--version"] },
  status: { command: "openclaw", args: ["models", "status", "--json"] },
  list: { command: "openclaw", args: ["models", "list", "--json"] },
  "list-all": { command: "openclaw", args: ["models", "list", "--all", "--json"] }
} as const satisfies Record<string, { command: string; args: string[] }>;

type ProbeCommandName = keyof typeof PROBE_COMMANDS;

export interface AsyncRuntimeModelCatalogDependencies extends Omit<RuntimeModelCatalogDependencies, "runCommand"> {
  runCommand?: (command: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number }) => Promise<RuntimeModelCommandResult>;
  /** 隔离 fixture 或非运行中配置可以跳过 Gateway 连接。 */
  useGateway?: boolean;
}

/** 独立 CLI 探测并行；随后复用同步纯解析器，避免两个解析口径。 */
export async function discoverRuntimeModelCatalogAsync(deps: AsyncRuntimeModelCatalogDependencies = {}): Promise<RuntimeModelSnapshot> {
  const runner = deps.runCommand ?? ((command, args, options) => runCatalogCommand(command, args, options, deps.configPath));
  const safeRun = async (args: string[]): Promise<RuntimeModelCommandResult> => {
    try { return await runner("openclaw", args, PROBE_OPTIONS); }
    catch { return { status: -1, stdout: "", timedOut: false }; }
  };
  const commands = Object.values(PROBE_COMMANDS);
  const pickerPromise = deps.useGateway === false ? undefined : safeRun(["gateway", "call", "models.list", "--params", '{"view":"default"}', "--json"]);
  // config.get 原始内容可能带认证信息；只比较路径/版本，不缓存或返回内容。
  const scopePromise = pickerPromise && deps.configPath ? safeRun(["gateway", "call", "config.get", "--json"]) : undefined;
  const results = await Promise.all(commands.map(probe => safeRun([...probe.args])));
  const snapshot = discoverRuntimeModelCatalog({
    ...(deps.now ? { now: deps.now } : {}),
    runCommand: (_command, args) => results[commands.findIndex(probe => probe.args.join(" ") === args.join(" "))]!
  });
  snapshot.pickerSource = "inferred";
  if (!pickerPromise) return snapshot;
  const picker = await pickerPromise;
  let scopeMatches = !scopePromise;
  if (scopePromise) {
    const scope = await scopePromise;
    try {
      const data = JSON.parse(scope.stdout);
      scopeMatches = scope.status === 0 && !scope.timedOut && typeof data.path === "string" && resolve(data.path) === resolve(deps.configPath!) &&
        data.valid !== false && !(typeof data.configRevisionHash === "string" && typeof data.appliedConfigHash === "string" && data.configRevisionHash !== data.appliedConfigHash);
    } catch { scopeMatches = false; }
  }
  if (scopeMatches && picker.status === 0 && !picker.timedOut) {
    try {
      const raw = JSON.parse(picker.stdout);
      const rows = Array.isArray(raw.models) ? raw.models.map((row: Record<string, unknown>) => ({
        key: typeof row.provider === "string" && typeof row.id === "string" ? `${row.provider}/${row.id}` : undefined,
        name: row.name, available: row.available, missing: row.missing, tags: row.tags
      })) : undefined;
      if (rows && rows.every(validModelRow)) {
        snapshot.pickerModels = parseModelEntries(rows);
        snapshot.pickerSource = "gateway";
        return snapshot;
      }
    } catch { /* 只返回脱敏诊断。 */ }
  }
  snapshot.diagnostics.push({ command: "picker", code: picker.timedOut ? "timeout" : picker.status === 0 ? "invalid-shape" : "non-zero-exit", message: "Gateway model picker unavailable; visibility is inferred from local config" });
  return snapshot;
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number },
  configPath?: string
): RuntimeModelCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    ...(configPath ? { env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath } } : {})
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    timedOut: result.status === null && (result.signal === "SIGTERM" || errorCode === "ETIMEDOUT")
  };
}

/** 过滤出字符串数组（丢弃非字符串项；非数组返回空）。 */
function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** 字符串 ref 数组：只接受字符串、去重保序（null/undefined 视为缺失形状）。 */
function parseStringRefArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isValidRef))];
}

function isValidRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { parseModelRef(value); return true; } catch { return false; }
}

function validModelRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return isValidRef(raw.key) &&
    // OpenClaw 的 --all 对尚未探测的模型显式返回 null：该行是 unknown，不是整份目录损坏。
    (raw.available === undefined || raw.available === null || typeof raw.available === "boolean") &&
    (raw.missing === undefined || typeof raw.missing === "boolean");
}

/** 白名单提取模型目录条目：非对象、非字符串 key 一律跳过；tags 非数组/非字符串项过滤；未知字段不复制。 */
function parseModelEntries(value: unknown): RuntimeModelEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: RuntimeModelEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!validModelRow(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.key !== "string" || !raw.key) continue;
    if (seen.has(raw.key)) continue;
    seen.add(raw.key);
    const entry: RuntimeModelEntry = { ref: raw.key, tags: asStringArray(raw.tags) };
    if (typeof raw.name === "string") entry.name = raw.name;
    if (typeof raw.available === "boolean") entry.available = raw.available;
    if (typeof raw.missing === "boolean") entry.missing = raw.missing;
    entries.push(entry);
  }
  return entries;
}

/** 判定命令结果是否为「命令缺失」（spawn ENOENT：status null 且非超时）。 */
function isMissing(result: RuntimeModelCommandResult): boolean {
  return result.status === null && !result.timedOut;
}

/** 归一 diagnostic 消息：只含命令与数值退出码，绝不携带 stdout/stderr 原文。 */
function messageFor(commandName: ProbeCommandName, code: RuntimeModelDiagnostic["code"], exitStatus: number | null): string {
  const label = `openclaw ${PROBE_COMMANDS[commandName].args.join(" ")}`;
  switch (code) {
    case "missing":
      return `${label}: command not found`;
    case "timeout":
      return `${label}: timed out after ${PROBE_OPTIONS.timeoutMs}ms`;
    case "non-zero-exit":
      return `${label}: exited with status ${exitStatus}`;
    default:
      return `${label}: ${code}`;
  }
}

/**
 * 探测 OpenClaw 运行时模型事实；任何失败降级为部分 snapshot + diagnostics，不抛错。
 *
 * 逐条命令独立探测：任一失败只影响对应的 completeness 位与该来源字段，
 * 其余成功来源照常保留（spec §5.2「任一命令失败时保留其余成功来源」）。
 */
export function discoverRuntimeModelCatalog(deps: RuntimeModelCatalogDependencies = {}): RuntimeModelSnapshot {
  const runner = deps.runCommand ?? ((command, args, options) => defaultRunCommand(command, args, options, deps.configPath));
  const runCommand: NonNullable<RuntimeModelCatalogDependencies["runCommand"]> = (command, args, options) => {
    try { return runner(command, args, options); }
    catch { return { status: -1, stdout: "", timedOut: false }; }
  };
  const now = deps.now ?? (() => new Date());

  const diagnostics: RuntimeModelDiagnostic[] = [];
  const snapshot: RuntimeModelSnapshot = {
    fallbackRefs: [],
    allowedRefs: [],
    configuredModels: [],
    allModels: [],
    completeness: { status: false, configuredList: false, allList: false },
    diagnostics,
    capturedAt: now().toISOString()
  };

  // 命令失败（missing/timeout/non-zero-exit）的通用处理：记 diagnostic、对应 completeness 保持 false。
  const recordFailure = (commandName: ProbeCommandName, result: RuntimeModelCommandResult): void => {
    const code: RuntimeModelDiagnostic["code"] = isMissing(result)
      ? "missing"
      : result.timedOut
        ? "timeout"
        : "non-zero-exit";
    diagnostics.push({ command: commandName, code, message: messageFor(commandName, code, result.status) });
  };

  // openclaw --version：纯文本版本串，失败不影响模型事实。
  const versionResult = runCommand(PROBE_COMMANDS.version.command, PROBE_COMMANDS.version.args, PROBE_OPTIONS);
  if (versionResult.status === 0 && !versionResult.timedOut && versionResult.stdout.trim().length > 0) {
    snapshot.openClawVersion = versionResult.stdout.trim();
  } else {
    if (versionResult.status === 0 && !versionResult.timedOut) {
      diagnostics.push({ command: "version", code: "invalid-shape", message: messageFor("version", "invalid-shape", 0) });
    } else recordFailure("version", versionResult);
  }

  // openclaw models status --json：默认模型、fallback、expanded allowed。
  // 注意：原始 JSON 含 auth（可能有密钥），这里只按字段白名单提取，其余整体丢弃。
  const statusResult = runCommand(PROBE_COMMANDS.status.command, PROBE_COMMANDS.status.args, PROBE_OPTIONS);
  if (statusResult.status !== 0 || statusResult.timedOut) {
    recordFailure("status", statusResult);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(statusResult.stdout);
    } catch {
      diagnostics.push({ command: "status", code: "invalid-json", message: messageFor("status", "invalid-json", 0) });
    }
    if (parsed !== undefined) {
      if (typeof parsed !== "object" || parsed === null) {
        diagnostics.push({ command: "status", code: "invalid-shape", message: messageFor("status", "invalid-shape", 0) });
      } else {
        const raw = parsed as Record<string, unknown>;
        const allowedRefs = parseStringRefArray(raw.allowed);
        if (allowedRefs === undefined) {
          // `allowed` 必需字段缺失/形状错误：其余字段仍可保留，但 completeness.status 不置 true
          diagnostics.push({ command: "status", code: "invalid-shape", message: messageFor("status", "invalid-shape", 0) });
        } else {
          snapshot.allowedRefs = allowedRefs;
          snapshot.completeness.status = (raw.allowed as unknown[]).every(isValidRef);
          if (!snapshot.completeness.status) diagnostics.push({ command: "status", code: "invalid-shape", message: messageFor("status", "invalid-shape", 0) });
        }
        if (typeof raw.agentDir === "string") snapshot.agentDir = raw.agentDir;
        if (typeof raw.defaultModel === "string") snapshot.defaultModel = raw.defaultModel;
        // fallbacks 允许缺失（未配置回退链时合法）；非数组形状按缺失处理
        snapshot.fallbackRefs = parseStringRefArray(raw.fallbacks) ?? [];
      }
    }
  }

  // openclaw models list --json：当前配置/可见目录。
  const listResult = runCommand(PROBE_COMMANDS.list.command, PROBE_COMMANDS.list.args, PROBE_OPTIONS);
  if (listResult.status !== 0 || listResult.timedOut) {
    recordFailure("list", listResult);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(listResult.stdout);
    } catch {
      parsed = undefined;
      diagnostics.push({ command: "list", code: "invalid-json", message: messageFor("list", "invalid-json", 0) });
    }
    if (parsed !== undefined) {
      const models = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).models : undefined;
      if (!Array.isArray(models)) {
        diagnostics.push({ command: "list", code: "invalid-shape", message: messageFor("list", "invalid-shape", 0) });
      } else {
        snapshot.configuredModels = parseModelEntries(models);
        snapshot.completeness.configuredList = models.every(validModelRow);
        if (!snapshot.completeness.configuredList) diagnostics.push({ command: "list", code: "invalid-shape", message: messageFor("list", "invalid-shape", 0) });
      }
    }
  }

  // openclaw models list --all --json：完整可发现目录。
  const listAllResult = runCommand(PROBE_COMMANDS["list-all"].command, PROBE_COMMANDS["list-all"].args, PROBE_OPTIONS);
  if (listAllResult.status !== 0 || listAllResult.timedOut) {
    recordFailure("list-all", listAllResult);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(listAllResult.stdout);
    } catch {
      parsed = undefined;
      diagnostics.push({ command: "list-all", code: "invalid-json", message: messageFor("list-all", "invalid-json", 0) });
    }
    if (parsed !== undefined) {
      const models = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).models : undefined;
      if (!Array.isArray(models)) {
        diagnostics.push({ command: "list-all", code: "invalid-shape", message: messageFor("list-all", "invalid-shape", 0) });
      } else {
        snapshot.allModels = parseModelEntries(models);
        snapshot.completeness.allList = models.every(validModelRow);
        if (!snapshot.completeness.allList) diagnostics.push({ command: "list-all", code: "invalid-shape", message: messageFor("list-all", "invalid-shape", 0) });
      }
    }
  }

  return snapshot;
}
