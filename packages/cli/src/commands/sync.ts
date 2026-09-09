import {
  applyEnvOperation,
  applySyncPayload,
  assertAllowedSemanticChange,
  buildSyncCheckReport,
  buildSyncPayload,
  discoverPluginCatalog,
  inspectConfigStatus,
  normalizeConfigForStorage,
  projectSyncTarget,
  summarizeConfigDiff,
  writeOpenClawTransaction,
  type ConfigDiffSummary,
  type OpenClawConfig,
  type SyncCheckReport,
  type SyncPayload
} from "@oc-switch/core";
import type { Command } from "commander";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { CommandContext } from "../command-context";
import { runSyncAgent, type SyncRemoteExecutor } from "../sync-executor";

/**
 * 跨机配置同步（spec：docs/superpowers/specs/2026-09-09-oc-switch-config-sync-design.md）。
 *
 * - `sync diff <host>` / `sync push <host>`：本地面向用户的命令；
 * - `sync-agent *`：隐藏 plumbing，经 ssh 在对端执行，stdout 为纯 JSON 协议，人类输出一律走 stderr。
 *
 * 安全约束：任何输出/日志中只出现 env 变量名，绝不出现密钥值；
 * 拉取到本地的对端 config 只进内存做 diff，不打印到终端。
 */

interface SyncAgentReadConfigResult {
  config: OpenClawConfig;
  paths: { openclawPath: string; envPath: string };
}

interface SyncAgentWriteResult {
  ok: boolean;
  backupDir: string;
}

interface SyncAgentEnvUpsertResult {
  ok: boolean;
  results: Array<{ envVar: string; ok: boolean; error?: string }>;
}

interface SyncCommandOptions {
  path?: string;
  yes?: boolean;
  enablePlugins?: boolean;
  fillKeys?: boolean;
}

interface SyncPlan {
  payload: SyncPayload;
  remotePaths: { openclawPath: string; envPath: string };
  summary: ConfigDiffSummary;
  report: SyncCheckReport;
}

function writeProtocol(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function failAgent(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseStdinJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stdin 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** payload 的最小结构校验：四个子树包装都必须带 boolean present */
function assertSyncPayload(value: unknown): SyncPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid sync payload");
  }
  const record = value as Record<string, unknown>;
  for (const key of ["providers", "defaultsModels", "modelPolicyAllow", "primaryModel"]) {
    const subtree = record[key];
    if (
      typeof subtree !== "object" ||
      subtree === null ||
      typeof (subtree as { present?: unknown }).present !== "boolean"
    ) {
      throw new Error(`Invalid sync payload: ${key}`);
    }
  }
  return value as SyncPayload;
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** 密钥输入：不回显（含粘贴），不落任何日志；返回 trim 后的值，空串表示跳过 */
async function askSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // readline 默认把输入回显到 output；密钥场景覆盖为空操作
  (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = () => {};
  try {
    const answer = await rl.question("");
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function confirmYes(question: string): Promise<boolean> {
  const answer = await ask(question);
  return answer.trim().toLowerCase() === "yes";
}

function printPlan(host: string, summary: ConfigDiffSummary): void {
  console.log(`同步计划（本机 → ${host}，仅 models.providers / 启用状态 / modelPolicy.allow / 主模型）：`);
  console.log(`  Provider：新增 ${summary.providersAdded.length}，移除 ${summary.providersRemoved.length}，变更 ${summary.providersChanged.length}`);
  if (summary.providersAdded.length) console.log(`    + ${summary.providersAdded.join(", ")}`);
  if (summary.providersRemoved.length) console.log(`    - ${summary.providersRemoved.join(", ")}`);
  if (summary.providersChanged.length) console.log(`    ~ ${summary.providersChanged.join(", ")}`);
  console.log(`  模型启用状态：新增 ${summary.modelsEnabled.length}，移除 ${summary.modelsDisabled.length}`);
  if (summary.modelsEnabled.length) console.log(`    + ${summary.modelsEnabled.join(", ")}`);
  if (summary.modelsDisabled.length) console.log(`    - ${summary.modelsDisabled.join(", ")}`);
  if (summary.primaryChanged) {
    console.log(`  主模型：${summary.primaryChanged.before ?? "(未设置)"} → ${summary.primaryChanged.after ?? "(未设置)"}`);
  } else {
    console.log("  主模型：不变");
  }
}

function printCheckReport(report: SyncCheckReport): void {
  const disabled = report.refs.filter((ref) => ref.status === "plugin-disabled");
  const notInstalled = report.refs.filter((ref) => ref.status === "not-installed");
  const pluginEnabled = report.refs.filter((ref) => ref.status === "plugin-enabled");
  console.log("校验提醒：");
  if (report.refs.length === 0) {
    console.log("  启用状态/主模型没有引用 config 之外的 provider");
  } else {
    console.log(`  外部 provider 引用：${pluginEnabled.length} 个插件已启用，${disabled.length} 个已安装未启用，${notInstalled.length} 个未安装`);
  }
  for (const ref of disabled) {
    console.log(`  - ${ref.providerId}：插件 ${ref.pluginId} 已安装但 enabled=false（可用 --enable-plugins 自动开启）`);
  }
  for (const ref of notInstalled) {
    console.log(`  - ${ref.providerId}：对端未安装对应插件，需 openclaw plugins install；相关 ref 在 config-status 中表现为 unknown/drift（同步本身不算失败）`);
  }
  if (report.missingEnvVars.length) {
    console.log(`  对端 .env 缺失变量（只列名称）：${report.missingEnvVars.join(", ")}`);
    console.log("    请在对端自行设置，或用 --fill-keys 逐项填入；改 Key 后需 sync-env + restart Gateway");
  }
  const status = report.configStatus;
  console.log(`  config-status：${status.issueCount} 个问题（blocking ${status.blockingIssueCount} / warning ${status.warningIssueCount}）`);
  if (status.unknownProviderRefs.length) {
    console.log(`    unknown provider refs：${status.unknownProviderRefs.join(", ")}`);
  }
}

/**
 * §5.1–5.3：preflight（read-config 同时验证 ssh 连通、远端 CLI 可用、路径解析）
 * → 拉远端 config 到本地做三子树 diff 预览 → 远端 check（带 payload）。
 * 全程只读，不写任何东西。
 */
async function buildSyncPlan(
  context: CommandContext,
  host: string,
  options: { path?: string; executor?: SyncRemoteExecutor }
): Promise<SyncPlan> {
  const remote = await runSyncAgent<SyncAgentReadConfigResult>(host, ["read-config"], {
    ...(options.path ? { openclawPath: options.path } : {}),
    ...(options.executor ? { executor: options.executor } : {})
  });
  console.log(`远端连接正常（openclaw.json：${remote.paths.openclawPath}）`);

  const payload = buildSyncPayload(context.readConfig());
  // 与远端写入保持一致：先应用 payload，再做存储规范化（Provider 前缀小写化等）
  const projected = normalizeConfigForStorage(projectSyncTarget(remote.config, payload)).config;
  // 本地预校验：覆盖写不得触碰 diff-guard 白名单外路径（远端 write 事务内还有同一道防线）
  assertAllowedSemanticChange(remote.config, projected);
  const summary = summarizeConfigDiff(remote.config, projected);
  const report = await runSyncAgent<SyncCheckReport>(host, ["check"], {
    input: { payload },
    ...(options.path ? { openclawPath: options.path } : {}),
    ...(options.executor ? { executor: options.executor } : {})
  });
  return { payload, remotePaths: remote.paths, summary, report };
}

function registerSyncAgentCommands(program: Command, context: CommandContext): void {
  const agent = program
    .command("sync-agent", { hidden: true })
    .description("跨机同步远端 plumbing（stdout 纯 JSON 协议，人类输出走 stderr）");

  agent.command("read-config").action(() => {
    try {
      const paths = context.activePaths();
      const config = JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
      writeProtocol({
        config,
        paths: { openclawPath: paths.openclawPath, envPath: paths.envPath }
      });
    } catch (error) {
      failAgent(error);
    }
  });

  agent.command("check").action(async () => {
    try {
      const input = parseStdinJson(await readStdinText());
      const payload = input.payload === undefined ? undefined : assertSyncPayload(input.payload);
      const paths = context.activePaths();
      const config = JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
      const envContent = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
      const catalog = discoverPluginCatalog();
      // 仅在内存中构造「应用 payload 后」的投影，不落盘
      const projected = projectSyncTarget(config, payload);
      const configStatus = inspectConfigStatus({
        config: projected,
        paths,
        envContent,
        pluginProviders: catalog.providers
      });
      writeProtocol(
        buildSyncCheckReport({
          config,
          ...(payload ? { payload } : {}),
          envContent,
          pluginProviders: catalog.providers,
          pluginDiagnostics: catalog.diagnostics,
          configStatus
        })
      );
    } catch (error) {
      failAgent(error);
    }
  });

  agent.command("write").action(async () => {
    try {
      const input = parseStdinJson(await readStdinText());
      if (input.payload === undefined) throw new Error("sync-agent write 需要 payload");
      const payload = assertSyncPayload(input.payload);
      const enablePluginIds = Array.isArray(input.enablePluginIds)
        ? input.enablePluginIds.filter((id): id is string => typeof id === "string")
        : [];
      const paths = context.activePaths();
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: "sync push",
        mutate: (config) => applySyncPayload(config, payload, { enablePluginIds })
      });
      writeProtocol({ ok: true, backupDir: result.backupDir });
    } catch (error) {
      failAgent(error);
    }
  });

  agent.command("env-upsert").action(async () => {
    try {
      const input = parseStdinJson(await readStdinText());
      if (typeof input.updates !== "object" || input.updates === null || Array.isArray(input.updates)) {
        throw new Error("sync-agent env-upsert 需要 updates 对象");
      }
      const paths = context.activePaths();
      const results: Array<{ envVar: string; ok: boolean; error?: string }> = [];
      for (const [envVar, rawValue] of Object.entries(input.updates as Record<string, unknown>)) {
        // 结果只含变量名与错误原因，绝不回显值
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar) || typeof rawValue !== "string") {
          results.push({ envVar, ok: false, error: "非法变量名或值类型" });
          continue;
        }
        try {
          await applyEnvOperation({
            paths,
            operation: { type: "upsert", envVar, value: rawValue },
            runtimeDiscoveryProvider: context.runtimeDiscoveryProvider
          });
          results.push({ envVar, ok: true });
        } catch (error) {
          results.push({
            envVar,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      writeProtocol({ ok: results.every((item) => item.ok), results });
      if (results.some((item) => !item.ok)) process.exitCode = 1;
    } catch (error) {
      failAgent(error);
    }
  });
}

export function registerSyncCommands(program: Command, context: CommandContext): void {
  registerSyncAgentCommands(program, context);

  const sync = program.command("sync").description("跨机配置同步（SSH 单向 push，子树覆盖）");

  sync
    .command("diff")
    .argument("<host>", "SSH 主机（ssh config 别名或 user@host）")
    .option("--path <path>", "远端 openclaw.json 路径（映射为远端 OPENCLAW_CONFIG_PATH）")
    .action(async (host: string, options: SyncCommandOptions) => {
      try {
        const plan = await buildSyncPlan(context, host, options);
        printPlan(host, plan.summary);
        printCheckReport(plan.report);
        console.log("dry-run：未写入任何内容");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });

  sync
    .command("push")
    .argument("<host>", "SSH 主机（ssh config 别名或 user@host）")
    .option("--path <path>", "远端 openclaw.json 路径（映射为远端 OPENCLAW_CONFIG_PATH）")
    .option("--yes", "跳过人工确认（非交互环境必须显式指定）")
    .option("--enable-plugins", "自动开启已安装但被禁用的插件（仅 false→true，绝不反向）")
    .option("--fill-keys", "交互式逐项填入对端缺失的 API Key（值不回显，可逐项回车跳过）")
    .action(async (host: string, options: SyncCommandOptions) => {
      try {
        // --fill-keys 的交互发生在写入之后，但终端能力必须先验，避免写完了才发现没法问
        if (options.fillKeys && !process.stdin.isTTY) {
          throw new Error("--fill-keys 需要交互终端（fail closed，未写入任何内容）");
        }
        const plan = await buildSyncPlan(context, host, options);
        printPlan(host, plan.summary);
        printCheckReport(plan.report);

        // §6.3：--enable-plugins 或交互逐项确认；--yes 只确认推送本身，不隐含开启插件
        const disabledPluginIds = [
          ...new Set(
            plan.report.refs
              .filter((ref) => ref.status === "plugin-disabled" && ref.pluginId !== undefined)
              .map((ref) => ref.pluginId!)
          )
        ];
        const enablePluginIds: string[] = [];
        if (options.enablePlugins) {
          enablePluginIds.push(...disabledPluginIds);
        } else if (!options.yes && disabledPluginIds.length > 0 && process.stdin.isTTY) {
          for (const pluginId of disabledPluginIds) {
            const answer = await ask(`开启对端插件 ${pluginId}（plugins.entries.${pluginId}.enabled false→true）？[y/N] `);
            if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
              enablePluginIds.push(pluginId);
            }
          }
        }

        if (!options.yes) {
          if (!process.stdin.isTTY) {
            throw new Error("非交互环境必须显式 --yes 确认推送（fail closed）");
          }
          const confirmed = await confirmYes(
            `确认把本机 Provider/模型/主模型配置覆盖推送到 ${host}？对端私有条目将被覆盖（写入前自动备份，可用 backup restore 回滚）。输入 yes 确认: `
          );
          if (!confirmed) throw new Error("已取消，未写入任何内容");
        }

        const writeResult = await runSyncAgent<SyncAgentWriteResult>(host, ["write"], {
          input: { payload: plan.payload, enablePluginIds },
          ...(options.path ? { openclawPath: options.path } : {})
        });
        console.log(`已写入对端配置（远端备份：${writeResult.backupDir}）`);
        if (enablePluginIds.length > 0) {
          console.log(`已开启插件：${enablePluginIds.join(", ")}；需 restart/apply Gateway 后生效（本命令不自动重启）`);
        }

        // §5.6：写后校验（不带 payload，反映对端实际状态）
        const postReport = await runSyncAgent<SyncCheckReport>(host, ["check"], {
          ...(options.path ? { openclawPath: options.path } : {})
        });

        // §6.2：--fill-keys 逐项交互填入缺失变量；值不回显、不写日志，收集后一次 env-upsert
        let remainingMissing = postReport.missingEnvVars;
        if (options.fillKeys && postReport.missingEnvVars.length > 0) {
          if (!process.stdin.isTTY) {
            throw new Error("--fill-keys 需要交互终端");
          }
          console.log("对端缺失的 API Key（逐项填入，回车跳过，输入不回显）：");
          const updates: Record<string, string> = {};
          for (const envVar of postReport.missingEnvVars) {
            const value = await askSecret(`  ${envVar}: `);
            if (value) updates[envVar] = value;
          }
          if (Object.keys(updates).length > 0) {
            const upsertResult = await runSyncAgent<SyncAgentEnvUpsertResult>(host, ["env-upsert"], {
              input: { updates },
              ...(options.path ? { openclawPath: options.path } : {})
            });
            const filled = new Set<string>();
            for (const item of upsertResult.results) {
              console.log(`  ${item.envVar}：${item.ok ? "已写入对端 .env 托管块" : `失败（${item.error ?? "未知错误"}）`}`);
              if (item.ok) filled.add(item.envVar);
            }
            remainingMissing = postReport.missingEnvVars.filter((envVar) => !filled.has(envVar));
            if (filled.size > 0) {
              console.log("已更新的 Key 需 sync-env + restart Gateway，运行中进程才会加载新值");
            }
          }
        }

        printCheckReport({ ...postReport, missingEnvVars: remainingMissing });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
