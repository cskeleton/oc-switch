/**
 * scripts/e2e-real-config.ts 的单测：门禁、路径校验、语义指纹、还原协议、退出码。
 *
 * 全部用临时目录 fixture 模拟 `--config` 指向隔离 HOME 下的配置文件走全协议；
 * 全测绝不读取开发机真实 ~/.openclaw（baseEnv 最小化 + 注入空运行实例探测 +
 * CLI 子进程 PATH 前置假 openclaw）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginCatalogResult } from "../packages/core/src/plugin-catalog";
import type { RuntimeDiscoveryResult } from "../packages/core/src/runtime-discovery-types";
import {
  createCliRunner,
  evaluateGate,
  findSecretViolations,
  runRealConfigE2E,
  semanticFingerprint,
  stableStringify,
  EXIT_GATE_REFUSAL,
  EXIT_OK,
  EXIT_RESTORE_FAILURE,
  EXIT_SCENARIO_FAILURE,
  type CliResult,
  type RealConfigE2EOptions
} from "./e2e-real-config";

const CLI_ENTRY = resolve(join(import.meta.dir, "../packages/cli/src/index.ts"));
/** fixture 密钥：报告与 CLI 输出绝不应包含该值 */
const FIXTURE_SECRET = "sk-zetafixture1234567890abcd";

/** 空运行实例探测（隔离：不把 envPath 解析到真实运行实例） */
const emptyDiscovery = (): RuntimeDiscoveryResult => ({
  status: "gateway-not-detected",
  instances: [],
  candidateGroups: [],
  diagnostics: []
});

const emptyPluginCatalog = async (): Promise<PluginCatalogResult> => ({ providers: [], plugins: [], diagnostics: [] });

/**
 * 假 openclaw：按 argv 回放运行时探测 fixture（插件空目录 + 全量 available 模型目录），
 * 与 acceptance 的假 openclaw 同思路；任何未覆盖命令失败降级。
 */
function writeFakeOpenClaw(binDir: string, fixtureDataDir: string): void {
  const allRefs = [
    "anthropic/claude-sonnet-4",
    "anthropic/claude-opus-4",
    "openrouter/or-main",
    "zeta/zeta-1",
    "solo/m1",
    "solo/m2"
  ];
  writeFileSync(
    join(fixtureDataDir, "status.json"),
    `${JSON.stringify({ allowed: allRefs, defaultModel: allRefs[0], fallbacks: [] })}\n`
  );
  writeFileSync(
    join(fixtureDataDir, "list.json"),
    `${JSON.stringify({ models: allRefs.map((key) => ({ key, available: true })) })}\n`
  );
  const script = `#!/bin/sh
case "$*" in
  "--version") echo "OpenClaw 2026.9.1-fake"; exit 0 ;;
  "plugins list --json") echo '{"plugins":[]}'; exit 0 ;;
  "models status --json") cat "${fixtureDataDir}/status.json"; exit 0 ;;
  "models list --json"|"models list --all --json") cat "${fixtureDataDir}/list.json"; exit 0 ;;
  *) echo "fake openclaw: unsupported $*" >&2; exit 1 ;;
esac
`;
  const path = join(binDir, "openclaw");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

/** 含 JSON5 注释与主模型对象形态的完整 fixture（三场景均可执行） */
const FIXTURE_A = `{
  // 用户注释：还原必须字节级保留本行与格式
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "api": "anthropic-messages",
        "models": [ { "id": "claude-sonnet-4" }, { "id": "claude-opus-4" } ]
      },
      "openrouter": {
        "baseUrl": "https://openrouter.ai/api/v1",
        "api": "openai-completions",
        "models": [ { "id": "or-main" } ]
      },
      "zeta": {
        "baseUrl": "https://zeta.example.com/v1",
        "api": "openai-completions",
        "models": [ { "id": "zeta-1" } ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-sonnet-4", "fallbacks": ["openrouter/or-main"], "customNote": { "keep": true } },
      "models": { "anthropic/claude-sonnet-4": { "alias": "main" } },
      "modelPolicy": { "allow": ["anthropic/*"] }
    }
  }
}
`;

/** 单 Provider + legacy 模式 fixture（场景 2/3 走 skip 分支） */
const FIXTURE_B = `{
  "models": {
    "providers": {
      "solo": {
        "baseUrl": "https://solo.example.com/v1",
        "api": "openai-completions",
        "models": [ { "id": "m1" }, { "id": "m2" } ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "solo/m1",
      "models": { "solo/m1": { "alias": "main" } }
    }
  }
}
`;

interface FixtureHome {
  home: string;
  configPath: string;
  envPath: string;
  providerStatesPath: string;
  binDir: string;
  cleanup: () => void;
}

/** 搭一个隔离 HOME：.openclaw/openclaw.json + .env + 假 openclaw bin */
function makeFixtureHome(configContent: string, options: { withEnv?: boolean } = {}): FixtureHome {
  const home = mkdtempSync(join(tmpdir(), "e2e-real-home-"));
  const openclawDir = join(home, ".openclaw");
  mkdirSync(openclawDir, { recursive: true });
  const configPath = join(openclawDir, "openclaw.json");
  writeFileSync(configPath, configContent);
  const envPath = join(openclawDir, ".env");
  if (options.withEnv !== false) {
    writeFileSync(envPath, `# fixture env\nZETA_API_KEY=${FIXTURE_SECRET}\n`);
  }
  const binDir = join(home, "bin");
  mkdirSync(binDir);
  const fixtureDataDir = join(home, "fake-openclaw-data");
  mkdirSync(fixtureDataDir);
  writeFakeOpenClaw(binDir, fixtureDataDir);
  return {
    home,
    configPath,
    envPath,
    providerStatesPath: join(home, ".oc-switch", "provider-states.json"),
    binDir,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

/** 真实 CLI 子进程 runner（PATH 前置假 openclaw，HOME 指向 fixture） */
function subprocessCli(fixture: FixtureHome): (args: string[]) => Promise<CliResult> {
  return createCliRunner({
    cliEntry: CLI_ENTRY,
    timeoutMs: 120_000,
    env: {
      PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
      HOME: fixture.home
    } as NodeJS.ProcessEnv
  });
}

function baseOptions(fixture: FixtureHome, overrides: Partial<RealConfigE2EOptions> = {}): RealConfigE2EOptions {
  return {
    envFlag: "1",
    configPathArg: fixture.configPath,
    home: fixture.home,
    // 门禁的「系统临时目录」语义用独立目录表达：fixture home 扮演真实 $HOME
    tmpDir: join(fixture.home, "system-tmp"),
    isTty: true,
    confirm: async () => true,
    runCli: subprocessCli(fixture),
    pluginCatalog: emptyPluginCatalog,
    gatewayProbe: async () => ({ ok: false, detail: "测试注入：跳过只读对账" }),
    baseEnv: { PATH: process.env.PATH ?? "" },
    runtimeDiscoveryProvider: emptyDiscovery,
    log: () => {},
    ...overrides
  };
}

let fixtures: FixtureHome[] = [];
function fixture(configContent: string, options?: { withEnv?: boolean }): FixtureHome {
  const home = makeFixtureHome(configContent, options);
  fixtures.push(home);
  return home;
}
afterEach(() => {
  for (const f of fixtures) f.cleanup();
  fixtures = [];
});

describe("语义指纹", () => {
  test("格式与注释差异不改变指纹", () => {
    const a = `{\n  // 注释\n  "b": 1, "a": [2, 3]\n}\n`;
    const b = `{"a":[2,3],"b":1}`;
    expect(semanticFingerprint(a)).toBe(semanticFingerprint(b));
  });

  test("语义差异改变指纹", () => {
    const a = `{"a":1,"b":2}`;
    const b = `{"a":1,"b":3}`;
    expect(semanticFingerprint(a)).not.toBe(semanticFingerprint(b));
  });

  test("非法 JSON5 抛错", () => {
    expect(() => semanticFingerprint("{ not json")).toThrow();
  });

  test("stableStringify 键序稳定", () => {
    expect(stableStringify({ b: 1, a: { d: 4, c: [1, 2] } })).toBe(stableStringify({ a: { c: [1, 2], d: 4 }, b: 1 }));
  });
});

describe("三重门禁（evaluateGate）", () => {
  test("缺少环境变量门", () => {
    const f = fixture(FIXTURE_A);
    const decision = evaluateGate({ envFlag: undefined, configPathArg: f.configPath, home: f.home, tmpDir: f.envPath, isTty: true });
    expect(decision.ok).toBe(false);
  });

  test("缺少 --config", () => {
    const f = fixture(FIXTURE_A);
    const decision = evaluateGate({ envFlag: "1", configPathArg: undefined, home: f.home, tmpDir: f.envPath, isTty: true });
    expect(decision.ok).toBe(false);
  });

  test("非 TTY 拒跑", () => {
    const f = fixture(FIXTURE_A);
    const decision = evaluateGate({ envFlag: "1", configPathArg: f.configPath, home: f.home, tmpDir: f.envPath, isTty: false });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("TTY");
  });

  test("fixture 模式路径拒跑（防线镜像）", () => {
    const home = mkdtempSync(join(tmpdir(), "e2e-real-home-"));
    fixtures.push({ home, configPath: "", envPath: "", providerStatesPath: "", binDir: "", cleanup: () => rmSync(home, { recursive: true, force: true }) });
    const configPath = join(home, "oc-switch-e2e-cfg.json");
    writeFileSync(configPath, FIXTURE_A);
    const decision = evaluateGate({ envFlag: "1", configPathArg: configPath, home, tmpDir: join(home, "system-tmp"), isTty: true });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("oc-switch-e2e-");
  });

  test("系统临时目录路径拒跑", () => {
    const sysTmp = mkdtempSync(join(tmpdir(), "e2e-real-system-tmp-"));
    const home = join(sysTmp, "home");
    mkdirSync(home);
    fixtures.push({ home, configPath: "", envPath: "", providerStatesPath: "", binDir: "", cleanup: () => rmSync(sysTmp, { recursive: true, force: true }) });
    const configPath = join(home, "openclaw.json");
    writeFileSync(configPath, FIXTURE_A);
    const decision = evaluateGate({ envFlag: "1", configPathArg: configPath, home, tmpDir: sysTmp, isTty: true });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("临时目录");
  });

  test("$HOME 之外拒跑", () => {
    const f = fixture(FIXTURE_A);
    const otherHome = mkdtempSync(join(tmpdir(), "e2e-real-other-"));
    fixtures.push({ home: otherHome, configPath: "", envPath: "", providerStatesPath: "", binDir: "", cleanup: () => rmSync(otherHome, { recursive: true, force: true }) });
    const decision = evaluateGate({ envFlag: "1", configPathArg: f.configPath, home: otherHome, tmpDir: join(otherHome, "system-tmp"), isTty: true });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toContain("$HOME");
  });

  test("合法真实形态通过", () => {
    const f = fixture(FIXTURE_A);
    const decision = evaluateGate({ envFlag: "1", configPathArg: f.configPath, home: f.home, tmpDir: join(f.home, "system-tmp"), isTty: true });
    expect(decision).toEqual({ ok: true, configPath: f.configPath });
  });
});

describe("全协议（隔离 fixture 走完整流程）", () => {
  test("三场景全 pass：退出 0 + 字节还原 + 备份报告 + 无密钥泄露", async () => {
    const f = fixture(FIXTURE_A);
    const originalBytes = readFileSync(f.configPath);
    const envBytes = readFileSync(f.envPath);
    const report: string[] = [];
    const code = await runRealConfigE2E(baseOptions(f, { log: (line) => report.push(line) }));
    expect(code).toBe(EXIT_OK);
    const text = report.join("\n");
    expect(text).toContain("场景 1 主模型切换往返: PASS");
    expect(text).toContain("场景 2 Policy 规则往返: PASS");
    expect(text).toContain("场景 3 Provider 停用/恢复往返: PASS");
    expect(text).toContain("还原证明");
    expect(text).toContain("字节一致");
    expect(text).toContain("语义指纹等价");
    expect(text).toMatch(/安全网备份: [^\s]+/);
    expect(text).toContain("手动 apply");
    // 字节级还原：JSON5 注释与格式原样保留
    expect(readFileSync(f.configPath).equals(originalBytes)).toBe(true);
    // .env 字节不变；provider-states 原本不存在则仍不存在
    expect(readFileSync(f.envPath).equals(envBytes)).toBe(true);
    expect(existsSync(f.providerStatesPath)).toBe(false);
    // 报告不打印任何密钥值
    expect(text).not.toContain(FIXTURE_SECRET);
    expect(findSecretViolations(text)).toEqual([]);
  });

  test("skip 路径：legacy 模式跳过场景 2、全被引用跳过场景 3，仍退出 0", async () => {
    const f = fixture(FIXTURE_B);
    const originalBytes = readFileSync(f.configPath);
    const report: string[] = [];
    const code = await runRealConfigE2E(baseOptions(f, { log: (line) => report.push(line) }));
    expect(code).toBe(EXIT_OK);
    const text = report.join("\n");
    expect(text).toContain("场景 1 主模型切换往返: PASS");
    expect(text).toContain("场景 2 Policy 规则往返: SKIP");
    expect(text).toContain("非 restricted");
    expect(text).toContain("场景 3 Provider 停用/恢复往返: SKIP");
    expect(readFileSync(f.configPath).equals(originalBytes)).toBe(true);
  });

  test("场景失败退出 1：后续场景停止，字节还原仍兜底", async () => {
    const f = fixture(FIXTURE_A);
    const originalBytes = readFileSync(f.configPath);
    const calls: string[][] = [];
    const realCli = subprocessCli(f);
    const failingCli = async (args: string[]): Promise<CliResult> => {
      calls.push(args);
      if (args[0] === "use" && args[1] === "anthropic/claude-opus-4") {
        return { code: 1, stdout: "", stderr: "injected failure" };
      }
      return realCli(args);
    };
    const report: string[] = [];
    const code = await runRealConfigE2E(baseOptions(f, { runCli: failingCli, log: (line) => report.push(line) }));
    expect(code).toBe(EXIT_SCENARIO_FAILURE);
    const text = report.join("\n");
    expect(text).toContain("场景 1 主模型切换往返: FAIL");
    expect(text).toContain("立即停止后续场景");
    // 场景 2/3 未执行（runCli 未被调用到 policy/provider 命令）
    expect(calls.filter((args) => args[0] === "model" || args[0] === "provider")).toHaveLength(0);
    // 字节还原兜底仍生效
    expect(readFileSync(f.configPath).equals(originalBytes)).toBe(true);
    expect(text).toContain("还原证明");
  });

  test("还原失败退出 2：醒目告警 + 备份路径 + 当前文件状态", async () => {
    const f = fixture(FIXTURE_A);
    const report: string[] = [];
    const code = await runRealConfigE2E(baseOptions(f, {
      log: (line) => report.push(line),
      restoreFile: (path, bytes) => {
        if (path === f.configPath) throw new Error("注入还原故障");
        if (bytes === null) rmSync(path, { force: true });
        else writeFileSync(path, bytes);
      }
    }));
    expect(code).toBe(EXIT_RESTORE_FAILURE);
    const text = report.join("\n");
    expect(text).toContain("还原断言失败");
    expect(text).toContain("字节写回失败");
    expect(text).toContain("备份路径");
    expect(text).toContain("原语义指纹=");
    expect(text).not.toContain(FIXTURE_SECRET);
  });

  test("门禁拒绝退出 3 且不调用 confirm/runCli", async () => {
    const f = fixture(FIXTURE_A);
    let confirmCalled = false;
    let cliCalled = false;
    const code = await runRealConfigE2E(baseOptions(f, {
      isTty: false,
      confirm: async () => { confirmCalled = true; return true; },
      runCli: async () => { cliCalled = true; return { code: 0, stdout: "", stderr: "" }; }
    }));
    expect(code).toBe(EXIT_GATE_REFUSAL);
    expect(confirmCalled).toBe(false);
    expect(cliCalled).toBe(false);
  });

  test("用户未确认退出 3，不写入任何内容", async () => {
    const f = fixture(FIXTURE_A);
    const originalBytes = readFileSync(f.configPath);
    let cliCalled = false;
    const code = await runRealConfigE2E(baseOptions(f, {
      confirm: async () => false,
      runCli: async () => { cliCalled = true; return { code: 0, stdout: "", stderr: "" }; }
    }));
    expect(code).toBe(EXIT_GATE_REFUSAL);
    expect(cliCalled).toBe(false);
    expect(readFileSync(f.configPath).equals(originalBytes)).toBe(true);
  });
});

describe("密钥扫描", () => {
  test("命中常见密钥形态", () => {
    expect(findSecretViolations("key=sk-abcdefghijklmnop")).not.toEqual([]);
    expect(findSecretViolations("Authorization: Bearer abcdef1234567890")).not.toEqual([]);
    expect(findSecretViolations("apiKey: abcdef1234567890xyz")).not.toEqual([]);
    expect(findSecretViolations("普通日志行")).toEqual([]);
  });
});
