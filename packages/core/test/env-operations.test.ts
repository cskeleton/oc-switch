import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { applyEnvOperation, previewEnvOperation } from "../src/env-operations";
import { readManifest, upsertExtraEnvManifest } from "../src/manifest-manager";
import type { OpenClawConfig } from "../src/types";

const tempDirs: string[] = [];

function workspace(envContent: string) {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-env-ops-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(envPath, envContent);
  return { dir, openclawPath, envPath, stateDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("previewEnvOperation", () => {
  test("previews unmanaged migration without accepting secret value", () => {
    const ws = workspace("SOME_MCP_EPID=old-secret\n");
    const preview = previewEnvOperation({
      paths: ws,
      operation: { type: "upsert", envVar: "SOME_MCP_EPID", note: "MCP endpoint id" }
    });

    expect(preview).toMatchObject({
      affectedKeys: ["SOME_MCP_EPID"],
      requiresConfirmation: true,
      backupWillIncludeSecrets: true
    });
    expect(JSON.stringify(preview)).not.toContain("old-secret");
  });
});

describe("applyEnvOperation", () => {
  test("migrates unmanaged variable to managed block only when confirmed", async () => {
    const ws = workspace("SOME_MCP_EPID=old-secret\n");

    await expect(applyEnvOperation({
      paths: ws,
      operation: { type: "upsert", envVar: "SOME_MCP_EPID", value: "new-secret", note: "MCP endpoint id" }
    })).rejects.toThrow("requires confirmation");

    const result = await applyEnvOperation({
      paths: ws,
      operation: {
        type: "upsert",
        envVar: "SOME_MCP_EPID",
        value: "new-secret",
        note: "MCP endpoint id",
        confirmMigration: true
      }
    });

    const envAfter = readFileSync(ws.envPath, "utf8");
    expect(envAfter).not.toContain("old-secret");
    expect(envAfter).toContain("# oc-switch:start");
    expect(envAfter).toContain("SOME_MCP_EPID=new-secret");
    expect(result.backupId).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("new-secret");
    expect(existsSync(join(ws.stateDir, "backups", result.backupId!, ".env"))).toBe(true);
  });

  test("rejects complex migration without explicit complex confirmation", async () => {
    const ws = workspace("export COMPLEX_TOKEN=old-secret\n");

    await expect(applyEnvOperation({
      paths: ws,
      operation: {
        type: "upsert",
        envVar: "COMPLEX_TOKEN",
        value: "new-secret",
        confirmMigration: true
      }
    })).rejects.toThrow("complex env var requires confirmation");
  });

  test("deletes managed extra env variable", async () => {
    const ws = workspace("# oc-switch:start\nSOME_MCP_EPID=secret\n# oc-switch:end\n");

    await applyEnvOperation({
      paths: ws,
      operation: { type: "delete", envVar: "SOME_MCP_EPID" }
    });

    expect(readFileSync(ws.envPath, "utf8")).not.toContain("SOME_MCP_EPID=");
  });

  test("renames managed extra env variable without returning the secret", async () => {
    const ws = workspace("# oc-switch:start\nSOME_MCP_EPID=secret-value\n# oc-switch:end\n");
    upsertExtraEnvManifest(ws.stateDir, "SOME_MCP_EPID", { note: "MCP endpoint id", managed: true });

    const result = await applyEnvOperation({
      paths: ws,
      operation: { type: "rename", fromEnvVar: "SOME_MCP_EPID", toEnvVar: "SOME_MCP_EPID_NEXT" }
    });

    const envAfter = readFileSync(ws.envPath, "utf8");
    expect(envAfter).not.toContain("SOME_MCP_EPID=");
    expect(envAfter).toContain("SOME_MCP_EPID_NEXT=secret-value");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    const manifest = readManifest(ws.stateDir);
    expect(manifest.extraEnv?.SOME_MCP_EPID).toBeUndefined();
    expect(manifest.extraEnv?.SOME_MCP_EPID_NEXT).toMatchObject({
      envVar: "SOME_MCP_EPID_NEXT",
      note: "MCP endpoint id",
      managed: true
    });
  });

  test("does not store provider env refs as extra managed variables", async () => {
    const ws = workspace("# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    await applyEnvOperation({
      paths: ws,
      operation: { type: "upsert", envVar: "NVIDIA_API_KEY", value: "new-secret" }
    });

    expect(readManifest(ws.stateDir).extraEnv?.NVIDIA_API_KEY).toBeUndefined();
  });
});
