#!/usr/bin/env bun
/**
 * 真实配置写 E2E（第一阶段）—— opt-in 手动脚本。
 *
 * 设计规格：docs/superpowers/specs/2026-09-19-oc-switch-real-config-e2e-design.md
 *
 * 在真实 OpenClaw 配置上做最小写入面验证（只写 openclaw.json，不碰 .env / 密钥 /
 * Gateway 进程），三场景：主模型切换往返、policy 冗余规则往返、Provider 停用/恢复往返。
 * 还原协议：写前 readFileSync 存原始字节 + createBackup 安全网，finally 无条件字节写回，
 * 四重断言（openclaw.json 字节一致 / 语义指纹等价 / .env 字节不变 / provider-states 字节不变）。
 * 绝不使用 restoreBackupSafely（JSON 归一丢注释且恢复 .env 会外溢 gateway sync）。
 *
 * 三重安全门（缺一拒跑，退出码 3）：
 *   1. 环境变量 OC_SWITCH_REAL_CONFIG_E2E=1
 *   2. 显式 --config <path>：文件存在、位于 $HOME 下、不匹配 fixture 模式（oc-switch-e2e-*）且不在系统临时目录
 *   3. TTY 交互确认（非 TTY 拒跑）
 * 退出码：场景失败 1、还原失败 2、门禁拒绝 3。
 *
 * 不进 package.json 默认脚本链；首次真实执行须用户在场授权。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import JSON5 from "json5";
import { createBackup } from "../packages/core/src/backup-manager";
import type { PluginCatalogResult } from "../packages/core/src/plugin-catalog";
import { getActivePaths } from "../packages/core/src/paths";
import { discoverOpenClawRuntime } from "../packages/core/src/path-discovery";
import type { RuntimeDiscoveryProvider } from "../packages/core/src/runtime-discovery-types";
import { discoverPluginCatalogAsync } from "../packages/core/src/plugin-catalog";
import {
  findExactEntryInAllowList,
  findWildcardEntryInAllowList,
  getModelPolicyMode,
  readModelPolicyAllow,
  readModelPolicyAllowRaw
} from "../packages/core/src/model-policy";
import { normalizeModelRefForStorage, normalizeProviderId, parseModelRef } from "../packages/core/src/model-ref";
import { readFallbackModelRefs, readPrimaryModelRef } from "../packages/core/src/primary-model";
import { getDisabledProviderState } from "../packages/core/src/provider-states";
import type { OpenClawConfig } from "../packages/core/src/types";

export const EXIT_OK = 0;
export const EXIT_SCENARIO_FAILURE = 1;
export const EXIT_RESTORE_FAILURE = 2;
export const EXIT_GATE_REFUSAL = 3;

/** 备份 reason（spec §4） */
const BACKUP_REASON = "e2e-real-config";
/** 确认词（TTY 交互确认） */
const CONFIRM_WORD = "yes";
/** CLI 子进程单命令超时 */
const CLI_TIMEOUT_MS = 60_000;
/** 运行中 serve 常驻实例探测地址（仅提示不阻断） */
const SERVE_PROBE_URL = "http://127.0.0.1:7420/api/meta";

/** 密钥形态扫描（复用 acceptance-smoke 的 assertNoSecrets 模式） */
const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{8,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/i,
  /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

/** 返回命中的密钥模式描述；无命中返回空数组 */
export function findSecretViolations(text: string): string[] {
  return SECRET_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
}

/** 递归排序对象键的稳定序列化（语义指纹基础） */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** 语义指纹：JSON5 解析后稳定序列化的 sha256（注释/格式变化不改变指纹） */
export function semanticFingerprint(content: string): string {
  const parsed: unknown = JSON5.parse(content);
  return createHash("sha256").update(stableStringify(parsed)).digest("hex");
}

// ---------- 三重安全门 ----------

export interface GateInput {
  envFlag: string | undefined;
  configPathArg: string | undefined;
  home: string;
  tmpDir: string;
  isTty: boolean;
}

export type GateDecision = { ok: true; configPath: string } | { ok: false; reason: string };

/**
 * 三重门求值（纯函数，便于单测）：
 * 环境变量门 → --config 参数门（存在 / $HOME 之下 / 反向 fixture 防线）→ TTY 门。
 */
export function evaluateGate(input: GateInput): GateDecision {
  if (input.envFlag !== "1") {
    return { ok: false, reason: `缺少环境变量 OC_SWITCH_REAL_CONFIG_E2E=1（当前为 ${JSON.stringify(input.envFlag)}）` };
  }
  if (!input.configPathArg || !input.configPathArg.trim()) {
    return { ok: false, reason: "缺少显式 --config <path> 参数" };
  }
  const configPath = resolve(input.configPathArg.trim());
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    return { ok: false, reason: `配置文件不存在或不是普通文件: ${configPath}` };
  }
  const home = resolve(input.home);
  if (configPath !== home && !configPath.startsWith(`${home}${sep}`)) {
    return { ok: false, reason: `配置路径必须位于 $HOME (${home}) 之下: ${configPath}` };
  }
  const tmpDir = resolve(input.tmpDir);
  if (configPath.startsWith(`${tmpDir}${sep}`)) {
    return { ok: false, reason: `配置路径位于系统临时目录（fixture 防线镜像断言）: ${configPath}` };
  }
  const fixtureSegment = configPath.split(sep).find((segment) => segment.startsWith("oc-switch-e2e-"));
  if (fixtureSegment !== undefined) {
    return { ok: false, reason: `配置路径匹配 fixture 模式（oc-switch-e2e-*）: ${configPath}` };
  }
  if (!input.isTty) {
    return { ok: false, reason: "非 TTY 环境拒跑（须交互确认）" };
  }
  return { ok: true, configPath };
}

// ---------- CLI 子进程 ----------

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 真实 CLI 子进程 runner：bun 直接跑 CLI 入口，env 注入 OPENCLAW_CONFIG_PATH 指向目标，
 * HOME 保持真实 HOME，与被测真实链路一致。
 */
export function createCliRunner(options: { cliEntry: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): (args: string[]) => Promise<CliResult> {
  return (args: string[]) =>
    new Promise<CliResult>((done) => {
      const child = spawn(process.execPath, [options.cliEntry, ...args], {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs ?? CLI_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        done({ code: 125, stdout, stderr: `${stderr}${String(error)}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code: code ?? 124, stdout, stderr });
      });
    });
}

// ---------- 场景 ----------

interface ScenarioContext {
  configPath: string;
  stateDir: string;
  runCli: (args: string[]) => Promise<CliResult>;
  pluginCatalog: () => Promise<PluginCatalogResult>;
}

export interface ScenarioResult {
  id: string;
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

function readConfigFile(ctx: ScenarioContext): OpenClawConfig {
  return JSON5.parse(readFileSync(ctx.configPath, "utf8")) as OpenClawConfig;
}

/** 两个 ModelRef 是否同一模型（大小写折叠比较；任一非法视为不等） */
function sameRef(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  try {
    return normalizeModelRefForStorage(a) === normalizeModelRefForStorage(b);
  } catch {
    return false;
  }
}

/** 目录证据：config Provider 模型 ∪ 启用中插件 Provider 模型（ref 列表，去重） */
async function collectCatalogRefs(ctx: ScenarioContext, config: OpenClawConfig): Promise<string[]> {
  const refs: string[] = [];
  const seen = new Set<string>();
  const push = (ref: string) => {
    try {
      const identity = normalizeModelRefForStorage(ref);
      if (!seen.has(identity)) {
        seen.add(identity);
        refs.push(ref);
      }
    } catch {
      // 非法 ref 不参与候选
    }
  };
  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    if (provider === null || typeof provider !== "object") continue;
    for (const model of (provider as { models?: Array<{ id?: unknown }> }).models ?? []) {
      if (model && typeof model.id === "string" && model.id.trim()) push(`${providerId}/${model.id.trim()}`);
    }
  }
  try {
    const catalog = await ctx.pluginCatalog();
    for (const pluginProvider of catalog.providers) {
      if (!pluginProvider.enabled) continue;
      for (const model of pluginProvider.models) push(`${pluginProvider.providerId}/${model.id}`);
    }
  } catch {
    // 插件目录探测失败只限 config 目录（与 core 降级语义一致）
  }
  return refs;
}

function providerDisabled(ctx: ScenarioContext, providerId: string): boolean {
  try {
    return getDisabledProviderState(ctx.stateDir, providerId) !== undefined;
  } catch {
    return false;
  }
}

/** CLI 失败详情（截断 + 密钥扫描；命中即抑制不回显） */
function cliDetail(cli: CliResult, max = 200): string {
  const text = cli.stderr.trim() || cli.stdout.trim();
  if (text.length === 0) return "";
  if (findSecretViolations(text).length > 0) return "（输出疑似含密钥，已抑制不回显）";
  return `: ${text.slice(0, max)}`;
}

/** 场景 1：主模型切换往返（use → 断言 → use 还原 → 语义指纹等价） */
async function scenarioPrimaryRoundtrip(ctx: ScenarioContext): Promise<ScenarioResult> {
  const result = (status: ScenarioResult["status"], detail: string): ScenarioResult => ({
    id: "primary-roundtrip",
    name: "主模型切换往返",
    status,
    detail
  });
  const config = readConfigFile(ctx);
  const primary = readPrimaryModelRef(config);
  if (primary === undefined) {
    return result("skip", "当前未配置主模型（agents.defaults.model 缺失或非法），无法做切换往返");
  }
  const fallbacksBefore = readFallbackModelRefs(config);
  const fallbackIdentities = new Set(fallbacksBefore.map((ref) => normalizeModelRefForStorage(ref)));
  const primaryIdentity = normalizeModelRefForStorage(primary);
  const refs = await collectCatalogRefs(ctx, config);
  const alternate = refs.find((ref) => {
    if (sameRef(ref, primary) || fallbackIdentities.has(normalizeModelRefForStorage(ref))) return false;
    try {
      if (providerDisabled(ctx, parseModelRef(ref).providerId)) return false;
    } catch {
      return false;
    }
    return true;
  });
  if (alternate === undefined) {
    return result("skip", "目录中没有可作切换目标的其它有效模型（全部被主模型/fallback 引用或所在 Provider 已停用）");
  }
  const fingerprintBefore = semanticFingerprint(readFileSync(ctx.configPath, "utf8"));
  const originalModelValue = structuredClone(config.agents?.defaults?.model);

  let cli = await ctx.runCli(["use", alternate]);
  if (cli.code !== 0) {
    return result("fail", `use ${alternate} 退出码 ${cli.code}${cliDetail(cli)}`);
  }
  let after = readConfigFile(ctx);
  if (!sameRef(readPrimaryModelRef(after), alternate)) {
    return result("fail", `切换后 agents.defaults.model 未变为 ${alternate}`);
  }
  if (stableStringify(readFallbackModelRefs(after)) !== stableStringify(fallbacksBefore)) {
    return result("fail", "切换主模型后 agents.defaults.model.fallbacks 发生变化（形状守恒被破坏）");
  }
  cli = await ctx.runCli(["use", primary]);
  if (cli.code !== 0) {
    return result("fail", `use ${primary}（还原）退出码 ${cli.code}${cliDetail(cli)}`);
  }
  after = readConfigFile(ctx);
  if (stableStringify(after.agents?.defaults?.model) !== stableStringify(originalModelValue)) {
    return result("fail", "还原后 agents.defaults.model 与原值语义不等价（fallbacks/未知键可能丢失）");
  }
  if (semanticFingerprint(readFileSync(ctx.configPath, "utf8")) !== fingerprintBefore) {
    return result("fail", "场景结束后语义指纹与场景前不等价");
  }
  return result("pass", `主模型 ${primary} -> ${alternate} 往返成功，fallbacks/未知键守恒，语义指纹等价`);
}

/** 场景 2：policy 规则往返（restricted 时；优先添加被 wildcard 覆盖的冗余 exact） */
async function scenarioPolicyRuleRoundtrip(ctx: ScenarioContext): Promise<ScenarioResult> {
  const result = (status: ScenarioResult["status"], detail: string): ScenarioResult => ({
    id: "policy-rule-roundtrip",
    name: "Policy 规则往返",
    status,
    detail
  });
  const config = readConfigFile(ctx);
  const mode = getModelPolicyMode(config);
  if (mode !== "restricted") {
    return result("skip", `modelPolicy 模式为 ${mode}（非 restricted），规则编辑入口不可用`);
  }
  const allowBefore = readModelPolicyAllow(config) ?? [];
  const rawAllowBefore = structuredClone(readModelPolicyAllowRaw(config) ?? []);
  const fingerprintBefore = semanticFingerprint(readFileSync(ctx.configPath, "utf8"));
  const protectedIdentities = new Set<string>();
  const primary = readPrimaryModelRef(config);
  if (primary !== undefined) protectedIdentities.add(normalizeModelRefForStorage(primary));
  for (const ref of readFallbackModelRefs(config)) protectedIdentities.add(normalizeModelRefForStorage(ref));
  const refs = await collectCatalogRefs(ctx, config);
  const isProtected = (ref: string) => protectedIdentities.has(normalizeModelRefForStorage(ref));
  // 优先：被现有 wildcard 覆盖且尚无 exact 的目录模型（零有效选择范围变化）
  let candidate = refs.find(
    (ref) =>
      !isProtected(ref) &&
      findExactEntryInAllowList(allowBefore, ref) === undefined &&
      findWildcardEntryInAllowList(allowBefore, ref) !== undefined
  );
  let redundant = candidate !== undefined;
  // 降级：指向目录已有模型的 exact（添加后删除，仍恢复零变化）
  candidate ??= refs.find((ref) => !isProtected(ref) && findExactEntryInAllowList(allowBefore, ref) === undefined);
  if (candidate === undefined) {
    return result("skip", "目录中没有可安全添加/删除的 policy 规则候选（全部被 exact 覆盖或受 primary/fallback 保护）");
  }
  const rule = normalizeModelRefForStorage(candidate);
  const strategy = redundant ? "冗余 exact（已被 wildcard 覆盖）" : "指向目录已有模型的 exact";

  let cli = await ctx.runCli(["model", "add-policy-rule", rule]);
  if (cli.code !== 0) {
    return result("fail", `add-policy-rule ${rule} 退出码 ${cli.code}${cliDetail(cli)}`);
  }
  let after = readConfigFile(ctx);
  if (findExactEntryInAllowList(readModelPolicyAllow(after) ?? [], rule) === undefined) {
    return result("fail", `添加后 modelPolicy.allow 中不存在 ${rule}`);
  }
  cli = await ctx.runCli(["model", "remove-policy-rule", rule, "--yes"]);
  if (cli.code !== 0) {
    return result("fail", `remove-policy-rule ${rule} 退出码 ${cli.code}${cliDetail(cli)}`);
  }
  after = readConfigFile(ctx);
  if (stableStringify(readModelPolicyAllowRaw(after) ?? []) !== stableStringify(rawAllowBefore)) {
    return result("fail", "删除后 modelPolicy.allow 与原数组语义不等价（顺序/重复/非字符串条目可能变化）");
  }
  if (semanticFingerprint(readFileSync(ctx.configPath, "utf8")) !== fingerprintBefore) {
    return result("fail", "场景结束后语义指纹与场景前不等价");
  }
  return result("pass", `规则 ${rule} 添加/删除往返成功（${strategy}），allow 数组复原`);
}

/** 场景 3：Provider 停用/恢复往返（不贡献主模型/fallback 的 config Provider） */
async function scenarioProviderDisableRestore(ctx: ScenarioContext): Promise<ScenarioResult> {
  const result = (status: ScenarioResult["status"], detail: string): ScenarioResult => ({
    id: "provider-disable-restore",
    name: "Provider 停用/恢复往返",
    status,
    detail
  });
  const config = readConfigFile(ctx);
  const providerIds = Object.keys(config.models?.providers ?? {});
  if (providerIds.length === 0) {
    return result("skip", "config 的 models.providers 为空，无可停用 Provider");
  }
  const protectedProviders = new Set<string>();
  const primary = readPrimaryModelRef(config);
  if (primary !== undefined) {
    try {
      protectedProviders.add(normalizeProviderId(parseModelRef(primary).providerId));
    } catch {
      // 非法 primary 不产生保护
    }
  }
  for (const ref of readFallbackModelRefs(config)) {
    try {
      protectedProviders.add(normalizeProviderId(parseModelRef(ref).providerId));
    } catch {
      // 非法 fallback 不产生保护
    }
  }
  const candidate = providerIds.find(
    (id) => !protectedProviders.has(normalizeProviderId(id)) && !providerDisabled(ctx, id)
  );
  if (candidate === undefined) {
    return result("skip", "所有 config Provider 都被主模型/fallback 引用或已停用，无安全候选");
  }
  const fingerprintBefore = semanticFingerprint(readFileSync(ctx.configPath, "utf8"));

  let cli = await ctx.runCli(["provider", "disable", candidate]);
  if (cli.code !== 0) {
    return result("fail", `provider disable ${candidate} 退出码 ${cli.code}${cliDetail(cli)}`);
  }
  const snapshot = getDisabledProviderState(ctx.stateDir, candidate);
  if (!snapshot || snapshot.openclawPath !== ctx.configPath) {
    return result("fail", `停用后 provider-states.json 中缺少 ${candidate} 的快照（或快照路径不属于目标配置）`);
  }
  let after = readConfigFile(ctx);
  if (!after.models?.providers?.[candidate]) {
    return result("fail", `停用后 models.providers.${candidate} 目录条目未保留`);
  }
  cli = await ctx.runCli(["provider", "enable", candidate]);
  if (cli.code !== 0) {
    return result("fail", `provider enable ${candidate} 退出码 ${cli.code}${cliDetail(cli)}`);
  }
  if (getDisabledProviderState(ctx.stateDir, candidate) !== undefined) {
    return result("fail", `恢复后 provider-states.json 中仍存在 ${candidate} 的快照`);
  }
  after = readConfigFile(ctx);
  if (semanticFingerprint(readFileSync(ctx.configPath, "utf8")) !== fingerprintBefore) {
    return result("fail", "场景结束后语义指纹与场景前不等价（停用/恢复未完全复原）");
  }
  return result("pass", `Provider ${candidate} 停用/恢复往返成功，快照已清除，语义指纹等价`);
}

// ---------- 主流程 ----------

export interface RealConfigE2EOptions {
  /** 环境变量 OC_SWITCH_REAL_CONFIG_E2E 的值 */
  envFlag: string | undefined;
  /** --config 参数原值 */
  configPathArg: string | undefined;
  /** 真实 HOME（fixture 防线锚点） */
  home: string;
  /** 系统临时目录（fixture 防线镜像断言用） */
  tmpDir: string;
  /** stdin/stdout 均为 TTY */
  isTty: boolean;
  /** TTY 交互确认（返回 true 才开始） */
  confirm: () => Promise<boolean>;
  /** CLI 子进程执行器（测试可注入假实现） */
  runCli: (args: string[]) => Promise<CliResult>;
  /** 插件目录探测（测试可注入；真实链路 shell-out openclaw） */
  pluginCatalog: () => Promise<PluginCatalogResult>;
  /** Gateway 只读对账探测（失败仅 warning） */
  gatewayProbe: () => Promise<{ ok: boolean; detail: string }>;
  /** 确认屏幕附加告警（如检测到常驻 serve 实例） */
  preflightWarnings?: string[];
  /** 报告输出行（默认 console.log） */
  log?: (line: string) => void;
  /** 字节还原写盘（测试可注入故障） */
  restoreFile?: (path: string, bytes: Buffer | null, mode: number | null) => void;
  /** 覆盖进程环境（测试隔离用；默认继承 process.env 并注入 HOME/OPENCLAW_CONFIG_PATH） */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * 运行实例探测（只读）；默认真实 discoverOpenClawRuntime，与 CLI 子进程解析规则保持一致
   * （envPath 可能经唯一运行实例组解析）。测试注入空结果实现隔离。
   */
  runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
}

interface SnapshotEntry {
  path: string;
  bytes: Buffer | null;
  /** 写前权限位（还原时保留；事务 rename 会重建 inode 导致 mode 漂移） */
  mode: number | null;
}

/**
 * 真实配置写 E2E 主流程。返回进程退出码：
 * 0 全 pass（允许含 skip）/ 1 场景失败 / 2 还原失败 / 3 门禁拒绝或未确认。
 */
export async function runRealConfigE2E(options: RealConfigE2EOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.log(line));
  const decision = evaluateGate({
    envFlag: options.envFlag,
    configPathArg: options.configPathArg,
    home: options.home,
    tmpDir: options.tmpDir,
    isTty: options.isTty
  });
  if (!decision.ok) {
    log(`门禁拒绝：${decision.reason}`);
    return EXIT_GATE_REFUSAL;
  }
  const configPath = decision.configPath;
  const env: NodeJS.ProcessEnv = {
    ...(options.baseEnv ?? process.env),
    HOME: options.home,
    OPENCLAW_CONFIG_PATH: configPath
  };
  // 与 CLI 子进程同一解析规则（stateDir / envPath 均来自 core getActivePaths，
  // 含唯一运行实例组对 envPath 的解析，保证 .env 字节快照锁定的就是 CLI 会写的文件）
  const discovery = (options.runtimeDiscoveryProvider ?? discoverOpenClawRuntime)();
  const paths = getActivePaths({ env, runtimeDiscovery: discovery });
  const providerStatesPath = join(paths.stateDir, "provider-states.json");

  // 写前快照：openclaw.json 原始字节 + 语义指纹；.env 与 provider-states 只读存字节
  const openclawBytes = readFileSync(configPath);
  const openclawFingerprint = semanticFingerprint(openclawBytes.toString("utf8"));
  const envBytes = existsSync(paths.envPath) ? readFileSync(paths.envPath) : null;
  const providerStatesBytes = existsSync(providerStatesPath) ? readFileSync(providerStatesPath) : null;
  // bytes=null 表示写前不存在：还原 = 删除；四重断言含「不存在仍不存在」
  const snapshotOf = (path: string): SnapshotEntry => ({
    path,
    bytes: existsSync(path) ? readFileSync(path) : null,
    mode: existsSync(path) ? statSync(path).mode & 0o7777 : null
  });
  const snapshots: SnapshotEntry[] = [
    snapshotOf(configPath),
    snapshotOf(paths.envPath),
    snapshotOf(providerStatesPath)
  ];

  // 安全网备份（还原不走 restoreBackupSafely，备份仅保留报告）
  let backupId = "";
  try {
    backupId = basename(createBackup({
      stateDir: paths.stateDir,
      openclawPath: configPath,
      envPath: paths.envPath,
      reason: BACKUP_REASON,
      beforeHash: openclawFingerprint
    }));
  } catch (error) {
    log(`门禁拒绝：写前安全网备份失败，拒绝继续（${String(error)}）`);
    return EXIT_GATE_REFUSAL;
  }

  const initialConfig = JSON5.parse(openclawBytes.toString("utf8")) as OpenClawConfig;
  const primary = readPrimaryModelRef(initialConfig);
  const mode = getModelPolicyMode(initialConfig);
  log("== 真实配置写 E2E（第一阶段）==");
  log(`目标配置: ${configPath}`);
  log(`stateDir: ${paths.stateDir}`);
  log(`envPath: ${paths.envPath}（场景绝不写入；仅字节快照 + 结束还原兜底）`);
  log(`当前主模型: ${primary ?? "（未配置）"}   modelPolicy 模式: ${mode}`);
  log("场景清单:");
  log("  1. 主模型切换往返（use → 断言 → 还原）");
  log("  2. Policy 规则往返（restricted 时；非 restricted 跳过）");
  log("  3. Provider 停用/恢复往返（无可选 Provider 跳过）");
  log("说明: 将写入 openclaw.json 子树并在每场景后及结束时还原（字节写回 + 四重断言）。");
  log(`安全网备份: ${backupId}（保留于 stateDir/backups，可自行清理）`);
  for (const warning of options.preflightWarnings ?? []) log(`警告: ${warning}`);
  if (!(await options.confirm())) {
    log("未确认，退出（未写入任何内容；安全网备份仍保留）");
    return EXIT_GATE_REFUSAL;
  }

  const ctx: ScenarioContext = {
    configPath,
    stateDir: paths.stateDir,
    runCli: options.runCli,
    pluginCatalog: options.pluginCatalog
  };
  const results: ScenarioResult[] = [];
  const scenarios = [
    { name: "1 主模型切换往返", run: scenarioPrimaryRoundtrip },
    { name: "2 Policy 规则往返", run: scenarioPolicyRuleRoundtrip },
    { name: "3 Provider 停用/恢复往返", run: scenarioProviderDisableRestore }
  ];
  let gatewayDetail = "";
  try {
    for (const scenario of scenarios) {
      const result = await scenario.run(ctx);
      results.push(result);
      log(`场景 ${scenario.name}: ${result.status.toUpperCase()} — ${result.detail}`);
      if (result.status === "fail") {
        log("场景失败，立即停止后续场景（已做字节还原兜底）。");
        break;
      }
    }
    const gateway = await options.gatewayProbe();
    gatewayDetail = gateway.ok ? `成功（${gateway.detail}）` : `warning: ${gateway.detail}`;
  } finally {
    // 还原（无条件）：字节写回 + 四重断言；禁用 restoreBackupSafely
    const restore = options.restoreFile ?? ((path: string, bytes: Buffer | null, mode: number | null) => {
      if (bytes === null) {
        rmSync(path, { force: true });
        return;
      }
      writeFileSync(path, bytes);
      if (mode !== null) chmodSync(path, mode);
    });
    const failures: string[] = [];
    for (const snapshot of snapshots) {
      try {
        restore(snapshot.path, snapshot.bytes, snapshot.mode);
      } catch (error) {
        failures.push(`${snapshot.path} 字节写回失败: ${String(error)}`);
        continue;
      }
      const current = existsSync(snapshot.path) ? readFileSync(snapshot.path) : null;
      const mismatch = snapshot.bytes === null
        ? current !== null
        : current === null || !current.equals(snapshot.bytes);
      if (mismatch) {
        failures.push(`${snapshot.path} 字节不一致`);
      }
    }
    // openclaw.json 语义指纹等价
    if (failures.length === 0) {
      try {
        const currentFingerprint = semanticFingerprint(readFileSync(configPath, "utf8"));
        if (currentFingerprint !== openclawFingerprint) failures.push("openclaw.json 语义指纹不等价");
      } catch (error) {
        failures.push(`openclaw.json 语义指纹重算失败: ${String(error)}`);
      }
    }
    if (failures.length > 0) {
      // 还原断言失败：醒目告警 + 备份路径 + 当前文件状态（不回显内容，防密钥泄露）
      const currentStat = existsSync(configPath) ? statSync(configPath) : null;
      log("");
      log("!!! 还原断言失败 !!!");
      for (const failure of failures) log(`  - ${failure}`);
      log(`  备份路径: ${join(paths.stateDir, "backups", backupId)}`);
      log(`  当前 openclaw.json: ${currentStat ? `size=${currentStat.size}` : "缺失"}  原语义指纹=${openclawFingerprint}`);
      log("  请立即人工核对，必要时从上述备份恢复。");
      return EXIT_RESTORE_FAILURE;
    }
    log("还原证明: openclaw.json 字节一致 ✓ 语义指纹等价 ✓ .env 字节不变 ✓ provider-states.json 字节不变 ✓");
  }
  log(`Gateway 只读对账: ${gatewayDetail}`);
  log("重要: 运行中 Gateway 进程 env/选择器未验证，如需生效由用户手动 apply。");
  log(`安全网备份（保留）: ${backupId}`);
  return results.some((r) => r.status === "fail") ? EXIT_SCENARIO_FAILURE : EXIT_OK;
}

// ---------- 真实入口 ----------

/** 探测常驻 oc-switch serve 实例（仅提示不阻断） */
async function detectServeInstance(): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    const response = await fetch(SERVE_PROBE_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      return `检测到 127.0.0.1:7420 有常驻 oc-switch serve 实例，测试期间该实例会读到配置变化`;
    }
  } catch {
    // 无常驻实例或探测失败：无需提示
  }
  return undefined;
}

/** Gateway 只读对账：openclaw CLI 可用时尝试只读 config.get（失败仅 warning） */
function realGatewayProbe(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((done) => {
    try {
      const result = spawnSync("openclaw", ["gateway", "config.get"], { timeout: 15_000, encoding: "utf8" });
      if (result.error) {
        done({ ok: false, detail: `openclaw CLI 不可用（${String(result.error)}），跳过只读对账` });
        return;
      }
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const violations = findSecretViolations(output);
      if (violations.length > 0) {
        done({ ok: false, detail: "gateway config.get 输出疑似含密钥，已抑制不回显" });
        return;
      }
      if (result.status !== 0) {
        done({ ok: false, detail: `gateway config.get 退出码 ${result.status}（只读对账失败仅记 warning）` });
        return;
      }
      const firstLine = output.trim().split("\n")[0] ?? "";
      done({ ok: true, detail: `config.get 退出码 0${firstLine ? `, ${firstLine.slice(0, 120)}` : ""}` });
    } catch (error) {
      done({ ok: false, detail: `gateway 只读对账异常（${String(error)}）` });
    }
  });
}

/** TTY 交互确认 */
async function promptConfirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`确认对以上真实配置执行写入并还原，请输入 ${CONFIRM_WORD}: `);
    return answer.trim().toLowerCase() === CONFIRM_WORD;
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): { configPathArg?: string | undefined; help: boolean } {
  let configPathArg: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--config") configPathArg = argv[i + 1];
    else if (arg.startsWith("--config=")) configPathArg = arg.slice("--config=".length);
    else if (arg === "-h" || arg === "--help") help = true;
  }
  return { ...(configPathArg !== undefined ? { configPathArg } : {}), help };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { configPathArg, help } = parseArgs(argv);
  if (help) {
    console.log("用法: bun run scripts/e2e-real-config.ts -- --config <path>");
    console.log("三重门: OC_SWITCH_REAL_CONFIG_E2E=1 + --config（$HOME 下、非 fixture 路径）+ TTY 确认。");
    console.log("退出码: 0 通过 / 1 场景失败 / 2 还原失败 / 3 门禁拒绝。");
    return EXIT_OK;
  }
  const home = homedir();
  const preflightWarnings: string[] = [];
  const serveWarning = await detectServeInstance();
  if (serveWarning) preflightWarnings.push(serveWarning);
  const cliEntry = resolve(join(import.meta.dir, "../packages/cli/src/index.ts"));
  return runRealConfigE2E({
    envFlag: process.env.OC_SWITCH_REAL_CONFIG_E2E,
    configPathArg,
    home,
    tmpDir: tmpdir(),
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: promptConfirm,
    runCli: createCliRunner({
      cliEntry,
      env: { ...process.env, HOME: home, OPENCLAW_CONFIG_PATH: resolve(configPathArg ?? "") }
    }),
    pluginCatalog: async () => discoverPluginCatalogAsync({ configPath: resolve(configPathArg ?? "") }),
    gatewayProbe: realGatewayProbe,
    preflightWarnings
  });
}

if (import.meta.main) {
  const code = await main();
  if (code !== EXIT_OK) process.exit(code);
}
