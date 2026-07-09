import { describe, expect, test } from "bun:test";
import {
  parseManagedEnvVars,
  summarizeConfigDiff,
  summarizeCredentialsDiff
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
      credentialsChanged: []
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
