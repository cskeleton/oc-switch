import { describe, expect, test } from "bun:test";
import { formatEnvWriteSuccess, formatGatewayServiceEnvLabel, GATEWAY_NEXT_STEP_HINT } from "./env-feedback";

describe("formatGatewayServiceEnvLabel", () => {
  test("uses basename of targetPath when available", () => {
    expect(formatGatewayServiceEnvLabel({
      ok: true,
      targetKind: "launchd",
      targetPath: "/Users/me/.openclaw/service-env/ai.openclaw.gateway.env",
      syncedKeys: [],
      removedKeys: [],
      warnings: []
    })).toBe("ai.openclaw.gateway.env");
  });

  test("falls back to generic label", () => {
    expect(formatGatewayServiceEnvLabel(undefined)).toBe("Gateway 服务环境文件");
  });
});

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
    })).toBe(`Provider elysiver 的 API Key 已写入托管块：ELYSIVER_API_KEY = sk-abc********123456 ${GATEWAY_NEXT_STEP_HINT}`);
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
    })).toBe(`TEST_KEY 已写入托管块。 ${GATEWAY_NEXT_STEP_HINT}`);
  });
});
