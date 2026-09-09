import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpenClawConfig } from "@oc-switch/core";
import { prepareGatewayEnvTarget } from "../../core/test/gateway-sync-fixture";
import { repoRoot } from "../src/command-context";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 本地端 fixture：本机 openclaw.json + settings 固定路径（避免真实 runtime discovery 漂移） */
function prepareLocalHome(config: OpenClawConfig): { home: string; configPath: string } {
  const home = makeTempDir("oc-switch-sync-local-");
  const openclawDir = join(home, ".openclaw");
  const stateDir = join(home, ".oc-switch");
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(openclawDir, "openclaw.json");
  const envPath = join(openclawDir, ".env");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(envPath, "LOCAL_ONLY=1\n");
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ openclawPath: configPath, envPath }));
  return { home, configPath };
}

interface RemoteFixtureOptions {
  config: OpenClawConfig;
  envContent?: string;
  /** 自定义远端 config 路径（配合 --path）；默认 <home>/.openclaw/openclaw.json */
  configPath?: string;
  /** 远端假 openclaw 的 `plugins list --json` 输出；默认空插件列表 */
  pluginsListJson?: string;
  /** settings.json 是否固定 openclawPath（--path 场景由远端 env 覆盖，不需要固定） */
  pinOpenclawPath?: boolean;
}

/** 远端 fixture：独立 HOME（stateDir/备份/.env 全隔离）+ bin/oc-switch 薄包装 + 假 openclaw */
function prepareRemoteHome(options: RemoteFixtureOptions): { home: string; configPath: string; envPath: string; stateDir: string } {
  const home = makeTempDir("oc-switch-sync-remote-");
  const configPath = options.configPath ?? join(home, ".openclaw", "openclaw.json");
  const envPath = join(home, ".openclaw", ".env");
  const stateDir = join(home, ".oc-switch");
  mkdirSync(dirname(configPath), { recursive: true });
  mkdirSync(dirname(envPath), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(options.config, null, 2)}\n`);
  writeFileSync(envPath, options.envContent ?? "KEEP=1\n");
  // 固定路径，防止开发机真实 Gateway discovery 接管远端 activePaths
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      ...(options.pinOpenclawPath === false ? {} : { openclawPath: configPath }),
      envPath
    })
  );
  // 远端 bin：oc-switch 薄包装（经 buildRemoteCommand 的 PATH 前置被发现）+ 确定性 openclaw stub
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const cliShim = join(binDir, "oc-switch");
  writeFileSync(cliShim, `#!/bin/sh\nexec bun run ${shellQuote(join(repoRoot, "packages/cli/src/index.ts"))} "$@"\n`);
  chmodSync(cliShim, 0o755);
  const openclawStub = join(binDir, "openclaw");
  writeFileSync(
    openclawStub,
    `#!/bin/sh\ncat <<'OCJSON'\n${options.pluginsListJson ?? '{"plugins":[]}'}\nOCJSON\n`
  );
  chmodSync(openclawStub, 0o755);
  // 与既有 CLI 测试一致：macOS 安装 LaunchAgent fixture，让写入路径的 gateway 探测确定
  prepareGatewayEnvTarget(dirname(configPath), home);
  return { home, configPath, envPath, stateDir };
}

/** 假 ssh：忽略 host 与选项参数，最后一个参数是远端命令，在远端 fixture HOME 下执行 */
function prepareFakeSsh(remoteHome: string): string {
  const dir = makeTempDir("oc-switch-sync-ssh-");
  const script = join(dir, "ssh");
  writeFileSync(script, `#!/bin/sh
for last do :; done
export HOME=${shellQuote(remoteHome)}
unset OPENCLAW_CONFIG_PATH OPENCLAW_STATE_DIR OC_SWITCH_MOCK_SYNC OC_SWITCH_MOCK_METADATA
exec sh -c "$last"
`);
  chmodSync(script, 0o755);
  return dir;
}

async function runSyncCli(
  args: string[],
  env: Record<string, string>,
  options: { sshDir?: string; stdinText?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const pathParts = [options.sshDir, process.env.PATH].filter((part): part is string => Boolean(part));
  const proc = Bun.spawn(["bun", "run", "packages/cli/src/index.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PATH: pathParts.join(":") },
    // 默认不给 stdin：isTTY 为 undefined，覆盖「非 TTY fail closed」路径
    stdin: options.stdinText === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  if (options.stdinText !== undefined) {
    const sink = proc.stdin;
    if (typeof sink === "object" && sink !== null && "write" in sink) {
      await sink.write(options.stdinText);
      sink.end();
    }
  }
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text()
  };
}

const localConfig: OpenClawConfig = {
  models: {
    providers: {
      alpha: { baseUrl: "https://alpha.example/v1", api: "openai-completions", models: [{ id: "m1" }] }
    }
  },
  agents: {
    defaults: {
      model: "alpha/m1",
      models: { "alpha/m1": { alias: "a1" } }
    }
  }
};

const remoteConfig: OpenClawConfig = {
  models: {
    providers: {
      beta: { baseUrl: "https://beta.example/v1", api: "openai-completions", models: [{ id: "m9" }] },
      "alpha-old": { baseUrl: "https://old.example/v1", models: [] }
    }
  },
  agents: {
    defaults: {
      model: "beta/m9",
      models: { "beta/m9": {} }
    }
  },
  channels: { preserve: true }
};

describe("sync diff / push（假 ssh 双端 fixture）", () => {
  test("sync diff 只读：输出计划与校验提醒，不写远端、不产生备份", async () => {
    const local = prepareLocalHome(localConfig);
    const remote = prepareRemoteHome({ config: remoteConfig });
    const sshDir = prepareFakeSsh(remote.home);
    const before = readFileSync(remote.configPath, "utf8");

    const result = await runSyncCli(
      ["sync", "diff", "claw"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("同步计划");
    expect(result.stdout).toContain("+ alpha");
    expect(result.stdout).toContain("beta");
    expect(result.stdout).toContain("alpha-old");
    expect(result.stdout).toContain("主模型：beta/m9 → alpha/m1");
    expect(result.stdout).toContain("dry-run");
    expect(readFileSync(remote.configPath, "utf8")).toBe(before);
    expect(existsSync(join(remote.stateDir, "backups"))).toBe(false);
  }, 30000);

  test("sync push --yes：三子树覆盖、对端私有 provider 消失、产生备份", async () => {
    const local = prepareLocalHome(localConfig);
    const remote = prepareRemoteHome({ config: remoteConfig });
    const sshDir = prepareFakeSsh(remote.home);

    const result = await runSyncCli(
      ["sync", "push", "claw", "--yes"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("已写入对端配置");
    const persisted = JSON.parse(readFileSync(remote.configPath, "utf8")) as OpenClawConfig;
    expect(Object.keys(persisted.models?.providers ?? {})).toEqual(["alpha"]);
    expect(persisted.agents?.defaults?.models).toEqual({ "alpha/m1": { alias: "a1" } });
    expect(persisted.agents?.defaults?.model).toBe("alpha/m1");
    // 白名单外字段原样保留
    expect(persisted.channels).toEqual({ preserve: true });
    // 自动备份含覆盖前内容，可回滚
    const backupsDir = join(remote.stateDir, "backups");
    const backups = readdirSync(backupsDir);
    expect(backups.length).toBe(1);
    const backupConfig = readFileSync(join(backupsDir, backups[0]!, "openclaw.json"), "utf8");
    expect(backupConfig).toContain("beta");
  }, 30000);

  test("sync push 非 TTY 且无 --yes：fail closed，不写远端", async () => {
    const local = prepareLocalHome(localConfig);
    const remote = prepareRemoteHome({ config: remoteConfig });
    const sshDir = prepareFakeSsh(remote.home);
    const before = readFileSync(remote.configPath, "utf8");

    const result = await runSyncCli(
      ["sync", "push", "claw"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(readFileSync(remote.configPath, "utf8")).toBe(before);
    expect(existsSync(join(remote.stateDir, "backups"))).toBe(false);
  }, 30000);

  test("sync push --yes --fill-keys 非 TTY：在任何写入前 fail closed", async () => {
    const local = prepareLocalHome(localConfig);
    const remote = prepareRemoteHome({ config: remoteConfig });
    const sshDir = prepareFakeSsh(remote.home);
    const before = readFileSync(remote.configPath, "utf8");

    const result = await runSyncCli(
      ["sync", "push", "claw", "--yes", "--fill-keys"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--fill-keys");
    expect(readFileSync(remote.configPath, "utf8")).toBe(before);
  }, 30000);

  test("插件 disabled 默认只提醒；--enable-plugins 后置 true", async () => {
    const local = prepareLocalHome({
      agents: { defaults: { model: "acme/m1", models: { "acme/m1": {} } } }
    });
    // 远端假 openclaw：acme-plugin 已安装但 disabled，provider acme 声明 ACME_API_KEY
    const pluginRoot = join(makeTempDir("oc-switch-sync-plugin-"), "acme-plugin");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "openclaw.plugin.json"), JSON.stringify({
      modelCatalog: {
        providers: {
          acme: { baseUrl: "https://acme.example/v1", api: "openai-completions", models: [{ id: "m1" }] }
        }
      },
      setup: { providers: [{ id: "acme", envVars: ["ACME_API_KEY"] }] }
    }));
    const remote = prepareRemoteHome({
      config: {
        plugins: { entries: { "acme-plugin": { enabled: false } } },
        gateway: { preserve: true }
      } as OpenClawConfig,
      pluginsListJson: JSON.stringify({
        plugins: [{ id: "acme-plugin", rootDir: pluginRoot, origin: "bundled", enabled: false, providerIds: ["acme"] }]
      })
    });
    const sshDir = prepareFakeSsh(remote.home);

    // 默认：只提醒，不写 plugins.entries
    const first = await runSyncCli(
      ["sync", "push", "claw", "--yes"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("acme-plugin");
    expect(first.stdout).toContain("enabled=false");
    let persisted = JSON.parse(readFileSync(remote.configPath, "utf8")) as {
      plugins: { entries: Record<string, { enabled: boolean }> };
      gateway?: unknown;
    };
    expect(persisted.plugins.entries["acme-plugin"]).toEqual({ enabled: false });
    expect(persisted.gateway).toEqual({ preserve: true });

    // --enable-plugins：false→true
    const second = await runSyncCli(
      ["sync", "push", "claw", "--yes", "--enable-plugins"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("已开启插件：acme-plugin");
    persisted = JSON.parse(readFileSync(remote.configPath, "utf8"));
    expect(persisted.plugins.entries["acme-plugin"]).toEqual({ enabled: true });
  }, 60000);

  test("缺失 env 变量名出现在报告；任何密钥值不外泄", async () => {
    const withKeys = structuredClone(localConfig);
    withKeys.models!.providers!.alpha!.apiKey = { source: "env", provider: "default", id: "ALPHA_API_KEY" };
    withKeys.models!.providers!.settled = {
      baseUrl: "https://settled.example/v1",
      apiKey: { source: "env", provider: "default", id: "SETTLED_KEY" },
      models: [{ id: "m2" }]
    };
    const local = prepareLocalHome(withKeys);
    const remote = prepareRemoteHome({
      config: remoteConfig,
      envContent: "# oc-switch:start\nSETTLED_KEY=sk-remote-secret\n# oc-switch:end\n"
    });
    const sshDir = prepareFakeSsh(remote.home);

    const result = await runSyncCli(
      ["sync", "push", "claw", "--yes"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ALPHA_API_KEY");
    // 已存在的变量不列为缺失，且任何密钥值（含对端已有值）都不出现在输出里
    expect(result.stdout).not.toContain("SETTLED_KEY");
    expect(result.stdout).not.toContain("sk-remote-secret");
    expect(result.stderr).not.toContain("sk-remote-secret");
  }, 30000);

  test("--path 透传为远端 OPENCLAW_CONFIG_PATH", async () => {
    const local = prepareLocalHome(localConfig);
    const customPathDir = makeTempDir("oc-switch-sync-custom-");
    const customPath = join(customPathDir, "conf.json");
    const remote = prepareRemoteHome({
      config: remoteConfig,
      configPath: customPath,
      pinOpenclawPath: false
    });
    const sshDir = prepareFakeSsh(remote.home);

    // 不带 --path：远端默认路径不存在 → preflight 失败
    const noPath = await runSyncCli(
      ["sync", "diff", "claw"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );
    expect(noPath.code).toBe(1);

    const withPath = await runSyncCli(
      ["sync", "push", "claw", "--yes", "--path", customPath],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { sshDir }
    );
    expect(withPath.code).toBe(0);
    const persisted = JSON.parse(readFileSync(customPath, "utf8")) as OpenClawConfig;
    expect(Object.keys(persisted.models?.providers ?? {})).toEqual(["alpha"]);
  }, 60000);
});

describe("sync-agent plumbing（直接调用，不经 ssh）", () => {
  test("env-upsert 写入托管块且输出不含密钥值", async () => {
    const local = prepareLocalHome(localConfig);
    const result = await runSyncCli(
      ["sync-agent", "env-upsert"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { stdinText: JSON.stringify({ updates: { FOO_API_KEY: "sk-test-value" } }) }
    );

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; results: Array<{ envVar: string; ok: boolean }> };
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toEqual([{ envVar: "FOO_API_KEY", ok: true }]);
    expect(result.stdout).not.toContain("sk-test-value");
    const envContent = readFileSync(join(local.home, ".openclaw", ".env"), "utf8");
    expect(envContent).toContain("# oc-switch:start");
    expect(envContent).toContain("FOO_API_KEY=sk-test-value");
  }, 30000);

  test("read-config 输出纯 JSON 协议", async () => {
    const local = prepareLocalHome(localConfig);
    const result = await runSyncCli(
      ["sync-agent", "read-config"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath }
    );

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { config: OpenClawConfig; paths: { openclawPath: string } };
    expect(parsed.paths.openclawPath).toBe(local.configPath);
    expect(Object.keys(parsed.config.models?.providers ?? {})).toEqual(["alpha"]);
  }, 30000);

  test("check 不带 payload：反映对端现状", async () => {
    const local = prepareLocalHome(localConfig);
    const result = await runSyncCli(
      ["sync-agent", "check"],
      { HOME: local.home, OPENCLAW_CONFIG_PATH: local.configPath },
      { stdinText: "{}" }
    );

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { refs: unknown[]; missingEnvVars: string[] };
    expect(parsed.refs).toEqual([]);
    expect(parsed.missingEnvVars).toEqual([]);
  }, 30000);
});
