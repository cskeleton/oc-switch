import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ApiType, ProviderPreset } from "../src/types";

// 测试用 preset 样例（非仓库分发数据）
const FIXTURE_BUILTIN_DIR = join(import.meta.dir, "fixtures/presets/builtin");

const SUPPORTED_API_TYPES: ApiType[] = ["openai-completions", "anthropic-messages", "google-generative-ai"];

// apiKeyEnv 必须为全大写蛇形且以 _API_KEY 结尾
const API_KEY_ENV_PATTERN = /^[A-Z][A-Z0-9_]*_API_KEY$/;

// 检测 JSON 中是否含有疑似真实密钥的字符串
const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{8,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/i,
  /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

function listFixturePresetFiles(): string[] {
  return readdirSync(FIXTURE_BUILTIN_DIR)
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

describe("preset contract (fixtures)", () => {
  test("fixture catalog is non-empty", () => {
    expect(listFixturePresetFiles().length).toBeGreaterThan(0);
  });

  for (const file of listFixturePresetFiles()) {
    const presetId = basename(file, ".json");
    test(`${presetId}.json validates preset contract`, () => {
      const preset = loadPreset(join(FIXTURE_BUILTIN_DIR, file));

      expect(preset.id).toBe(presetId);
      expect(preset.name).toBeTruthy();
      expect(SUPPORTED_API_TYPES).toContain(preset.provider.api);
      expect(preset.provider.apiKeyEnv).toMatch(API_KEY_ENV_PATTERN);
      expect(preset.provider.baseUrl).toMatch(/^https?:\/\//);
      expect(preset.models.length).toBeGreaterThan(0);
      for (const model of preset.models) {
        expect(model.id).toBeTruthy();
      }
      assertNoSecrets(preset);
    });
  }
});
