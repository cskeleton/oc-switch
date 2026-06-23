import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
});
