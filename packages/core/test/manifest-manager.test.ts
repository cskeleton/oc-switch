import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markProviderEnvOrphan, readManifest, upsertProviderEnvManifest } from "../src/manifest-manager";

const tempDirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("manifest manager metadata", () => {
  test("stores provider display metadata and preserves createdAt on update", () => {
    const dir = stateDir();
    upsertProviderEnvManifest(dir, "custom", "CUSTOM_API_KEY", "2026-06-24T00:00:00.000Z", {
      displayName: "Custom Provider",
      notes: "Company account",
      websiteUrl: "https://example.com",
      isFullUrl: false
    });
    upsertProviderEnvManifest(dir, "custom", "CUSTOM_API_KEY", "2026-06-24T01:00:00.000Z", {
      displayName: "Custom Provider Updated",
      notes: "Updated account",
      websiteUrl: "https://updated.example.com",
      isFullUrl: true
    });

    const entry = readManifest(dir).providers.custom;
    expect(entry).toMatchObject({
      providerId: "custom",
      envVar: "CUSTOM_API_KEY",
      displayName: "Custom Provider Updated",
      notes: "Updated account",
      websiteUrl: "https://updated.example.com",
      isFullUrl: true,
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T01:00:00.000Z",
      orphan: false
    });
  });

  test("marking orphan keeps existing display metadata", () => {
    const dir = stateDir();
    upsertProviderEnvManifest(dir, "custom", "CUSTOM_API_KEY", "2026-06-24T00:00:00.000Z", {
      displayName: "Custom Provider",
      notes: "Company account",
      websiteUrl: "https://example.com",
      isFullUrl: false
    });

    markProviderEnvOrphan(dir, "custom", "CUSTOM_API_KEY", "2026-06-24T02:00:00.000Z");

    expect(readManifest(dir).providers.custom).toMatchObject({
      providerId: "custom",
      envVar: "CUSTOM_API_KEY",
      displayName: "Custom Provider",
      notes: "Company account",
      websiteUrl: "https://example.com",
      isFullUrl: false,
      orphan: true,
      updatedAt: "2026-06-24T02:00:00.000Z"
    });
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).not.toContain("sk-");
  });
});
