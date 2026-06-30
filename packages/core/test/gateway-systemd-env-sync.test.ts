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
  test("merges managed keys into existing gateway.systemd.env and preserves unrelated keys", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=new-secret",
      "ELY_API_KEY=ely-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, "HTTP_PROXY=http://proxy\nNVIDIA_API_KEY=old-secret\n");

    const result = syncManagedBlockToGatewaySystemdEnv({ envPath: ws.envPath, gatewaySystemdEnvPath: ws.gatewayPath });

    expect(result.ok).toBe(true);
    expect(result.syncedKeys.sort()).toEqual(["ELY_API_KEY", "NVIDIA_API_KEY"]);
    const content = readFileSync(ws.gatewayPath, "utf8");
    expect(content).toContain("HTTP_PROXY=http://proxy");
    expect(content).toContain("NVIDIA_API_KEY=new-secret");
    expect(content).toContain("ELY_API_KEY=ely-secret");
    expect(readGatewaySystemdEnv(content).HTTP_PROXY).toBe("http://proxy");
  });

  test("adds new managed key to gateway.systemd.env", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NEW_KEY=value",
      "# oc-switch:end"
    ].join("\n") + "\n");

    syncManagedBlockToGatewaySystemdEnv({ envPath: ws.envPath, gatewaySystemdEnvPath: ws.gatewayPath });

    expect(readFileSync(ws.gatewayPath, "utf8")).toContain("NEW_KEY=value");
  });

  test("removes keys listed in removedKeys", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "KEEP_KEY=keep",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, "REMOVE_KEY=gone\nKEEP_KEY=old\n");

    syncManagedBlockToGatewaySystemdEnv({
      envPath: ws.envPath,
      gatewaySystemdEnvPath: ws.gatewayPath,
      removedKeys: ["REMOVE_KEY"]
    });

    const content = readFileSync(ws.gatewayPath, "utf8");
    expect(content).not.toContain("REMOVE_KEY=");
    expect(content).toContain("KEEP_KEY=keep");
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
