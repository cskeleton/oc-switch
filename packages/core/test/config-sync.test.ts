import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySyncPayload,
  buildSyncCheckReport,
  buildSyncPayload,
  classifySyncProviderRefs,
  collectSyncRefs,
  projectSyncTarget,
  type SyncPayload
} from "../src/config-sync";
import type { ConfigStatusReport } from "../src/config-status";
import type { PluginProvider } from "../src/plugin-catalog";
import type { RuntimeDiscoveryResult } from "../src/runtime-discovery-types";
import { writeOpenClawTransaction } from "../src/transaction-writer";
import type { OpenClawConfig } from "../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyDiscovery(): RuntimeDiscoveryResult {
  return { status: "gateway-not-detected", instances: [], candidateGroups: [], diagnostics: [] };
}

function emptyConfigStatus(): ConfigStatusReport {
  return {
    version: 1,
    health: { caseDuplicateGroups: [], summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 } },
    disabledProviders: [],
    orphanEnvKeys: [],
    envWarnings: [],
    modelPolicy: {
      mode: "legacy",
      policyEntryCount: 0,
      effectiveCatalogCount: 0,
      unknownProviderRefs: [],
      policyOnlyExactRefs: [],
      knownProviderUnknownModelRefs: []
    },
    issues: [],
    summary: {
      issueCount: 0,
      blockingIssueCount: 0,
      warningIssueCount: 0,
      duplicateGroupCount: 0,
      disabledProviderCount: 0,
      orphanEnvKeyCount: 0
    }
  };
}

function makePlugin(partial: Partial<PluginProvider> & Pick<PluginProvider, "pluginId" | "providerId" | "enabled">): PluginProvider {
  return { origin: "bundled", models: [], apiKeyEnvVars: [], ...partial };
}

describe("buildSyncPayload", () => {
  test("提取四个子树，缺失与空数组可区分", () => {
    const config: OpenClawConfig = {
      models: { providers: { acme: { baseUrl: "https://acme.example/v1" } } },
      agents: { defaults: { model: "acme/m1", models: { "acme/m1": {} } } }
    };
    const payload = buildSyncPayload(config);
    expect(payload.providers.present).toBe(true);
    expect(payload.defaultsModels.present).toBe(true);
    // 源端没有 modelPolicy.allow 键 → present=false（legacy），绝不能变成 []
    expect(payload.modelPolicyAllow.present).toBe(false);
    expect(payload.primaryModel).toEqual({ present: true, value: "acme/m1" });

    const withEmptyAllow: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: [] } } }
    };
    const emptyPayload = buildSyncPayload(withEmptyAllow);
    expect(emptyPayload.modelPolicyAllow).toEqual({ present: true, value: [] });
    expect(emptyPayload.providers.present).toBe(false);
    expect(emptyPayload.primaryModel.present).toBe(false);
  });

  test("payload 是深拷贝，修改 payload 不影响源 config", () => {
    const config: OpenClawConfig = {
      models: { providers: { acme: { baseUrl: "https://acme.example/v1" } } },
      agents: { defaults: { model: { primary: "acme/m1", fallbacks: ["acme/m2"] } } }
    };
    const payload = buildSyncPayload(config);
    payload.providers.value!.acme!.baseUrl = "https://mutated.example";
    (payload.primaryModel.value as { fallbacks: string[] }).fallbacks.push("acme/m3");
    expect(config.models?.providers?.acme?.baseUrl).toBe("https://acme.example/v1");
    expect((config.agents?.defaults?.model as { fallbacks: string[] }).fallbacks).toEqual(["acme/m2"]);
  });
});

describe("applySyncPayload", () => {
  test("整体替换四个子树，白名单外字段原样保留", () => {
    const remote: OpenClawConfig = {
      models: {
        mode: "merge",
        providers: { remoteOnly: { baseUrl: "https://remote.example/v1" } }
      },
      agents: {
        defaults: {
          model: "remoteOnly/old",
          models: { "remoteOnly/old": { alias: "old" } },
          modelPolicy: { allow: ["remoteOnly/*"], other: "keep" }
        },
        entries: { someAgent: { modelPolicy: { allow: ["x/y"] } } }
      },
      channels: { preserve: true }
    };
    const payload = buildSyncPayload({
      models: { providers: { acme: { baseUrl: "https://acme.example/v1" } } },
      agents: { defaults: { model: "acme/m1", models: { "acme/m1": {} }, modelPolicy: { allow: [] } } }
    });

    const result = applySyncPayload(remote, payload);

    // 对端私有 provider 被覆盖消失，源端 provider 写入
    expect(result.models?.providers).toEqual({ acme: { baseUrl: "https://acme.example/v1" } });
    expect(result.models?.mode).toBe("merge");
    expect(result.agents?.defaults?.models).toEqual({ "acme/m1": {} });
    // 显式 [] 覆盖为非空 allow：unrestricted 语义保留
    expect(result.agents?.defaults?.modelPolicy).toEqual({ allow: [], other: "keep" });
    expect(result.agents?.defaults?.model).toBe("acme/m1");
    // 白名单外：per-agent 配置与 channels 不动
    expect(result.agents?.entries).toEqual({ someAgent: { modelPolicy: { allow: ["x/y"] } } });
    expect(result.channels).toEqual({ preserve: true });
  });

  test("源端缺失的子树在对端删除对应键，且保留兄弟键", () => {
    const remote: OpenClawConfig = {
      models: { mode: "merge", providers: { remoteOnly: {} } },
      agents: {
        defaults: {
          model: "remoteOnly/old",
          models: { "remoteOnly/old": {} },
          modelPolicy: { allow: ["remoteOnly/*"], other: "keep" }
        }
      }
    };
    const payload = buildSyncPayload({}); // 源端四个子树全部缺失

    const result = applySyncPayload(remote, payload);

    expect(result.models).toEqual({ mode: "merge" });
    expect(result.agents?.defaults?.model).toBeUndefined();
    expect(result.agents?.defaults?.models).toBeUndefined();
    expect(result.agents?.defaults?.modelPolicy).toEqual({ other: "keep" });
  });

  test("主模型字符串形态整体替换对象形态（对端 fallbacks 不残留）", () => {
    const remote: OpenClawConfig = {
      agents: { defaults: { model: { primary: "a/1", fallbacks: ["b/2"], extra: 1 } } }
    };
    const payload = buildSyncPayload({ agents: { defaults: { model: "acme/m1" } } });
    const result = applySyncPayload(remote, payload);
    expect(result.agents?.defaults?.model).toBe("acme/m1");

    const remote2: OpenClawConfig = { agents: { defaults: { model: "acme/m1" } } };
    const payload2 = buildSyncPayload({
      agents: { defaults: { model: { primary: "a/1", fallbacks: ["b/2"], extra: 1 } } }
    });
    const result2 = applySyncPayload(remote2, payload2);
    expect(result2.agents?.defaults?.model).toEqual({ primary: "a/1", fallbacks: ["b/2"], extra: 1 });
  });

  test("插件开启仅 false→true、仅列出项，绝不创建条目或反向关闭", () => {
    const remote: OpenClawConfig = {
      plugins: {
        entries: {
          "plugin-a": { enabled: false, other: "keep" },
          "plugin-b": { enabled: true },
          "plugin-c": { enabled: false }
        }
      }
    } as OpenClawConfig;
    const payload = buildSyncPayload({});
    const result = applySyncPayload(remote, payload, { enablePluginIds: ["plugin-a", "plugin-b", "plugin-missing"] });

    const entries = (result.plugins as { entries: Record<string, Record<string, unknown>> }).entries;
    expect(entries["plugin-a"]).toEqual({ enabled: true, other: "keep" });
    expect(entries["plugin-b"]).toEqual({ enabled: true });
    // 未列出的 plugin-c 保持 false；不存在的插件不创建条目
    expect(entries["plugin-c"]).toEqual({ enabled: false });
    expect(entries["plugin-missing"]).toBeUndefined();
  });

  test("对端无 plugins.entries 时不创建任何结构", () => {
    const remote: OpenClawConfig = {};
    const result = applySyncPayload(remote, buildSyncPayload({}), { enablePluginIds: ["plugin-a"] });
    expect(result.plugins).toBeUndefined();
  });

  test("present=true 但缺 value 的畸形 payload fail closed", () => {
    const remote: OpenClawConfig = { models: { providers: { keep: {} } } };
    const malformed = {
      providers: { present: true },
      defaultsModels: { present: false },
      modelPolicyAllow: { present: false },
      primaryModel: { present: false }
    } as unknown as SyncPayload;
    expect(() => applySyncPayload(remote, malformed)).toThrow("providers");
  });
});

describe("collectSyncRefs", () => {
  test("汇总 metadata/policy/主模型/fallbacks 的 provider 段，减去 payload 自带 providers（大小写折叠）", () => {
    const payload = buildSyncPayload({
      models: { providers: { acme: {}, Other: {} } },
      agents: {
        defaults: {
          model: { primary: "acme/m1", fallbacks: ["plugin-p/m2", "bad-ref", 42] },
          models: { "other/m3": {}, "plugin-p/m4": {} },
          modelPolicy: { allow: ["acme/*", "plugin-q/ns/*", 7, "noslash"] }
        }
      }
    });
    // acme/other（含 Other 大小写折叠）由 payload 提供；bad-ref、noslash、非字符串忽略
    expect(collectSyncRefs(payload)).toEqual(["plugin-p", "plugin-q"]);
  });

  test("子树缺失时不产生引用", () => {
    expect(collectSyncRefs(buildSyncPayload({}))).toEqual([]);
  });
});

describe("classifySyncProviderRefs", () => {
  test("config 优先于插件；插件区分 enabled/disabled；未知为 not-installed", () => {
    const config: OpenClawConfig = { models: { providers: { acme: {} } } };
    const plugins = [
      makePlugin({ pluginId: "p1", providerId: "plug-on", enabled: true }),
      makePlugin({ pluginId: "p2", providerId: "plug-off", enabled: false }),
      // 与 config provider 同名（大小写折叠）→ config 优先，插件被遮蔽
      makePlugin({ pluginId: "p3", providerId: "ACME", enabled: true })
    ];
    expect(classifySyncProviderRefs(config, ["acme", "plug-on", "plug-off", "ghost"], plugins)).toEqual([
      { providerId: "acme", status: "config" },
      { providerId: "plug-on", status: "plugin-enabled", pluginId: "p1" },
      { providerId: "plug-off", status: "plugin-disabled", pluginId: "p2" },
      { providerId: "ghost", status: "not-installed" }
    ]);
  });
});

describe("buildSyncCheckReport", () => {
  test("缺失 env 只报名称；插件与 config provider 的变量都覆盖；报告不含密钥值", () => {
    const remote: OpenClawConfig = {
      models: { providers: { legacy: { apiKey: { source: "env", provider: "default", id: "LEGACY_KEY" } } } }
    };
    const payload = buildSyncPayload({
      models: {
        providers: {
          acme: { apiKey: { source: "env", provider: "default", id: "ACME_API_KEY" } },
          settled: { apiKey: { source: "env", provider: "default", id: "SETTLED_KEY" } }
        }
      },
      agents: { defaults: { models: { "plug/m1": {} } } }
    });
    const plugins = [makePlugin({ pluginId: "p1", providerId: "plug", enabled: false, apiKeyEnvVars: ["PLUG_API_KEY"] })];
    // 对端 .env：SETTLED_KEY 存在（含值，值绝不出现在报告里）
    const envContent = "# oc-switch:start\nSETTLED_KEY=sk-super-secret-value\n# oc-switch:end\n";
    const status = emptyConfigStatus();
    status.summary.issueCount = 2;
    status.summary.blockingIssueCount = 1;
    status.modelPolicy.unknownProviderRefs = ["plug/m1"];

    const report = buildSyncCheckReport({
      config: remote,
      payload,
      envContent,
      pluginProviders: plugins,
      pluginDiagnostics: ["diag"],
      configStatus: status
    });

    // legacy provider 被覆盖消失，其 env 引用不再校验；plug 走插件；SETTLED_KEY 已存在
    expect(report.missingEnvVars).toEqual(["ACME_API_KEY", "PLUG_API_KEY"]);
    expect(report.refs).toEqual([{ providerId: "plug", status: "plugin-disabled", pluginId: "p1" }]);
    expect(report.configStatus).toEqual({
      issueCount: 2,
      blockingIssueCount: 1,
      warningIssueCount: 0,
      unknownProviderRefs: ["plug/m1"]
    });
    expect(report.pluginDiagnostics).toEqual(["diag"]);
    expect(JSON.stringify(report)).not.toContain("sk-super-secret-value");
  });

  test("无 payload 时校验对端现状", () => {
    const remote: OpenClawConfig = {
      agents: { defaults: { models: { "plug/m1": {} } } }
    };
    const plugins = [makePlugin({ pluginId: "p1", providerId: "plug", enabled: true, apiKeyEnvVars: ["PLUG_API_KEY"] })];
    const report = buildSyncCheckReport({
      config: remote,
      envContent: "PLUG_API_KEY=present\n",
      pluginProviders: plugins,
      configStatus: emptyConfigStatus()
    });
    expect(report.refs).toEqual([{ providerId: "plug", status: "plugin-enabled", pluginId: "p1" }]);
    expect(report.missingEnvVars).toEqual([]);
  });
});

describe("projectSyncTarget", () => {
  test("无 payload 返回深拷贝；有 payload 返回应用后的投影且不改原 config", () => {
    const remote: OpenClawConfig = { models: { providers: { a: {} } } };
    const clone = projectSyncTarget(remote);
    clone.models!.providers!.b = {};
    expect(remote.models?.providers?.b).toBeUndefined();

    const payload = buildSyncPayload({ models: { providers: { c: {} } } });
    const projected = projectSyncTarget(remote, payload);
    expect(Object.keys(projected.models?.providers ?? {})).toEqual(["c"]);
    expect(Object.keys(remote.models?.providers ?? {})).toEqual(["a"]);
  });
});

describe("writeOpenClawTransaction 集成", () => {
  function makeRemote(config: OpenClawConfig) {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-sync-test-"));
    tempDirs.push(dir);
    const openclawPath = join(dir, "openclaw.json");
    const envPath = join(dir, ".env");
    const stateDir = join(dir, ".oc-switch");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(openclawPath, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(envPath, "KEEP=1\n");
    return { dir, openclawPath, envPath, stateDir };
  }

  test("子树覆盖 + 插件开启经 diff-guard 放行，含自动备份", async () => {
    const ws = makeRemote({
      models: { providers: { remoteOnly: { baseUrl: "https://remote.example/v1" } }, mode: "merge" },
      agents: {
        defaults: {
          model: "remoteOnly/old",
          models: { "remoteOnly/old": {} },
          modelPolicy: { allow: ["remoteOnly/*"] }
        }
      },
      plugins: { entries: { "plug-a": { enabled: false } } },
      channels: { preserve: true }
    } as OpenClawConfig);
    const payload = buildSyncPayload({
      models: { providers: { acme: { baseUrl: "https://acme.example/v1" } } },
      agents: { defaults: { model: "acme/m1", models: { "acme/m1": {}, "plug/m2": {} } } }
    });

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "sync push",
      runtimeDiscoveryProvider: () => emptyDiscovery(),
      mutate: (config) => applySyncPayload(config, payload, { enablePluginIds: ["plug-a"] })
    });

    const persisted = JSON.parse(readFileSync(ws.openclawPath, "utf8")) as OpenClawConfig;
    expect(Object.keys(persisted.models?.providers ?? {})).toEqual(["acme"]);
    expect(persisted.models?.mode).toBe("merge");
    expect(persisted.agents?.defaults?.model).toBe("acme/m1");
    // 源端无 modelPolicy.allow → 对端 allow 键被删除（回到 legacy），而不是被清空为 []
    expect(persisted.agents?.defaults?.modelPolicy).toEqual({});
    expect((persisted.plugins as { entries: Record<string, { enabled: boolean }> }).entries["plug-a"]).toEqual({ enabled: true });
    expect(persisted.channels).toEqual({ preserve: true });
    // 备份里保留覆盖前的对端配置，可回滚
    const backup = JSON.parse(readFileSync(join(result.backupDir, "openclaw.json"), "utf8")) as OpenClawConfig;
    expect(backup.models?.providers?.remoteOnly).toBeDefined();
  });

  test("unrestricted（[]）与 legacy（缺失）在写入后严格可区分", async () => {
    const ws = makeRemote({
      agents: { defaults: { modelPolicy: { allow: ["x/*"] } } }
    });
    const write = async (payload: SyncPayload) => {
      await writeOpenClawTransaction({
        openclawPath: ws.openclawPath,
        envPath: ws.envPath,
        stateDir: ws.stateDir,
        reason: "sync push",
        runtimeDiscoveryProvider: () => emptyDiscovery(),
        mutate: (config) => applySyncPayload(config, payload)
      });
      return JSON.parse(readFileSync(ws.openclawPath, "utf8")) as OpenClawConfig;
    };

    const afterUnrestricted = await write(buildSyncPayload({ agents: { defaults: { modelPolicy: { allow: [] } } } }));
    expect(afterUnrestricted.agents?.defaults?.modelPolicy).toEqual({ allow: [] });

    const afterLegacy = await write(buildSyncPayload({}));
    expect(afterLegacy.agents?.defaults?.modelPolicy).toEqual({});
  });

  test("payload 之外的写入仍被 diff-guard 阻断（白名单未被过度放宽）", async () => {
    const ws = makeRemote({ gateway: { port: 1 } } as OpenClawConfig);
    await expect(
      writeOpenClawTransaction({
        openclawPath: ws.openclawPath,
        envPath: ws.envPath,
        stateDir: ws.stateDir,
        reason: "sync push",
        runtimeDiscoveryProvider: () => emptyDiscovery(),
        mutate: (config) => {
          const next = applySyncPayload(config, buildSyncPayload({}));
          (next as Record<string, unknown>).gateway = { port: 2 };
          return next;
        }
      })
    ).rejects.toThrow("Diff guard blocked change to gateway");
  });
});
