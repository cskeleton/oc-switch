import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import sample from "../../core/test/fixtures/openclaw.sample.json";
import type { OpenClawConfig, RuntimeDiscoveryResult } from "@oc-switch/core";
import { MAX_PROVIDER_MODELS, upsertDisabledProviderState, writeModelMetadataQueue } from "@oc-switch/core";
import { prepareGatewayEnvTarget, expectedGatewayEnvPath } from "../../core/test/gateway-sync-fixture";
import { createCommandContext, repoRoot } from "../src/command-context";
import { registerGatewayCommands } from "../src/commands/gateway";

// 新增的 inventory / reconcile / plugin 命令每次 runCli 都要 spawn bun 子进程 + 8s 级探测，
// 偶发超过 bun:test 默认 5s 超时；放宽到 30s（只调时长，不放宽断言）
Bun.env.BUN_TEST_TIMEOUT = "30000";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 在 PATH 最前面放一个假的 `openclaw`，让 plugin-catalog 发现走确定性输出。
 * 不打桩时 CLI 会 shell-out 到本机真实 openclaw，provider 列表随开发机插件漂移。
 */
function prepareOpenClawStub(pluginsListJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-openclaw-stub-"));
  tempDirs.push(dir);
  const script = join(dir, "openclaw");
  const pluginsPath = join(dir, "plugins.json");
  writeFileSync(pluginsPath, pluginsListJson);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(script, `#!/bin/sh\nexport OC_SWITCH_TEST_PLUGINS_PATH=${quote(pluginsPath)}\nexec ${quote(process.execPath)} ${quote(join(import.meta.dir, "fixtures/openclaw-stub.ts"))} "$@"\n`);
  chmodSync(script, 0o755);
  return dir;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  options: { skipGatewayFixture?: boolean; pluginsListJson?: string } = {}
) {
  if (!env.HOME) {
    const home = mkdtempSync(join(tmpdir(), "oc-switch-cli-home-"));
    tempDirs.push(home);
    env = { ...env, HOME: home };
  }
  if (env.HOME && process.platform === "darwin" && !options.skipGatewayFixture) {
    const baseDir = env.OPENCLAW_CONFIG_PATH
      ? join(env.OPENCLAW_CONFIG_PATH, "..")
      : env.HOME;
    prepareGatewayEnvTarget(baseDir, env.HOME);
  }
  // 固定 settings，避免本机真实 Gateway discovery 覆盖测试 envPath
  if (env.HOME && env.OPENCLAW_CONFIG_PATH) {
    const stateDir = join(env.HOME, ".oc-switch");
    const settingsPath = join(stateDir, "settings.json");
    if (!existsSync(settingsPath)) {
      mkdirSync(stateDir, { recursive: true });
      const envPath = join(env.HOME, ".openclaw", ".env");
      mkdirSync(join(env.HOME, ".openclaw"), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({
        openclawPath: env.OPENCLAW_CONFIG_PATH,
        envPath
      }));
    }
  }
  const stubDir = prepareOpenClawStub(options.pluginsListJson ?? '{"plugins":[]}');
  const proc = Bun.spawn(["bun", "run", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, OPENCLAW_CONFIG_PATH: undefined, OPENCLAW_STATE_DIR: undefined, OC_SWITCH_MOCK_RUNTIME_MODELS: undefined, ...env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text()
  };
}

describe("cli read commands", () => {
  test("command context caches one runtime discovery snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-context-"));
    tempDirs.push(dir);
    const home = join(dir, "home");
    const runtimeState = join(dir, "runtime");
    mkdirSync(runtimeState, { recursive: true });
    const openclawPath = join(runtimeState, "openclaw.json");
    const envPath = join(runtimeState, ".env");
    writeFileSync(openclawPath, "{}\n");
    writeFileSync(envPath, "RUNTIME=1\n");
    let calls = 0;
    const context = createCommandContext({
      env: { HOME: home },
      stateDir: join(home, ".oc-switch"),
      runtimeDiscoveryProvider: () => {
        calls += 1;
        return {
          status: "resolved",
          instances: [{
            instanceId: "pid:7",
            pid: 7,
            stateDir: runtimeState,
            openclawPath,
            envPath,
            confidence: "strong",
            evidence: ["process-environ"]
          }],
          candidateGroups: [{
            candidateId: "pid:7:candidate",
            instanceId: "pid:7",
            stateDir: runtimeState,
            openclawPath,
            envPath,
            pid: 7,
            confidence: "strong",
            evidence: ["process-environ"]
          }],
          diagnostics: []
        };
      }
    });

    expect(context.activePaths().openclawPath).toBe(openclawPath);
    expect(context.activePaths().envPath).toBe(envPath);
    expect(calls).toBe(1);
    expect(repoRoot).toBe(join(import.meta.dir, "../../.."));
  });

  test("prints status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["status"], { OPENCLAW_CONFIG_PATH: configPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Primary: minimax-portal/MiniMax-M3");
    expect(result.stdout).toContain("Providers: 3");
    expect(result.stdout).toContain("Allowlist models: 4");
  });

  test("prints providers with status column", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nvidia");
    expect(result.stdout).toContain("enabled");
    expect(result.stdout).toContain("minimax-portal");
  });

  test("health repair dry-run previews compatibility fixes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!.repairme = {
      apiKey: { source: "env", id: "REPAIRME_API_KEY" },
      models: [{ id: "model-x" }]
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const dry = await runCli(["health", "repair", "--dry-run"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("repairme");
    expect(JSON.parse(readFileSync(configPath, "utf8")).models.providers.repairme.apiKey).toEqual({
      source: "env",
      id: "REPAIRME_API_KEY"
    });

    const repair = await runCli(["health", "repair"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });
    expect(repair.code).toBe(0);
    expect(repair.stdout).toContain("Repaired OpenClaw compatibility");
    expect(JSON.parse(readFileSync(configPath, "utf8")).models.providers.repairme.apiKey).toEqual({
      source: "env",
      id: "REPAIRME_API_KEY"
    });
  });
});

describe("cli write commands", () => {
  test("uses slash-containing model ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Primary model set to nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("disables model allowlist entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["model", "disable", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Disabled nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("lists backups after write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    const result = await runCli(["backup", "list"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("set primary model");
  });

  test("diff shows changes since latest backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    const result = await runCli(["diff"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("primaryChanged");
    expect(result.stdout).not.toContain("sk-");
  });

  test("restores backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    const listResult = await runCli(["backup", "list"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    const backupId = listResult.stdout.trim().split("\n")[0]?.split("\t")[0];
    expect(backupId).toBeTruthy();

    const restoreResult = await runCli(["backup", "restore", backupId!], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(restoreResult.code).toBe(0);

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.agents.defaults.model).toBe("minimax-portal/MiniMax-M3");
  });

  test("rejects restore when backup paths mismatch active paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    const listResult = await runCli(["backup", "list"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    const backupId = listResult.stdout.trim().split("\t")[0];
    expect(backupId).toBeTruthy();

    const otherConfig = join(dir, "other-openclaw.json");
    writeFileSync(otherConfig, `${JSON.stringify(sample, null, 2)}\n`);

    const restoreResult = await runCli(["backup", "restore", backupId!], {
      OPENCLAW_CONFIG_PATH: otherConfig,
      HOME: dir
    });
    expect(restoreResult.code).not.toBe(0);
    expect(restoreResult.stderr).toContain("备份路径与当前 active 路径不一致");
  });
});

describe("cli preset commands", () => {
  test("exports provider preset without secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["presets", "export", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Exported preset");
    expect(result.stdout).not.toContain("sk-");
    expect(result.stderr).not.toContain("sk-");
  });

  test("imports all providers as presets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["import"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Imported preset nvidia");
    expect(result.stdout).not.toContain("sk-");
  });

  test("lists presets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    await runCli(["import"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });
    const result = await runCli(["presets", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nvidia");
    expect(result.stdout).toContain("custom");
  });
});

describe("cli provider crud", () => {
  test("adds provider from preset with key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);
    const customDir = join(dir, ".oc-switch", "presets", "custom");
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, "testprov.json"), JSON.stringify({
      id: "testprov",
      name: "Test Provider",
      provider: { api: "openai-completions", baseUrl: "https://test.example/v1", apiKeyEnv: "TESTPROV_API_KEY" },
      models: [{ id: "vendor/model", alias: "vm" }]
    }));

    const result = await runCli(["provider", "add", "testprov", "--key", "test-secret-value", "--models", "vendor/model"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("test-secret-value");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.testprov.baseUrl).toBe("https://test.example/v1");
    expect(config.agents.defaults.models["testprov/vendor/model"]).toEqual({ alias: "vm" });
  });

  test("edits provider base url and api", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "edit", "nvidia",
      "--base-url", "https://new-nvidia.example/v1",
      "--api", "anthropic-messages"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia.baseUrl).toBe("https://new-nvidia.example/v1");
    expect(config.models.providers.nvidia.api).toBe("anthropic-messages");
    expect(config.models.providers.nvidia.models[0].id).toBe("deepseek-ai/deepseek-v4-flash");
  });

  test("provider edit --key rejects unmanaged env without --confirm-migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const envPath = join(dir, ".openclaw", ".env");
    mkdirSync(join(dir, ".openclaw"), { recursive: true });
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!.nvidia!.apiKey = "${NVIDIA_API_KEY}";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(envPath, "NVIDIA_API_KEY=old-secret\n");

    const rejected = await runCli(["provider", "edit", "nvidia", "--key", "new-secret"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("env var migration requires confirmation");

    const accepted = await runCli([
      "provider", "edit", "nvidia", "--key", "new-secret", "--confirm-migration"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(accepted.code).toBe(0);
    expect(readFileSync(envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(readFileSync(envPath, "utf8")).not.toContain("old-secret");
  });

  test("deletes provider with new primary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "delete", "minimax-portal",
      "--new-primary", "nvidia/deepseek-ai/deepseek-v4-flash"
    ], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers["minimax-portal"]).toBeUndefined();
    expect(config.agents.defaults.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("adds custom provider with slash-containing model id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "add-custom",
      "--id", "custom-openai",
      "--name", "Custom OpenAI",
      "--api", "openai-completions",
      "--base-url", "https://api.custom.example",
      "--env", "CUSTOM_OPENAI_API_KEY",
      "--key", "sk-test-custom-secret",
      "--models", "model-a,vendor/model-b",
      "--aliases", "model-a:a,vendor/model-b:b"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Added custom provider custom-openai");
    expect(result.stdout + result.stderr).not.toContain("sk-test-custom-secret");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers["custom-openai"].baseUrl).toBe("https://api.custom.example/v1");
    expect(config.agents.defaults.models["custom-openai/vendor/model-b"]).toEqual({ alias: "b" });
    expect(readFileSync(join(dir, ".openclaw", ".env"), "utf8")).toContain("CUSTOM_OPENAI_API_KEY=sk-test-custom-secret");
  });

  test("adds custom provider without allowlist when disabled by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "add-custom",
      "--id", "custom-disabled",
      "--name", "Custom Disabled",
      "--api", "anthropic-messages",
      "--base-url", "https://anthropic.custom.example",
      "--env", "CUSTOM_DISABLED_API_KEY",
      "--key", "sk-test-custom-secret",
      "--models", "claude-4",
      "--disable-by-default"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers["custom-disabled"].apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "CUSTOM_DISABLED_API_KEY"
    });
    expect(config.models.providers["custom-disabled"].authHeader).toBeUndefined();
    expect(config.agents.defaults.models["custom-disabled/claude-4"]).toBeUndefined();
  });

  test("rejects custom provider with unsupported api type", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "add-custom",
      "--id", "bad-api",
      "--name", "Bad API",
      "--api", "bogus-api",
      "--base-url", "https://api.bad.example",
      "--key", "sk-test-custom-secret",
      "--models", "model-a"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("api must be a supported API type");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers["bad-api"]).toBeUndefined();
  });
});

describe("cli model crud", () => {
  test("adds model with slash id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "model", "add", "nvidia/deepseek-ai/deepseek-v4-pro",
      "--alias", "nv-ds-pro", "--enable"
    ], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((m: { id: string }) => m.id)).toContain("deepseek-ai/deepseek-v4-pro");
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-pro"]).toEqual({ alias: "nv-ds-pro" });
  });

  test("removes model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["model", "remove", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((m: { id: string }) => m.id)).not.toContain("deepseek-ai/deepseek-v4-flash");
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
  });
});

describe("cli provider sync", () => {
  test("discovers openai-compatible provider with mocked fetch without writing config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    const configText = `${JSON.stringify(sample, null, 2)}\n`;
    writeFileSync(configPath, configText);

    const result = await runCli(["provider", "sync", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir,
      OC_SWITCH_MOCK_SYNC: "remote-model-a,remote-model-b"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("sk-");
    expect(result.stdout).toContain("remote-model-a");
    expect(result.stdout).toContain("remote-model-b");
    expect(readFileSync(configPath, "utf8")).toBe(configText);
  });

  test("reports unsupported for google-generative-ai provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!["google-test"] = {
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "google-generative-ai",
      apiKey: { source: "env", id: "GOOGLE_API_KEY" },
      models: [{ id: "gemini-pro" }]
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await runCli(["provider", "sync", "google-test"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("google-generative-ai");
  });

  test("sync --add writes models including ids with slashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "sync", "nvidia",
      "--add", "vendor/new-model,vendor/nested/extra"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("已添加 2 个模型");
    expect(result.stdout).toContain("vendor/new-model");
    expect(result.stdout).toContain("vendor/nested/extra");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const ids = config.models.providers.nvidia.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("vendor/new-model");
    expect(ids).toContain("vendor/nested/extra");
    expect(config.models.providers.nvidia.models.find(
      (model: { id: string }) => model.id === "vendor/new-model"
    ).reasoning).toBe(true);
    expect(config.models.providers.nvidia.models.find(
      (model: { id: string }) => model.id === "vendor/nested/extra"
    ).reasoning).toBe(true);
    expect(config.agents.defaults.models["nvidia/vendor/new-model"]).toBeUndefined();
    expect(config.agents.defaults.models["nvidia/vendor/nested/extra"]).toBeUndefined();
  });

  test("sync --add --enable writes allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli([
      "provider", "sync", "nvidia",
      "--add", "vendor/enabled-model",
      "--enable"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((m: { id: string }) => m.id)).toContain("vendor/enabled-model");
    expect(config.agents.defaults.models["nvidia/vendor/enabled-model"]).toEqual({});
  });

  test("sync --add rejects when provider model catalog is over limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!.nvidia!.models = Array.from({ length: MAX_PROVIDER_MODELS }, (_, index) => ({
      id: `catalog-model-${index}`,
      name: `Catalog ${index}`
    }));
    const configText = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(configPath, configText);

    const result = await runCli([
      "provider", "sync", "nvidia",
      "--add", "vendor/over-cap"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/limit|capacity/i);
    expect(readFileSync(configPath, "utf8")).toBe(configText);
  });

  test("sync --add rejects disabled provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    await runCli(["provider", "disable", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    const result = await runCli([
      "provider", "sync", "nvidia",
      "--add", "vendor/blocked"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Provider nvidia is disabled");
  });
});

describe("cli Provider 生命周期快照清理", () => {
  test("provider delete 成功后删除同 Provider 的 disabled snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);
    upsertDisabledProviderState(join(dir, ".oc-switch"), {
      providerId: "nvidia",
      openclawPath: configPath,
      disabledAt: "2026-09-04T00:00:00.000Z",
      allowlistEntries: {}
    });

    const result = await runCli(["provider", "delete", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const states = JSON.parse(readFileSync(join(dir, ".oc-switch", "provider-states.json"), "utf8"));
    expect(states.disabledProviders.nvidia).toBeUndefined();
  });

  test("providers merge-duplicates 成功后清理整个重复组的 disabled snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!.deepseek = { models: [{ id: "extra" }] };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    for (const providerId of ["deepseek", "DeepSeek"]) {
      upsertDisabledProviderState(join(dir, ".oc-switch"), {
        providerId,
        openclawPath: configPath,
        disabledAt: "2026-09-04T00:00:00.000Z",
        allowlistEntries: {}
      });
    }

    const result = await runCli([
      "providers", "merge-duplicates", "--group", "deepseek", "--keep", "deepseek", "--remove", "DeepSeek"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const states = JSON.parse(readFileSync(join(dir, ".oc-switch", "provider-states.json"), "utf8"));
    expect(states.disabledProviders.deepseek).toBeUndefined();
  });
});

describe("cli provider models remove", () => {
  test("removes models by --ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!.nvidia!.models!.push(
      { id: "vendor/removable-a", name: "Removable A" },
      { id: "vendor/removable-b", name: "Removable B" }
    );
    config.agents!.defaults!.models!["nvidia/vendor/removable-b"] = {};
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await runCli([
      "provider", "models", "remove", "nvidia",
      "--ids", "vendor/removable-a"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("已删除 1 个模型");
    expect(result.stdout).toContain("vendor/removable-a");
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    const ids = after.models.providers.nvidia.models.map((m: { id: string }) => m.id);
    expect(ids).not.toContain("vendor/removable-a");
    expect(ids).toContain("vendor/removable-b");
    expect(after.agents.defaults.models["nvidia/vendor/removable-a"]).toBeUndefined();
    expect(after.agents.defaults.models["nvidia/vendor/removable-b"]).toEqual({});
  });

  test("keep-enabled-only removes unlisted catalog models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.models!.providers!.nvidia!.models!.push({ id: "vendor/unlisted-catalog", name: "Unlisted" });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const result = await runCli([
      "provider", "models", "remove", "nvidia",
      "--keep-enabled-only"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("vendor/unlisted-catalog");
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    const ids = after.models.providers.nvidia.models.map((m: { id: string }) => m.id).sort();
    expect(ids).toEqual(["deepseek-ai/deepseek-v4-flash", "z-ai/glm5.1"].sort());
    expect(after.agents.defaults.models["nvidia/vendor/unlisted-catalog"]).toBeUndefined();
  });

  test("requires one of --ids or --keep-enabled-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const missing = await runCli(["provider", "models", "remove", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("require one of --ids or --keep-enabled-only");

    const both = await runCli([
      "provider", "models", "remove", "nvidia",
      "--ids", "z-ai/glm5.1",
      "--keep-enabled-only"
    ], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain("mutually exclusive");
  });
});

describe("cli start/stop/restart", () => {
  test("start fails without web dist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-start-"));
    tempDirs.push(dir);
    const emptyDist = mkdtempSync(join(tmpdir(), "oc-switch-empty-dist-"));
    tempDirs.push(emptyDist);
    writeFileSync(join(dir, "openclaw.json"), "{}\n");
    const result = await runCli(["start"], {
      HOME: dir,
      OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json"),
      OC_SWITCH_WEB_DIST: emptyDist
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/build/i);
  });

  test("stop with no pid exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-stop-"));
    tempDirs.push(dir);
    const result = await runCli(["stop"], { HOME: dir });
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/not running|未在运行|No server/i);
  });

  test("restart cleans a stale pid before reusing start validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-restart-"));
    tempDirs.push(dir);
    const emptyDist = mkdtempSync(join(tmpdir(), "oc-switch-empty-dist-"));
    tempDirs.push(emptyDist);
    const stateDir = join(dir, ".oc-switch");
    mkdirSync(stateDir, { recursive: true });
    const pidPath = join(stateDir, "serve.pid");
    writeFileSync(pidPath, "2147483647\n");
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, "{}\n");

    const result = await runCli(["restart"], {
      HOME: dir,
      OPENCLAW_CONFIG_PATH: configPath,
      OC_SWITCH_WEB_DIST: emptyDist
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/build/i);
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe("cli serve and token", () => {
  test("serve rejects 0.0.0.0 without token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const result = await runCli(["serve", "--host", "0.0.0.0", "--port", "17420"], {
      HOME: dir,
      OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json")
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("0.0.0.0");
  });

  test("token rotate writes persisted token with 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const result = await runCli(["token", "rotate"], { HOME: dir });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Rotated token");
    const tokenPath = join(dir, ".oc-switch", "token.json");
    expect(existsSync(tokenPath)).toBe(true);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(result.stdout + result.stderr).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
  });
});

test("uses persisted oc-switch env path when OPENCLAW_CONFIG_PATH overrides only config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-active-paths-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, "custom.env");
  const stateDir = join(dir, ".oc-switch");
  mkdirSync(stateDir, { recursive: true });
  const config = structuredClone(sample) as OpenClawConfig;
  config.models!.providers!.nvidia!.apiKey = "${NVIDIA_API_KEY}";
  writeFileSync(openclawPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(envPath, "");
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ envPath }, null, 2));

  const result = await runCli([
    "provider", "edit", "nvidia",
    "--key", "persisted-env-secret"
  ], { OPENCLAW_CONFIG_PATH: openclawPath, HOME: dir });

  expect(result.code).toBe(0);
  expect(readFileSync(envPath, "utf8")).toContain("NVIDIA_API_KEY=persisted-env-secret");
});

describe("cli provider disable/enable", () => {
  test("disables and restores provider from CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const disable = await runCli(["provider", "disable", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(disable.code).toBe(0);
    expect(disable.stdout).toContain("Disabled provider nvidia (2 model(s) hidden)");
    let config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia).toBeDefined();
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();

    const list = await runCli(["providers", "list"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(list.stdout).toContain("nvidia");
    expect(list.stdout).toContain("disabled");

    const enable = await runCli(["provider", "enable", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(enable.code).toBe(0);
    expect(enable.stdout).toContain("Enabled provider nvidia (2 model(s) restored)");
    config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash",
      agentRuntime: { id: "codex" }
    });
  });

  test("refuses disabling primary provider and enabling model inside disabled provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const primary = await runCli(["provider", "disable", "minimax-portal"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(primary.code).not.toBe(0);
    expect(primary.stderr).toContain("contains the primary model");

    await runCli(["provider", "disable", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    const enableModel = await runCli(["model", "enable", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });
    expect(enableModel.code).not.toBe(0);
    expect(enableModel.stderr).toContain("Provider nvidia is disabled");
  });
});

describe("cli gateway commands", () => {
  test("gateway sync-env merges managed block for single active candidate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-gateway-"));
    tempDirs.push(dir);
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    prepareGatewayEnvTarget(dir, homeDir);
    const openclawPath = join(dir, "openclaw.json");
    const envPath = join(dir, ".env");
    const stateDir = join(homeDir, ".oc-switch");
    const serviceEnvPath = expectedGatewayEnvPath(dir);
    writeFileSync(envPath, "# oc-switch:start\nCLI_SYNC_KEY=cli-secret\n# oc-switch:end\n");
    writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ openclawPath, envPath }));

    const serviceManager = process.platform === "darwin" ? "launchd" as const : "systemd" as const;
    const discovery: RuntimeDiscoveryResult = {
      status: "resolved",
      instances: [{
        instanceId: "cli:single",
        pid: 42,
        openclawPath,
        envPath,
        stateDir: dir,
        serviceEnvPath,
        serviceManager,
        confidence: "strong",
        evidence: ["process-environ"]
      }],
      candidateGroups: [{
        candidateId: "cli:single:candidate",
        instanceId: "cli:single",
        stateDir: dir,
        openclawPath,
        envPath,
        serviceEnvPath,
        serviceManager,
        pid: 42,
        confidence: "strong",
        evidence: ["process-environ"]
      }],
      diagnostics: []
    };

    const program = new Command();
    program.exitOverride();
    const context = createCommandContext({
      env: { HOME: homeDir, OPENCLAW_CONFIG_PATH: openclawPath },
      stateDir,
      runtimeDiscoveryProvider: () => discovery
    });
    registerGatewayCommands(program, context);
    await program.parseAsync(["gateway", "sync-env"], { from: "user" });

    const gatewayContent = readFileSync(serviceEnvPath, "utf8");
    expect(gatewayContent).toContain("CLI_SYNC_KEY");
    expect(gatewayContent).toContain("cli-secret");
  });

  test("gateway commands require --candidate when multiple candidates exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-gateway-multi-"));
    tempDirs.push(dir);
    const homeDir = join(dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const openclawPath = join(dir, "openclaw.json");
    const envPath = join(dir, ".env");
    const stateDir = join(homeDir, ".oc-switch");
    const serviceEnvPath = join(dir, "gateway.systemd.env");
    writeFileSync(envPath, "# oc-switch:start\nK=v\n# oc-switch:end\n");
    writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
    writeFileSync(serviceEnvPath, "");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ openclawPath, envPath }));

    const discovery: RuntimeDiscoveryResult = {
      status: "resolved",
      instances: [],
      candidateGroups: [
        {
          candidateId: "cli:a:candidate",
          instanceId: "cli:a",
          stateDir: dir,
          openclawPath,
          envPath,
          serviceEnvPath,
          serviceManager: "systemd",
          pid: 1,
          confidence: "strong",
          evidence: ["process-environ"]
        },
        {
          candidateId: "cli:b:candidate",
          instanceId: "cli:b",
          stateDir: join(dir, "b"),
          openclawPath: join(dir, "b", "openclaw.json"),
          envPath: join(dir, "b", ".env"),
          serviceEnvPath: join(dir, "b", "gateway.systemd.env"),
          serviceManager: "systemd",
          pid: 2,
          confidence: "strong",
          evidence: ["process-environ"]
        }
      ],
      diagnostics: []
    };

    const program = new Command();
    program.exitOverride();
    const context = createCommandContext({
      env: { HOME: homeDir, OPENCLAW_CONFIG_PATH: openclawPath },
      stateDir,
      runtimeDiscoveryProvider: () => discovery
    });
    let stderr = "";
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      stderr += args.map(String).join(" ") + "\n";
    };
    registerGatewayCommands(program, context, {
      restartGateway: async () => ({ ok: true, exitCode: 0, message: "ok" })
    });
    try {
      await expect(program.parseAsync(["gateway", "restart"], { from: "user" })).rejects.toThrow();
      expect(stderr).toContain("cli:a:candidate");
      expect(stderr).toContain("cli:b:candidate");
      expect(stderr).not.toContain("K=v");
    } finally {
      console.error = originalError;
    }

    const okProgram = new Command();
    okProgram.exitOverride();
    let seenCandidate = "";
    registerGatewayCommands(okProgram, context, {
      restartGateway: async (input) => {
        seenCandidate = input.target.candidateId;
        return { ok: true, exitCode: 0, message: "Gateway restarted" };
      }
    });
    await okProgram.parseAsync(["gateway", "restart", "--candidate", "cli:a:candidate"], { from: "user" });
    expect(seenCandidate).toBe("cli:a:candidate");

    const staleProgram = new Command();
    staleProgram.exitOverride();
    registerGatewayCommands(staleProgram, context, {
      restartGateway: async () => ({ ok: true, exitCode: 0, message: "ok" })
    });
    await expect(
      staleProgram.parseAsync(["gateway", "restart", "--candidate", "missing"], { from: "user" })
    ).rejects.toThrow(/missing|stale|no longer/i);
  });
});

describe("provider sync-metadata / metadata-queue", () => {
  /** 用 core fixture 组装 OC_SWITCH_MOCK_METADATA 文件（{ models, api } 双 payload） */
  function writeMockMetadataFile(dir: string): string {
    const fixtureDir = join(import.meta.dir, "../../core/test/fixtures/model-metadata");
    const mockPath = join(dir, "mock-metadata.json");
    writeFileSync(mockPath, JSON.stringify({
      models: JSON.parse(readFileSync(join(fixtureDir, "models.json"), "utf8")),
      api: JSON.parse(readFileSync(join(fixtureDir, "api.json"), "utf8"))
    }));
    return mockPath;
  }

  /** endpoint-provider：special-model 唯一 high 置信（provider-exact + endpoint-exact），shared 多候选入队 */
  function writeEndpointConfig(configPath: string): void {
    writeFileSync(configPath, `${JSON.stringify({
      models: {
        providers: {
          "endpoint-provider": {
            baseUrl: "https://api.endpoint.example/v1",
            api: "openai-completions",
            models: [{ id: "special-model" }, { id: "shared" }]
          }
        }
      }
    }, null, 2)}\n`);
  }

  test("sync-metadata 回填 high 置信模型并列摘要；队列 list/accept/dismiss 全链路", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-mmsync-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeEndpointConfig(configPath);
    const env = {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir,
      OC_SWITCH_MOCK_METADATA: writeMockMetadataFile(dir)
    };

    // 同步：special-model 自动回填；shared 进确认队列
    const sync = await runCli(["provider", "sync-metadata", "endpoint-provider"], env);
    expect(sync.code).toBe(0);
    expect(sync.stdout).toContain("已回填 1");
    expect(sync.stdout).toContain("待确认 1");
    let config = JSON.parse(readFileSync(configPath, "utf8"));
    const special = config.models.providers["endpoint-provider"].models
      .find((model: { id: string }) => model.id === "special-model");
    expect(special.contextWindow).toBe(64000);

    // 队列 list：含模型条目与候选 catalogKey
    const list = await runCli(["provider", "metadata-queue", "list"], env);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("endpoint-provider/shared");
    expect(list.stdout).toContain("aaa/shared");

    // accept 指定候选：shared 回填 contextWindow 1000，队列清空
    const accept = await runCli([
      "provider", "metadata-queue", "accept", "endpoint-provider", "shared",
      "--catalog", "aaa/shared"
    ], env);
    expect(accept.code).toBe(0);
    expect(accept.stdout).toContain("已回填 shared");
    config = JSON.parse(readFileSync(configPath, "utf8"));
    const shared = config.models.providers["endpoint-provider"].models
      .find((model: { id: string }) => model.id === "shared");
    expect(shared.contextWindow).toBe(1000);
    const emptyList = await runCli(["provider", "metadata-queue", "list"], env);
    expect(emptyList.stdout).toContain("确认队列为空");

    // 再次入队后 dismiss：仅标记已忽略
    const resync = await runCli(["provider", "sync-metadata", "endpoint-provider"], env);
    expect(resync.code).toBe(0);
    const dismiss = await runCli(["provider", "metadata-queue", "dismiss", "endpoint-provider", "shared"], env);
    expect(dismiss.code).toBe(0);
    expect(dismiss.stdout).toContain("已忽略 1 项");
    const dismissedList = await runCli(["provider", "metadata-queue", "list"], env);
    expect(dismissedList.stdout).toContain("[已忽略]");
  });

  test("metadata-queue list --provider 大小写折叠：归一化前大写入队项对小写过滤可见", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-mmsync-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeEndpointConfig(configPath);
    // 模拟归一化前写入：队列项存大写 provider key
    writeModelMetadataQueue(join(dir, ".oc-switch"), {
      version: 1,
      items: [{
        providerId: "ENDPOINT-PROVIDER",
        modelId: "shared",
        dismissed: false,
        lastSeenAt: "2026-09-05T00:00:00.000Z",
        candidates: [{
          catalogKey: "aaa/shared",
          score: 1,
          reason: "resolver-core-model-id",
          metadata: {
            catalogKey: "aaa/shared",
            providerId: "aaa",
            modelId: "shared",
            contextWindow: 1000,
            sourceKind: "models-dev-model",
            sourceUrl: "https://models.dev/aaa/shared"
          }
        }]
      }]
    });
    const env = { OPENCLAW_CONFIG_PATH: configPath, HOME: dir };

    const list = await runCli(["provider", "metadata-queue", "list", "--provider", "endpoint-provider"], env);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("ENDPOINT-PROVIDER/shared");
    // 不匹配的小写过滤仍为空
    const other = await runCli(["provider", "metadata-queue", "list", "--provider", "openrouter"], env);
    expect(other.stdout).toContain("确认队列为空");
  });

  test("sync-metadata 无 mock 且目录不可用时 fail closed：报错退出非 0、不写盘", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-mmsync-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeEndpointConfig(configPath);
    const configText = readFileSync(configPath, "utf8");

    // 不注入 OC_SWITCH_MOCK_METADATA；指向不可达代理让 models.dev 请求确定性失败
    const result = await runCli(["provider", "sync-metadata", "endpoint-provider"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir,
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9"
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("目录不可用");
    expect(readFileSync(configPath, "utf8")).toBe(configText);
  });
});

describe("对象形态主模型 CLI", () => {
  function writeObjectPrimaryConfig(): { dir: string; configPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    const config = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>;
    (config.agents as { defaults: Record<string, unknown> }).defaults.model = {
      primary: "  minimax-portal/MiniMax-M3  ",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"]
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { dir, configPath };
  }

  test("status 输出 trim 后的归一 ref，不再出现 [object Object]", async () => {
    const { configPath } = writeObjectPrimaryConfig();
    const result = await runCli(["status"], { OPENCLAW_CONFIG_PATH: configPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Primary: minimax-portal/MiniMax-M3");
    expect(result.stdout).not.toContain("[object Object]");
  });

  test("providers list 对对象形态主模型不再崩溃", async () => {
    const { dir, configPath } = writeObjectPrimaryConfig();
    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("minimax-portal");
    expect(result.stdout).not.toContain("[object Object]");
  });
});

describe("cli 插件 provider", () => {
  /** 落一份插件 manifest 并返回 `openclaw plugins list --json` 的等价输出 */
  function preparePluginFixture(options: { enabled?: boolean; providerId?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-plugin-"));
    tempDirs.push(dir);
    const rootDir = join(dir, "opencode");
    mkdirSync(rootDir, { recursive: true });
    const providerId = options.providerId ?? "opencode";
    writeFileSync(join(rootDir, "openclaw.plugin.json"), JSON.stringify({
      modelCatalog: {
        providers: {
          [providerId]: {
            baseUrl: "https://opencode.ai/zen/v1",
            api: "openai-completions",
            models: [{ id: "big-pickle" }, { id: "hy3" }]
          }
        }
      },
      setup: { providers: [{ id: providerId, envVars: ["OPENCODE_API_KEY"] }] }
    }));
    return JSON.stringify({
      plugins: [{
        id: "opencode",
        rootDir,
        origin: "npm-global",
        enabled: options.enabled ?? true,
        status: "loaded",
        providerIds: [providerId]
      }]
    });
  }

  function writeConfig(): { dir: string; configPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);
    return { dir, configPath };
  }

  test("providers list 列出插件 provider 并标注 plugin", async () => {
    const { dir, configPath } = writeConfig();
    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir }, {
      pluginsListJson: preparePluginFixture()
    });
    expect(result.code).toBe(0);
    const pluginRow = result.stdout.split("\n").find((line) => line.startsWith("opencode\t"));
    expect(pluginRow).toBeDefined();
    expect(pluginRow).toContain("plugin");
    expect(pluginRow).toContain("enabled");
    // config 条目不带 plugin 标记
    expect(result.stdout.split("\n").find((line) => line.startsWith("nvidia\t"))).not.toContain("plugin");
  });

  test("providers list 对停用插件显示 disabled", async () => {
    const { dir, configPath } = writeConfig();
    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir }, {
      pluginsListJson: preparePluginFixture({ enabled: false })
    });
    expect(result.code).toBe(0);
    const pluginRow = result.stdout.split("\n").find((line) => line.startsWith("opencode\t"));
    expect(pluginRow).toContain("disabled");
    expect(pluginRow).toContain("0/2");
  });

  test("models list 含插件模型行", async () => {
    const { dir, configPath } = writeConfig();
    const result = await runCli(["models", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir }, {
      pluginsListJson: preparePluginFixture()
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("opencode/big-pickle");
    expect(result.stdout).toContain("opencode/hy3");
  });

  test("model enable 与 use 接受插件 ref 并落盘", async () => {
    const { dir, configPath } = writeConfig();
    const pluginsListJson = preparePluginFixture();
    const enabled = await runCli(["model", "enable", "opencode/big-pickle", "--alias", "oc-bp"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    }, { pluginsListJson });
    expect(enabled.code).toBe(0);
    expect(enabled.stdout).toContain("Enabled opencode/big-pickle");

    const used = await runCli(["use", "opencode/hy3"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir }, {
      pluginsListJson
    });
    expect(used.code).toBe(0);

    const config = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfig;
    expect(config.agents?.defaults?.models?.["opencode/big-pickle"]).toEqual({ alias: "oc-bp" });
    expect(config.agents?.defaults?.model).toBe("opencode/hy3");
  });

  test("model enable 拒绝停用插件的 ref，配置不变", async () => {
    const { dir, configPath } = writeConfig();
    const before = readFileSync(configPath, "utf8");
    const result = await runCli(["model", "enable", "opencode/big-pickle"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    }, { pluginsListJson: preparePluginFixture({ enabled: false }) });
    expect(result.code).not.toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("provider remove 对插件 provider 显式失败，配置不变", async () => {
    const { dir, configPath } = writeConfig();
    const before = readFileSync(configPath, "utf8");
    const result = await runCli(["provider", "remove", "opencode", "--force"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    }, { pluginsListJson: preparePluginFixture() });
    expect(result.code).not.toBe(0);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("openclaw CLI 缺失时降级为 config-only，不影响既有输出", async () => {
    const { dir, configPath } = writeConfig();
    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath, HOME: dir });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nvidia");
    expect(result.stdout).not.toContain("plugin");
  });
});

describe("cli 运行时模型管理（inventory / reconcile / plugin）", () => {
  /**
   * 组装 OC_SWITCH_MOCK_RUNTIME_MODELS fixture 文件：键（version/status/list/listAll）
   * 直接对应四个探测命令，值是假 openclaw 会打印的原始 stdout（版本串 / models JSON），
   * production parser 照常解析，不喂业务 DTO。
   * 值为 undefined 的命令不出现在 fixture 中，按「命令缺失」应答（status null、非超时）。
   */
  function writeRuntimeMockFile(
    dir: string,
    commands: {
      version?: string | undefined;
      status?: unknown;
      list?: unknown;
      listAll?: unknown;
    } = {}
  ): string {
    const mockPath = join(dir, "mock-runtime-models.json");
    const fixture: Record<string, { status: number; stdout: string }> = {};
    if (commands.version !== undefined) fixture.version = { status: 0, stdout: commands.version };
    if (commands.status !== undefined) fixture.status = { status: 0, stdout: JSON.stringify(commands.status) };
    if (commands.list !== undefined) fixture.list = { status: 0, stdout: JSON.stringify(commands.list) };
    if (commands.listAll !== undefined) fixture.listAll = { status: 0, stdout: JSON.stringify(commands.listAll) };
    writeFileSync(mockPath, JSON.stringify(fixture));
    return mockPath;
  }

  /** restricted policy + 悬空 exact ref fixture（spec §13.4 acceptance 场景 1/3 的 CLI 版） */
  function writePolicyFixture(): { dir: string; configPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-runtime-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config = structuredClone(sample) as OpenClawConfig;
    config.agents!.defaults!.modelPolicy = {
      allow: [
        "nvidia/*",
        "minimax-portal/MiniMax-M3",
        "DeepSeek/deepseek-chat",
        "ghost-provider/policy-only-model"
      ]
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { dir, configPath };
  }

  /** 完整探测的 runtime fixture：ghost ref available=false（provider 拒绝）+ nvidia 运行时新模型 */
  function completeRuntimeCommands(): { status: unknown; list: unknown; listAll: unknown } {
    return {
      status: {
        agentDir: "/home/.openclaw",
        defaultModel: "minimax-portal/MiniMax-M3",
        fallbacks: [],
        allowed: [
          "minimax-portal/MiniMax-M3",
          "DeepSeek/deepseek-chat",
          "ghost-provider/policy-only-model"
        ]
      },
      list: { models: [
        { key: "minimax-portal/MiniMax-M3", available: true, tags: [] },
        { key: "DeepSeek/deepseek-chat", available: true, tags: [] },
        { key: "ghost-provider/policy-only-model", available: false, tags: [] }
      ] },
      listAll: { models: [
        { key: "minimax-portal/MiniMax-M3", available: true, tags: [] },
        { key: "DeepSeek/deepseek-chat", available: true, tags: [] },
        { key: "ghost-provider/policy-only-model", available: false, tags: [] },
        { key: "nvidia/vendor/runtime-extra", available: true, tags: [] }
      ] }
    };
  }

  /** xiaomi 插件 fixture：一个插件贡献两个 Provider + speech/contract 非模型能力（spec §9.1） */
  function prepareXiaomiPluginFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-xiaomi-"));
    tempDirs.push(dir);
    const rootDir = join(dir, "xiaomi");
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(join(rootDir, "openclaw.plugin.json"), JSON.stringify({
      modelCatalog: {
        providers: {
          xiaomi: { baseUrl: "https://xiaomi.example/v1", api: "openai-completions", models: [{ id: "mi-1" }, { id: "mi-2" }] },
          "xiaomi-token-plan": { baseUrl: "https://xiaomi.example/plan/v1", api: "openai-completions", models: [{ id: "tp-1" }, { id: "tp-2" }] }
        }
      },
      contracts: { acp: {} }
    }));
    return JSON.stringify({
      plugins: [{
        id: "xiaomi",
        rootDir,
        origin: "npm-global",
        enabled: true,
        providerIds: ["xiaomi", "xiaomi-token-plan"],
        speechProviderIds: ["xiaomi-tts"]
      }]
    });
  }

  /** xiaomi 场景 config：主模型/fallback 均在 other Provider，policy 命中两个 xiaomi Provider */
  function writeXiaomiConfig(options: { withEntries?: boolean } = {}): { dir: string; configPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-xiaomi-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "openclaw.json");
    const config: OpenClawConfig = {
      ...(options.withEntries
        ? { plugins: { entries: { xiaomi: { enabled: true, pinned: "1.2.0", config: { region: "cn" } } } } }
        : {}),
      models: { providers: { other: { models: [{ id: "primary-model" }] } } },
      agents: {
        defaults: {
          model: "other/primary-model",
          models: { "other/primary-model": { alias: "primary" } },
          modelPolicy: { allow: ["other/primary-model", "xiaomi/mi-1", "xiaomi-token-plan/*"] }
        }
      }
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { dir, configPath };
  }

  describe("models inventory / unavailable", () => {
    test("表格输出包含 ref、policy、availability、reason、sources，--json 与 Core inventory 一致", async () => {
      const { dir, configPath } = writePolicyFixture();
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, completeRuntimeCommands())
      };

      const table = await runCli(["models", "inventory"], env);
      expect(table.code).toBe(0);
      // 表格列：ref / policy / availability / reason / sources
      expect(table.stdout).toContain("ref");
      expect(table.stdout).toContain("policy");
      expect(table.stdout).toContain("availability");
      expect(table.stdout).toContain("reason");
      expect(table.stdout).toContain("sources");
      // 无配置的 exact ref：runtime 明确不可用，但不能推断为 Provider 拒绝
      expect(table.stdout).toContain("ghost-provider/policy-only-model");
      expect(table.stdout).toContain("unavailable");
      expect(table.stdout).not.toContain("provider-rejected");
      expect(table.stdout).toContain("policy-exact");
      // 运行时新模型行：available + 可补全
      expect(table.stdout).toContain("nvidia/vendor/runtime-extra");
      // 密钥纪律：不出现 SecretRef 的 env id
      expect(table.stdout).not.toContain("NVIDIA_API_KEY");
      expect(table.stdout).not.toContain("sk-");

      // --json 与 Core ModelInventory 形状一致（同字段名/值）
      const jsonResult = await runCli(["models", "inventory", "--json"], env);
      expect(jsonResult.code).toBe(0);
      const inventory = JSON.parse(jsonResult.stdout) as {
        models: Array<Record<string, unknown>>;
        summary: Record<string, number>;
      };
      const ghost = inventory.models.find((m) => m.ref === "ghost-provider/policy-only-model");
      expect(ghost).toMatchObject({
        ref: "ghost-provider/policy-only-model",
        providerId: "ghost-provider",
        catalogSources: ["openclaw-runtime"],
        referenceSources: ["policy-exact"],
        policyAllowed: true,
        selectionSource: "policy-exact",
        availability: "unavailable",
        availabilityReasons: [],
        pluginIds: []
      });
      expect(inventory.summary.unavailableCount).toBeGreaterThanOrEqual(1);
      // JSON 无密钥
      expect(jsonResult.stdout).not.toContain("NVIDIA_API_KEY");
      expect(jsonResult.stdout).not.toContain("sk-");
    });

    test("models unavailable 只列 unavailable/unknown，unknown 明确标注且无「建议删除」", async () => {
      const { dir, configPath } = writePolicyFixture();
      // 混合态 fixture：status+list 成功（ghost available=false → unavailable），list-all 缺失
      // （探测不完整）→ 不在 list 里的 config 模型（nvidia）为 unknown
      const commands = completeRuntimeCommands();
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, {
          status: commands.status,
          list: commands.list
        })
      };

      const table = await runCli(["models", "unavailable"], env);
      expect(table.code).toBe(0);
      // 目录不完整时，available=false 的 ghost 也必须保持 unknown。
      expect(table.stdout).toContain("ghost-provider/policy-only-model");
      expect(table.stdout).toMatch(/ghost-provider\/policy-only-model\t[^\t]+\tunknown/);
      // unknown：探测不完整的 config 模型明确标注 unknown
      expect(table.stdout).toContain("unknown");
      expect(table.stdout).toMatch(/nvidia\/deepseek-ai\/deepseek-v4-flash\t[^\t]+\tunknown/);
      // 只列 unavailable/unknown：available 的 minimax 与 list-all-only 模型不得出现
      expect(table.stdout).not.toContain("minimax-portal/MiniMax-M3");
      expect(table.stdout).not.toContain("nvidia/vendor/runtime-extra");
      // unknown 行禁止删除建议（spec §11.2）
      expect(table.stdout).not.toContain("建议删除");

      const jsonResult = await runCli(["models", "unavailable", "--json"], env);
      expect(jsonResult.code).toBe(0);
      const rows = JSON.parse(jsonResult.stdout) as Array<{ availability: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.availability === "unavailable" || row.availability === "unknown")).toBe(true);
    });

    test("探测诊断降级输出：diagnostics 行展示且退出码 0", async () => {
      const { dir, configPath } = writePolicyFixture();
      const mockPath = join(dir, "mock-runtime-models.json");
      // 只保留 version 成功：status/list/listAll 全部「命令缺失」
      writeFileSync(mockPath, JSON.stringify({ version: { status: 0, stdout: "2026.9.3\n" } }));

      const result = await runCli(["models", "inventory"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: mockPath
      });
      expect(result.code).toBe(0);
      // 部分探测失败不影响主流程，诊断展示命令名
      expect(result.stdout).toContain("openclaw models status --json");
    });
  });

  describe("model remove-policy-ref", () => {
    test("非 TTY 无 --yes fail closed；带 --yes 删除 exact ref 且保留 metadata；--remove-metadata 连带清理", async () => {
      const { dir, configPath } = writePolicyFixture();

      const blocked = await runCli(["model", "remove-policy-ref", "ghost-provider/policy-only-model"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, completeRuntimeCommands())
      });
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain("--yes");
      // fail closed：配置不变
      const before = JSON.parse(readFileSync(configPath, "utf8"));
      expect(before.agents.defaults.modelPolicy.allow).toContain("ghost-provider/policy-only-model");

      const kept = await runCli(["model", "remove-policy-ref", "ghost-provider/policy-only-model", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, completeRuntimeCommands())
      });
      expect(kept.code).toBe(0);
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(after.agents.defaults.modelPolicy.allow).not.toContain("ghost-provider/policy-only-model");
      expect(after.agents.defaults.modelPolicy.allow).toContain("nvidia/*");

      // --remove-metadata：再次构造 fixture 验证 legacy metadata 同步删除
      // （无 runtime mock：remove-policy-ref 的失败路径不需要运行时证据，少一次探测等待）
      const again = writePolicyFixture();
      const config = structuredClone(sample) as OpenClawConfig;
      config.agents!.defaults!.models!["ghost-provider/policy-only-model"] = { alias: "ghost" };
      config.agents!.defaults!.modelPolicy = { allow: ["ghost-provider/policy-only-model", "other/model"] };
      writeFileSync(again.configPath, `${JSON.stringify(config, null, 2)}\n`);
      const removed = await runCli([
        "model", "remove-policy-ref", "ghost-provider/policy-only-model", "--yes", "--remove-metadata"
      ], {
        OPENCLAW_CONFIG_PATH: again.configPath,
        HOME: again.dir
      });
      expect(removed.code).toBe(0);
      const finalConfig = JSON.parse(readFileSync(again.configPath, "utf8"));
      expect(finalConfig.agents.defaults.modelPolicy.allow).toEqual(["other/model"]);
      expect(finalConfig.agents.defaults.models["ghost-provider/policy-only-model"]).toBeUndefined();
    });

    test("primary / fallback 引用与 wildcard 输入 fail closed，配置不变", async () => {
      const { dir, configPath } = writePolicyFixture();
      const config = structuredClone(sample) as OpenClawConfig;
      config.agents!.defaults!.modelPolicy = { allow: ["minimax-portal/MiniMax-M3", "other/model"] };
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const before = readFileSync(configPath, "utf8");

      // primary 引用：fail closed
      const primary = await runCli(["model", "remove-policy-ref", "minimax-portal/MiniMax-M3", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      });
      expect(primary.code).not.toBe(0);
      expect(primary.stderr).toContain("primary");
      expect(readFileSync(configPath, "utf8")).toBe(before);

      // fallback 引用：fail closed
      const fallbackConfig = structuredClone(sample) as OpenClawConfig;
      fallbackConfig.agents!.defaults!.model = {
        primary: "other/model",
        fallbacks: ["minimax-portal/MiniMax-M3"]
      };
      fallbackConfig.agents!.defaults!.modelPolicy = { allow: ["minimax-portal/MiniMax-M3", "other/model"] };
      writeFileSync(configPath, `${JSON.stringify(fallbackConfig, null, 2)}\n`);
      const fallbackBefore = readFileSync(configPath, "utf8");
      const fallback = await runCli(["model", "remove-policy-ref", "minimax-portal/MiniMax-M3", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      });
      expect(fallback.code).not.toBe(0);
      expect(fallback.stderr).toContain("fallback");
      expect(readFileSync(configPath, "utf8")).toBe(fallbackBefore);

      // wildcard 输入：拒绝（wildcard 本期只读）
      const wildcard = await runCli(["model", "remove-policy-ref", "nvidia/*", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      });
      expect(wildcard.code).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(fallbackBefore);

      // 最后一条 exact 删除会变 [] unrestricted：fail closed
      const lastConfig = structuredClone(sample) as OpenClawConfig;
      lastConfig.agents!.defaults!.modelPolicy = { allow: ["other/model"] };
      writeFileSync(configPath, `${JSON.stringify(lastConfig, null, 2)}\n`);
      const lastBefore = readFileSync(configPath, "utf8");
      const last = await runCli(["model", "remove-policy-ref", "other/model", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      });
      expect(last.code).not.toBe(0);
      expect(last.stderr).toMatch(/unrestricted/);
      expect(readFileSync(configPath, "utf8")).toBe(lastBefore);

      // policy 中不存在的 ref：非零退出
      const unknown = await runCli(["model", "remove-policy-ref", "ghost/nothing", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      });
      expect(unknown.code).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(lastBefore);
    });
  });

  describe("model reconcile", () => {
    test("runtime available 且 Provider 存在：预览 + --yes 写入；--json 不含密钥", async () => {
      const { dir, configPath } = writePolicyFixture();
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, completeRuntimeCommands())
      };

      // 非 TTY 无 --yes：仅预览，不写盘
      const preview = await runCli(["model", "reconcile", "nvidia/vendor/runtime-extra"], env);
      expect(preview.code).toBe(0);
      expect(preview.stdout).toContain("nvidia/vendor/runtime-extra");
      expect(preview.stdout).toContain("materialize");
      const before = readFileSync(configPath, "utf8");
      expect(readFileSync(configPath, "utf8")).toBe(before);

      const applied = await runCli(["model", "reconcile", "nvidia/vendor/runtime-extra", "--yes"], env);
      expect(applied.code).toBe(0);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      const ids = config.models.providers.nvidia.models.map((m: { id: string }) => m.id);
      expect(ids).toContain("vendor/runtime-extra");
      // 运行时事实（tags/catalogSources/availability）不写入 openclaw.json
      expect(readFileSync(configPath, "utf8")).not.toContain("catalogSources");
      // 输出无密钥
      expect(applied.stdout + applied.stderr).not.toContain("sk-");
      expect(applied.stdout + applied.stderr).not.toContain("NVIDIA_API_KEY");

      // --json 模式：输出 inventory entry / 处理结果，无密钥
      const jsonRun = await runCli(["model", "reconcile", "nvidia/z-ai/glm5.1", "--json"], env);
      expect(jsonRun.code).toBe(0);
      expect(JSON.parse(jsonRun.stdout)).toMatchObject({ ref: "nvidia/z-ai/glm5.1" });
      expect(jsonRun.stdout).not.toContain("sk-");
      expect(jsonRun.stdout).not.toContain("NVIDIA_API_KEY");
    });

    test("Provider 缺配置：打印下一步所需字段并非零退出，不自动创建", async () => {
      const { dir, configPath } = writePolicyFixture();
      const commands = completeRuntimeCommands();
      // ghost-provider 不在 models.providers：即使运行时报告 available 也只能提示补 Provider
      (commands.listAll as { models: Array<{ key: string; available: boolean; tags: string[] }> }).models.push({
        key: "ghost-provider/policy-only-model",
        available: true,
        tags: []
      });
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, commands)
      };

      const result = await runCli(["model", "reconcile", "ghost-provider/policy-only-model", "--yes"], env);
      expect(result.code).not.toBe(0);
      // 下一步所需字段：providerId + baseUrl / API / credentials 方向提示
      expect(result.stderr + result.stdout).toContain("ghost-provider");
      expect(result.stderr + result.stdout).toContain("baseUrl");
      expect(result.stderr + result.stdout).toContain("provider add-custom");
      // 不自动创建 Provider
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.models.providers["ghost-provider"]).toBeUndefined();
    });
  });

  describe("plugin enable / disable", () => {
    test("停用 xiaomi 插件：提示两个 Provider 与 speech/contract 影响；policy 原样保留；非 TTY 需 --yes", async () => {
      const { dir, configPath } = writeXiaomiConfig();
      const before = readFileSync(configPath, "utf8");
      const pluginsListJson = prepareXiaomiPluginFixture();
      const env = {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir,
        OC_SWITCH_MOCK_RUNTIME_MODELS: writeRuntimeMockFile(dir, {
          status: { allowed: ["other/primary-model", "xiaomi/mi-1"] },
          list: { models: [{ key: "other/primary-model", available: true, tags: [] }] },
          listAll: { models: [
            { key: "other/primary-model", available: true, tags: [] },
            { key: "xiaomi/mi-1", available: true, tags: [] },
            { key: "xiaomi-token-plan/tp-1", available: true, tags: [] }
          ] }
        })
      };

      // 非 TTY 无 --yes：fail closed，不写盘
      const blocked = await runCli(["plugin", "disable", "xiaomi"], env, { pluginsListJson });
      expect(blocked.code).not.toBe(0);
      expect(blocked.stderr).toContain("--yes");
      expect(readFileSync(configPath, "utf8")).toBe(before);

      const disabled = await runCli(["plugin", "disable", "xiaomi", "--yes"], env, { pluginsListJson });
      expect(disabled.code).toBe(0);
      // 影响面提示：两个 Provider（一个插件组，不能拆成两个开关）
      expect(disabled.stdout).toContain("xiaomi-token-plan");
      // 非模型能力影响：speech + contracts
      expect(disabled.stdout).toContain("speech");
      // policy 原样保留（插件启停绝不联动删 policy）
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.plugins.entries.xiaomi.enabled).toBe(false);
      expect(config.agents.defaults.modelPolicy.allow).toEqual(["other/primary-model", "xiaomi/mi-1", "xiaomi-token-plan/*"]);

      // 重新启用：恢复可用性，policy 仍原样
      const enabled = await runCli(["plugin", "enable", "xiaomi", "--yes"], env, { pluginsListJson });
      expect(enabled.code).toBe(0);
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(after.plugins.entries.xiaomi.enabled).toBe(true);
      expect(after.agents.defaults.modelPolicy.allow).toEqual(["other/primary-model", "xiaomi/mi-1", "xiaomi-token-plan/*"]);
    });

    test("primary / fallback 命中插件 Provider 时阻断停用，配置不变", async () => {
      const pluginsListJson = prepareXiaomiPluginFixture();

      // primary 命中 xiaomi Provider：阻止停用
      const primaryHit = writeXiaomiConfig();
      const primaryConfig: OpenClawConfig = JSON.parse(readFileSync(primaryHit.configPath, "utf8"));
      primaryConfig.agents!.defaults!.model = "xiaomi/mi-1";
      writeFileSync(primaryHit.configPath, `${JSON.stringify(primaryConfig, null, 2)}\n`);
      const primaryBefore = readFileSync(primaryHit.configPath, "utf8");
      const primary = await runCli(["plugin", "disable", "xiaomi", "--yes"], {
        OPENCLAW_CONFIG_PATH: primaryHit.configPath,
        HOME: primaryHit.dir
      }, { pluginsListJson });
      expect(primary.code).not.toBe(0);
      expect(primary.stderr).toContain("primary");
      expect(readFileSync(primaryHit.configPath, "utf8")).toBe(primaryBefore);

      // fallback 命中 xiaomi-token-plan Provider：阻止停用
      const fallbackHit = writeXiaomiConfig();
      const fallbackConfig: OpenClawConfig = JSON.parse(readFileSync(fallbackHit.configPath, "utf8"));
      fallbackConfig.agents!.defaults!.model = { primary: "other/primary-model", fallbacks: ["xiaomi-token-plan/tp-1"] };
      writeFileSync(fallbackHit.configPath, `${JSON.stringify(fallbackConfig, null, 2)}\n`);
      const fallbackBefore = readFileSync(fallbackHit.configPath, "utf8");
      const fallback = await runCli(["plugin", "disable", "xiaomi", "--yes"], {
        OPENCLAW_CONFIG_PATH: fallbackHit.configPath,
        HOME: fallbackHit.dir
      }, { pluginsListJson });
      expect(fallback.code).not.toBe(0);
      expect(fallback.stderr).toContain("fallback");
      expect(readFileSync(fallbackHit.configPath, "utf8")).toBe(fallbackBefore);
    });

    test("未知 pluginId：清晰报错并非零退出，不写盘（Task 4 review 边界）", async () => {
      const { dir, configPath } = writeXiaomiConfig();
      const before = readFileSync(configPath, "utf8");
      const result = await runCli(["plugin", "disable", "not-installed"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      }, { pluginsListJson: prepareXiaomiPluginFixture() });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("not-installed");
      expect(readFileSync(configPath, "utf8")).toBe(before);
    });

    test("已有 entry 时只改 enabled 一个键，其他键逐字保留", async () => {
      const { dir, configPath } = writeXiaomiConfig({ withEntries: true });
      const result = await runCli(["plugin", "disable", "xiaomi", "--yes"], {
        OPENCLAW_CONFIG_PATH: configPath,
        HOME: dir
      }, { pluginsListJson: prepareXiaomiPluginFixture() });
      expect(result.code).toBe(0);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.plugins.entries.xiaomi).toEqual({
        enabled: false,
        pinned: "1.2.0",
        config: { region: "cn" }
      });
    });
  });
});
