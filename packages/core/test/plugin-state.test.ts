import { describe, expect, test } from "bun:test";
import { assertAllowedSemanticChange } from "../src/diff-guard";
import {
  isPluginStateError,
  setModelPluginEnabled
} from "../src/plugin-state";
import type { ModelPluginDescriptor } from "../src/model-inventory";
import type { OpenClawConfig } from "../src/types";

/**
 * Task 4：插件级安全启停（setModelPluginEnabled）的纯函数测试。
 * 覆盖 spec §9.2 写入语义与 §9.3 停用预检；全部使用内存 fixture：
 * 不读写文件、不 shell-out、不触碰 provider-states.json / 真实 openclaw。
 */

/** xiaomi 形状 descriptor：一个插件贡献两个 Provider（spec §9.1 真实关系） */
function xiaomiPlugin(overrides: Partial<ModelPluginDescriptor> = {}): ModelPluginDescriptor {
  return {
    id: "xiaomi",
    origin: "npm-global",
    enabled: true,
    providerIds: ["xiaomi", "xiaomi-token-plan"],
    nonModelCapabilities: ["speech", "other-contracts"],
    ...overrides
  };
}

/** 基线 config：无 plugins.entries（依赖 enabledByDefault），policy exact + wildcard 覆盖两个 Provider */
function baseConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "other/primary-model",
        models: { "other/primary-model": { alias: "primary" } },
        modelPolicy: { allow: ["other/primary-model", "xiaomi/mi-1", "xiaomi-token-plan/*"] }
      }
    }
  };
}

/** entry 已存在且带其他键（pinned/config）的 config */
function entryConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        xiaomi: {
          enabled: true,
          pinned: "1.2.0",
          config: { region: "cn" }
        }
      }
    },
    agents: {
      defaults: {
        model: "other/primary-model",
        modelPolicy: { allow: ["other/primary-model", "xiaomi/mi-1", "xiaomi-token-plan/*"] }
      }
    }
  };
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

function requirePluginStateError(error: unknown) {
  if (!isPluginStateError(error)) {
    throw new Error(`expected PluginStateError, got: ${String(error)}`);
  }
  return error;
}

describe("setModelPluginEnabled：预检失败（fail closed）", () => {
  test("descriptor 没有 providerIds → 拒绝（非模型插件不在启停范围）", () => {
    const error = captureError(() =>
      setModelPluginEnabled(baseConfig(), xiaomiPlugin({ providerIds: [] }), false)
    );
    const typed = requirePluginStateError(error);
    expect(typed.code).toBe("plugin-without-model-providers");
  });

  test("primary 命中任一贡献 Provider（第二个 Provider 也算）→ 阻止停用", () => {
    const config = baseConfig();
    config.agents!.defaults!.model = "xiaomi-token-plan/tp-1";
    const error = captureError(() => setModelPluginEnabled(config, xiaomiPlugin(), false));
    const typed = requirePluginStateError(error);
    expect(typed.code).toBe("primary-model-referenced");
    // 报错必须点名实际命中的 Provider 与候选处理方向
    expect(typed.message).toContain("xiaomi-token-plan");
    expect(typed.message).toContain("primary");
  });

  test("primary 命中且贡献 Provider 为大小写变体 → 同样阻止", () => {
    const config = baseConfig();
    config.agents!.defaults!.model = "Xiaomi/mi-1";
    const error = captureError(() => setModelPluginEnabled(config, xiaomiPlugin(), false));
    expect(requirePluginStateError(error).code).toBe("primary-model-referenced");
  });

  test("合法 fallback 命中 → 阻止停用（force 不可绕过的 fail-closed 家族）", () => {
    const config = baseConfig();
    config.agents!.defaults!.model = {
      primary: "other/primary-model",
      fallbacks: ["xiaomi/mi-2"]
    };
    const error = captureError(() => setModelPluginEnabled(config, xiaomiPlugin(), false));
    const typed = requirePluginStateError(error);
    expect(typed.code).toBe("fallback-referenced");
    expect(typed.message).toContain("fallback");
  });

  test("启停一个 Provider 的主模型不可用时，启用操作（true）不受 primary/fallback 预检限制", () => {
    // 启用只会恢复可用性，不会被 primary 命中阻断（预检只针对停用）
    const config = entryConfig();
    config.agents!.defaults!.model = "xiaomi/mi-1";
    const result = setModelPluginEnabled(config, xiaomiPlugin({ enabled: true }), true);
    expect(result.config.plugins!.entries!.xiaomi!.enabled).toBe(true);
  });
});

describe("setModelPluginEnabled：policy 与影响面（warnings，默认保留）", () => {
  test("policy exact/wildcard 命中 → 只产生 warnings，allow 原样保留", () => {
    const config = baseConfig();
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes("xiaomi/mi-1"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("xiaomi-token-plan/*"))).toBe(true);
    // policy 不联动删除
    expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual([
      "other/primary-model",
      "xiaomi/mi-1",
      "xiaomi-token-plan/*"
    ]);
    // 纯函数：输入 config 不被修改
    expect(config.agents?.defaults?.modelPolicy?.allow).toEqual([
      "other/primary-model",
      "xiaomi/mi-1",
      "xiaomi-token-plan/*"
    ]);
  });

  test("一个插件两个 Provider 同时受影响：warnings 必须完整列出两个 Provider", () => {
    const config = baseConfig();
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);
    const joined = result.warnings.join("\n");
    expect(joined).toContain("xiaomi");
    expect(joined).toContain("xiaomi-token-plan");
  });

  test("legacy metadata 命中贡献 Provider → warnings 提示（不删除）", () => {
    const config = baseConfig();
    config.agents!.defaults!.models!["xiaomi/mi-1"] = { alias: "mi-one" };
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);
    expect(result.warnings.some((warning) => warning.includes("xiaomi/mi-1"))).toBe(true);
    expect(result.config.agents?.defaults?.models?.["xiaomi/mi-1"]).toBeDefined();
  });

  test("policy 不受影响时不产生 policy warning（非模型能力提示仍在）", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { model: "other/primary-model", modelPolicy: { allow: ["other/primary-model"] } } }
    };
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);
    expect(result.warnings).toEqual([
      `Plugin xiaomi also provides non-model capabilities (speech, other-contracts); disabling it affects those as well, not only model providers (xiaomi, xiaomi-token-plan).`
    ]);
  });
});

describe("setModelPluginEnabled：写入语义（只改 enabled 键）", () => {
  test("entry 缺失时 disable 创建最小 { enabled: false }", () => {
    const config = baseConfig();
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);
    expect(result.config.plugins).toEqual({ entries: { xiaomi: { enabled: false } } });
  });

  test("entry 缺失时 enable 创建最小 { enabled: true }（显式确认 enabledByDefault）", () => {
    const config = baseConfig();
    const result = setModelPluginEnabled(config, xiaomiPlugin({ enabled: false }), true);
    expect(result.config.plugins).toEqual({ entries: { xiaomi: { enabled: true } } });
  });

  test("false→true 只改 enabled，保留 pinned/config 其他键", () => {
    const config = entryConfig();
    config.plugins!.entries!.xiaomi!.enabled = false;
    const result = setModelPluginEnabled(config, xiaomiPlugin({ enabled: false }), true);
    expect(result.config.plugins!.entries!.xiaomi).toEqual({
      enabled: true,
      pinned: "1.2.0",
      config: { region: "cn" }
    });
  });

  test("true→false 只改 enabled，保留其他键", () => {
    const config = entryConfig();
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);
    expect(result.config.plugins!.entries!.xiaomi).toEqual({
      enabled: false,
      pinned: "1.2.0",
      config: { region: "cn" }
    });
    // 纯函数：输入不被修改
    expect(config.plugins!.entries!.xiaomi!.enabled).toBe(true);
  });

  test("已处于目标状态时仍是幂等安全写（值不变，结构不破坏）", () => {
    const config = entryConfig();
    const result = setModelPluginEnabled(config, xiaomiPlugin(), true);
    expect(result.config.plugins!.entries!.xiaomi).toEqual({
      enabled: true,
      pinned: "1.2.0",
      config: { region: "cn" }
    });
  });

  test("config 无 plugins 键时建立完整容器（plugins.entries）", () => {
    const result = setModelPluginEnabled({} as OpenClawConfig, xiaomiPlugin(), false);
    expect(result.config.plugins).toEqual({ entries: { xiaomi: { enabled: false } } });
    // 其他顶层字段不受影响
    expect(Object.keys(result.config)).toEqual(["plugins"]);
  });

  test("同事务不得触碰其他插件条目 / provider-states / modelPolicy 结构", () => {
    const config = entryConfig();
    (config.plugins!.entries as Record<string, unknown>)["other-plugin"] = { enabled: true };
    const result = setModelPluginEnabled(config, xiaomiPlugin(), false);
    expect((result.config.plugins!.entries as Record<string, unknown>)["other-plugin"]).toEqual({ enabled: true });
    expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual([
      "other/primary-model",
      "xiaomi/mi-1",
      "xiaomi-token-plan/*"
    ]);
  });

  test("diff guard 放行 setModelPluginEnabled 的全部转换（absence→false / false→true / true→false）", () => {
    const fromScratch = baseConfig();
    const disabled = setModelPluginEnabled(fromScratch, xiaomiPlugin(), false);
    expect(() => assertAllowedSemanticChange(fromScratch, disabled.config)).not.toThrow();

    const enabled = setModelPluginEnabled(disabled.config, xiaomiPlugin({ enabled: false }), true);
    expect(() => assertAllowedSemanticChange(disabled.config, enabled.config)).not.toThrow();

    const disabledAgain = setModelPluginEnabled(enabled.config, xiaomiPlugin({ enabled: true }), false);
    expect(() => assertAllowedSemanticChange(enabled.config, disabledAgain.config)).not.toThrow();
  });
});
