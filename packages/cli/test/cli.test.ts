import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../../core/test/fixtures/openclaw.sample.json";

async function runCli(args: string[], env: Record<string, string>) {
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

  test("prints providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nvidia");
    expect(result.stdout).toContain("minimax-portal");
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
    expect(config.models.providers["custom-disabled"].authHeader).toEqual({ source: "env", id: "CUSTOM_DISABLED_API_KEY" });
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
  test("syncs openai-compatible provider with mocked fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["provider", "sync", "nvidia"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir,
      OC_SWITCH_MOCK_SYNC: "remote-model-a,remote-model-b"
    });

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("sk-");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((m: { id: string }) => m.id)).toContain("remote-model-a");
    expect(config.models.providers.nvidia.models.map((m: { id: string }) => m.id)).toContain("remote-model-b");
    expect(config.agents.defaults.models["nvidia/remote-model-a"]).toBeUndefined();
  });

  test("reports unsupported for anthropic provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["provider", "sync", "minimax-portal"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("anthropic-messages");
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
