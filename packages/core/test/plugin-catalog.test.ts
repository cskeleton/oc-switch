import { describe, expect, test } from "bun:test";
import { discoverPluginCatalog, filterPluginProvidersConflictWithConfig } from "../src/plugin-catalog";
import type { PluginCatalogDependencies, PluginCatalogRunResult } from "../src/plugin-catalog";
import type { OpenClawConfig } from "../src/types";

const pluginsListJson = JSON.stringify({
  plugins: [
    {
      id: "opencode",
      rootDir: "/plugins/opencode",
      origin: "npm-global",
      enabled: true,
      status: "loaded",
      providerIds: ["opencode"]
    },
    {
      id: "opencode-go",
      rootDir: "/plugins/opencode-go",
      origin: "bundled",
      enabled: false,
      status: "disabled",
      providerIds: ["opencode-go"]
    },
    // 无 provider 的插件必须被忽略（不读 manifest、不产生 diagnostic）
    { id: "some-hook", rootDir: "/plugins/some-hook", origin: "bundled", enabled: true, providerIds: [] }
  ]
});

const opencodeManifest = JSON.stringify({
  modelCatalog: {
    providers: {
      opencode: {
        baseUrl: "https://opencode.ai/zen/v1",
        api: "openai-completions",
        models: [
          { id: "big-pickle", name: "Big Pickle", contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text"] },
          { id: "hy3" },
          // 缺 id 的条目跳过，不影响其余解析
          { name: "no id" }
        ]
      }
    }
  },
  setup: {
    providers: [{ id: "opencode", envVars: ["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY", "OPENCODE_API_KEY"] }]
  }
});

const opencodeGoManifest = JSON.stringify({
  modelCatalog: {
    providers: {
      "opencode-go": {
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
        models: [{ id: "kimi-k3" }]
      }
    }
  }
});

function deps(
  overrides: {
    run?: (command: string, args: string[]) => PluginCatalogRunResult;
    files?: Record<string, string>;
  } = {}
): PluginCatalogDependencies {
  const files = overrides.files ?? {
    "/plugins/opencode/openclaw.plugin.json": opencodeManifest,
    "/plugins/opencode-go/openclaw.plugin.json": opencodeGoManifest
  };
  return {
    runCommand: overrides.run ?? (() => ({ status: 0, stdout: pluginsListJson, timedOut: false })),
    readTextFile: (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    }
  };
}

describe("discoverPluginCatalog", () => {
  test("解析插件 manifest 的 provider 目录与 auth 环境变量", () => {
    const result = discoverPluginCatalog(deps());
    expect(result.diagnostics).toEqual([]);
    expect(result.providers.map((provider) => provider.providerId)).toEqual(["opencode", "opencode-go"]);

    const [opencode, opencodeGo] = result.providers;
    expect(opencode).toMatchObject({
      pluginId: "opencode",
      providerId: "opencode",
      origin: "npm-global",
      enabled: true,
      baseUrl: "https://opencode.ai/zen/v1",
      api: "openai-completions"
    });
    // 缺 id 的模型条目被丢弃；envVars 去重且保序
    expect(opencode!.models.map((model) => model.id)).toEqual(["big-pickle", "hy3"]);
    expect(opencode!.models[0]).toEqual({
      id: "big-pickle",
      name: "Big Pickle",
      contextWindow: 200_000,
      maxTokens: 8192,
      reasoning: true,
      input: ["text"]
    });
    expect(opencode!.apiKeyEnvVars).toEqual(["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]);


    // plugins.entries 停用的插件仍列出，但 enabled=false
    expect(opencodeGo).toMatchObject({ providerId: "opencode-go", origin: "bundled", enabled: false });
    expect(opencodeGo!.apiKeyEnvVars).toEqual([]);
  });

  test("CLI 超时降级为空目录 + diagnostic，不抛错", () => {
    const result = discoverPluginCatalog(deps({
      run: () => ({ status: null, stdout: "", timedOut: true })
    }));
    expect(result.providers).toEqual([]);
    expect(result.diagnostics).toEqual(["openclaw plugins list timed out"]);
  });

  test("CLI 缺失/非零退出降级为空目录", () => {
    const result = discoverPluginCatalog(deps({
      run: () => ({ status: 127, stdout: "", timedOut: false })
    }));
    expect(result.providers).toEqual([]);
    expect(result.diagnostics).toEqual(["openclaw plugins list exited with status 127"]);
  });

  test("CLI 输出非 JSON 降级为空目录", () => {
    const result = discoverPluginCatalog(deps({
      run: () => ({ status: 0, stdout: "not json", timedOut: false })
    }));
    expect(result.providers).toEqual([]);
    expect(result.diagnostics).toEqual(["openclaw plugins list returned invalid JSON"]);
  });

  test("manifest 不可读时跳过该插件并保留其余", () => {
    const result = discoverPluginCatalog(deps({
      files: { "/plugins/opencode-go/openclaw.plugin.json": opencodeGoManifest }
    }));
    expect(result.providers.map((provider) => provider.providerId)).toEqual(["opencode-go"]);
    expect(result.diagnostics).toEqual(["plugin opencode: manifest not readable; skipped"]);
  });

  test("manifest 解析失败时跳过该插件", () => {
    const result = discoverPluginCatalog(deps({
      files: {
        "/plugins/opencode/openclaw.plugin.json": "{ broken",
        "/plugins/opencode-go/openclaw.plugin.json": opencodeGoManifest
      }
    }));
    expect(result.providers.map((provider) => provider.providerId)).toEqual(["opencode-go"]);
    expect(result.diagnostics).toEqual(["plugin opencode: manifest parse failed; skipped"]);
  });

  test("manifest 缺 modelCatalog 时不产生 provider，也不报错", () => {
    const result = discoverPluginCatalog(deps({
      files: {
        "/plugins/opencode/openclaw.plugin.json": JSON.stringify({ name: "opencode" }),
        "/plugins/opencode-go/openclaw.plugin.json": opencodeGoManifest
      }
    }));
    expect(result.providers.map((provider) => provider.providerId)).toEqual(["opencode-go"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("插件条目缺 id/rootDir 时记 diagnostic 并跳过", () => {
    const result = discoverPluginCatalog(deps({
      run: () => ({
        status: 0,
        stdout: JSON.stringify({ plugins: [{ origin: "bundled", providerIds: ["ghost"] }] }),
        timedOut: false
      })
    }));
    expect(result.providers).toEqual([]);
    expect(result.diagnostics).toEqual(["plugin entry missing id/rootDir; skipped"]);
  });
});

describe("apiKeyEnvVars 排序", () => {
  test("API_KEY 变量提前，避免把 API Key 写进 OAuth token 变量", () => {
    const manifest = JSON.stringify({
      modelCatalog: { providers: { anthropic: { models: [{ id: "opus" }] } } },
      // 真实 anthropic manifest 的声明顺序：OAuth token 在前
      setup: { providers: [{ id: "anthropic", envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] }] }
    });
    const result = discoverPluginCatalog({
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          plugins: [{ id: "anthropic", rootDir: "/plugins/anthropic", origin: "bundled", enabled: true, providerIds: ["anthropic"] }]
        }),
        timedOut: false
      }),
      readTextFile: () => manifest
    });
    expect(result.providers[0]?.apiKeyEnvVars).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]);
  });

  test("没有 API_KEY 变量时保持 manifest 声明顺序", () => {
    const manifest = JSON.stringify({
      modelCatalog: { providers: { "github-copilot": { models: [{ id: "gpt" }] } } },
      setup: { providers: [{ id: "github-copilot", envVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] }] }
    });
    const result = discoverPluginCatalog({
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          plugins: [{ id: "github-copilot", rootDir: "/p", origin: "bundled", enabled: true, providerIds: ["github-copilot"] }]
        }),
        timedOut: false
      }),
      readTextFile: () => manifest
    });
    expect(result.providers[0]?.apiKeyEnvVars).toEqual(["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]);
  });
});

describe("discoverPluginCatalog.plugins descriptor", () => {
  // 真实形状 fixture：一个 xiaomi 插件贡献两个 Provider，且声明 speech 与其他契约能力
  const xiaomiPluginsListJson = JSON.stringify({
    plugins: [
      {
        id: "xiaomi",
        name: "@openclaw/xiaomi-provider",
        rootDir: "/plugins/xiaomi",
        origin: "npm-global",
        enabled: false,
        status: "disabled",
        providerIds: ["xiaomi", "xiaomi-token-plan"],
        speechProviderIds: ["xiaomi"],
        channelIds: ["telegram"],
        toolCount: 0
      }
    ]
  });
  const xiaomiManifest = JSON.stringify({
    contracts: { acp: { version: "1.0" } },
    modelCatalog: {
      providers: {
        xiaomi: { models: [{ id: "mi-m1" }, { id: "mi-m2" }] },
        "xiaomi-token-plan": { models: [{ id: "tp-1" }, { id: "tp-2" }] }
      }
    }
  });

  function xiaomiDeps(): PluginCatalogDependencies {
    return {
      runCommand: () => ({ status: 0, stdout: xiaomiPluginsListJson, timedOut: false }),
      readTextFile: (path) => {
        if (path === "/plugins/xiaomi/openclaw.plugin.json") return xiaomiManifest;
        throw new Error(`ENOENT ${path}`);
      }
    };
  }

  test("一个插件 descriptor 对应两个 Provider，不拆成两个插件", () => {
    const result = discoverPluginCatalog(xiaomiDeps());
    expect(result.providers.map((provider) => provider.providerId)).toEqual(["xiaomi", "xiaomi-token-plan"]);
    expect(result.providers.every((provider) => provider.pluginId === "xiaomi")).toBe(true);
  });

  test("descriptor 保留脱敏字段：id/name/origin/enabled/providerIds", () => {
    const result = discoverPluginCatalog(xiaomiDeps());
    expect(result.plugins).toEqual([
      {
        id: "xiaomi",
        name: "@openclaw/xiaomi-provider",
        origin: "npm-global",
        enabled: false,
        providerIds: ["xiaomi", "xiaomi-token-plan"],
        nonModelCapabilities: ["channels", "speech", "other-contracts"]
      }
    ]);
  });

  test("manifest 不可读时 descriptor 仍从 plugins list 产出（providers 跳过）", () => {
    const result = discoverPluginCatalog({
      runCommand: () => ({ status: 0, stdout: xiaomiPluginsListJson, timedOut: false }),
      readTextFile: () => {
        throw new Error("ENOENT");
      }
    });
    expect(result.providers).toEqual([]);
    expect(result.plugins.map((plugin) => plugin.id)).toEqual(["xiaomi"]);
    expect(result.diagnostics).toEqual(["plugin xiaomi: manifest not readable; skipped"]);
  });

  test("非模型插件（providerIds 为空）不出现在 descriptor 列表", () => {
    const result = discoverPluginCatalog({
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          plugins: [
            { id: "some-hook", rootDir: "/p/hook", origin: "bundled", enabled: true, providerIds: [], toolIds: ["t1"] }
          ]
        }),
        timedOut: false
      }),
      readTextFile: () => {
        throw new Error("ENOENT");
      }
    });
    expect(result.plugins).toEqual([]);
  });

  test("未知 capability 字段（不认识的键）被忽略，不产生 other-contracts", () => {
    const result = discoverPluginCatalog({
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          plugins: [{ id: "opencode", rootDir: "/p/oc", origin: "bundled", enabled: true, providerIds: ["opencode"] }]
        }),
        timedOut: false
      }),
      readTextFile: () => JSON.stringify({ modelCatalog: { providers: { opencode: { models: [{ id: "m" }] } } } })
    });
    expect(result.plugins[0]?.nonModelCapabilities).toEqual([]);
  });
});

describe("filterPluginProvidersConflictWithConfig", () => {
  test("config 的 models.providers 优先，大小写折叠判定冲突", () => {
    const config = {
      models: { providers: { OpenCode: { api: "openai-completions", models: [{ id: "local" }] } } }
    } as unknown as OpenClawConfig;
    const { providers } = discoverPluginCatalog(deps());
    expect(filterPluginProvidersConflictWithConfig(config, providers).map((p) => p.providerId))
      .toEqual(["opencode-go"]);
  });

  test("无冲突时全部保留", () => {
    const { providers } = discoverPluginCatalog(deps());
    expect(filterPluginProvidersConflictWithConfig({} as OpenClawConfig, providers)).toHaveLength(2);
  });
});
