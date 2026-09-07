import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { inspectConfigStatus } from "../src/config-status";
import { upsertDisabledProviderState } from "../src/provider-states";
import type { OcSwitchPaths } from "../src/paths";
import type { PluginProvider } from "../src/plugin-catalog";
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
  pluginProviders?: PluginProvider[];
} = {}) {
  return inspectConfigStatus({
    paths,
    envContent: overrides.envContent ?? "",
    ...(overrides.config ? { config: overrides.config } : {}),
    ...(overrides.configReadError ? { configReadError: overrides.configReadError } : {}),
    ...(overrides.pluginProviders ? { pluginProviders: overrides.pluginProviders } : {})
  });
}

function pluginProvider(overrides: Partial<PluginProvider> = {}): PluginProvider {
  return {
    pluginId: "opencode",
    providerId: "opencode",
    origin: "npm-global",
    enabled: true,
    baseUrl: "https://opencode.ai/zen/v1",
    api: "openai-completions",
    models: [{ id: "big-pickle" }, { id: "hy3" }],
    apiKeyEnvVars: ["OPENCODE_API_KEY"],
    ...overrides
  };
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
            apiKey: { source: "env", provider: "default", id: "TEST_KEY" },
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

  test("modelPolicy.allow 非空且未覆盖已启用模型时产生 model-policy-not-covered warning", () => {
    const { paths } = workspace();
    writeFileSync(paths.envPath, "TEST=1\n");
    const config: OpenClawConfig = {
      models: { providers: { cpa: { baseUrl: "https://api.test/v1", models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] } } },
      agents: {
        defaults: {
          models: { "cpa/m1": {}, "cpa/m2": {} },
          modelPolicy: { allow: ["cpa/m1"] }
        }
      }
    };
    const report = inspect(paths, { config });
    const issue = report.issues.find((i) => i.id === "health:model-policy-not-covered:modelPolicy.allow");
    expect(issue?.severity).toBe("warning");
    expect(issue?.detail).toContain("cpa/m2");
    expect(issue?.detail).not.toContain("cpa/m1,");
  });

  test("modelPolicy.allow 缺省、为空或通配已覆盖时不产生 issue", () => {
    const { paths } = workspace();
    writeFileSync(paths.envPath, "TEST=1\n");
    const base: OpenClawConfig = {
      models: { providers: { cpa: { baseUrl: "https://api.test/v1", models: [{ id: "m1", name: "M1" }] } } },
      agents: { defaults: { models: { "cpa/m1": {} } } }
    };
    const noPolicy = inspect(paths, { config: structuredClone(base) });
    expect(noPolicy.issues.some((i) => i.id.includes("model-policy"))).toBe(false);

    const emptyAllow = structuredClone(base);
    emptyAllow.agents!.defaults!.modelPolicy = { allow: [] };
    expect(inspect(paths, { config: emptyAllow }).issues.some((i) => i.id.includes("model-policy"))).toBe(false);

    const wildcard = structuredClone(base);
    wildcard.agents!.defaults!.modelPolicy = { allow: ["cpa/*"] };
    expect(inspect(paths, { config: wildcard }).issues.some((i) => i.id.includes("model-policy"))).toBe(false);
  });

  test("脱敏 claw-like policy fixture 将有效目录、policy-only stale ref 与 Provider 停用状态分开报告", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          cpa: { models: [{ id: "m1", name: "CPA 1" }, { id: "m2", name: "CPA 2" }] },
          grok2api: { models: [{ id: "grok-1", name: "Grok 1" }] },
          OpenCode: { models: [{ id: "gpt-5", name: "GPT 5" }] },
          nvidia: { models: [{ id: "nemotron", name: "Nemotron" }] },
          openrouter: { models: [{ id: "qwen", name: "Qwen" }] }
        }
      },
      agents: {
        defaults: {
          models: {
            "cpa/m1": {},
            "grok2api/grok-1": {},
            "OpenCode/gpt-5": {},
            "nvidia/nemotron": {},
            "openrouter/qwen": {},
            "cpa/legacy-only": {},
            "OpenCode/legacy-only": {},
            "legacy/only": {}
          },
          modelPolicy: {
            allow: [
              "cpa/*",
              "grok2api/*",
              "OpenCode/gpt-5",
              "nvidia/nemotron",
              "openrouter/qwen",
              "cpa/policy-only",
              "nvidia/unknown",
              "absent-provider/model",
              42
            ]
          }
        }
      }
    };
    for (const providerId of ["nvidia", "openrouter"]) {
      upsertDisabledProviderState(paths.stateDir, {
        providerId,
        openclawPath: paths.openclawPath,
        disabledAt: "2026-09-04T00:00:00.000Z",
        allowlistEntries: {}
      });
    }

    const report = inspect(paths, { config });

    expect(report.modelPolicy).toEqual({
      mode: "restricted",
      policyEntryCount: 9,
      effectiveCatalogCount: 4,
      unknownProviderRefs: ["absent-provider/model"],
      policyOnlyExactRefs: ["cpa/policy-only", "nvidia/unknown", "absent-provider/model"],
      knownProviderUnknownModelRefs: ["cpa/policy-only", "nvidia/unknown"]
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "health:model-policy-not-covered:modelPolicy.allow",
      source: "health",
      severity: "warning",
      detail: expect.stringContaining("OpenCode/legacy-only"),
      action: expect.stringContaining("metadata")
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "health:invalid-model-policy-entry:modelPolicy.allow[8]",
      source: "health",
      severity: "blocking"
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "providers:disabled:nvidia",
      source: "providers",
      severity: "info"
    }));
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "providers:disabled:openrouter",
      source: "providers",
      severity: "info"
    }));
    const issueIds = report.issues.map((issue) => issue.id);
    expect(new Set(issueIds).size).toBe(issueIds.length);
  });

  test("畸形 modelPolicy.allow 以 legacy 读取并输出不泄露值的 blocking issue", () => {
    const { paths } = workspace();
    const config = {
      models: { providers: { cpa: { models: [{ id: "m1", name: "CPA 1" }] } } },
      agents: { defaults: { models: { "cpa/m1": {} }, modelPolicy: { allow: "not-an-array" } } }
    } as unknown as OpenClawConfig;

    const report = inspect(paths, { config });

    expect(report.modelPolicy).toMatchObject({
      mode: "legacy",
      policyEntryCount: 0,
      effectiveCatalogCount: 1,
      unknownProviderRefs: [],
      policyOnlyExactRefs: [],
      knownProviderUnknownModelRefs: []
    });
    expect(report.issues).toContainEqual(expect.objectContaining({
      id: "health:invalid-model-policy-allow:modelPolicy.allow",
      source: "health",
      severity: "blocking",
      detail: expect.stringContaining("不是数组")
    }));
  });
});

describe("OpenClaw compatibility issues", () => {
  test("reports legacy Provider env refs as opt-in SecretRef migrations", () => {
    const { paths } = workspace();
    const config: OpenClawConfig = {
      models: {
        providers: {
          nvidia: {
            apiKey: "${NVIDIA_API_KEY}",
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
      id: "health:secret-ref-migration:nvidia",
      severity: "warning",
      source: "health",
      title: expect.stringContaining("SecretRef")
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
    expect(report.issues.some((issue) => issue.id === "health:secret-ref-migration:vaultBacked")).toBe(false);
    expect(report.summary.blockingIssueCount).toBe(0);
  });
});

describe("inspectConfigStatus 插件 provider", () => {
  /** 只含插件 ref 的 restricted policy，用于隔离验证插件相关判定 */
  function pluginPolicyConfig(allow: unknown[]): OpenClawConfig {
    return {
      models: { providers: {} },
      agents: { defaults: { modelPolicy: { allow } } }
    } as unknown as OpenClawConfig;
  }

  test("插件 provider 的 exact ref 不再误报为 unknownProviderRefs", () => {
    const { paths } = workspace();
    const config = pluginPolicyConfig(["opencode/big-pickle"]);
    expect(inspect(paths, { config }).modelPolicy.unknownProviderRefs).toEqual(["opencode/big-pickle"]);
    expect(
      inspect(paths, { config, pluginProviders: [pluginProvider()] }).modelPolicy.unknownProviderRefs
    ).toEqual([]);
  });

  test("providerId 大小写不一致时同样折叠判定", () => {
    const { paths } = workspace();
    const report = inspect(paths, {
      config: pluginPolicyConfig(["OpenCode/big-pickle"]),
      pluginProviders: [pluginProvider()]
    });
    expect(report.modelPolicy.unknownProviderRefs).toEqual([]);
    expect(report.modelPolicy.knownProviderUnknownModelRefs).toEqual([]);
  });

  test("插件 provider 存在但模型不在 manifest 目录中，计入 knownProviderUnknownModelRefs", () => {
    const { paths } = workspace();
    const report = inspect(paths, {
      config: pluginPolicyConfig(["opencode/ghost-model"]),
      pluginProviders: [pluginProvider()]
    });
    expect(report.modelPolicy.unknownProviderRefs).toEqual([]);
    expect(report.modelPolicy.knownProviderUnknownModelRefs).toEqual(["opencode/ghost-model"]);
  });

  test("effectiveCatalogCount 计入启用中插件的有效模型，停用插件不计入", () => {
    const { paths } = workspace();
    const config = pluginPolicyConfig(["opencode/*"]);
    expect(inspect(paths, { config }).modelPolicy.effectiveCatalogCount).toBe(0);
    expect(
      inspect(paths, { config, pluginProviders: [pluginProvider()] }).modelPolicy.effectiveCatalogCount
    ).toBe(2);
    expect(
      inspect(paths, { config, pluginProviders: [pluginProvider({ enabled: false })] })
        .modelPolicy.effectiveCatalogCount
    ).toBe(0);
  });

  test("与 models.providers 同名的插件条目被忽略，判定仍以 config 目录为准", () => {
    const { paths } = workspace();
    const config = {
      models: { providers: { opencode: { baseUrl: "https://local/v1", models: [{ id: "local-only" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["opencode/big-pickle"] } } }
    } as unknown as OpenClawConfig;
    const report = inspect(paths, { config, pluginProviders: [pluginProvider()] });
    expect(report.modelPolicy.unknownProviderRefs).toEqual([]);
    // config 目录里没有 big-pickle ⇒ 仍属 drift，插件目录不得掩盖
    expect(report.modelPolicy.knownProviderUnknownModelRefs).toEqual(["opencode/big-pickle"]);
  });

  test("未传 pluginProviders 时行为与既有版本一致（不新增 issue 类型）", () => {
    const { paths } = workspace();
    const config = pluginPolicyConfig(["opencode/big-pickle"]);
    const withoutPlugin = inspect(paths, { config });
    const withPlugin = inspect(paths, { config, pluginProviders: [pluginProvider()] });
    expect(withPlugin.issues.map((issue) => issue.id).sort())
      .toEqual(withoutPlugin.issues.map((issue) => issue.id).sort());
  });
});
