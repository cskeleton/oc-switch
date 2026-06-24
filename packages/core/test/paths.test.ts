import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPaths,
  getActivePaths,
  readOcSwitchSettings,
  resolveOpenClawPathCandidates,
  writeOcSwitchSettings
} from "../src/paths";

const tempDirs: string[] = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-paths-"));
  tempDirs.push(dir);
  const home = join(dir, "home");
  const stateDir = join(home, ".oc-switch");
  const openclawDir = join(home, ".openclaw");
  mkdirSync(openclawDir, { recursive: true });
  const openclawPath = join(openclawDir, "openclaw.json");
  const envPath = join(openclawDir, ".env");
  writeFileSync(openclawPath, "{}\n");
  writeFileSync(envPath, "DEFAULT_KEY=value\n");
  return { dir, home, stateDir, openclawDir, openclawPath, envPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("path settings", () => {
  test("persists active openclaw and env paths with private file permissions", () => {
    const ws = workspace();
    const customConfig = join(ws.dir, "custom-openclaw.json");
    const customEnv = join(ws.dir, "custom.env");
    writeFileSync(customConfig, "{}\n");
    writeFileSync(customEnv, "CUSTOM_KEY=value\n");

    writeOcSwitchSettings(ws.stateDir, {
      openclawPath: customConfig,
      envPath: customEnv
    });

    expect(readOcSwitchSettings(ws.stateDir)).toEqual({
      openclawPath: customConfig,
      envPath: customEnv
    });
    expect(statSync(join(ws.stateDir, "settings.json")).mode & 0o777).toBe(0o600);
  });

  test("uses explicit OPENCLAW_CONFIG_PATH while keeping settings env path", () => {
    const ws = workspace();
    const settingsConfig = join(ws.dir, "settings-openclaw.json");
    const settingsEnv = join(ws.dir, "settings.env");
    const explicitConfig = join(ws.dir, "explicit-openclaw.json");
    writeFileSync(settingsConfig, "{}\n");
    writeFileSync(settingsEnv, "SETTINGS_KEY=value\n");
    writeFileSync(explicitConfig, "{}\n");
    writeOcSwitchSettings(ws.stateDir, { openclawPath: settingsConfig, envPath: settingsEnv });

    expect(getActivePaths({
      env: { HOME: ws.home, OPENCLAW_CONFIG_PATH: explicitConfig },
      stateDir: ws.stateDir
    })).toEqual({
      openclawPath: explicitConfig,
      envPath: settingsEnv,
      stateDir: ws.stateDir
    });
  });

  test("falls back to default openclaw paths when settings are absent", () => {
    const ws = workspace();

    expect(getActivePaths({ env: { HOME: ws.home }, stateDir: ws.stateDir })).toEqual({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir
    });
  });

  test("lists labeled path candidates and recommends running instance paths", () => {
    const ws = workspace();
    const runningStateDir = join(ws.dir, "running-state");
    mkdirSync(runningStateDir, { recursive: true });
    const runningConfig = join(runningStateDir, "openclaw.json");
    const runningEnv = join(runningStateDir, ".env");
    writeFileSync(runningConfig, "{}\n");
    writeFileSync(runningEnv, "RUNNING_KEY=value\n");

    const candidates = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runningInstances: [{
        pid: 123,
        openclawPath: runningConfig,
        envPath: runningEnv
      }]
    });

    expect(candidates.openclawPaths.find((item) => item.path === runningConfig)).toMatchObject({
      source: "running-instance",
      recommended: true,
      exists: true
    });
    expect(candidates.envPaths.find((item) => item.path === runningEnv)).toMatchObject({
      source: "running-instance",
      recommended: true,
      exists: true
    });
    expect(candidates.envPaths.find((item) => item.path === ws.envPath)).toMatchObject({
      source: "openclaw-default",
      recommended: false,
      exists: true
    });
  });

  test("uses running instance paths as active fallback before defaults", () => {
    const ws = workspace();
    const runningStateDir = join(ws.dir, "running-active");
    mkdirSync(runningStateDir, { recursive: true });
    const runningConfig = join(runningStateDir, "openclaw.json");
    const runningEnv = join(runningStateDir, ".env");
    writeFileSync(runningConfig, "{}\n");
    writeFileSync(runningEnv, "RUNNING_KEY=value\n");

    const candidates = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runningInstances: [{
        pid: 456,
        openclawPath: runningConfig,
        envPath: runningEnv
      }]
    });

    expect(candidates.active).toEqual({
      openclawPath: runningConfig,
      envPath: runningEnv,
      stateDir: ws.stateDir
    });
  });

  test("marks unreadable or missing candidates without throwing", () => {
    const ws = workspace();
    const missing = join(ws.dir, "missing", ".env");
    const candidates = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      manualEnvPaths: [missing]
    });

    expect(candidates.envPaths.find((item) => item.path === missing)).toMatchObject({
      source: "manual",
      exists: false,
      readable: false
    });
  });
});
