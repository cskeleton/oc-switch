import { describe, expect, test } from "bun:test";
import { formatModelRef, parseModelRef } from "../src/model-ref";

describe("parseModelRef", () => {
  test("splits only on the first slash", () => {
    expect(parseModelRef("nvidia/deepseek-ai/deepseek-v4-flash")).toEqual({
      providerId: "nvidia",
      modelId: "deepseek-ai/deepseek-v4-flash"
    });
  });

  test("preserves provider casing", () => {
    expect(parseModelRef("DeepSeek/deepseek-chat")).toEqual({
      providerId: "DeepSeek",
      modelId: "deepseek-chat"
    });
  });

  test("rejects invalid refs", () => {
    expect(() => parseModelRef("nvidia")).toThrow("ModelRef must contain a provider and model id");
    expect(() => parseModelRef("/model")).toThrow("ModelRef must contain a provider and model id");
    expect(() => parseModelRef("provider/")).toThrow("ModelRef must contain a provider and model id");
  });
});

describe("formatModelRef", () => {
  test("joins provider and model id without normalizing", () => {
    expect(formatModelRef("OpenRouter", "openrouter/free")).toBe("OpenRouter/openrouter/free");
  });
});
