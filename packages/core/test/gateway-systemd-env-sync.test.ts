import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readGatewaySystemdEnv,
  readManagedBlockEntries,
  syncManagedBlockToGatewaySystemdEnv
} from "../src/gateway-systemd-env-sync";

const tempDirs: string[] = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-gateway-sync-"));
  tempDirs.push(dir);
  const envPath = join(dir, ".env");
  const gatewayPath = join(dir, "gateway.systemd.env");
  return { dir, envPath, gatewayPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readManagedBlockEntries", () => {
  test("parses keys inside managed block only", () => {
    const content = [
      "HTTP_PROXY=http://proxy",
      "# oc-switch:start",
      "NVIDIA_API_KEY=secret-a",
      "ELY_API_KEY=secret-b",
      "# oc-switch:end"
    ].join("\n");
    expect(readManagedBlockEntries(content)).toEqual({
      NVIDIA_API_KEY: "secret-a",
      ELY_API_KEY: "secret-b"
    });
  });
});

describe("syncManagedBlockToGatewaySystemdEnv", () => {
  test("replaces only the oc-switch block and preserves same-name keys outside the block", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=new-secret",
      "ELY_API_KEY=ely-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, [
      "HTTP_PROXY=http://proxy",
      "NVIDIA_API_KEY=old-secret",
      "# oc-switch:start",
      "NVIDIA_API_KEY=managed-old",
      "# oc-switch:end"
    ].join("\n") + "\n");

    const result = syncManagedBlockToGatewaySystemdEnv({ envPath: ws.envPath, gatewaySystemdEnvPath: ws.gatewayPath });

    expect(result.ok).toBe(true);
    expect(result.syncedKeys.sort()).toEqual(["ELY_API_KEY", "NVIDIA_API_KEY"]);
    expect(result.warnings).toContain("NVIDIA_API_KEY also exists outside oc-switch block in gateway.systemd.env");
    const content = readFileSync(ws.gatewayPath, "utf8");
    expect(content).toContain("HTTP_PROXY=http://proxy");
    expect(content).toContain("NVIDIA_API_KEY=old-secret");
    expect(content).toContain("# oc-switch:start\nNVIDIA_API_KEY=new-secret\nELY_API_KEY=ely-secret\n# oc-switch:end");
    expect(readGatewaySystemdEnv(content).HTTP_PROXY).toBe("http://proxy");
  });

  test("appends an oc-switch block when gateway.systemd.env has no managed block", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NEW_KEY=value",
      "# oc-switch:end"
    ].join("\n") + "\n");

    syncManagedBlockToGatewaySystemdEnv({ envPath: ws.envPath, gatewaySystemdEnvPath: ws.gatewayPath });

    expect(readFileSync(ws.gatewayPath, "utf8")).toBe("# oc-switch:start\nNEW_KEY=value\n# oc-switch:end\n");
  });

  test("removes stale keys from the existing oc-switch block", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "KEEP_KEY=keep",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, [
      "REMOVE_KEY=user-owned",
      "# oc-switch:start",
      "REMOVE_KEY=managed-gone",
      "KEEP_KEY=old",
      "# oc-switch:end"
    ].join("\n") + "\n");

    const result = syncManagedBlockToGatewaySystemdEnv({
      envPath: ws.envPath,
      gatewaySystemdEnvPath: ws.gatewayPath
    });

    const content = readFileSync(ws.gatewayPath, "utf8");
    expect(content).toContain("REMOVE_KEY=user-owned");
    expect(content).not.toContain("REMOVE_KEY=managed-gone");
    expect(content).toContain("KEEP_KEY=keep");
    expect(result.removedKeys).toEqual(["REMOVE_KEY"]);
  });

  test("rejects empty managed values without writing gateway file", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "BAD_KEY=",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, "HTTP_PROXY=http://proxy\n");

    expect(() => syncManagedBlockToGatewaySystemdEnv({
      envPath: ws.envPath,
      gatewaySystemdEnvPath: ws.gatewayPath
    })).toThrow("empty");

    expect(readFileSync(ws.gatewayPath, "utf8")).toBe("HTTP_PROXY=http://proxy\n");
  });

  test("creates gateway.systemd.env when missing", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "ONLY_KEY=value",
      "# oc-switch:end"
    ].join("\n") + "\n");

    expect(existsSync(ws.gatewayPath)).toBe(false);
    syncManagedBlockToGatewaySystemdEnv({ envPath: ws.envPath, gatewaySystemdEnvPath: ws.gatewayPath });
    expect(readFileSync(ws.gatewayPath, "utf8")).toContain("ONLY_KEY=value");
    chmodSync(ws.gatewayPath, 0o600);
    expect(statSync(ws.gatewayPath).mode & 0o777).toBe(0o600);
  });
});
