import { describe, expect, test } from "bun:test";
import {
  parseManagedEnvVars,
  summarizeConfigDiff,
  summarizeCredentialsDiff,
  summarizeProviderFieldChanges,
  summarizeProviderStateChanges
} from "../src/diff";
import type { OpenClawConfig } from "../src/types";

describe("summarizeConfigDiff", () => {
  test("summarizes provider, allowlist, and primary changes only", () => {
    const before: OpenClawConfig = {
      models: { providers: { old: { models: [{ id: "a" }] } } },
      agents: { defaults: { model: "old/a", models: { "old/a": { alias: "a" } } } }
    };
    const after: OpenClawConfig = {
      models: { providers: { old: { models: [{ id: "a" }] }, next: { models: [{ id: "b" }] } } },
      agents: { defaults: { model: "next/b", models: { "old/a": { alias: "a" }, "next/b": { alias: "b" } } } }
    };

    expect(summarizeConfigDiff(before, after)).toEqual({
      providersAdded: ["next"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["next/b"],
      modelsDisabled: [],
      primaryChanged: { before: "old/a", after: "next/b" },
      credentialsChanged: [],
      providerStateChanges: [],
      providerFieldChanges: []
    });
  });
});

describe("parseManagedEnvVars", () => {
  test("reads only managed block keys", () => {
    const content = [
      "OUTSIDE=ignored",
      "# oc-switch:start",
      "NVIDIA_API_KEY=secret-a",
      "DEEPSEEK_API_KEY=secret-b",
      "# oc-switch:end",
      "TAIL=ignored"
    ].join("\n");
    expect([...parseManagedEnvVars(content).entries()]).toEqual([
      ["NVIDIA_API_KEY", "secret-a"],
      ["DEEPSEEK_API_KEY", "secret-b"]
    ]);
  });
});

describe("summarizeCredentialsDiff", () => {
  const config: OpenClawConfig = {
    models: {
      providers: {
        nvidia: {
          apiKey: "${NVIDIA_API_KEY}",
          models: [{ id: "m1" }]
        },
        custom: {
          apiKey: { source: "env", id: "CUSTOM_API_KEY" },
          models: [{ id: "m2" }]
        }
      }
    }
  };

  test("detects added, removed, and changed managed keys without returning values", () => {
    const before = "# oc-switch:start\nNVIDIA_API_KEY=old-secret\nOLD_KEY=gone\n# oc-switch:end\n";
    const after = "# oc-switch:start\nNVIDIA_API_KEY=new-secret\nCUSTOM_API_KEY=fresh\n# oc-switch:end\n";

    const items = summarizeCredentialsDiff(before, after, config);
    expect(items).toEqual([
      { envVar: "CUSTOM_API_KEY", change: "added", providerId: "custom" },
      { envVar: "NVIDIA_API_KEY", change: "changed", providerId: "nvidia" },
      { envVar: "OLD_KEY", change: "removed" }
    ]);
    expect(JSON.stringify(items)).not.toContain("secret");
    expect(JSON.stringify(items)).not.toContain("fresh");
  });

  test("summarizeConfigDiff includes credentials when env options provided", () => {
    const configBefore: OpenClawConfig = { models: { providers: {} } };
    const configAfter: OpenClawConfig = {
      models: { providers: { nvidia: { apiKey: "${NVIDIA_API_KEY}", models: [] } } }
    };
    const beforeEnv = "# oc-switch:start\n# oc-switch:end\n";
    const afterEnv = "# oc-switch:start\nNVIDIA_API_KEY=new-key\n# oc-switch:end\n";

    expect(summarizeConfigDiff(configBefore, configAfter, { beforeEnv, afterEnv })).toMatchObject({
      providersAdded: ["nvidia"],
      credentialsChanged: [{ envVar: "NVIDIA_API_KEY", change: "added", providerId: "nvidia" }]
    });
  });
});

describe("summarizeProviderStateChanges", () => {
  test("derives disable and enable from allowlist transitions", () => {
    const before: OpenClawConfig = {
      models: { providers: { alpha: { models: [] }, beta: { models: [] } } },
      agents: {
        defaults: {
          models: {
            "alpha/a1": {},
            "beta/b1": {}
          }
        }
      }
    };
    const after: OpenClawConfig = {
      models: { providers: { alpha: { models: [] }, beta: { models: [] } } },
      agents: {
        defaults: {
          models: {
            "beta/b1": {},
            "beta/b2": {}
          }
        }
      }
    };
    expect(summarizeProviderStateChanges(before, after)).toEqual([
      { providerId: "alpha", change: "disable" }
    ]);
  });
});

describe("summarizeProviderFieldChanges", () => {
  test("returns non-secret top-level field changes", () => {
    const before: OpenClawConfig = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://api.nvidia.com/v1",
            authHeader: false,
            apiKey: "${NVIDIA_API_KEY}",
            models: [{ id: "a" }]
          }
        }
      }
    };
    const after: OpenClawConfig = {
      models: {
        providers: {
          nvidia: {
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            authHeader: true,
            apiKey: "${NVIDIA_API_KEY}",
            models: [{ id: "a" }, { id: "b" }]
          }
        }
      }
    };

    expect(summarizeProviderFieldChanges(before, after)).toEqual([
      {
        providerId: "nvidia",
        parameterName: "authHeader",
        oldValue: "false",
        newValue: "true"
      },
      {
        providerId: "nvidia",
        parameterName: "baseUrl",
        oldValue: "https://api.nvidia.com/v1",
        newValue: "https://integrate.api.nvidia.com/v1"
      }
    ]);
  });
});

describe("summarizeConfigDiff 对象形态主模型", () => {
  const base: OpenClawConfig = {
    models: { providers: { nvidia: { models: [{ id: "a" }] } } },
    agents: { defaults: { model: "nvidia/a", models: {} } }
  };

  test("仅 fallbacks 变化不报 primaryChanged", () => {
    const before = structuredClone(base);
    const after = structuredClone(base);
    after.agents!.defaults!.model = { primary: "nvidia/a", fallbacks: ["openai/b"] };
    expect(summarizeConfigDiff(before, after).primaryChanged).toBeNull();
  });

  test("跨形态归一 ref 相同（含首尾空白）不报 primaryChanged", () => {
    const before = structuredClone(base);
    const after = structuredClone(base);
    after.agents!.defaults!.model = { primary: " nvidia/a " };
    expect(summarizeConfigDiff(before, after).primaryChanged).toBeNull();
  });

  test("ref 不同则报告且 before/after 均为归一字符串", () => {
    const before = structuredClone(base);
    const after = structuredClone(base);
    after.agents!.defaults!.model = { primary: " nvidia/other ", fallbacks: [] };
    expect(summarizeConfigDiff(before, after).primaryChanged).toEqual({
      before: "nvidia/a",
      after: "nvidia/other"
    });
  });
});
