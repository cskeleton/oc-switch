import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { inspectConfigStatus } from "../src/config-status";
import { upsertDisabledProviderState } from "../src/provider-states";
import type { OcSwitchPaths } from "../src/paths";
import type { OpenClawConfig } from "../src/types";

const tempDirs: string[] = [];

function workspace(): { dir: string; paths: OcSwitchPaths } {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-config-status-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  return { dir, paths: { openclawPath, envPath, stateDir } };
}

function inspect(paths: OcSwitchPaths, overrides: {
  config?: OpenClawConfig;
  configReadError?: string;
  envContent?: string;
} = {}) {
  return inspectConfigStatus({
    paths,
    envContent: overrides.envContent ?? "",
    ...(overrides.config ? { config: overrides.config } : {}),
    ...(overrides.configReadError ? { configReadError: overrides.configReadError } : {})
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("inspectConfigStatus", () => {
  test("无问题时 issues 为空且 summary.issueCount 为 0", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          test: {
            baseUrl: "https://api.test/v1",
            apiKey: "${TEST_KEY}",
            models: [{ id: "m", name: "Model M" }]
          }
        }
      },
      agents: { defaults: { model: "test/m", models: { "test/m": {} } } }
    };
    writeFileSync(paths.envPath, "TEST_KEY=secret\n");
    const report = inspect(paths, { config, envContent: "TEST_KEY=secret\n" });
    expect(report.issues).toEqual([]);
    expect(report.summary.issueCount).toBe(0);
    expect(report.summary.blockingIssueCount).toBe(0);
    expect(report.summary.warningIssueCount).toBe(0);
  });

  test("case-duplicate 组计入 duplicateGroupCount 并产生 health:duplicate issue", () => {
    const { paths } = workspace();
    writeFileSync(paths.envPath, "DEEPSEEK_API_KEY=secret\n");
    const config: OpenClawConfig = {
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "chat" }] },
          DeepSeek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "chat" }] }
        }
      },
      agents: { defaults: { model: "deepseek/chat", models: { "deepseek/chat": {} } } }
    };
    const report = inspect(paths, { config, envContent: "DEEPSEEK_API_KEY=secret\n" });
    expect(report.summary.duplicateGroupCount).toBe(1);
    expect(report.issues.some((i) => i.id === "health:duplicate:deepseek")).toBe(true);
    expect(report.issues.find((i) => i.id === "health:duplicate:deepseek")?.severity).toBe("warning");
  });

  test("disabled provider 计入 disabledProviderCount 并产生 providers:disabled issue", () => {
    const { paths } = workspace();
    const config = JSON.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
    upsertDisabledProviderState(paths.stateDir, {
      providerId: "nvidia",
      openclawPath: paths.openclawPath,
      disabledAt: "2026-06-26T00:00:00.000Z",
      allowlistEntries: { "nvidia/foo": {} }
    });
    const report = inspect(paths, { config });
    expect(report.summary.disabledProviderCount).toBe(1);
    expect(report.disabledProviders[0]?.providerId).toBe("nvidia");
    expect(report.disabledProviders[0]?.hiddenModelCount).toBe(1);
    expect(report.issues.some((i) => i.id === "providers:disabled:nvidia")).toBe(true);
  });

  test("orphan env key 计入 orphanEnvKeyCount 并产生 env:orphan issue", () => {
    const { paths } = workspace();
    const config = JSON.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
    const manifestPath = join(paths.stateDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      providers: { old: { envVar: "OLD_KEY", orphan: true } },
      extraEnv: {}
    }));
    const report = inspect(paths, { config });
    expect(report.summary.orphanEnvKeyCount).toBe(1);
    expect(report.orphanEnvKeys).toEqual(["OLD_KEY"]);
    expect(report.issues.some((i) => i.id === "env:orphan:OLD_KEY")).toBe(true);
  });

  test("缺失 provider env key 产生 env:missing issue 且不与 orphan 重复", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          test: { baseUrl: "https://api.test/v1", apiKey: { source: "env", id: "MISSING_KEY" }, models: [{ id: "m" }] }
        }
      },
      agents: { defaults: { models: {} } }
    };
    const manifestPath = join(paths.stateDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      providers: { test: { envVar: "MISSING_KEY", orphan: true } },
      extraEnv: {}
    }));
    const report = inspect(paths, { config });
    expect(report.issues.some((i) => i.id === "env:missing:MISSING_KEY")).toBe(true);
    expect(report.issues.some((i) => i.id === "env:orphan:MISSING_KEY")).toBe(false);
  });

  test("活动 openclaw.json 缺失时仍返回 report 并产生 paths:missing:openclaw blocking issue", () => {
    const { paths } = workspace();
    rmSync(paths.openclawPath);
    const report = inspect(paths, { configReadError: "openclaw.json not found" });
    expect(report.health.caseDuplicateGroups).toEqual([]);
    expect(report.issues.some((i) => i.id === "paths:missing:openclaw" && i.severity === "blocking")).toBe(true);
  });

  test("活动 env 路径缺失时产生 paths:missing:env warning", () => {
    const { paths } = workspace();
    const config = JSON.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
    const report = inspect(paths, { config });
    expect(report.issues.some((i) => i.id === "paths:missing:env" && i.severity === "warning")).toBe(true);
  });

  test("解析失败时产生 paths:invalid:openclaw blocking issue", () => {
    const { paths } = workspace();
    writeFileSync(paths.envPath, "\n");
    const report = inspect(paths, { configReadError: "JSON5 parse error at line 1" });
    expect(report.issues.some((i) => i.id === "paths:invalid:openclaw" && i.severity === "blocking")).toBe(true);
    expect(report.health.summary.duplicateGroupCount).toBe(0);
  });

  test("issues[] 中所有 id 唯一", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "c" }] },
          DeepSeek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "c" }] }
        }
      },
      agents: { defaults: { model: "deepseek/c", models: { "deepseek/c": {} } } }
    };
    upsertDisabledProviderState(paths.stateDir, {
      providerId: "nvidia",
      openclawPath: paths.openclawPath,
      disabledAt: "2026-06-26T00:00:00.000Z",
      allowlistEntries: {}
    });
    const report = inspect(paths, { config });
    const ids = report.issues.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("env 不可读时产生 paths:unreadable:env blocking issue", () => {
    const { paths } = workspace();
    writeFileSync(paths.envPath, "TEST=1\n");
    if (process.platform !== "win32") {
      chmodSync(paths.envPath, 0o000);
      const config = JSON.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
      const report = inspect(paths, { config, envContent: "" });
      expect(report.issues.some((i) => i.id === "paths:unreadable:env")).toBe(true);
      chmodSync(paths.envPath, 0o644);
    } else {
      expect(existsSync(paths.envPath)).toBe(true);
    }
  });
});

describe("OpenClaw compatibility issues", () => {
  test("reports legacy env ref, invalid authHeader ref, and missing model names", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          nvidia: {
            apiKey: { source: "env", id: "NVIDIA_API_KEY" },
            models: [{ id: "vendor/model-a" }]
          },
          anthropicProxy: {
            authHeader: { source: "env", id: "ANTHROPIC_API_KEY" },
            models: [{ id: "claude-proxy", name: "Proxy" }]
          }
        }
      },
      agents: { defaults: { models: {} } }
    };
    const report = inspect(paths, { config });
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "health:legacy-env-ref:nvidia",
      severity: "blocking",
      source: "health",
      title: expect.stringContaining("OpenClaw 2026.6.8")
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "health:invalid-auth-header-ref:anthropicProxy",
      severity: "blocking",
      source: "health"
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: `health:missing-model-name:${encodeURIComponent("nvidia/vendor/model-a")}`,
      severity: "blocking",
      source: "health"
    }));
  });

  test("does not report canonical SecretRef objects as legacy env refs", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          vaultBacked: {
            apiKey: { source: "env", provider: "custom-env", id: "NVIDIA_API_KEY" },
            models: [{ id: "vendor/model-a", name: "Vendor Model A" }]
          }
        }
      },
      agents: { defaults: { models: {} } }
    };

    const report = inspect(paths, { config });
    expect(report.issues.some((issue) => issue.id === "health:legacy-env-ref:vaultBacked")).toBe(false);
    expect(report.summary.blockingIssueCount).toBe(0);
  });
});
