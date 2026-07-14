import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  defaultPaths,
  getActivePaths,
  readOcSwitchSettings,
  resolveOpenClawPathCandidates,
  validateRuntimePathSelection,
  writeOcSwitchSettings
} from "../src/paths";
import type {
  RuntimeDiscoveryConfidence,
  RuntimeDiscoveryResult,
  RuntimePathCandidateGroup
} from "../src/runtime-discovery-types";

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

function runtimeDiscovery(
  groups: RuntimePathCandidateGroup[],
  status: RuntimeDiscoveryResult["status"] = "resolved"
): RuntimeDiscoveryResult {
  return {
    status,
    instances: groups.map((group) => ({
      instanceId: group.instanceId,
      pid: group.pid,
      stateDir: group.stateDir,
      openclawPath: group.openclawPath,
      envPath: group.envPath,
      ...(group.serviceEnvPath ? { serviceEnvPath: group.serviceEnvPath } : {}),
      ...(group.confidence ? { confidence: group.confidence } : {}),
      evidence: group.evidence
    })),
    candidateGroups: groups,
    diagnostics: []
  };
}

function runtimeGroup(
  ws: ReturnType<typeof workspace>,
  name: string,
  confidence?: RuntimeDiscoveryConfidence
): RuntimePathCandidateGroup {
  const stateDir = join(ws.dir, name);
  mkdirSync(stateDir, { recursive: true });
  const openclawPath = join(stateDir, "openclaw.json");
  const envPath = join(stateDir, ".env");
  writeFileSync(openclawPath, "{}\n");
  writeFileSync(envPath, `${name.toUpperCase()}=1\n`);
  return {
    candidateId: `launchd:${name}:candidate`,
    instanceId: `launchd:${name}`,
    stateDir,
    openclawPath,
    envPath,
    serviceEnvPath: join(stateDir, "service-env", `${name}.env`),
    serviceManager: "launchd",
    serviceId: name,
    pid: name.length,
    ...(confidence ? { confidence } : {}),
    evidence: ["launchd-plist"]
  };
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
    expect(statSync(ws.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(ws.stateDir, "settings.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(ws.stateDir, "settings.json"), "utf8").endsWith("\n")).toBe(true);
  });

  test("falls back to empty settings when settings JSON is invalid", () => {
    const ws = workspace();
    mkdirSync(ws.stateDir, { recursive: true });
    writeFileSync(join(ws.stateDir, "settings.json"), "{bad json");

    expect(readOcSwitchSettings(ws.stateDir)).toEqual({});
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

  test("external OPENCLAW_CONFIG_PATH alone keeps default state-dir env", () => {
    const ws = workspace();
    const externalDir = join(ws.dir, "outside-only");
    mkdirSync(externalDir);
    const externalConfig = join(externalDir, "openclaw.json");
    writeFileSync(externalConfig, "{}\n");

    expect(getActivePaths({
      env: { HOME: ws.home, OPENCLAW_CONFIG_PATH: externalConfig },
      stateDir: ws.stateDir
    })).toEqual({
      openclawPath: externalConfig,
      envPath: ws.envPath,
      stateDir: ws.stateDir
    });
    expect(getActivePaths({
      env: { HOME: ws.home, OPENCLAW_CONFIG_PATH: externalConfig },
      stateDir: ws.stateDir
    }).envPath).not.toBe(join(externalDir, ".env"));
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

  test("settings paths are not overridden by runtime discovery", () => {
    const ws = workspace();
    const settingsConfig = join(ws.dir, "settings.json5");
    const settingsEnv = join(ws.dir, "settings.env");
    writeFileSync(settingsConfig, "{}\n");
    writeFileSync(settingsEnv, "SETTINGS=1\n");
    writeOcSwitchSettings(ws.stateDir, {
      openclawPath: settingsConfig,
      envPath: settingsEnv
    });
    const group = runtimeGroup(ws, "runtime", "confirmed");

    expect(getActivePaths({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([group])
    })).toEqual({
      openclawPath: settingsConfig,
      envPath: settingsEnv,
      stateDir: ws.stateDir
    });
  });

  test("unique confirmed or strong runtime group initializes both active paths", () => {
    for (const confidence of ["confirmed", "strong"] as const) {
      const ws = workspace();
      const group = runtimeGroup(ws, confidence, confidence);

      expect(getActivePaths({
        env: { HOME: ws.home },
        stateDir: ws.stateDir,
        runtimeDiscovery: runtimeDiscovery([group])
      })).toEqual({
        openclawPath: group.openclawPath,
        envPath: group.envPath,
        stateDir: ws.stateDir
      });
    }
  });

  test("inferred runtime group is recommended but does not become active", () => {
    const ws = workspace();
    const group = runtimeGroup(ws, "inferred", "inferred");
    const result = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([group])
    });

    expect(result.active.openclawPath).toBe(ws.openclawPath);
    expect(result.active.envPath).toBe(ws.envPath);
    expect(result.openclawPaths.find((item) => item.candidateId === group.candidateId))
      .toMatchObject({ recommended: true });
  });

  test("multiple strong runtime groups do not initialize active paths", () => {
    const ws = workspace();
    const first = runtimeGroup(ws, "first", "strong");
    const second = runtimeGroup(ws, "second", "strong");

    expect(getActivePaths({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([first, second])
    })).toEqual({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir
    });
  });

  test("runtimeDiscovery ignores legacy runningInstances for active paths", () => {
    const ws = workspace();
    const first = runtimeGroup(ws, "first", "strong");
    const second = runtimeGroup(ws, "second", "strong");
    const legacyConfig = join(ws.dir, "legacy.json");
    const legacyEnv = join(ws.dir, "legacy.env");
    writeFileSync(legacyConfig, "{}\n");
    writeFileSync(legacyEnv, "LEGACY=1\n");

    expect(getActivePaths({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([first, second]),
      runningInstances: [{
        pid: 1,
        openclawPath: legacyConfig,
        envPath: legacyEnv
      }]
    })).toEqual({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir
    });
  });

  test("conflicted or unresolved unique group does not initialize active paths", () => {
    const ws = workspace();
    const conflicted = { ...runtimeGroup(ws, "conflict", "strong"), conflicted: true };
    expect(getActivePaths({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery(
        [conflicted],
        "gateway-detected-path-unresolved"
      )
    })).toEqual({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir
    });

    const unresolvedStrong = runtimeGroup(ws, "unresolved", "strong");
    expect(getActivePaths({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery(
        [unresolvedStrong],
        "gateway-detected-path-unresolved"
      )
    })).toEqual({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir
    });
  });

  test("shared path across multiple candidate groups clears flat candidateId", () => {
    const ws = workspace();
    const sharedConfig = join(ws.dir, "shared", "openclaw.json");
    mkdirSync(dirname(sharedConfig), { recursive: true });
    writeFileSync(sharedConfig, "{}\n");
    const first = {
      ...runtimeGroup(ws, "first", "strong"),
      openclawPath: sharedConfig
    };
    const second = {
      ...runtimeGroup(ws, "second", "strong"),
      openclawPath: sharedConfig
    };
    const result = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([first, second])
    });

    expect(result.runtimeCandidateGroups).toHaveLength(2);
    expect(result.openclawPaths.find((item) => item.path === sharedConfig))
      .toMatchObject({ source: "running-instance", recommended: false });
    expect(result.openclawPaths.find((item) => item.path === sharedConfig)?.candidateId)
      .toBeUndefined();
  });

  test("external explicit config path never changes runtime-derived env path", () => {
    const ws = workspace();
    const group = runtimeGroup(ws, "runtime-state", "confirmed");
    const externalDir = join(ws.dir, "external");
    mkdirSync(externalDir);
    const externalConfig = join(externalDir, "openclaw.json");
    writeFileSync(externalConfig, "{}\n");

    expect(getActivePaths({
      env: { HOME: ws.home, OPENCLAW_CONFIG_PATH: externalConfig },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([group])
    })).toEqual({
      openclawPath: externalConfig,
      envPath: group.envPath,
      stateDir: ws.stateDir
    });
  });

  test("runtime candidate pair shares candidateId and excludes service env", () => {
    const ws = workspace();
    const group = runtimeGroup(ws, "paired", "strong");
    const result = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([group])
    });

    expect(result.runtimeDiscovery).toEqual(runtimeDiscovery([group]));
    expect(result.runtimeCandidateGroups).toEqual([group]);
    expect(result.openclawPaths.find((item) => item.path === group.openclawPath))
      .toMatchObject({ candidateId: group.candidateId, source: "running-instance" });
    expect(result.envPaths.find((item) => item.path === group.envPath))
      .toMatchObject({ candidateId: group.candidateId, source: "running-instance" });
    expect(result.envPaths.some((item) => item.path === group.serviceEnvPath)).toBe(false);
  });

  test("conflicted runtime group remains a non-recommended candidate", () => {
    const ws = workspace();
    const group = { ...runtimeGroup(ws, "conflict"), conflicted: true };
    const result = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery(
        [group],
        "gateway-detected-path-unresolved"
      )
    });

    expect(result.openclawPaths.find((item) => item.candidateId === group.candidateId))
      .toMatchObject({ recommended: false });
  });

  test("running candidate metadata wins when its path duplicates the default", () => {
    const ws = workspace();
    const group: RuntimePathCandidateGroup = {
      candidateId: "default-running",
      instanceId: "pid:99",
      stateDir: ws.openclawDir,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      pid: 99,
      confidence: "strong",
      evidence: ["process-environ"]
    };
    const result = resolveOpenClawPathCandidates({
      env: { HOME: ws.home },
      stateDir: ws.stateDir,
      runtimeDiscovery: runtimeDiscovery([group])
    });

    expect(result.openclawPaths.filter((item) => item.path === ws.openclawPath))
      .toEqual([expect.objectContaining({
        source: "running-instance",
        candidateId: group.candidateId,
        recommended: true
      })]);
  });
});

describe("runtime path selection validation", () => {
  test("accepts the exact current candidate pair", () => {
    const ws = workspace();
    const group = runtimeGroup(ws, "valid", "confirmed");

    expect(() => validateRuntimePathSelection({
      openclawPath: group.openclawPath,
      envPath: group.envPath,
      candidateId: group.candidateId,
      discovery: runtimeDiscovery([group])
    })).not.toThrow();
  });

  test("rejects stale candidateId and mixed runtime pairs", () => {
    const ws = workspace();
    const first = runtimeGroup(ws, "first", "confirmed");
    const second = runtimeGroup(ws, "second", "confirmed");
    const discovery = runtimeDiscovery([first, second]);

    expect(() => validateRuntimePathSelection({
      openclawPath: first.openclawPath,
      envPath: first.envPath,
      candidateId: "stale",
      discovery
    })).toThrow("candidateId");
    expect(() => validateRuntimePathSelection({
      openclawPath: first.openclawPath,
      envPath: second.envPath,
      candidateId: first.candidateId,
      discovery
    })).toThrow("路径配对");
  });

  test("rejects every discovered service env path", () => {
    const ws = workspace();
    const group = runtimeGroup(ws, "service", "strong");
    mkdirSync(join(group.stateDir, "service-env"));
    writeFileSync(group.serviceEnvPath!, "SERVICE=1\n");

    expect(() => validateRuntimePathSelection({
      openclawPath: group.openclawPath,
      envPath: group.serviceEnvPath!,
      discovery: runtimeDiscovery([group])
    })).toThrow("service env");
  });

  test("manual mode accepts a complete pair without candidate recommendation", () => {
    const ws = workspace();
    const manualConfig = join(ws.dir, "manual.json");
    const manualEnv = join(ws.dir, "manual.env");
    writeFileSync(manualConfig, "{}\n");
    writeFileSync(manualEnv, "MANUAL=1\n");

    expect(() => validateRuntimePathSelection({
      openclawPath: manualConfig,
      envPath: manualEnv,
      discovery: runtimeDiscovery([])
    })).not.toThrow();
  });
});
