import { describe, expect, test } from "bun:test";
import { maskSecretValue, verifyEnvWrite } from "../src/env-verification";

describe("maskSecretValue", () => {
  test("shows a bounded prefix and suffix for normal API keys", () => {
    expect(maskSecretValue("sk-abcdefghijklmnopqrstuvwxyz123456")).toBe("sk-abc********123456");
  });

  test("does not expose short values", () => {
    expect(maskSecretValue("short-key")).toBeUndefined();
  });
});

describe("verifyEnvWrite", () => {
  test("verifies exact value from the oc-switch managed block", () => {
    const content = [
      "ELYSIVER_API_KEY=old-unmanaged",
      "# oc-switch:start",
      "ELYSIVER_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456",
      "# oc-switch:end",
      ""
    ].join("\n");

    expect(verifyEnvWrite(content, { ELYSIVER_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456" })).toEqual({
      verified: true,
      entries: [
        {
          envVar: "ELYSIVER_API_KEY",
          verified: true,
          managed: true,
          maskedValue: "sk-abc********123456"
        }
      ]
    });
  });

  test("does not verify unmanaged values outside the managed block", () => {
    const content = "ELYSIVER_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\n";

    expect(verifyEnvWrite(content, { ELYSIVER_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456" })).toEqual({
      verified: false,
      entries: [
        {
          envVar: "ELYSIVER_API_KEY",
          verified: false,
          managed: false,
          reason: "missing-managed-value"
        }
      ]
    });
  });

  test("does not leak the disk value when verification fails", () => {
    const content = [
      "# oc-switch:start",
      "ELYSIVER_API_KEY=Refusing to overwrite unmanaged env var ELYSIVER_API_KEY",
      "# oc-switch:end",
      ""
    ].join("\n");

    const result = verifyEnvWrite(content, { ELYSIVER_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456" });

    expect(result.verified).toBe(false);
    expect(result.entries[0]).toEqual({
      envVar: "ELYSIVER_API_KEY",
      verified: false,
      managed: true,
      reason: "value-mismatch"
    });
    expect(JSON.stringify(result)).not.toContain("Refusing to overwrite");
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });
});
