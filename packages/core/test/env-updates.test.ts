import { describe, expect, test } from "bun:test";
import { applyEnvUpdates, previewEnvUpdates } from "../src/env-updates";

const emptyManifest = { version: 1, providers: {} };

describe("previewEnvUpdates", () => {
  test("reports unmanaged provider key migration without values", () => {
    const preview = previewEnvUpdates({
      content: "TEST_API_KEY=old-secret\n",
      providerRefs: [{ providerId: "test", envVar: "TEST_API_KEY" }],
      manifest: emptyManifest,
      updates: { TEST_API_KEY: "new-secret" }
    });

    expect(preview).toMatchObject({
      affectedKeys: ["TEST_API_KEY"],
      requiresConfirmation: true,
      requiresMigration: true,
      requiresComplex: false,
      backupWillIncludeSecrets: true
    });
    expect(JSON.stringify(preview)).not.toContain("old-secret");
    expect(JSON.stringify(preview)).not.toContain("new-secret");
  });
});

describe("applyEnvUpdates", () => {
  test("rejects unmanaged key without migration confirmation", () => {
    expect(() => applyEnvUpdates({
      content: "TEST_API_KEY=old-secret\n",
      providerRefs: [{ providerId: "test", envVar: "TEST_API_KEY" }],
      manifest: emptyManifest,
      updates: { TEST_API_KEY: "new-secret" }
    })).toThrow("env var migration requires confirmation");
  });

  test("migrates unmanaged key into managed block when confirmed", () => {
    const result = applyEnvUpdates({
      content: "TEST_API_KEY=old-secret\n",
      providerRefs: [{ providerId: "test", envVar: "TEST_API_KEY" }],
      manifest: emptyManifest,
      updates: { TEST_API_KEY: "new-secret" },
      options: { confirmMigration: true }
    });

    expect(result.content).not.toContain("old-secret");
    expect(result.content).toContain("# oc-switch:start");
    expect(result.content).toContain("TEST_API_KEY=new-secret");
  });

  test("requires complex confirmation for duplicate keys", () => {
    const preview = previewEnvUpdates({
      content: "TEST_API_KEY=one\nTEST_API_KEY=two\n",
      providerRefs: [{ providerId: "test", envVar: "TEST_API_KEY" }],
      manifest: emptyManifest,
      updates: { TEST_API_KEY: "new-secret" }
    });
    expect(preview).toMatchObject({
      requiresConfirmation: true,
      requiresMigration: true,
      requiresComplex: true
    });

    expect(() => applyEnvUpdates({
      content: "TEST_API_KEY=one\nTEST_API_KEY=two\n",
      providerRefs: [{ providerId: "test", envVar: "TEST_API_KEY" }],
      manifest: emptyManifest,
      updates: { TEST_API_KEY: "new-secret" },
      options: { confirmMigration: true }
    })).toThrow("complex env var requires confirmation");
  });
});
