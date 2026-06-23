import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ApiType, ProviderPreset } from "../src/types";

// 内置 preset 目录（相对 packages/core/test）
const BUILTIN_DIR = join(import.meta.dir, "../../../presets/builtin");

// 计划要求的全部内置 preset id
const EXPECTED_PRESET_IDS = [
  "elysiver",
  "cherryin",
  "juya",
  "aitoolscfd",
  "nvidia",
  "openrouter",
  "deepseek",
  "minimax-portal",
  "cerebras",
  "openai-compatible"
] as const;

const SUPPORTED_API_TYPES: ApiType[] = ["openai-completions", "anthropic-messages", "google-generative-ai"];

// apiKeyEnv 必须为全大写蛇形且以 _API_KEY 结尾
const API_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*_API_KEY$/;

// 检测 JSON 中是否含有疑似真实密钥的字符串
const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{8,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/i,
  /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

function listBuiltinPresetFiles(): string[] {
  return readdirSync(BUILTIN_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function loadPreset(filePath: string): ProviderPreset {
  return JSON.parse(readFileSync(filePath, "utf8")) as ProviderPreset;
}

/** 递归收集 JSON 中所有字符串叶子值 */
function collectStringValues(value: unknown, values: string[] = []): string[] {
  if (typeof value === "string") {
    values.push(value);
    return values;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, values);
    }
    return values;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      collectStringValues(nested, values);
    }
  }
  return values;
}

function assertNoSecrets(preset: ProviderPreset): void {
  // preset 不应包含明文 apiKey 字段
  expect(JSON.stringify(preset)).not.toContain('"apiKey"');

  const strings = collectStringValues(preset);
  for (const text of strings) {
    for (const pattern of SECRET_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  }
}

describe("builtin presets", () => {
  test("catalog contains all required preset files", () => {
    const files = listBuiltinPresetFiles();
    const ids = files.map((file) => basename(file, ".json"));
    expect(ids.sort()).toEqual([...EXPECTED_PRESET_IDS].sort());
  });

  for (const expectedId of EXPECTED_PRESET_IDS) {
    test(`${expectedId}.json validates preset contract`, () => {
      const filePath = join(BUILTIN_DIR, `${expectedId}.json`);
      const preset = loadPreset(filePath);

      // id 与文件名一致
      expect(preset.id).toBe(expectedId);
      expect(preset.name).toBeTruthy();

      // provider.api 为支持的 ApiType
      expect(SUPPORTED_API_TYPES).toContain(preset.provider.api);

      // apiKeyEnv 命名规范
      expect(preset.provider.apiKeyEnv).toMatch(API_KEY_ENV_PATTERN);

      // baseUrl 必须存在
      expect(preset.provider.baseUrl).toMatch(/^https?:\/\//);

      // 每个模型必须有 id
      expect(preset.models.length).toBeGreaterThan(0);
      for (const model of preset.models) {
        expect(model.id).toBeTruthy();
      }

      // 不得包含疑似密钥
      assertNoSecrets(preset);
    });
  }
});
