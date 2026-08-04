import { describe, expect, test } from "bun:test";
import type { OpenClawConfig } from "../src/types";
import {
  isPrimaryModelRef,
  readFallbackModelRefs,
  readPrimaryModelRef,
  writePrimaryModelRef
} from "../src/primary-model";

/** 用 JSON 构造配置，避免畸形值与 TS 类型摩擦 */
function configWith(modelJson: string): OpenClawConfig {
  return JSON.parse(`{"agents":{"defaults":{"model":${modelJson}}}}`) as OpenClawConfig;
}

function emptyConfig(): OpenClawConfig {
  return {};
}

describe("readPrimaryModelRef", () => {
  test("字符串形态返回归一 ref", () => {
    expect(readPrimaryModelRef(configWith('"minimax-portal/MiniMax-M3"'))).toBe("minimax-portal/MiniMax-M3");
  });

  test("字符串首尾空白被 trim", () => {
    expect(readPrimaryModelRef(configWith('" openai/gpt-5.2 "'))).toBe("openai/gpt-5.2");
  });

  test("保留大小写与 model ID 内部斜杠", () => {
    expect(readPrimaryModelRef(configWith('"nvidia/deepseek-ai/deepseek-v4-flash"'))).toBe(
      "nvidia/deepseek-ai/deepseek-v4-flash"
    );
    expect(readPrimaryModelRef(configWith('"DeepSeek/deepseek-chat"'))).toBe("DeepSeek/deepseek-chat");
  });

  test("对象形态返回其 primary 字段（同样 trim）", () => {
    expect(
      readPrimaryModelRef(configWith('{"primary":" openai/gpt-5.6-luna ","fallbacks":["nvidia/a"]}'))
    ).toBe("openai/gpt-5.6-luna");
  });

  test("空白、无斜杠、空 provider、空 model 一律视为未设置", () => {
    expect(readPrimaryModelRef(configWith('"   "'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('"no-slash"'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('"/model-only"'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('"provider/"'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('{"primary":"  "}'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('{"primary":"provider/"}'))).toBeUndefined();
  });

  test("对象缺 primary 或 primary 非字符串时视为未设置", () => {
    expect(readPrimaryModelRef(configWith('{"fallbacks":["nvidia/a"]}'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('{"primary":42}'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith('{"primary":null}'))).toBeUndefined();
  });

  test("agents/defaults/model 缺失时视为未设置", () => {
    expect(readPrimaryModelRef(emptyConfig())).toBeUndefined();
    expect(readPrimaryModelRef({ agents: {} })).toBeUndefined();
    expect(readPrimaryModelRef({ agents: { defaults: {} } })).toBeUndefined();
  });

  test("畸形形态（数组/数字/null/布尔）视为未设置且不抛错", () => {
    expect(readPrimaryModelRef(configWith('["nvidia/a"]'))).toBeUndefined();
    expect(readPrimaryModelRef(configWith("42"))).toBeUndefined();
    expect(readPrimaryModelRef(configWith("null"))).toBeUndefined();
    expect(readPrimaryModelRef(configWith("true"))).toBeUndefined();
  });
});

describe("readFallbackModelRefs", () => {
  test("合法 string[] 逐项归一且保持顺序", () => {
    const config = configWith('{"primary":"openai/p","fallbacks":[" nvidia/a ","minimax-portal/MiniMax-M3"]}');
    expect(readFallbackModelRefs(config)).toEqual(["nvidia/a", "minimax-portal/MiniMax-M3"]);
  });

  test("非法/空白 ref 不参与保护", () => {
    const config = configWith('{"primary":"openai/p","fallbacks":["bad","  ","/x","y/","nvidia/ok",7,null]}');
    expect(readFallbackModelRefs(config)).toEqual(["nvidia/ok"]);
  });

  test("非数组 fallbacks 返回空数组", () => {
    expect(readFallbackModelRefs(configWith('{"primary":"openai/p","fallbacks":"nvidia/a"}'))).toEqual([]);
    expect(readFallbackModelRefs(configWith('{"primary":"openai/p","fallbacks":{"0":"nvidia/a"}}'))).toEqual([]);
  });

  test("字符串形态/null/数组 model 返回空数组", () => {
    expect(readFallbackModelRefs(configWith('"openai/p"'))).toEqual([]);
    expect(readFallbackModelRefs(configWith("null"))).toEqual([]);
    expect(readFallbackModelRefs(configWith('["nvidia/a"]'))).toEqual([]);
    expect(readFallbackModelRefs(emptyConfig())).toEqual([]);
  });

  test("读取不修改原始配置", () => {
    const config = configWith('{"primary":"openai/p","fallbacks":[" nvidia/a "]}');
    const snapshot = structuredClone(config);
    readFallbackModelRefs(config);
    readPrimaryModelRef(config);
    expect(config).toEqual(snapshot);
  });
});

describe("writePrimaryModelRef", () => {
  test("对象形态仅更新 primary，保留 fallbacks 与未知键", () => {
    const config = configWith('{"primary":"openai/old","fallbacks":["nvidia/a"],"customFlag":true}');
    writePrimaryModelRef(config, "minimax-portal/MiniMax-M3");
    const model = config.agents?.defaults?.model as Record<string, unknown>;
    expect(model.primary).toBe("minimax-portal/MiniMax-M3");
    expect(model.fallbacks).toEqual(["nvidia/a"]);
    expect(model.customFlag).toBe(true);
  });

  test("缺 primary 的畸形 record 显式写入后仍为 object 且其他键不丢", () => {
    const config = configWith('{"customFlag":1}');
    writePrimaryModelRef(config, "nvidia/m");
    const model = config.agents?.defaults?.model as Record<string, unknown>;
    expect(typeof model).toBe("object");
    expect(Array.isArray(model)).toBe(false);
    expect(model.primary).toBe("nvidia/m");
    expect(model.customFlag).toBe(1);
  });

  test("字符串形态写入后仍是纯字符串", () => {
    const config = configWith('"openai/old"');
    writePrimaryModelRef(config, "nvidia/m");
    expect(config.agents?.defaults?.model).toBe("nvidia/m");
  });

  test("字段缺失写入纯字符串", () => {
    const config: OpenClawConfig = { agents: { defaults: {} } };
    writePrimaryModelRef(config, "nvidia/m");
    expect(config.agents?.defaults?.model).toBe("nvidia/m");
  });

  test("array/null/数字等非 record 旧值写纯字符串", () => {
    for (const json of ['["nvidia/a"]', "null", "42"]) {
      const config = configWith(json);
      writePrimaryModelRef(config, "nvidia/m");
      expect(config.agents?.defaults?.model).toBe("nvidia/m");
    }
  });

  test("agents/defaults 缺失时可安全写入", () => {
    const config = emptyConfig();
    writePrimaryModelRef(config, "nvidia/m");
    expect(config.agents?.defaults?.model).toBe("nvidia/m");
  });
});

describe("isPrimaryModelRef", () => {
  test("两种形态按 trim 后的合法归一 ref 等价比较", () => {
    expect(isPrimaryModelRef(configWith('" openai/gpt-5.2 "'), "openai/gpt-5.2")).toBe(true);
    expect(isPrimaryModelRef(configWith('{"primary":"openai/gpt-5.2"}'), "openai/gpt-5.2")).toBe(true);
    expect(isPrimaryModelRef(configWith('"openai/gpt-5.2"'), "openai/other")).toBe(false);
  });

  test("非法/缺失 primary 永不命中", () => {
    expect(isPrimaryModelRef(configWith('{"fallbacks":["nvidia/a"]}'), "nvidia/a")).toBe(false);
    expect(isPrimaryModelRef(configWith('"bad"'), "bad")).toBe(false);
    expect(isPrimaryModelRef(emptyConfig(), "nvidia/a")).toBe(false);
  });
});
