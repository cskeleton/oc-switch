#!/usr/bin/env bun
/**
 * Phase 5.3 验收烟雾测试
 * 使用临时 fixture 目录，不修改用户真实 OpenClaw 配置。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { listBackups } from "../packages/core/src/backup-manager";
import { parseLaunchAgentGatewayMetadata } from "../packages/core/src/gateway-launchd-metadata";
import { discoverPluginCatalog } from "../packages/core/src/plugin-catalog";
import { discoverRuntimeModelCatalog } from "../packages/core/src/runtime-model-catalog";
import { discoverLinuxOpenClawRuntime } from "../packages/core/src/path-discovery-linux";
import { discoverMacOSOpenClawRuntime } from "../packages/core/src/path-discovery-macos";
import { validateRuntimePathSelection } from "../packages/core/src/paths";
import type {
  RuntimeDiscoveryDependencies,
  RuntimeDiscoveryResult,
  RuntimePathCandidateGroup
} from "../packages/core/src/runtime-discovery-types";
import { writeOpenClawTransaction } from "../packages/core/src/transaction-writer";
import { upsertDisabledProviderState } from "../packages/core/src/provider-states";
import type { OpenClawConfig } from "../packages/core/src/types";
import modelPolicyAcceptance from "../packages/core/test/fixtures/model-policy-acceptance.json";
import sample from "../packages/core/test/fixtures/openclaw.sample.json";
import { createApp as createServerApp } from "../packages/server/src/app";
import type { AppOptions, PluginCatalogProvider, RuntimeModelCatalogProvider } from "../packages/server/src/context";
import type { PluginProvider } from "../packages/core/src/plugin-catalog";
import type { ModelInventory } from "../packages/core/src/model-inventory";

const repoRoot = join(import.meta.dir, "..");
const CLI_ENTRY = join(repoRoot, "packages/cli/src/index.ts");
const fixtureBuiltinDir = join(repoRoot, "packages/core/test/fixtures/presets/builtin");
const TOKEN = "acceptance-smoke-token";
const SERVER_PORT = 17_421;

/** 旧场景也必须显式提供运行时事实，不能在新增写入预检后意外探测开发机。 */
function fixtureRuntimeCommands(config: OpenClawConfig, plugins: PluginProvider[] = []) {
  const models = [
    ...Object.entries(config.models?.providers ?? {}).flatMap(([providerId, provider]) =>
      (provider.models ?? []).map(model => ({ key: `${providerId}/${model.id}`, available: true }))),
    ...plugins.flatMap(provider => provider.models.map(model => ({ key: `${provider.providerId}/${model.id}`, available: provider.enabled })))
  ];
  const result = (value: unknown) => ({ status: 0, timedOut: false, stdout: JSON.stringify(value) });
  return {
    version: { status: 0, timedOut: false, stdout: "OpenClaw acceptance fixture" },
    status: result({ allowed: Object.keys(config.agents?.defaults?.models ?? {}) }),
    list: result({ models }), listAll: result({ models })
  };
}

function createApp(options: AppOptions) {
  return createServerApp({
    ...options,
    pluginCatalogProvider: options.pluginCatalogProvider ?? emptyPluginCatalog,
    runtimeDiscoveryProvider: options.runtimeDiscoveryProvider ?? (() => discoveryResult([])),
    runtimeModelCatalogProvider: options.runtimeModelCatalogProvider ?? ((paths) => {
      const config = JSON.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
      const commands = fixtureRuntimeCommands(config, options.pluginCatalogProvider?.(paths).providers);
      return discoverRuntimeModelCatalog({ runCommand: (_command, args) => {
        const key = args[0] === "--version" ? "version" : args[1] === "status" ? "status" : args.includes("--all") ? "listAll" : "list";
        return commands[key];
      } });
    })
  });
}

/**
 * 假 OpenClaw 需要回放的运行时目录 fixtures（runtime spec §13.4）：
 * 五个必含场景的数据全部集中在这里，fake 脚本与断言共用同一份事实源。
 */
interface RuntimeProbeFixtures {
  /** `openclaw --version` 的 stdout（纯文本版本串） */
  version: string;
  /** `openclaw models status --json` 的 stdout 对象（allowed / fallbacks / defaultModel） */
  status: Record<string, unknown>;
  /** `openclaw models list --json` 的 stdout 对象（当前可见目录） */
  list: Record<string, unknown>;
  /** `openclaw models list --all --json` 的 stdout 对象（完整目录） */
  listAll: Record<string, unknown>;
}

/**
 * 生成 fake `openclaw` 可执行脚本（PATH 前置注入）。
 *
 * - 同一个脚本按 argv 分发 `--version` / `plugins list` / `models status` /
 *   `models list` / `models list --all` 五类回放；fixture JSON 落在脚本同目录
 *   的 `fixtures/` 下，每次按临时 config 回放真实状态，不在测试步骤里替它手动同步；
 * - 失败模式经环境变量 `OC_FAKE_OPENCLAW_MODE` 切换：
 *   `timeout`（探测命令 sleep 30，触发 oc-switch 8s 超时）、
 *   `invalid-json`（探测命令打印非 JSON 噪音）、默认正常回放；
 * - `models status` fixture 里带一个假密钥字段（`authToken`），core 的白名单提取
 *   必须丢弃它，断言据此验证任何输出都不回显该值。
 */
function writeFakeOpenClawScript(
  dir: string,
  pluginsListJson: string,
  fixtures: RuntimeProbeFixtures
): string {
  const fixtureDir = join(dir, "fixtures");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "version.txt"), `${fixtures.version}\n`);
  writeFileSync(join(fixtureDir, "plugins.json"), `${pluginsListJson}\n`);
  writeFileSync(join(fixtureDir, "status.json"), `${JSON.stringify(fixtures.status)}\n`);
  writeFileSync(join(fixtureDir, "list.json"), `${JSON.stringify(fixtures.list)}\n`);
  writeFileSync(join(fixtureDir, "list-all.json"), `${JSON.stringify(fixtures.listAll)}\n`);

  const script = join(dir, "openclaw");
  writeFileSync(script, `#!/usr/bin/env bun
// oc-switch acceptance fake openclaw（隔离 fixture，绝不触碰真实 ~/.openclaw）
import { readFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(import.meta.dir, "fixtures");
const args = process.argv.slice(2);
const mode = process.env.OC_FAKE_OPENCLAW_MODE;
const read = name => JSON.parse(readFileSync(join(dir, name), "utf8"));
const emit = value => console.log(JSON.stringify(value));
if (args[0] !== "plugins" && mode === "timeout") await Bun.sleep(30_000);
if (args[0] === "--version") {
  console.log(readFileSync(join(dir, "version.txt"), "utf8").trim());
  process.exit(0);
}
if (args[0] === "models" && mode === "invalid-json") {
  console.log("<html>gateway crashed</html>");
  process.exit(0);
}
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const defaults = config.agents?.defaults ?? {};
const plugins = read("plugins.json");
for (const plugin of plugins.plugins) plugin.enabled = config.plugins?.entries?.[plugin.id]?.enabled ?? plugin.enabled;
if (args[0] === "plugins" && args[1] === "list") { emit(plugins); process.exit(0); }
const identity = ref => { const slash = ref.indexOf("/"); return ref.slice(0, slash).toLowerCase() + ref.slice(slash); };
const policy = Array.isArray(defaults.modelPolicy?.allow) ? defaults.modelPolicy.allow.filter(ref => typeof ref === "string") : undefined;
const primary = typeof defaults.model === "string" ? defaults.model : defaults.model?.primary;
const fallbacks = typeof defaults.model === "object" ? defaults.model?.fallbacks ?? [] : [];
const refs = new Set([...Object.keys(defaults.models ?? {}), ...(policy ?? []).filter(ref => !ref.endsWith("/*")), ...(primary ? [primary] : []), ...fallbacks].map(identity));
const disabled = new Set(plugins.plugins.filter(plugin => !plugin.enabled).flatMap(plugin => plugin.providerIds));
const catalog = read("list-all.json").models.filter(entry => entry.missing !== true);
if (args[0] === "models" && args[1] === "status") {
  const payload = read("status.json");
  payload.allowed = policy === undefined ? Object.keys(defaults.models ?? {}) : policy.length === 0 ? catalog.map(entry => entry.key)
    : [...policy.filter(ref => !ref.endsWith("/*")), ...catalog.filter(entry => policy.some(ref => ref.endsWith("/*") && identity(entry.key).startsWith(identity(ref).slice(0, -1)))).map(entry => entry.key)];
  payload.allowed = [...new Set(payload.allowed)];
  payload.defaultModel = primary;
  payload.fallbacks = fallbacks;
  emit(payload);
} else if (args[0] === "models" && args[1] === "list") {
  const all = args.includes("--all");
  const payload = read(all ? "list-all.json" : "list.json");
  payload.models = payload.models.filter(entry => entry.missing === true ? !all && refs.has(identity(entry.key)) : all || !disabled.has(entry.key.split("/")[0]))
    .map(entry => { if (!disabled.has(entry.key.split("/")[0])) return entry; const { available, ...rest } = entry; return rest; });
  emit(payload);
} else process.exit(1);
`);
  chmodSync(script, 0o755);
  return script;
}

/**
 * 验收必须与本机安装了哪些 OpenClaw 插件无关：默认注入空插件目录，
 * 需要覆盖插件路径的场景显式注入固定 catalog。
 */
const emptyPluginCatalog: PluginCatalogProvider = () => ({ providers: [], plugins: [], diagnostics: [] });

function acceptancePluginCatalog(overrides: Partial<PluginProvider> = {}): PluginCatalogProvider {
  return () => ({
    providers: [{
      pluginId: "opencode",
      providerId: "opencode",
      origin: "npm-global",
      enabled: true,
      baseUrl: "https://opencode.ai/zen/v1",
      api: "openai-completions",
      models: [{ id: "big-pickle" }, { id: "hy3" }],
      apiKeyEnvVars: ["OPENCODE_API_KEY"],
      ...overrides
    }],
    plugins: [],
    diagnostics: []
  });
}
/** fixture 专用密钥，任何响应/探测结果都不得回显 */
const FIXTURE_SECRET = "acceptance-fixture-secret-NEVER-LEAK";

/** 疑似真实密钥的输出模式（与 builtin-presets 测试保持一致） */
const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{8,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/i,
  /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

/** 扫描输出，确保不含 API Key 形态字符串 */
function assertNoSecrets(text: string, label: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      fail(`${label} 输出疑似包含密钥: ${pattern}`);
    }
  }
  if (text.includes(FIXTURE_SECRET)) {
    fail(`${label} 输出包含 fixture 密钥明文`);
  }
}

interface ModelPolicyAcceptanceExpectation {
  enabled: boolean;
  selectionSource?: string;
  alias?: string;
}

interface ModelPolicyAcceptanceScenario {
  id: string;
  config: OpenClawConfig;
  disabledProviderIds: string[];
  expected: {
    status: {
      modelPolicyMode: string;
      allowlistModelCount: number;
      effectiveModelCount: number;
    };
    models: Record<string, ModelPolicyAcceptanceExpectation>;
    providers: Record<string, { disabled: boolean; enabledModelCount: number }>;
  };
}

/**
 * 通过真实文件读取与 REST 路由验证 model policy 三态；fixture 全部脱敏且只写临时目录。
 */
async function assertModelPolicyAcceptance(rootDir: string, outputs: string[]): Promise<void> {
  const scenarios = modelPolicyAcceptance.scenarios as ModelPolicyAcceptanceScenario[];
  const observedModes = new Set<string>();

  for (const scenario of scenarios) {
    const scenarioDir = join(rootDir, `model-policy-${scenario.id}`);
    const stateDir = join(scenarioDir, ".oc-switch");
    const customDir = join(stateDir, "presets", "custom");
    const openclawPath = join(scenarioDir, "openclaw.json");
    const envPath = join(scenarioDir, ".env");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(openclawPath, `${JSON.stringify(scenario.config, null, 2)}\n`);
    writeFileSync(envPath, "");

    for (const providerId of scenario.disabledProviderIds) {
      upsertDisabledProviderState(stateDir, {
        providerId,
        openclawPath,
        disabledAt: "2026-01-01T00:00:00.000Z",
        allowlistEntries: {}
      });
    }

    const beforeConfig = readFileSync(openclawPath, "utf8");
    const app = createApp({
      token: TOKEN,
      paths: { openclawPath, envPath, stateDir },
      presetDirs: { builtinDir: fixtureBuiltinDir, customDir },
      pluginCatalogProvider: emptyPluginCatalog
    });
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const statusResponse = await app.request("/api/status", { headers });
    const modelsResponse = await app.request("/api/models", { headers });
    const providersResponse = await app.request("/api/providers", { headers });
    const configStatusResponse = await app.request("/api/config-status", { headers });
    assert(statusResponse.status === 200, `${scenario.id}: status REST 应成功`);
    assert(modelsResponse.status === 200, `${scenario.id}: models REST 应成功`);
    assert(providersResponse.status === 200, `${scenario.id}: providers REST 应成功`);
    assert(configStatusResponse.status === 200, `${scenario.id}: config-status REST 应成功`);

    const status = await statusResponse.json() as Record<string, unknown>;
    const modelsBody = await modelsResponse.json() as { models: Array<Record<string, unknown>> };
    const providersBody = await providersResponse.json() as { providers: Array<Record<string, unknown>> };
    const configStatus = await configStatusResponse.json() as {
      modelPolicy?: { mode?: string; effectiveCatalogCount?: number };
    };
    outputs.push(JSON.stringify({ status, modelsBody, providersBody, configStatus }));
    observedModes.add(String(status.modelPolicyMode));

    assert(status.modelPolicyMode === scenario.expected.status.modelPolicyMode, `${scenario.id}: policy mode 不符`);
    assert(status.allowlistModelCount === scenario.expected.status.allowlistModelCount, `${scenario.id}: metadata 计数不符`);
    assert(status.effectiveModelCount === scenario.expected.status.effectiveModelCount, `${scenario.id}: 有效目录计数不符`);
    assert(configStatus.modelPolicy?.mode === scenario.expected.status.modelPolicyMode, `${scenario.id}: config-status mode 不符`);
    assert(
      configStatus.modelPolicy?.effectiveCatalogCount === scenario.expected.status.effectiveModelCount,
      `${scenario.id}: config-status 有效目录计数不符`
    );

    for (const [ref, expected] of Object.entries(scenario.expected.models)) {
      const model = modelsBody.models.find((item) => item.ref === ref);
      assert(Boolean(model), `${scenario.id}: 缺少模型 ${ref}`);
      assert(model?.enabled === expected.enabled, `${scenario.id}: ${ref} enabled 不符`);
      assert(model?.selectionSource === expected.selectionSource, `${scenario.id}: ${ref} selectionSource 不符`);
      assert(model?.alias === expected.alias, `${scenario.id}: ${ref} alias 不符`);
    }

    for (const [providerId, expected] of Object.entries(scenario.expected.providers)) {
      const provider = providersBody.providers.find((item) => item.id === providerId);
      assert(Boolean(provider), `${scenario.id}: 缺少 Provider ${providerId}`);
      assert(provider?.disabled === expected.disabled, `${scenario.id}: ${providerId} disabled 不符`);
      assert(
        provider?.enabledModelCount === expected.enabledModelCount,
        `${scenario.id}: ${providerId} 有效模型计数不符`
      );
    }

    assert(readFileSync(openclawPath, "utf8") === beforeConfig, `${scenario.id}: 只读验收不得修改配置`);
  }

  assert(
    ["legacy", "unrestricted", "restricted"].every((mode) => observedModes.has(mode)),
    "model policy acceptance fixture 必须覆盖 legacy、unrestricted、restricted 三态"
  );
}

/** 运行 CLI 子进程并收集 stdout/stderr */
async function runCli(args: string[], env: Record<string, string>) {
  if (!env.HOME || env.HOME === process.env.HOME) throw new Error("acceptance CLI requires an isolated HOME");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, OPENCLAW_HOME: env.HOME, OPENCLAW_STATE_DIR: join(env.HOME, ".openclaw") };
  if (!env.PATH) {
    const fakeDir = join(env.HOME, "default-fake-bin");
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(join(fakeDir, "openclaw"), '#!/bin/sh\n[ "$1 $2" = "plugins list" ] || exit 1\nprintf \'%s\\n\' \'{"plugins":[]}\'\n', { mode: 0o755 });
    const config = JSON.parse(readFileSync(env.OPENCLAW_CONFIG_PATH!, "utf8")) as OpenClawConfig;
    const mockPath = join(fakeDir, "runtime.json");
    writeFileSync(mockPath, JSON.stringify(fixtureRuntimeCommands(config)));
    childEnv.PATH = `${fakeDir}:${process.env.PATH ?? ""}`;
    childEnv.OC_SWITCH_MOCK_RUNTIME_MODELS = mockPath;
  }
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: repoRoot,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe"
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr, combined: stdout + stderr };
}

function plistWithArgs(args: string[]): string {
  return `<?xml version="1.0"?>
<plist><dict><key>ProgramArguments</key><array>
${args.map((arg) => `<string>${arg}</string>`).join("\n")}
</array></dict></plist>`;
}

function discoveryGroup(
  partial: Partial<RuntimePathCandidateGroup> & Pick<
    RuntimePathCandidateGroup,
    "candidateId" | "instanceId" | "stateDir" | "openclawPath" | "envPath" | "serviceEnvPath"
  >
): RuntimePathCandidateGroup {
  return {
    pid: 42,
    evidence: ["systemd-unit"],
    serviceManager: "systemd",
    confidence: "strong",
    ...partial
  };
}

function discoveryResult(groups: RuntimePathCandidateGroup[]): RuntimeDiscoveryResult {
  return {
    status: groups.length ? "resolved" : "gateway-not-detected",
    instances: groups.map((group) => ({
      instanceId: group.instanceId,
      pid: group.pid,
      openclawPath: group.openclawPath,
      envPath: group.envPath,
      stateDir: group.stateDir,
      ...(group.serviceEnvPath ? { serviceEnvPath: group.serviceEnvPath } : {}),
      ...(group.serviceManager ? { serviceManager: group.serviceManager } : {}),
      evidence: group.evidence,
      ...(group.confidence ? { confidence: group.confidence } : {})
    })),
    candidateGroups: groups,
    diagnostics: []
  };
}

/**
 * 跨平台 runtime discovery / 多实例隔离 / service-env 拒绝 验收
 * 全部使用临时 fixture 与注入依赖，不触碰真实 OpenClaw 配置。
 */
async function assertRuntimeDiscoveryAcceptance(outputs: string[]): Promise<void> {
  const runtimeDir = mkdtempSync(join(tmpdir(), "oc-switch-acceptance-runtime-"));
  try {
    // --- Linux：无 --config 的默认 systemd（由 gateway.systemd.env 推导 state dir）---
    const linuxDefaultDeps: RuntimeDiscoveryDependencies = {
      platform: "linux",
      homeDir: "/home/alice",
      userId: undefined,
      listGatewayProcesses: () => [{
        pid: 401,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway", "--port", "18789"]
      }],
      readTextFile: (path) => {
        if (path === "/proc/401/environ") {
          return [
            "HOME=/home/alice",
            "OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service",
            `SECRET_TOKEN=${FIXTURE_SECRET}`
          ].join("\0");
        }
        if (path.endsWith("openclaw-gateway.service")) {
          return "[Service]\nEnvironmentFile=/home/alice/.openclaw/gateway.systemd.env\n";
        }
        throw new Error("ENOENT");
      },
      listDirectory: (path) => path.endsWith("/systemd/user")
        ? ["openclaw-gateway.service"]
        : [],
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=401",
          "FragmentPath=/home/alice/.config/systemd/user/openclaw-gateway.service"
        ].join("\n"),
        timedOut: false
      }),
      pathExists: (path) => path === "/home/alice/.openclaw/openclaw.json"
    };
    const linuxDefault = discoverLinuxOpenClawRuntime(linuxDefaultDeps);
    outputs.push(JSON.stringify(linuxDefault));
    assert(linuxDefault.status === "resolved", "Linux 无 --config systemd 应 resolved");
    assert(
      linuxDefault.instances[0]?.stateDir === "/home/alice/.openclaw",
      "Linux 无 --config 应由 gateway.systemd.env 推导 state dir"
    );
    assert(
      linuxDefault.instances[0]?.envPath === "/home/alice/.openclaw/.env",
      "Linux 管理源应为 state dir 下 .env"
    );
    assert(
      linuxDefault.instances[0]?.serviceEnvPath === "/home/alice/.openclaw/gateway.systemd.env",
      "Linux 应记录 canonical service env"
    );
    assert(
      linuxDefault.instances[0]?.openclawPath === "/home/alice/.openclaw/openclaw.json",
      "Linux 无 --config 时 config 应为 state dir 默认 openclaw.json"
    );

    // --- Linux：自定义 EnvironmentFile（不得猜测 canonical 路径）---
    const customEnvFile = "/srv/alpha/runtime/custom gateway.env";
    const linuxCustomDeps: RuntimeDiscoveryDependencies = {
      platform: "linux",
      homeDir: "/home/alice",
      userId: undefined,
      listGatewayProcesses: () => [{
        pid: 402,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      readTextFile: (path) => {
        if (path === "/proc/402/environ") {
          return [
            "HOME=/home/alice",
            "OPENCLAW_STATE_DIR=/srv/alpha",
            "OPENCLAW_CONFIG_PATH=/etc/openclaw/alpha.json",
            "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service",
            `API_KEY=${FIXTURE_SECRET}`
          ].join("\0");
        }
        if (path.endsWith("openclaw-alpha.service")) {
          // 与 unit 测试一致：带空格的自定义 EnvironmentFile 需引号
          return `[Service]\nEnvironmentFile=-"${customEnvFile}"\n`;
        }
        throw new Error("ENOENT");
      },
      listDirectory: (path) => path.endsWith("/systemd/user")
        ? ["openclaw-alpha.service"]
        : [],
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=402",
          "FragmentPath=/home/alice/.config/systemd/user/openclaw-alpha.service"
        ].join("\n"),
        timedOut: false
      }),
      pathExists: (path) => path === "/etc/openclaw/alpha.json"
    };
    const linuxCustom = discoverLinuxOpenClawRuntime(linuxCustomDeps);
    outputs.push(JSON.stringify(linuxCustom));
    assert(
      linuxCustom.instances[0]?.serviceEnvPath === customEnvFile,
      "Linux 自定义 EnvironmentFile 必须使用 unit 实际目标，而非猜测 canonical gateway.systemd.env"
    );
    assert(
      linuxCustom.instances[0]?.envPath === "/srv/alpha/.env",
      "Linux 自定义 EnvironmentFile 时管理源仍为 state dir .env"
    );

    // --- macOS：当前 /bin/sh + wrapper 布局 ---
    const macStateDir = "/Users/alice/.openclaw";
    const macServiceEnv = `${macStateDir}/service-env/ai.openclaw.gateway.env`;
    const macWrapper = `${macStateDir}/service-env/ai.openclaw.gateway-env-wrapper.sh`;
    const currentArgs = [
      "/bin/sh",
      macWrapper,
      macServiceEnv,
      "/usr/local/bin/node",
      "/opt/openclaw/dist/index.js",
      "gateway",
      "--port",
      "18789"
    ];
    const currentMeta = parseLaunchAgentGatewayMetadata(plistWithArgs(currentArgs));
    assert(currentMeta.wrapperPath === macWrapper, "macOS 当前布局应解析 wrapper");
    assert(currentMeta.serviceEnvPath === macServiceEnv, "macOS 当前布局应解析 service env");
    assert(
      currentMeta.gatewayCommand[0] === "/usr/local/bin/node"
        && currentMeta.gatewayCommand.includes("gateway"),
      "macOS 当前布局应解包 Gateway command"
    );

    const macCurrentDeps: RuntimeDiscoveryDependencies = {
      platform: "darwin",
      homeDir: "/Users/alice",
      userId: 501,
      listGatewayProcesses: () => [{
        pid: 501,
        argv: ["/usr/local/bin/node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      readTextFile: (path) => {
        if (path.endsWith("ai.openclaw.gateway.plist")) return plistWithArgs(currentArgs);
        if (path === macServiceEnv) {
          return [
            `OPENCLAW_STATE_DIR=${macStateDir}`,
            `API_KEY=${FIXTURE_SECRET}`
          ].join("\n");
        }
        throw new Error("ENOENT");
      },
      listDirectory: (path) => path.endsWith("/LaunchAgents")
        ? ["ai.openclaw.gateway.plist"]
        : [],
      runCommand: () => ({ status: 0, stdout: "pid = 501\n", timedOut: false }),
      pathExists: () => true
    };
    const macCurrent = discoverMacOSOpenClawRuntime(macCurrentDeps);
    outputs.push(JSON.stringify(macCurrent));
    assert(macCurrent.status === "resolved", "macOS 当前 wrapper 应 resolved");
    assert(
      macCurrent.instances[0]?.serviceEnvPath === macServiceEnv,
      "macOS 当前布局应绑定 service-env"
    );
    assert(
      macCurrent.instances[0]?.envPath === `${macStateDir}/.env`,
      "macOS 管理源应为 state dir .env"
    );

    // --- macOS：旧 wrapper 布局（无 /bin/sh）---
    const legacyArgs = currentArgs.slice(1);
    const legacyMeta = parseLaunchAgentGatewayMetadata(plistWithArgs(legacyArgs));
    assert(legacyMeta.wrapperPath === macWrapper, "macOS 旧布局应解析同一 wrapper");
    assert(legacyMeta.serviceEnvPath === macServiceEnv, "macOS 旧布局应解析同一 service env");
    assert(
      JSON.stringify(legacyMeta.gatewayCommand) === JSON.stringify(currentMeta.gatewayCommand),
      "macOS 新旧布局解包后的 Gateway command 应一致"
    );

    const macLegacyDeps: RuntimeDiscoveryDependencies = {
      ...macCurrentDeps,
      readTextFile: (path) => {
        if (path.endsWith("ai.openclaw.gateway.plist")) return plistWithArgs(legacyArgs);
        if (path === macServiceEnv) return `OPENCLAW_STATE_DIR=${macStateDir}\nSECRET=${FIXTURE_SECRET}`;
        throw new Error("ENOENT");
      }
    };
    const macLegacy = discoverMacOSOpenClawRuntime(macLegacyDeps);
    outputs.push(JSON.stringify(macLegacy));
    assert(macLegacy.status === "resolved", "macOS 旧 wrapper 应 resolved");
    assert(
      macLegacy.instances[0]?.serviceEnvPath === macServiceEnv,
      "macOS 旧布局应绑定同一 service-env"
    );

    // --- A/B 多实例隔离：同步 A 不得改写 B ---
    const openclawA = join(runtimeDir, "a", "openclaw.json");
    const envA = join(runtimeDir, "a", ".env");
    const serviceEnvA = join(runtimeDir, "a", "gateway.env");
    const openclawB = join(runtimeDir, "b", "openclaw.json");
    const envB = join(runtimeDir, "b", ".env");
    const serviceEnvB = join(runtimeDir, "b", "gateway.env");
    const stateDir = join(runtimeDir, ".oc-switch");
    mkdirSync(join(runtimeDir, "a"), { recursive: true });
    mkdirSync(join(runtimeDir, "b"), { recursive: true });
    writeFileSync(openclawA, `${JSON.stringify(sample, null, 2)}\n`);
    writeFileSync(openclawB, `${JSON.stringify(sample, null, 2)}\n`);
    writeFileSync(envA, "# oc-switch:start\nNVIDIA_API_KEY=old-a\n# oc-switch:end\n");
    writeFileSync(envB, "# oc-switch:start\nNVIDIA_API_KEY=old-b\n# oc-switch:end\n");
    writeFileSync(serviceEnvA, "KEEP_A=1\n");
    writeFileSync(serviceEnvB, "KEEP_B=1\n");

    const groupA = discoveryGroup({
      candidateId: "systemd:a:acceptance",
      instanceId: "systemd:a",
      stateDir: join(runtimeDir, "a"),
      openclawPath: openclawA,
      envPath: envA,
      serviceEnvPath: serviceEnvA,
      pid: 1
    });
    const groupB = discoveryGroup({
      candidateId: "systemd:b:acceptance",
      instanceId: "systemd:b",
      stateDir: join(runtimeDir, "b"),
      openclawPath: openclawB,
      envPath: envB,
      serviceEnvPath: serviceEnvB,
      pid: 2
    });

    const txResult = await writeOpenClawTransaction({
      openclawPath: openclawA,
      envPath: envA,
      stateDir,
      reason: "acceptance A/B isolation",
      envUpdates: { NVIDIA_API_KEY: "secret-only-for-a" },
      runtimeDiscoveryProvider: () => discoveryResult([groupA, groupB]),
      mutate(config) {
        return config;
      }
    });
    outputs.push(JSON.stringify(txResult.gatewayEnvSync ?? {}));
    assert(txResult.gatewayEnvSync?.ok === true, "唯一匹配 A 时应自动 sync 成功");
    assert(
      readFileSync(serviceEnvA, "utf8").includes("NVIDIA_API_KEY=secret-only-for-a"),
      "A 的 service env 应收到托管块"
    );
    assert(
      readFileSync(serviceEnvB, "utf8") === "KEEP_B=1\n",
      "B 的 service env 不得被 A 的写入修改"
    );

    // --- service env 拒绝成为 active envPath ---
    let rejected = false;
    try {
      validateRuntimePathSelection({
        openclawPath: openclawA,
        envPath: serviceEnvA,
        discovery: discoveryResult([groupA, groupB])
      });
    } catch (error) {
      rejected = true;
      assert(
        error instanceof Error && error.message.includes("service env"),
        "拒绝 service env 时应说明其为运行时快照"
      );
    }
    assert(rejected, "已知 serviceEnvPath 不得通过 env 切换校验");

    // --- API：拒绝 service env + 响应不含 fixture 密钥 ---
    const customDir = join(stateDir, "presets", "custom");
    mkdirSync(customDir, { recursive: true });
    const discoveryForApi = discoveryResult([groupA, groupB]);
    // 故意在 discovery 旁路数据中不塞密钥；探测侧密钥已在上方断言不泄漏
    const app = createApp({
      token: TOKEN,
      paths: { openclawPath: openclawA, envPath: envA, stateDir },
      presetDirs: { builtinDir: fixtureBuiltinDir, customDir },
      runtimeDiscoveryProvider: () => discoveryForApi,
      pluginCatalogProvider: emptyPluginCatalog
    });
    const server = Bun.serve({
      port: SERVER_PORT + 1,
      hostname: "127.0.0.1",
      fetch: app.fetch
    });
    try {
      const baseUrl = `http://127.0.0.1:${SERVER_PORT + 1}`;
      const pathsGet = await fetch(`${baseUrl}/api/settings/paths`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      const pathsJson = await pathsGet.json() as Record<string, unknown>;
      const pathsText = JSON.stringify(pathsJson);
      outputs.push(pathsText);
      assert(pathsGet.status === 200, "GET /api/settings/paths 应成功");
      assert(!pathsText.includes(FIXTURE_SECRET), "paths 响应不得含 fixture 密钥");
      const groups = pathsJson.runtimeCandidateGroups as Array<{ serviceEnvPath?: string }> | undefined;
      assert(Array.isArray(groups) && groups.length === 2, "paths 应返回 A/B 候选组");
      assert(
        !(pathsJson.envPaths as Array<{ path: string }>).some((item) => item.path === serviceEnvA),
        "service env 不得出现在可编辑 envPaths"
      );

      const rejectPut = await fetch(`${baseUrl}/api/settings/paths`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          openclawPath: openclawA,
          envPath: serviceEnvA
        })
      });
      const rejectBody = await rejectPut.text();
      outputs.push(rejectBody);
      assert(rejectPut.status === 400, "PUT 将 service env 设为 active 应返回 400");
      assert(rejectBody.includes("service env") || rejectBody.includes("运行时"), "400 应说明 service env 不可用");
      assert(!rejectBody.includes(FIXTURE_SECRET), "拒绝响应不得含 fixture 密钥");
    } finally {
      server.stop();
    }
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

/**
 * 插件 provider 只读验收：合并展示、编排放行、破坏性写操作 fail closed。
 * 全程注入固定插件 catalog，不依赖本机 openclaw。
 */
async function assertPluginProviderAcceptance(rootDir: string, outputs: string[]): Promise<void> {
  const scenarioDir = join(rootDir, "plugin-provider");
  const stateDir = join(scenarioDir, ".oc-switch");
  const customDir = join(stateDir, "presets", "custom");
  const openclawPath = join(scenarioDir, "openclaw.json");
  const envPath = join(scenarioDir, ".env");
  mkdirSync(customDir, { recursive: true });
  const config = JSON.parse(JSON.stringify(sample)) as OpenClawConfig;
  // 让 policy 指向插件 ref：修正前会被 config-status 误报为 unknown provider
  config.agents!.defaults!.modelPolicy = { allow: ["opencode/big-pickle", "minimax-portal/MiniMax-M3"] };
  writeFileSync(openclawPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(envPath, "");

  const headers = { Authorization: `Bearer ${TOKEN}` };
  const paths = { openclawPath, envPath, stateDir };
  const presetDirs = { builtinDir: fixtureBuiltinDir, customDir };

  // --- 未注入插件目录：插件 ref 被报为 unknown provider（回归基线） ---
  const baseline = createApp({ token: TOKEN, paths, presetDirs, pluginCatalogProvider: emptyPluginCatalog });
  const baselineStatus = await (await baseline.request("/api/config-status", { headers })).json() as {
    modelPolicy: { unknownProviderRefs: string[] };
  };
  outputs.push(JSON.stringify(baselineStatus));
  assert(
    baselineStatus.modelPolicy.unknownProviderRefs.includes("opencode/big-pickle"),
    "无插件目录时插件 ref 应仍被视为 unknown provider"
  );

  // --- 注入启用中的插件目录 ---
  const app = createApp({ token: TOKEN, paths, presetDirs, pluginCatalogProvider: acceptancePluginCatalog() });
  const before = readFileSync(openclawPath, "utf8");

  const providersBody = await (await app.request("/api/providers", { headers })).json() as {
    providers: Array<{ id: string; source: string; disabled: boolean; apiKeyEnv: string | null }>;
  };
  const modelsBody = await (await app.request("/api/models", { headers })).json() as {
    models: Array<{ ref: string; enabled: boolean }>;
  };
  const configStatus = await (await app.request("/api/config-status", { headers })).json() as {
    modelPolicy: { unknownProviderRefs: string[]; effectiveCatalogCount: number };
  };
  const statusBody = await (await app.request("/api/status", { headers })).json() as Record<string, unknown>;
  outputs.push(JSON.stringify({ providersBody, modelsBody, configStatus, statusBody }));

  const pluginRow = providersBody.providers.find((item) => item.id === "opencode");
  assert(Boolean(pluginRow), "providers 应含插件条目 opencode");
  assert(pluginRow?.source === "plugin", "插件条目 source 应为 plugin");
  assert(pluginRow?.disabled === false, "启用中的插件条目不应标记 disabled");
  assert(pluginRow?.apiKeyEnv === "OPENCODE_API_KEY", "插件条目应取 manifest 声明的 env 变量");
  assert(
    providersBody.providers.find((item) => item.id === "nvidia")?.source === "config",
    "config 条目 source 应为 config"
  );
  assert(
    modelsBody.models.some((item) => item.ref === "opencode/big-pickle" && item.enabled),
    "policy exact 命中的插件模型应为已启用"
  );
  assert(
    !configStatus.modelPolicy.unknownProviderRefs.includes("opencode/big-pickle"),
    "插件 ref 不应再被误报为 unknown provider"
  );
  assert(
    statusBody.effectiveModelCount === configStatus.modelPolicy.effectiveCatalogCount,
    "status 与 config-status 的有效目录计数必须一致"
  );
  assert(readFileSync(openclawPath, "utf8") === before, "只读探测不得修改配置");

  // --- 破坏性写操作对插件 provider fail closed ---
  const deleteResponse = await app.request("/api/providers/opencode", { method: "DELETE", headers });
  assert(deleteResponse.status === 400, "删除插件 provider 应被拒绝");
  const stateResponse = await app.request("/api/providers/opencode/state", {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false })
  });
  assert(stateResponse.status === 400, "关闭插件 provider 应被拒绝");
  assert(readFileSync(openclawPath, "utf8") === before, "被拒绝的写操作不得修改配置");

  // --- 停用插件的 ref 不可启用 ---
  const disabledApp = createApp({
    token: TOKEN,
    paths,
    presetDirs,
    pluginCatalogProvider: acceptancePluginCatalog({ enabled: false })
  });
  const enableResponse = await disabledApp.request("/api/models", {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ref: "opencode/hy3", enabled: true })
  });
  assert(enableResponse.status === 400, "停用插件的模型不应可启用");
  assert(readFileSync(openclawPath, "utf8") === before, "拒绝启用后配置不得变化");

  // --- 编排放行：主模型可指向插件 ref（写在临时 fixture 上） ---
  const primaryResponse = await app.request("/api/models/primary", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ref: "opencode/big-pickle" })
  });
  assert(primaryResponse.status === 200, "主模型指向插件 ref 应成功");
  const afterConfig = JSON.parse(readFileSync(openclawPath, "utf8")) as OpenClawConfig;
  assert(
    afterConfig.agents?.defaults?.model === "opencode/big-pickle",
    "主模型应写入插件 ref"
  );
  assert(
    Boolean(afterConfig.models?.providers) && !("opencode" in afterConfig.models!.providers!),
    "插件 provider 不得被写入 models.providers"
  );
}

/**
 * 运行时模型协调验收（runtime spec §13.4 七步）。
 *
 * 全程 mkdtemp 隔离 HOME + PATH 前置 fake `openclaw`：
 * fake 脚本按 argv 回放 plugins list / models status / models list / models list --all，
 * 并经 OC_FAKE_OPENCLAW_MODE 切换 timeout / invalid-json 失败模式。
 * fixture 覆盖五个必含场景：
 * 1. policy-only unavailable exact（ghost-provider/policy-only-model，运行时 available=false）；
 * 2. runtime-only available model（nvidia/vendor/runtime-extra，仅 --all 目录可见且 available=true）；
 * 3. wildcard 展开（nvidia/* 覆盖 nvidia 目录模型 → policy-wildcard 引用来源）；
 * 4. xiaomi 插件贡献 xiaomi / xiaomi-token-plan 两个 Provider + speech 能力；
 * 5. 探测失败模式（timeout / invalid JSON → unknown，清理操作禁用）。
 */
async function assertRuntimeModelAcceptance(rootDir: string, outputs: string[]): Promise<void> {
  const scenarioDir = join(rootDir, "runtime-model");
  const stateDir = join(scenarioDir, ".oc-switch");
  const openclawPath = join(scenarioDir, "openclaw.json");
  const envPath = join(scenarioDir, ".env");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(envPath, "");

  /** 运行时探测 fixture：状态 JSON 内嵌假密钥（authToken），core 白名单提取必须丢弃 */
  const runtimeFixtures: RuntimeProbeFixtures = {
    version: "2026.9.3",
    status: {
      agentDir: scenarioDir,
      defaultModel: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/z-ai/glm5.1"],
      allowed: [
        "minimax-portal/MiniMax-M3",
        "nvidia/z-ai/glm5.1",
        "DeepSeek/deepseek-chat",
        "ghost-provider/policy-only-model",
        "xiaomi/mi-1"
      ],
      // 假密钥：绝不允许出现在任何 oc-switch 输出 / 备份里
      authToken: FIXTURE_SECRET
    },
    list: {
      models: [
        { key: "minimax-portal/MiniMax-M3", available: true, tags: [] },
        { key: "nvidia/z-ai/glm5.1", available: true, tags: [] },
        { key: "DeepSeek/deepseek-chat", available: true, tags: [] },
        { key: "ghost-provider/policy-only-model", available: false, missing: true, tags: ["missing"] },
        { key: "xiaomi/mi-1", available: true, tags: [] },
        { key: "xiaomi-token-plan/tp-1", available: true, tags: [] }
      ]
    },
    listAll: {
      models: [
        { key: "nvidia/deepseek-ai/deepseek-v4-flash", available: true, tags: [] },
        { key: "nvidia/z-ai/glm5.1", available: true, tags: [] },
        { key: "minimax-portal/MiniMax-M3", available: true, tags: [] },
        { key: "DeepSeek/deepseek-chat", available: true, tags: [] },
        { key: "xiaomi/mi-1", available: true, tags: [] },
        { key: "xiaomi/mi-2", available: true, tags: [] },
        { key: "xiaomi-token-plan/tp-1", available: true, tags: [] },
        { key: "xiaomi-token-plan/tp-2", available: true, tags: [] },
        // runtime-only available：仅完整目录可见（wildcard nvidia/* 覆盖）
        { key: "nvidia/vendor/runtime-extra", available: true, tags: [] }
      ]
    }
  };

  /** fake `openclaw plugins list` JSON：xiaomi 插件贡献两个 Provider + speech 能力 */
  const pluginsListJson = JSON.stringify({
    plugins: [{
      id: "xiaomi",
      name: "Xiaomi Provider",
      rootDir: join(scenarioDir, "fake-plugin-root"),
      origin: "npm-global",
      enabled: true,
      providerIds: ["xiaomi", "xiaomi-token-plan"],
      speechProviderIds: ["xiaomi-tts"]
    }]
  });

  /** 受 restricted policy 管理的 fixture config（wildcard 展开 + policy-only 悬空 exact） */
  function writeRuntimeConfig(): void {
    const config = JSON.parse(JSON.stringify(sample)) as OpenClawConfig;
    config.agents!.defaults!.modelPolicy = {
      allow: [
        "nvidia/*",
        "minimax-portal/MiniMax-M3",
        "DeepSeek/deepseek-chat",
        "ghost-provider/policy-only-model",
        "xiaomi/mi-1",
        "xiaomi-token-plan/*"
      ]
    };
    writeFileSync(openclawPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  // xiaomi 插件的假 manifest（plugin-catalog 读取 rootDir/openclaw.plugin.json）
  const pluginRoot = join(scenarioDir, "fake-plugin-root");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({
    modelCatalog: {
      providers: {
        xiaomi: { baseUrl: "https://xiaomi.example/v1", api: "openai-completions", models: [{ id: "mi-1" }, { id: "mi-2" }] },
        "xiaomi-token-plan": { baseUrl: "https://xiaomi.example/plan/v1", api: "openai-completions", models: [{ id: "tp-1" }, { id: "tp-2" }] }
      }
    },
    setup: { providers: [{ id: "xiaomi", envVars: ["XIAOMI_API_KEY"] }, { id: "xiaomi-token-plan", envVars: ["XIAOMI_TOKEN_PLAN_API_KEY"] }] }
  }));

  const fakeBinDir = join(scenarioDir, "fake-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  writeFakeOpenClawScript(fakeBinDir, pluginsListJson, runtimeFixtures);

  const cliEnv = {
    OPENCLAW_CONFIG_PATH: openclawPath,
    HOME: scenarioDir,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`
  };

  function assertRuntimeOutputNoSecrets(text: string, label: string): void {
    assertNoSecrets(text, label);
    if (text.includes(FIXTURE_SECRET)) {
      fail(`${label} 输出包含 fixture authToken 明文`);
    }
  }

  // ---------- Step 1/2：policy-only unavailable exact 必须显示为 policy-only + unavailable ----------
  writeRuntimeConfig();
  let result = await runCli(["models", "inventory", "--json"], cliEnv);
  outputs.push(result.combined);
  assert(result.code === 0, `models inventory --json 应成功，实际退出码 ${result.code}`);
  let inventory = JSON.parse(result.stdout) as ModelInventory;
  assertRuntimeOutputNoSecrets(result.stdout, "CLI inventory JSON");

  const policyOnly = inventory.models.find((m) => m.ref === "ghost-provider/policy-only-model");
  assert(Boolean(policyOnly), "inventory 必须包含 policy-only exact 条目（不再因缺目录而消失）");
  assert(
    policyOnly?.catalogSources.length === 0,
    "policy-only 缺失占位不得伪装成任何目录来源"
  );
  assert(
    policyOnly?.referenceSources.includes("policy-exact") === true,
    "policy-only 条目必须有 policy-exact 引用来源"
  );
  assert(policyOnly?.policyAllowed === true, "policy-only 条目 policyAllowed 应为 true（策略允许但不可用，两维不合并）");
  assert(policyOnly?.availability === "unavailable", `policy-only 条目应为 unavailable，实际 ${policyOnly?.availability}`);
  assert(
    policyOnly?.availabilityReasons.includes("provider-rejected") || policyOnly?.availabilityReasons.includes("model-not-in-catalog"),
    "policy-only 条目应携带不可用原因"
  );

  // runtime-only available：仅 --all 目录可见 + wildcard 覆盖（可 materialize）
  const runtimeOnly = inventory.models.find((m) => m.ref === "nvidia/vendor/runtime-extra");
  assert(Boolean(runtimeOnly), "inventory 必须包含 runtime-only 模型（仅运行时目录可见）");
  assert(
    runtimeOnly?.catalogSources.includes("openclaw-runtime") && !runtimeOnly?.catalogSources.includes("config"),
    "runtime-only 模型目录来源应为 openclaw-runtime 而非 config"
  );
  assert(runtimeOnly?.availability === "available", "runtime-only 模型应为 available");
  assert(
    runtimeOnly?.referenceSources.includes("policy-wildcard") === true,
    "runtime-only 模型应被 nvidia/* 通配覆盖（wildcard 展开为引用来源）"
  );
  assert(
    runtimeOnly?.capabilities.canMaterializeConfigModel === true,
    "runtime-only available 且 config Provider 存在时应可补全（canMaterializeConfigModel）"
  );

  // wildcard 展开：nvidia 目录模型获得 policy-wildcard 引用来源
  const wildcardCovered = inventory.models.find((m) => m.ref === "nvidia/deepseek-ai/deepseek-v4-flash");
  assert(
    wildcardCovered?.referenceSources.includes("policy-wildcard") === true,
    "nvidia/* 通配必须给 nvidia 目录模型添加 policy-wildcard 引用来源"
  );
  // policyRules：wildcard 不是模型行，只作为规则展示
  const wildcardRule = inventory.policyRules.find((rule) => rule.value === "nvidia/*");
  assert(wildcardRule?.kind === "wildcard", "policyRules 应含 nvidia/* wildcard 规则");
  assert(
    (wildcardRule?.matchedModelCount ?? 0) >= 2,
    "nvidia/* 规则应命中至少 2 个 nvidia 模型（wildcard 展开计数）"
  );

  // xiaomi 插件：一个插件 → 两个 Provider + speech 能力
  assert(
    inventory.plugins.some(
      (plugin) => plugin.id === "xiaomi"
        && plugin.providerIds.includes("xiaomi") && plugin.providerIds.includes("xiaomi-token-plan")
        && plugin.nonModelCapabilities.includes("speech")
    ),
    "插件 descriptor 必须把 xiaomi / xiaomi-token-plan 归属同一插件且含 speech 能力"
  );
  for (const providerId of ["xiaomi", "xiaomi-token-plan"]) {
    const provider = inventory.providers.find((p) => p.providerId === providerId);
    assert(Boolean(provider), `inventory providers 应含插件 Provider ${providerId}`);
    assert(
      provider?.pluginIds.includes("xiaomi") === true,
      `${providerId} 应归属插件 xiaomi（一个插件多 Provider）`
    );
    assert(provider?.pluginEnabled === true, `${providerId} 插件启用状态应为 true`);
    assert(
      provider?.sources.includes("plugin-manifest"),
      `${providerId} 目录来源应含 plugin-manifest`
    );
  }

  // Server inventory 与 CLI inventory 对同一 fixture 必须一致（review gate 3）。
  // createApp 在本进程内运行，环境 PATH/OPENCLAW_CONFIG_PATH 不受子进程 env 影响，
  // 故依赖注入 fake provider（与 CLI 的 PATH 前置 fake openclaw 回放同一份 fixture），
  // 保证两边对同一事实源计算（server 侧经真实 discoverPluginCatalog 的解析链路由
  // 下方 HTTP fixture 走查，不在此重复）。
  const customDir = join(stateDir, "presets", "custom");
  mkdirSync(customDir, { recursive: true });
  const runFakeOpenClaw = (_command: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number }) => {
    const result = spawnSync(join(fakeBinDir, "openclaw"), args, {
      env: { ...process.env, ...cliEnv }, encoding: "utf8", timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes
    });
    return { status: result.status, stdout: result.stdout ?? "", timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" };
  };
  const fakeCatalogProvider: PluginCatalogProvider = () => discoverPluginCatalog({ runCommand: runFakeOpenClaw });
  const fakeRuntimeProvider: RuntimeModelCatalogProvider = () => discoverRuntimeModelCatalog({ runCommand: runFakeOpenClaw });
  const app = createApp({
    token: TOKEN,
    paths: { openclawPath, envPath, stateDir },
    presetDirs: { builtinDir: fixtureBuiltinDir, customDir },
    pluginCatalogProvider: fakeCatalogProvider,
    runtimeModelCatalogProvider: fakeRuntimeProvider
  });
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const inventoryResponse = await app.request("/api/model-inventory", { headers });
  assert(inventoryResponse.status === 200, "GET /api/model-inventory 应成功");
  const serverInventory = await inventoryResponse.json() as ModelInventory;
  const serverInventoryText = JSON.stringify(serverInventory);
  outputs.push(serverInventoryText);
  assertRuntimeOutputNoSecrets(serverInventoryText, "server inventory JSON");
  const cliRefs = inventory.models.map((model) => model.ref).sort();
  const serverRefs = serverInventory.models.map((model) => model.ref).sort();
  assert(
    JSON.stringify(cliRefs) === JSON.stringify(serverRefs),
    "Server 与 CLI 对同一 fixture 的 inventory 模型集合必须一致"
  );
  assert(serverInventoryText === JSON.stringify(inventory), "Server/CLI 完整 inventory（状态、能力、规则、插件、诊断）必须一致");

  // ---------- Step 3：删除 exact ref 后条目从 allowed 与待处理集合消失 ----------
  // 非 TTY 无 --yes：fail closed
  const blocked = await runCli(["model", "remove-policy-ref", "ghost-provider/policy-only-model"], cliEnv);
  outputs.push(blocked.combined);
  assert(blocked.code !== 0, "非 TTY 无 --yes 的 remove-policy-ref 必须 fail closed");
  assert(
    (JSON.parse(readFileSync(openclawPath, "utf8") as string).agents?.defaults?.modelPolicy?.allow ?? []).includes("ghost-provider/policy-only-model"),
    "fail closed 拒绝后 policy 不得变化"
  );

  const beforeConfig = readFileSync(openclawPath, "utf8");
  const removed = await runCli(["model", "remove-policy-ref", "ghost-provider/policy-only-model", "--yes"], cliEnv);
  outputs.push(removed.combined);
  assert(removed.code === 0, `remove-policy-ref --yes 应成功，实际退出码 ${removed.code}：${removed.combined}`);
  const afterRemoval = JSON.parse(readFileSync(openclawPath, "utf8")) as OpenClawConfig;
  assert(
    !(afterRemoval.agents?.defaults?.modelPolicy?.allow ?? []).includes("ghost-provider/policy-only-model"),
    "删除后 policy.allow 不得再含该 exact ref"
  );
  assert(
    (afterRemoval.agents?.defaults?.modelPolicy?.allow ?? []).includes("nvidia/*"),
    "删除 exact ref 不得影响 wildcard 规则"
  );
  assert(
    Object.keys(afterRemoval.agents?.defaults?.models ?? {}).length === Object.keys((JSON.parse(beforeConfig) as OpenClawConfig).agents?.defaults?.models ?? {}).length,
    "默认删除不得触碰 legacy metadata"
  );

  result = await runCli(["models", "inventory", "--json"], cliEnv);
  assert(result.code === 0, "删除后 inventory 应可重新探测");
  inventory = JSON.parse(result.stdout) as typeof inventory;
  assertRuntimeOutputNoSecrets(result.stdout, "删除后 CLI inventory JSON");
  assert(
    !inventory.policyRules.some((rule) => rule.value === "ghost-provider/policy-only-model"),
    "删除后 policyRules 不得再含该 exact 规则"
  );
  assert(!inventory.models.some(m => m.ref === "ghost-provider/policy-only-model"), "删除唯一 exact 引用后，缺失占位必须从 inventory 消失");
  assert(!fakeRuntimeProvider({ openclawPath, envPath, stateDir }).allowedRefs.includes("ghost-provider/policy-only-model"), "删除后 OpenClaw allowed 同步移除该 exact ref");
  assert(
    inventory.models.some((m) => m.ref === "nvidia/deepseek-ai/deepseek-v4-flash"),
    "删除操作不得影响其余模型"
  );

  // 写入应产生备份（备份目录存在且内容不含密钥）
  const backups = listBackups(stateDir);
  assert(backups.length > 0, "remove-policy-ref 写入后应存在备份包");
  const latestBackupDir = join(stateDir, "backups", backups[0]!.id);
  const backupConfig = readFileSync(join(latestBackupDir, "openclaw.json"), "utf8");
  assertRuntimeOutputNoSecrets(backupConfig, "备份 openclaw.json");

  // ---------- Step 4/5：xiaomi 插件启停，两个 Provider 同步变化且 policy 原样保留 ----------
  writeRuntimeConfig();
  const beforePlugin = readFileSync(openclawPath, "utf8");
  const beforePolicy = (JSON.parse(beforePlugin) as OpenClawConfig).agents?.defaults?.modelPolicy?.allow ?? [];

  const disableResult = await runCli(["plugin", "disable", "xiaomi", "--yes", "--json"], cliEnv);
  outputs.push(disableResult.combined);
  assert(disableResult.code === 0, `plugin disable 应成功：${disableResult.combined}`);
  const disableJson = JSON.parse(disableResult.stdout) as { affectedProviderIds?: string[]; runtimeConfirmed?: boolean };
  assert(disableJson.runtimeConfirmed === true, "写后重探测必须观察到实际停用，而非仅检查命令成功");
  assertRuntimeOutputNoSecrets(disableResult.stdout, "plugin disable JSON");
  assert(
    (disableJson.affectedProviderIds ?? []).includes("xiaomi") && (disableJson.affectedProviderIds ?? []).includes("xiaomi-token-plan"),
    "停用影响面必须同时列出两个 Provider（插件级开关）"
  );
  const afterDisable = JSON.parse(readFileSync(openclawPath, "utf8")) as {
    plugins?: { entries?: Record<string, { enabled?: boolean }> };
    agents?: { defaults?: { modelPolicy?: { allow?: string[] } } };
  };
  assert(afterDisable.plugins?.entries?.xiaomi?.enabled === false, "停用后 plugins.entries.xiaomi.enabled 应为 false");
  assert(
    JSON.stringify(afterDisable.agents?.defaults?.modelPolicy?.allow ?? []) === JSON.stringify(beforePolicy),
    "插件停用后 policy 必须逐项原样保留，大小写与重复规则也不得改写"
  );

  // fake CLI 自行回读 config；不要在写后替它手动改 enabled 或模型目录来制造确认成功。
  result = await runCli(["models", "inventory", "--json"], cliEnv);
  assert(result.code === 0, "停用后 inventory 应可探测");
  inventory = JSON.parse(result.stdout) as typeof inventory;
  const disabledModel = inventory.models.find((m) => m.ref === "xiaomi/mi-1");
  assert(
    disabledModel?.availability === "unavailable" && disabledModel?.availabilityReasons.includes("plugin-disabled"),
    "插件停用后其模型应为 unavailable/plugin-disabled"
  );
  for (const providerId of ["xiaomi", "xiaomi-token-plan"]) {
    const provider = inventory.providers.find((p) => p.providerId === providerId);
    assert(provider?.pluginEnabled === false, `停用后 ${providerId} 的 pluginEnabled 应为 false（两 Provider 同步变化）`);
    assert(
      provider?.availability === "unavailable",
      `停用后 ${providerId} 的 Provider 可用性应为 unavailable`
    );
  }

  // 重新启用：恢复可用性
  const enableResult = await runCli(["plugin", "enable", "xiaomi", "--yes", "--json"], cliEnv);
  outputs.push(enableResult.combined);
  assert(enableResult.code === 0, `plugin enable 应成功：${enableResult.combined}`);
  assert(JSON.parse(enableResult.stdout).runtimeConfirmed === true, "写后重探测必须观察到实际启用");
  const afterEnable = JSON.parse(readFileSync(openclawPath, "utf8")) as {
    plugins?: { entries?: Record<string, { enabled?: boolean }> };
    agents?: { defaults?: { modelPolicy?: { allow?: string[] } } };
  };
  assert(afterEnable.plugins?.entries?.xiaomi?.enabled === true, "启用后 plugins.entries.xiaomi.enabled 应为 true");
  assert(
    JSON.stringify(afterEnable.agents?.defaults?.modelPolicy?.allow ?? []) === JSON.stringify(beforePolicy),
    "插件启停全程 policy 必须逐项原样保留"
  );

  // ---------- Step 6：探测超时 → unknown，清理操作禁用 ----------
  writeRuntimeConfig();
  const timeoutEnv = { ...cliEnv, OC_FAKE_OPENCLAW_MODE: "timeout" };
  result = await runCli(["models", "inventory", "--json"], timeoutEnv);
  outputs.push(result.combined);
  assert(result.code === 0, `超时模式下 inventory 仍应成功（降级），退出码 ${result.code}`);
  inventory = JSON.parse(result.stdout) as typeof inventory;
  assertRuntimeOutputNoSecrets(result.stdout, "超时模式 CLI inventory JSON");
  const unknownCount = inventory.models.filter((m) => m.availability === "unknown").length;
  assert(unknownCount > 0, "探测超时时必须有 unknown 模型行");
  for (const model of inventory.models) {
    assert(
      model.availability !== "unavailable",
      `超时（证据不足）不得误判 unavailable：${model.ref} = ${model.availability}`
    );
    if (model.availability === "unknown") {
      assert(
        model.capabilities.canRemovePolicyExactRef !== true
          && model.capabilities.canTogglePolicy !== true
          && model.capabilities.canSetPrimary !== true,
        `unknown 模型 ${model.ref} 不得携带任何清理/编排能力`
      );
    }
  }
  // 超时模式下的删除操作必须被拒绝（unknown 状态不可依据不完整证据清理）
  const beforeUnknownRemoval = readFileSync(openclawPath, "utf8");
  const beforeUnknownBackups = listBackups(stateDir).length;
  const removeOnUnknown = await runCli(["model", "remove-policy-ref", "ghost-provider/policy-only-model", "--yes"], timeoutEnv);
  outputs.push(removeOnUnknown.combined);
  assert(removeOnUnknown.code !== 0, "unknown 下显式删除也必须失败，不能仅在 UI 隐藏按钮");
  assert(readFileSync(openclawPath, "utf8") === beforeUnknownRemoval, "unknown 下拒绝删除必须保持 config 原样");
  assert(listBackups(stateDir).length === beforeUnknownBackups, "拒绝的删除不得生成备份");
  assertRuntimeOutputNoSecrets(removeOnUnknown.combined, "超时模式 remove-policy-ref 输出");
  // 下一失败模式使用同一基线，不替前一步的失败掩盖写入。
  writeRuntimeConfig();

  // invalid JSON 失败模式：降级为 unknown + 诊断，不崩溃
  const invalidJsonEnv = { ...cliEnv, OC_FAKE_OPENCLAW_MODE: "invalid-json" };
  result = await runCli(["models", "inventory", "--json"], invalidJsonEnv);
  outputs.push(result.combined);
  assert(result.code === 0, "invalid JSON 模式 inventory 仍应成功（降级不崩溃）");
  inventory = JSON.parse(result.stdout) as typeof inventory;
  assertRuntimeOutputNoSecrets(result.stdout, "invalid JSON 模式 CLI inventory JSON");
  assert(
    inventory.models.some((m) => m.ref === "ghost-provider/policy-only-model"),
    `invalid JSON 模式仍应列出条目（config/引用来源不依赖运行时探测），实际 refs：${inventory.models.map((m) => m.ref).join(", ")}`
  );
  assert(
    inventory.models.every((m) => m.availability === "unknown"),
    "invalid JSON 模式下所有模型行必须降级为 unknown（不得误判 unavailable/available）"
  );
  assert(
    inventory.diagnostics.length > 0,
    "invalid JSON 模式必须产生探测诊断"
  );
  for (const model of inventory.models) {
    if (model.availability === "unknown") {
      assert(
        model.capabilities.canRemovePolicyExactRef !== true
          && model.capabilities.canTogglePolicy !== true
          && model.capabilities.canSetPrimary !== true,
        `unknown 模型 ${model.ref} 不得携带任何清理/编排能力（invalid JSON 模式）`
      );
    }
  }

  // ---------- Step 7：全程输出与备份不含密钥（在每个阶段已断言，这里做汇总复核） ----------
  const finalBackups = listBackups(stateDir);
  for (const backup of finalBackups) {
    const backupDir = join(stateDir, "backups", backup.id);
    // .env 可能未随备份落盘（无 env 变更的事务也会记录 env 快照；缺失按空处理）
    const backupEnvPath = join(backupDir, ".env");
    if (existsSync(backupEnvPath)) {
      assertRuntimeOutputNoSecrets(readFileSync(backupEnvPath, "utf8"), `备份 ${backup.id} .env`);
    }
    const backupMetadata = readFileSync(join(backupDir, "openclaw.json"), "utf8");
    assertRuntimeOutputNoSecrets(backupMetadata, `备份 ${backup.id} openclaw.json`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-acceptance-"));
  const outputs: string[] = [];

  try {
    // 准备临时目录与 fixture
    const openclawPath = join(dir, "openclaw.json");
    const envDir = join(dir, ".openclaw");
    mkdirSync(envDir, { recursive: true });
    const envPath = join(envDir, ".env");
    const stateDir = join(dir, ".oc-switch");
    const initialEnv = "# 用户自有变量\nUSER_DEFINED_API_KEY=keep-me\n";
    writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
    writeFileSync(envPath, initialEnv);

    const cliEnv = {
      OPENCLAW_CONFIG_PATH: openclawPath,
      HOME: dir
    };

    // CLI 只读命令
    let result = await runCli(["status"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, `status 退出码应为 0，实际 ${result.code}`);
    assert(result.stdout.includes("Providers: 3"), "status 应报告 3 个 provider");
    assert(result.stdout.includes("Allowlist models: 4"), "status 应报告 4 个 allowlist 模型");

    result = await runCli(["providers", "list"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, "providers list 应成功");
    assert(result.stdout.includes("nvidia"), "providers list 应包含 nvidia");

    result = await runCli(["models", "list"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, "models list 应成功");
    assert(result.stdout.includes("deepseek-ai/deepseek-v4-flash"), "models list 应保留斜杠 model id");

    // CLI 写入：切换 primary model（不写入 API Key）
    result = await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, "use 应成功");
    assert(
      result.stdout.includes("Primary model set to nvidia/deepseek-ai/deepseek-v4-flash"),
      "use 应确认 primary 已切换"
    );

    result = await runCli([
      "provider", "add-custom",
      "--id", "acceptance-custom",
      "--name", "Acceptance Custom",
      "--api", "openai-completions",
      "--base-url", "https://api.acceptance.example",
      "--env", "ACCEPTANCE_CUSTOM_API_KEY",
      "--key", "acceptance-secret-value",
      "--models", "acceptance-model,vendor/acceptance-model",
      "--aliases", "acceptance-model:acceptance,vendor/acceptance-model:vendor-acceptance"
    ], cliEnv);
    outputs.push(result.stdout, result.stderr);
    assert(result.code === 0, "provider add-custom 应成功");
    assert(result.stdout.includes("Added custom provider acceptance-custom"), "provider add-custom 应确认新增 provider");

    const customConfig = JSON.parse(readFileSync(openclawPath, "utf8")) as {
      models: { providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }> };
      agents: { defaults: { models: Record<string, { alias?: string }> } };
    };
    assert(
      customConfig.models.providers["acceptance-custom"]?.baseUrl === "https://api.acceptance.example/v1",
      "自定义 openai provider 应自动补 /v1"
    );
    assert(
      customConfig.agents.defaults.models["acceptance-custom/vendor/acceptance-model"]?.alias === "vendor-acceptance",
      "自定义 provider 应支持带斜杠的 model id"
    );
    assert(
      readFileSync(envPath, "utf8").includes("ACCEPTANCE_CUSTOM_API_KEY=acceptance-secret-value"),
      "自定义 provider API Key 应写入 .env managed block"
    );

    // 验证备份包已创建
    const backups = listBackups(stateDir);
    assert(backups.length > 0, "写入后应存在至少一个备份包");
    const latestBackupDir = join(stateDir, "backups", backups[0]!.id);
    assert(existsSync(join(latestBackupDir, "openclaw.json")), "备份包应包含 openclaw.json");
    assert(existsSync(join(latestBackupDir, ".env")), "备份包应包含 .env");

    const envAfter = readFileSync(envPath, "utf8");
    assert(envAfter.includes("USER_DEFINED_API_KEY=keep-me"), "用户自有 env 变量应保留");
    assert(envAfter.includes("# oc-switch:start"), "自定义 provider 写入后应存在 managed block");

    // REST 服务鉴权测试
    const customDir = join(stateDir, "presets", "custom");
    mkdirSync(customDir, { recursive: true });
    const app = createApp({
      token: TOKEN,
      paths: { openclawPath, envPath, stateDir },
      presetDirs: {
        builtinDir: fixtureBuiltinDir,
        customDir
      },
      pluginCatalogProvider: emptyPluginCatalog
    });
    const server = Bun.serve({
      port: SERVER_PORT,
      hostname: "127.0.0.1",
      fetch: app.fetch
    });

    try {
      const baseUrl = `http://127.0.0.1:${SERVER_PORT}`;

      const appEnvUpdate = await fetch(`${baseUrl}/api/env`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          type: "upsert",
          envVar: "USER_DEFINED_API_KEY",
          value: "new-managed-value",
          confirmMigration: true
        })
      });
      const appEnvUpdateJson = await appEnvUpdate.json() as Record<string, unknown>;
      outputs.push(JSON.stringify(appEnvUpdateJson));
      assert(appEnvUpdate.status === 200, "env update 应成功");
      assert(!JSON.stringify(appEnvUpdateJson).includes("new-managed-value"), "env update 响应不得回显新值");

      const latestAfterEnvUpdate = listBackups(stateDir)[0];
      assert(latestAfterEnvUpdate !== undefined, "env update 后应存在备份");
      const latestBackupDirAfterEnvUpdate = join(stateDir, "backups", latestAfterEnvUpdate.id);
      const latestMetadata = JSON.parse(readFileSync(join(latestBackupDirAfterEnvUpdate, "metadata.json"), "utf8")) as {
        openclawPath?: string;
        envPath?: string;
      };
      assert(latestMetadata.openclawPath === openclawPath, "备份 metadata 应记录 openclawPath");
      assert(latestMetadata.envPath === envPath, "备份 metadata 应记录 envPath");

      const unauth = await fetch(`${baseUrl}/api/status`);
      const unauthBody = await unauth.text();
      outputs.push(unauthBody);
      assert(unauth.status === 401, "无 token 请求应返回 401");
      assert(!unauthBody.includes("nvidia"), "401 响应不得泄漏 provider 配置");
      assert(!unauthBody.includes("minimax-portal"), "401 响应不得泄漏 primary model");

      const auth = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      const authJson = await auth.json() as Record<string, unknown>;
      outputs.push(JSON.stringify(authJson));
      assert(auth.status === 200, "携带 token 请求应返回 200");
      assert(authJson.primaryModel === "nvidia/deepseek-ai/deepseek-v4-flash", "授权后应返回更新后的 primary");
    } finally {
      server.stop();
    }

    // Runtime discovery / 多实例 / service-env 验收（临时 fixture）
    await assertRuntimeDiscoveryAcceptance(outputs);

    // Model policy 三态与独立 Provider state 验收（临时脱敏 fixture）
    await assertModelPolicyAcceptance(dir, outputs);

    // 插件 provider 合并展示 / 编排放行 / 破坏性写 fail closed（注入固定 catalog）
    await assertPluginProviderAcceptance(dir, outputs);

    // 运行时模型协调（spec §13.4 七步：fake openclaw + 失败模式切换）
    await assertRuntimeModelAcceptance(dir, outputs);

    // 汇总扫描所有输出
    for (const text of outputs) {
      assertNoSecrets(text, "acceptance");
    }

    console.log("✓ acceptance smoke passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
