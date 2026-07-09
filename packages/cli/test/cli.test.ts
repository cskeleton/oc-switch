import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../../core/test/fixtures/openclaw.sample.json";
import type { OpenClawConfig } from "@oc-switch/core";
import { MAX_PROVIDER_MODELS } from "@oc-switch/core";
import { prepareGatewayEnvTarget, expectedGatewayEnvPath } from "../../core/test/gateway-sync-fixture";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: string[], env: Record<string, string>) {
  if (env.HOME && process.platform === "darwin") {
    const baseDir = env.OPENCLAW_CONFIG_PATH
      ? join(env.OPENCLAW_CONFIG_PATH, "..")
      : env.HOME;
    prepareGatewayEnvTarget(baseDir, env.HOME);
  }
  const proc = Bun.spawn(["bun", "run", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, ...env },
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
    expect(JSON.parse(readFileSync(configPath, "utf8")).models.providers.repairme.apiKey).toBe("${REPAIRME_API_KEY}");
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

  test("edits provider base url", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["provider", "edit", "nvidia", "--base-url", "https://new-nvidia.example/v1"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia.baseUrl).toBe("https://new-nvidia.example/v1");
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
    expect(config.models.providers["custom-disabled"].apiKey).toBe("${CUSTOM_DISABLED_API_KEY}");
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
    expect(result.stderr).toMatch(/20|limit|capacity/i);
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

describe("cli start/stop", () => {
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

  test("gateway sync-env merges managed block into gateway.systemd.env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-gateway-"));
    tempDirs.push(dir);
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "# oc-switch:start\nCLI_SYNC_KEY=cli-secret\n# oc-switch:end\n");
    mkdirSync(join(dir, ".oc-switch"), { recursive: true });
    writeFileSync(join(dir, ".oc-switch", "settings.json"), JSON.stringify({ openclawPath: join(dir, "openclaw.json"), envPath }));
    writeFileSync(join(dir, "openclaw.json"), `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["gateway", "sync-env"], {
      OPENCLAW_CONFIG_PATH: join(dir, "openclaw.json"),
      HOME: dir
    });
    expect(result.code).toBe(0);
    const gatewayContent = readFileSync(expectedGatewayEnvPath(dir), "utf8");
    expect(gatewayContent).toContain("CLI_SYNC_KEY");
    expect(gatewayContent).toContain("cli-secret");
  });
});
