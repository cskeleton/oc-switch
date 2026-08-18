import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectGatewayServiceEnvKeyStates,
  readGatewayServiceEnvKeys,
  readLaunchdServiceEnv,
  readManagedBlockEntries,
  syncManagedBlockToGatewayServiceEnv
} from "../src/gateway-service-env-sync";

const tempDirs: string[] = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-service-env-sync-"));
  tempDirs.push(dir);
  const envPath = join(dir, ".env");
  const gatewayPath = join(dir, "gateway.systemd.env");
  return { dir, envPath, gatewayPath };
}

function macWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-launchd-sync-"));
  tempDirs.push(dir);
  const stateDir = join(dir, "openclaw-state");
  const serviceEnvDir = join(stateDir, "service-env");
  mkdirSync(serviceEnvDir, { recursive: true });
  const envPath = join(stateDir, ".env");
  const serviceEnvPath = join(serviceEnvDir, "ai.openclaw.gateway.env");
  return { dir, envPath, serviceEnvPath, serviceEnvDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("syncManagedBlockToGatewayServiceEnv linux", () => {
  test("requires explicit target and preserves systemd format", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=new-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, "HTTP_PROXY=http://proxy\n");

    const result = syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: {
        targetKind: "systemd",
        targetPath: ws.gatewayPath,
        candidateId: "systemd:openclaw-gateway.service:test"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      targetKind: "systemd",
      targetPath: ws.gatewayPath,
      syncedKeys: ["NVIDIA_API_KEY"]
    });
    expect(readFileSync(ws.gatewayPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(readFileSync(ws.gatewayPath, "utf8")).toContain("HTTP_PROXY=http://proxy");
  });

  test("does not guess sibling gateway.systemd.env when given another target", () => {
    const ws = workspace();
    const customTarget = join(ws.dir, "custom", "unit.env");
    mkdirSync(join(ws.dir, "custom"), { recursive: true });
    writeFileSync(ws.envPath, "# oc-switch:start\nONLY_KEY=value\n# oc-switch:end\n");
    writeFileSync(customTarget, "HTTP_PROXY=http://proxy\n");

    syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: { targetKind: "systemd", targetPath: customTarget }
    });

    expect(existsSync(ws.gatewayPath)).toBe(false);
    expect(readFileSync(customTarget, "utf8")).toContain("ONLY_KEY=value");
  });

  test("rejects when target parent directory does not exist", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, "# oc-switch:start\nONLY_KEY=value\n# oc-switch:end\n");
    const missingParent = join(ws.dir, "missing-parent", "gateway.systemd.env");

    expect(() => syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: { targetKind: "systemd", targetPath: missingParent }
    })).toThrow(/parent directory|does not exist/i);
    expect(existsSync(missingParent)).toBe(false);
  });
});

describe("syncManagedBlockToGatewayServiceEnv darwin", () => {
  test("writes export format to explicit launchd target", () => {
    const ws = macWorkspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=new-secret",
      "QUOTE_KEY=it's-fine",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.serviceEnvPath, [
      "# OpenClaw Gateway service environment",
      "export HTTP_PROXY='http://proxy'"
    ].join("\n") + "\n");

    const result = syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: {
        targetKind: "launchd",
        targetPath: ws.serviceEnvPath,
        candidateId: "launchd:ai.openclaw.gateway:/Users/gc/.openclaw"
      }
    });

    expect(result).toMatchObject({
      ok: true,
      targetKind: "launchd",
      targetPath: ws.serviceEnvPath,
      syncedKeys: ["NVIDIA_API_KEY", "QUOTE_KEY"]
    });
    const content = readFileSync(ws.serviceEnvPath, "utf8");
    expect(content).toContain("# OpenClaw Gateway service environment");
    expect(content).toContain("export HTTP_PROXY='http://proxy'");
    expect(content).toContain("# oc-switch:start");
    expect(content).toContain("export NVIDIA_API_KEY='new-secret'");
    expect(content).toContain("export QUOTE_KEY='it'\\''s-fine'");
    expect(content).not.toContain("NVIDIA_API_KEY=new-secret");
  });

  test("warns on outside-block key conflicts", () => {
    const ws = macWorkspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=new-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.serviceEnvPath, [
      "export NVIDIA_API_KEY='old-outside'",
      "# oc-switch:start",
      "export NVIDIA_API_KEY='managed-old'",
      "# oc-switch:end"
    ].join("\n") + "\n");

    const result = syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: { targetKind: "launchd", targetPath: ws.serviceEnvPath }
    });

    expect(result.warnings.some((w) => w.includes("NVIDIA_API_KEY") && w.includes("outside oc-switch block"))).toBe(true);
    const content = readFileSync(ws.serviceEnvPath, "utf8");
    expect(content).toContain("export NVIDIA_API_KEY='old-outside'");
    expect(content).toContain("export NVIDIA_API_KEY='new-secret'");
  });

  test("creates service-env file atomically with mode 0600 when parent exists", () => {
    const ws = macWorkspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "ONLY_KEY=value",
      "# oc-switch:end"
    ].join("\n") + "\n");
    expect(existsSync(ws.serviceEnvPath)).toBe(false);

    syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: { targetKind: "launchd", targetPath: ws.serviceEnvPath }
    });

    expect(existsSync(ws.serviceEnvPath)).toBe(true);
    expect(statSync(ws.serviceEnvPath).mode & 0o777).toBe(0o600);
  });

  test("rejects empty managed values without writing service-env file", () => {
    const ws = macWorkspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "BAD_KEY=",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.serviceEnvPath, "export HTTP_PROXY='http://proxy'\n");

    expect(() => syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      target: { targetKind: "launchd", targetPath: ws.serviceEnvPath }
    })).toThrow(/empty/);
    expect(readFileSync(ws.serviceEnvPath, "utf8")).toBe("export HTTP_PROXY='http://proxy'\n");
  });
});

describe("readLaunchdServiceEnv", () => {
  test("parses export lines", () => {
    const content = [
      "export HTTP_PROXY='http://proxy'",
      "export TOKEN='abc'",
      "# oc-switch:start",
      "export NVIDIA_API_KEY='secret'",
      "# oc-switch:end"
    ].join("\n");
    expect(readLaunchdServiceEnv(content)).toEqual({
      HTTP_PROXY: "http://proxy",
      TOKEN: "abc"
    });
    expect(readManagedBlockEntries(content)).toEqual({ NVIDIA_API_KEY: "secret" });
  });

  test("lists keys from both launchd outside entries and the managed block", () => {
    const ws = macWorkspace();
    writeFileSync(ws.serviceEnvPath, [
      "export HTTP_PROXY='http://proxy'",
      "# oc-switch:start",
      "export NVIDIA_API_KEY='secret'",
      "# oc-switch:end"
    ].join("\n"));

    expect(readGatewayServiceEnvKeys({
      targetKind: "launchd",
      targetPath: ws.serviceEnvPath
    })).toEqual(["HTTP_PROXY", "NVIDIA_API_KEY"]);
  });

  test("does not list empty Gateway service env values as resolvable keys", () => {
    const ws = workspace();
    writeFileSync(ws.gatewayPath, "READY_KEY=value\nEMPTY_KEY=\n");

    expect(readGatewayServiceEnvKeys({
      targetKind: "systemd",
      targetPath: ws.gatewayPath
    })).toEqual(["READY_KEY"]);
  });
});

describe("inspectGatewayServiceEnvKeyStates", () => {
  test("reports missing, equal, and different states without exposing values", () => {
    const ws = workspace();
    writeFileSync(ws.gatewayPath, [
      "EQUAL_KEY=same-secret",
      "DIFFERENT_KEY=old-secret",
      "EMPTY_KEY=",
      "SERVICE_ONLY=service-secret"
    ].join("\n") + "\n");

    expect(inspectGatewayServiceEnvKeyStates({
      sourceEntries: {
        EQUAL_KEY: "same-secret",
        DIFFERENT_KEY: "new-secret",
        EMPTY_KEY: "source-secret",
        MISSING_KEY: "source-secret"
      },
      keys: ["EQUAL_KEY", "DIFFERENT_KEY", "EMPTY_KEY", "MISSING_KEY"],
      target: { targetKind: "systemd", targetPath: ws.gatewayPath }
    })).toEqual({
      DIFFERENT_KEY: "different",
      EMPTY_KEY: "different",
      EQUAL_KEY: "equal",
      MISSING_KEY: "missing"
    });
  });
});
