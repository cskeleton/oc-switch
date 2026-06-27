import { describe, expect, test } from "bun:test";
import { formatEnvWriteSuccess } from "./env-feedback";

describe("formatEnvWriteSuccess", () => {
  test("includes masked value only when server verification succeeded", () => {
    expect(formatEnvWriteSuccess({
      label: "Provider elysiver 的 API Key",
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "ELYSIVER_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    })).toBe("Provider elysiver 的 API Key 已写入托管块：ELYSIVER_API_KEY = sk-abc********123456");
  });

  test("does not claim verification when server did not verify the value", () => {
    expect(formatEnvWriteSuccess({
      label: "ELYSIVER_API_KEY",
      envWrite: {
        verified: false,
        entries: [
          {
            envVar: "ELYSIVER_API_KEY",
            verified: false,
            managed: true,
            reason: "value-mismatch"
          }
        ]
      }
    })).toBe("ELYSIVER_API_KEY 保存请求已返回，但写后校验失败；请不要认为新值已生效。");
  });

  test("uses a non-secret success message for short values", () => {
    expect(formatEnvWriteSuccess({
      label: "TEST_KEY",
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "TEST_KEY",
            verified: true,
            managed: true
          }
        ]
      }
    })).toBe("TEST_KEY 已写入托管块。");
  });
});
