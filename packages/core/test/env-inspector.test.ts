import { describe, expect, test } from "bun:test";
import { inspectEnvFile, listProviderEnvRefs } from "../src/env-inspector";
import type { OcSwitchManifest, OpenClawConfig } from "../src";

const config: OpenClawConfig = {
  models: {
    providers: {
      nvidia: { apiKey: { source: "env", id: "NVIDIA_API_KEY" }, models: [{ id: "a" }] },
      minimax: { authHeader: { source: "env", id: "MINIMAX_API_KEY" }, models: [{ id: "b" }] }
    }
  }
};

describe("listProviderEnvRefs", () => {
  test("collects provider apiKey and authHeader env refs", () => {
    expect(listProviderEnvRefs(config)).toEqual([
      { providerId: "minimax", envVar: "MINIMAX_API_KEY" },
      { providerId: "nvidia", envVar: "NVIDIA_API_KEY" }
    ]);
  });
});

describe("inspectEnvFile", () => {
  test("returns variable metadata without values", () => {
    const manifest: OcSwitchManifest = {
      providers: {
        old: {
          providerId: "old",
          envVar: "OLD_API_KEY",
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
          orphan: true
        }
      },
      extraEnv: {
        SOME_MCP_EPID: {
          envVar: "SOME_MCP_EPID",
          note: "MCP endpoint id",
          managed: true,
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z"
        }
      }
    };
    const content = [
      "NVIDIA_API_KEY=sk-secret-nvidia",
      "export COMPLEX_TOKEN=secret",
      "DUPLICATE_KEY=first",
      "DUPLICATE_KEY=second",
      "# oc-switch:start",
      "MINIMAX_API_KEY=sk-secret-minimax",
      "SOME_MCP_EPID=epid-secret",
      "# oc-switch:end"
    ].join("\n");

    const result = inspectEnvFile({
      content,
      providerRefs: listProviderEnvRefs(config),
      manifest
    });

    expect(result.variables.find((item) => item.envVar === "NVIDIA_API_KEY")).toMatchObject({
      envVar: "NVIDIA_API_KEY",
      managed: false,
      providerRef: true,
      present: true
    });
    expect(result.variables.find((item) => item.envVar === "MINIMAX_API_KEY")).toMatchObject({
      envVar: "MINIMAX_API_KEY",
      managed: true,
      providerRef: true,
      present: true
    });
    expect(result.variables.find((item) => item.envVar === "SOME_MCP_EPID")).toMatchObject({
      extraManaged: true,
      note: "MCP endpoint id"
    });
    expect(result.variables.find((item) => item.envVar === "DUPLICATE_KEY")).toMatchObject({
      duplicate: true
    });
    expect(result.variables.find((item) => item.envVar === "COMPLEX_TOKEN")).toMatchObject({
      complex: true
    });
    expect(result.variables.find((item) => item.envVar === "OLD_API_KEY")).toMatchObject({
      orphan: true,
      present: false
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(JSON.stringify(result)).not.toContain("epid-secret");
  });

  test("marks missing provider refs", () => {
    const result = inspectEnvFile({
      content: "",
      providerRefs: listProviderEnvRefs(config),
      manifest: { providers: {}, extraEnv: {} }
    });

    expect(result.variables.filter((item) => item.missing).map((item) => item.envVar)).toEqual([
      "MINIMAX_API_KEY",
      "NVIDIA_API_KEY"
    ]);
  });
});
