import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLaunchdServiceEnv,
  readManagedBlockEntries,
  resolveGatewayServiceEnvTarget,
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
  const homeDir = join(dir, "home");
  const launchAgentsDir = join(homeDir, "Library/LaunchAgents");
  const stateDir = join(dir, "openclaw-state");
  const serviceEnvDir = join(stateDir, "service-env");
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(serviceEnvDir, { recursive: true });
  const envPath = join(stateDir, ".env");
  const serviceEnvPath = join(serviceEnvDir, "ai.openclaw.gateway.env");
  const wrapperPath = join(stateDir, "bin", "openclaw-env-wrapper.sh");
  mkdirSync(join(stateDir, "bin"), { recursive: true });
  writeFileSync(wrapperPath, "#!/bin/sh\n");
  const plistPath = join(launchAgentsDir, "ai.openclaw.gateway.plist");
  writeFileSync(plistPath, [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${wrapperPath}</string>`,
    `    <string>${serviceEnvPath}</string>`,
    "  </array>",
    "</dict>",
    "</plist>"
  ].join("\n"));
  return { dir, homeDir, envPath, serviceEnvPath, plistPath, wrapperPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveGatewayServiceEnvTarget", () => {
  test("linux resolves gateway.systemd.env beside env file", () => {
    const ws = workspace();
    const target = resolveGatewayServiceEnvTarget({ envPath: ws.envPath, platform: "linux" });
    expect(target).toEqual({
      targetKind: "systemd",
      targetPath: ws.gatewayPath
    });
  });

  test("darwin resolves service-env path from LaunchAgent plist", () => {
    const ws = macWorkspace();
    const target = resolveGatewayServiceEnvTarget({
      envPath: ws.envPath,
      platform: "darwin",
      homeDir: ws.homeDir
    });
    expect(target).toEqual({
      targetKind: "launchd",
      targetPath: ws.serviceEnvPath
    });
  });

  test("darwin rejects plist without env-wrapper ProgramArguments[0]", () => {
    const ws = macWorkspace();
    writeFileSync(ws.plistPath, [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<plist version=\"1.0\"><dict>",
      "  <key>ProgramArguments</key>",
      "  <array>",
      "    <string>/bin/sh</string>",
      `    <string>${ws.serviceEnvPath}</string>`,
      "  </array>",
      "</dict></plist>"
    ].join("\n"));
    expect(() => resolveGatewayServiceEnvTarget({
      envPath: ws.envPath,
      platform: "darwin",
      homeDir: ws.homeDir
    })).toThrow(/env-wrapper/);
  });

  test("unsupported platform throws without creating guessed paths", () => {
    const ws = workspace();
    expect(() => resolveGatewayServiceEnvTarget({ envPath: ws.envPath, platform: "win32" })).toThrow(/unsupported|platform/i);
    expect(existsSync(ws.gatewayPath)).toBe(false);
  });
});

describe("syncManagedBlockToGatewayServiceEnv linux", () => {
  test("preserves systemd format and outside keys", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=new-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");
    writeFileSync(ws.gatewayPath, "HTTP_PROXY=http://proxy\n");

    const result = syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      gatewayServiceEnvPath: ws.gatewayPath,
      platform: "linux"
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
});

describe("syncManagedBlockToGatewayServiceEnv darwin", () => {
  test("writes export format inside oc-switch block", () => {
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
      platform: "darwin",
      homeDir: ws.homeDir
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
      platform: "darwin",
      homeDir: ws.homeDir
    });

    expect(result.warnings.some((w) => w.includes("NVIDIA_API_KEY") && w.includes("outside oc-switch block"))).toBe(true);
    const content = readFileSync(ws.serviceEnvPath, "utf8");
    expect(content).toContain("export NVIDIA_API_KEY='old-outside'");
    expect(content).toContain("export NVIDIA_API_KEY='new-secret'");
  });

  test("creates service-env file atomically with mode 0600", () => {
    const ws = macWorkspace();
    writeFileSync(ws.envPath, [
      "# oc-switch:start",
      "ONLY_KEY=value",
      "# oc-switch:end"
    ].join("\n") + "\n");
    expect(existsSync(ws.serviceEnvPath)).toBe(false);

    syncManagedBlockToGatewayServiceEnv({
      envPath: ws.envPath,
      platform: "darwin",
      homeDir: ws.homeDir
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
      platform: "darwin",
      homeDir: ws.homeDir
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
});
