import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, readBackupMetadata, restoreBackup, restoreBackupSafely } from "../src/backup-manager";
import type { RuntimeDiscoveryResult, RuntimePathCandidateGroup } from "../src/runtime-discovery-types";
import { prepareGatewayEnvTarget, withTestHome } from "./gateway-sync-fixture";

function discoveryGroup(
  partial: Partial<RuntimePathCandidateGroup> & Pick<
    RuntimePathCandidateGroup,
    "candidateId" | "instanceId" | "stateDir" | "openclawPath" | "envPath"
  >
): RuntimePathCandidateGroup {
  return {
    pid: 42,
    evidence: ["systemd-unit"],
    serviceManager: "systemd",
    ...partial
  };
}

function discoveryResult(groups: RuntimePathCandidateGroup[]): RuntimeDiscoveryResult {
  return {
    status: groups.length ? "resolved" : "gateway-not-detected",
    instances: groups.map((g) => ({
      instanceId: g.instanceId,
      pid: g.pid,
      openclawPath: g.openclawPath,
      envPath: g.envPath,
      stateDir: g.stateDir,
      ...(g.serviceEnvPath ? { serviceEnvPath: g.serviceEnvPath } : {}),
      ...(g.serviceManager ? { serviceManager: g.serviceManager } : {}),
      ...(g.serviceId ? { serviceId: g.serviceId } : {}),
      evidence: g.evidence
    })),
    candidateGroups: groups,
    diagnostics: []
  };
}

const tempDirs: string[] = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-backup-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, "{\"before\":true}\n");
  writeFileSync(envPath, "KEY=before\n");
  return { dir, openclawPath, envPath, stateDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

describe("backup manager", () => {
  test("normalizes Provider IDs when restoring a legacy backup", () => {
    const ws = workspace();
    writeFileSync(ws.openclawPath, JSON.stringify({
      models: { providers: { OpenRouter: { models: [{ id: "Model-X" }] } } },
      agents: { defaults: { model: "OpenRouter/Model-X", models: { "OpenRouter/Model-X": {} } } }
    }));
    const backupDir = createBackup({ ...ws, reason: "restore normalized", beforeHash: "hash" });
    writeFileSync(ws.openclawPath, "{\"after\":true}\n");

    restoreBackup({ backupDir, openclawPath: ws.openclawPath, envPath: ws.envPath });

    const restored = JSON.parse(readFileSync(ws.openclawPath, "utf8"));
    expect(restored.models.providers.openrouter.models[0].id).toBe("Model-X");
    expect(restored.agents.defaults.model).toBe("openrouter/Model-X");
    expect(restored.agents.defaults.models["openrouter/Model-X"]).toEqual({});
  });

  test("lists backup packages newest first", () => {
    const ws = workspace();
    const first = createBackup({ ...ws, reason: "first", beforeHash: "hash-1" });
    const second = createBackup({ ...ws, reason: "second", beforeHash: "hash-2" });

    const backups = listBackups(ws.stateDir);
    expect(backups.map((backup) => backup.path)).toEqual([second, first]);
    expect(backups[0]?.metadata.reason).toBe("second");
  });

  test("restores openclaw and env from backup package", () => {
    const ws = workspace();
    const backupDir = createBackup({ ...ws, reason: "restore", beforeHash: "hash" });
    writeFileSync(ws.openclawPath, "{\"after\":true}\n");
    writeFileSync(ws.envPath, "KEY=after\n");

    restoreBackup({ backupDir, openclawPath: ws.openclawPath, envPath: ws.envPath });

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(ws.envPath, "utf8")).toBe("KEY=before\n");
    expect(existsSync(join(backupDir, "metadata.json"))).toBe(true);
  });

  test("keeps only the latest twenty backup packages by default", () => {
    const ws = workspace();
    for (let i = 0; i < 21; i += 1) {
      writeFileSync(ws.openclawPath, `{"version":${i}}\n`);
      createBackup({ ...ws, reason: `backup-${i}`, beforeHash: `hash-${i}` });
    }

    const backups = listBackups(ws.stateDir);
    expect(backups).toHaveLength(20);
    expect(backups.map((backup) => backup.metadata.reason)).not.toContain("backup-0");
    expect(backups[0]?.metadata.reason).toBe("backup-20");
  });

  test("creates a safety backup of current files before restore", () => {
    const ws = workspace();
    const restoreTarget = createBackup({ ...ws, reason: "restore-target", beforeHash: "hash" });
    writeFileSync(ws.openclawPath, "{\"current\":true}\n");
    writeFileSync(ws.envPath, "KEY=current\n");

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath
    });

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(join(result.safetyBackupDir, "openclaw.json"), "utf8")).toBe("{\"current\":true}\n");
    expect(readFileSync(join(result.safetyBackupDir, ".env"), "utf8")).toBe("KEY=current\n");
  });

  test("syncs restored managed env block to gateway.systemd.env after restore", () => {
    const ws = workspace();
    const homeDir = join(ws.dir, "home");
    mkdirSync(homeDir, { recursive: true });
    const gatewayPath = prepareGatewayEnvTarget(ws.dir, homeDir);
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({ ...ws, reason: "restore-target", beforeHash: "hash" });
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current-secret\n# oc-switch:end\n");
    writeFileSync(gatewayPath, [
      "HTTP_PROXY=http://proxy",
      "# oc-switch:start",
      "CURRENT_KEY=current-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");

    const provider = () => discoveryResult([
      discoveryGroup({
        candidateId: "systemd:gw:restore",
        instanceId: "systemd:gw",
        stateDir: ws.dir,
        openclawPath: ws.openclawPath,
        envPath: ws.envPath,
        serviceEnvPath: gatewayPath
      })
    ]);

    const result = withTestHome(homeDir, () => restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: provider
    }));

    expect(result.gatewayEnvSync?.syncedKeys).toEqual(["RESTORED_KEY"]);
    expect(result.gatewayEnvSync?.removedKeys).toEqual(["CURRENT_KEY"]);
    const syncedContent = readFileSync(gatewayPath, "utf8");
    expect(syncedContent).toContain("HTTP_PROXY=http://proxy");
    expect(syncedContent).toContain("RESTORED_KEY");
    expect(syncedContent).toContain("restored-secret");
    expect(syncedContent).not.toContain("CURRENT_KEY=current-secret");
  });

  darwinTest("keeps restored files when gateway service env target is missing", () => {
    const ws = workspace();
    const homeDir = join(ws.dir, "home");
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({ ...ws, reason: "restore-target", beforeHash: "hash" });
    writeFileSync(ws.openclawPath, "{\"current\":true}\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current-secret\n# oc-switch:end\n");

    const result = withTestHome(homeDir, () => restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: () => discoveryResult([])
    }));

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(ws.envPath, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      targetPath: "",
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n").length).toBeGreaterThan(0);
  });

  test("records optional runtimeInstanceId and serviceEnvPath in backup metadata", () => {
    const ws = workspace();
    const serviceEnvPath = join(ws.dir, "svc", "gateway.env");
    mkdirSync(join(ws.dir, "svc"), { recursive: true });
    const backupDir = createBackup({
      ...ws,
      reason: "runtime meta",
      beforeHash: "hash",
      runtimeInstanceId: "systemd:gw",
      serviceEnvPath
    });

    const metadata = readBackupMetadata(backupDir);
    expect(metadata.runtimeInstanceId).toBe("systemd:gw");
    expect(metadata.serviceEnvPath).toBe(serviceEnvPath);
  });

  test("restore revalidates discovery and ignores stale metadata serviceEnvPath", () => {
    const ws = workspace();
    const staleServiceEnv = join(ws.dir, "stale", "gateway.env");
    const liveServiceEnv = join(ws.dir, "live", "gateway.env");
    mkdirSync(join(ws.dir, "stale"), { recursive: true });
    mkdirSync(join(ws.dir, "live"), { recursive: true });
    writeFileSync(staleServiceEnv, "STALE=1\n");
    writeFileSync(liveServiceEnv, "LIVE=1\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({
      ...ws,
      reason: "stale meta",
      beforeHash: "hash",
      runtimeInstanceId: "stale:old",
      serviceEnvPath: staleServiceEnv
    });
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current\n# oc-switch:end\n");

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:live:now",
          instanceId: "systemd:live",
          stateDir: ws.dir,
          openclawPath: ws.openclawPath,
          envPath: ws.envPath,
          serviceEnvPath: liveServiceEnv
        })
      ])
    });

    expect(result.gatewayEnvSync?.ok).toBe(true);
    expect(result.gatewayEnvSync?.targetPath).toBe(liveServiceEnv);
    expect(readFileSync(liveServiceEnv, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(readFileSync(staleServiceEnv, "utf8")).toBe("STALE=1\n");
  });

  test("restore without current match succeeds and skips sync", () => {
    const ws = workspace();
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({
      ...ws,
      reason: "no match",
      beforeHash: "hash",
      serviceEnvPath: join(ws.dir, "ghost.env")
    });
    writeFileSync(ws.openclawPath, "{\"current\":true}\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current\n# oc-switch:end\n");

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: () => discoveryResult([])
    });

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(ws.envPath, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(result.gatewayEnvSync?.ok).toBe(false);
  });

  test("restoring A cannot modify B service env", () => {
    const ws = workspace();
    const serviceEnvA = join(ws.dir, "a", "gateway.env");
    const serviceEnvB = join(ws.dir, "b", "gateway.env");
    const openclawB = join(ws.dir, "b", "openclaw.json");
    const envB = join(ws.dir, "b", ".env");
    mkdirSync(join(ws.dir, "a"), { recursive: true });
    mkdirSync(join(ws.dir, "b"), { recursive: true });
    writeFileSync(serviceEnvA, "KEEP_A=1\n");
    writeFileSync(serviceEnvB, "KEEP_B=1\n");
    writeFileSync(openclawB, "{}\n");
    writeFileSync(envB, "");
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({ ...ws, reason: "A restore", beforeHash: "hash" });
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current\n# oc-switch:end\n");

    restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:a:aaa",
          instanceId: "systemd:a",
          stateDir: ws.dir,
          openclawPath: ws.openclawPath,
          envPath: ws.envPath,
          serviceEnvPath: serviceEnvA
        }),
        discoveryGroup({
          candidateId: "systemd:b:bbb",
          instanceId: "systemd:b",
          stateDir: join(ws.dir, "b"),
          openclawPath: openclawB,
          envPath: envB,
          serviceEnvPath: serviceEnvB
        })
      ])
    });

    expect(readFileSync(serviceEnvA, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(readFileSync(serviceEnvB, "utf8")).toBe("KEEP_B=1\n");
  });

  test("safety backup records current association independently of restore target metadata", () => {
    const ws = workspace();
    const currentServiceEnv = join(ws.dir, "current-svc", "gateway.env");
    mkdirSync(join(ws.dir, "current-svc"), { recursive: true });
    writeFileSync(currentServiceEnv, "");
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored\n# oc-switch:end\n");
    const restoreTarget = createBackup({
      ...ws,
      reason: "old association",
      beforeHash: "hash",
      runtimeInstanceId: "old:instance",
      serviceEnvPath: join(ws.dir, "old.env")
    });
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current\n# oc-switch:end\n");

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:current:now",
          instanceId: "systemd:current",
          stateDir: ws.dir,
          openclawPath: ws.openclawPath,
          envPath: ws.envPath,
          serviceEnvPath: currentServiceEnv
        })
      ])
    });

    const safetyMeta = readBackupMetadata(result.safetyBackupDir);
    expect(safetyMeta.runtimeInstanceId).toBe("systemd:current");
    expect(safetyMeta.serviceEnvPath).toBe(currentServiceEnv);
    expect(safetyMeta.runtimeInstanceId).not.toBe("old:instance");
  });

  test("restore soft-fails when associated sync throws GatewayServiceEnvTargetError", () => {
    const ws = workspace();
    const missingParentTarget = join(ws.dir, "missing-parent", "gateway.env");
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({ ...ws, reason: "assoc write fail", beforeHash: "hash" });
    writeFileSync(ws.openclawPath, "{\"current\":true}\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current\n# oc-switch:end\n");

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:gw:missing-parent",
          instanceId: "systemd:gw",
          stateDir: ws.dir,
          openclawPath: ws.openclawPath,
          envPath: ws.envPath,
          serviceEnvPath: missingParentTarget
        })
      ])
    });

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(ws.envPath, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n")).toMatch(/parent directory does not exist|Gateway service env/);
  });

  test("second discovery empty skips sync and does not write first-resolved service env", () => {
    const ws = workspace();
    const serviceEnvPath = join(ws.dir, "svc", "gateway.env");
    mkdirSync(join(ws.dir, "svc"), { recursive: true });
    writeFileSync(serviceEnvPath, "KEEP_FIRST=1\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const restoreTarget = createBackup({ ...ws, reason: "stale second discovery", beforeHash: "hash" });
    writeFileSync(ws.envPath, "# oc-switch:start\nCURRENT_KEY=current\n# oc-switch:end\n");

    const uniqueGroup = discoveryGroup({
      candidateId: "systemd:gw:once",
      instanceId: "systemd:gw",
      stateDir: ws.dir,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      serviceEnvPath
    });
    let discoveryCalls = 0;
    const provider = () => {
      discoveryCalls += 1;
      // 第1次：safety backup 关联；第2次：sync 重校验为空
      return discoveryCalls === 1 ? discoveryResult([uniqueGroup]) : discoveryResult([]);
    };

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      runtimeDiscoveryProvider: provider
    });

    expect(discoveryCalls).toBeGreaterThanOrEqual(2);
    expect(readFileSync(ws.envPath, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(result.gatewayEnvSync?.ok).toBe(false);
    expect(readFileSync(serviceEnvPath, "utf8")).toBe("KEEP_FIRST=1\n");

    const safetyMeta = readBackupMetadata(result.safetyBackupDir);
    expect(safetyMeta.serviceEnvPath).toBe(serviceEnvPath);
  });

  test("rejects restore when backup paths do not match active paths", () => {
    const ws = workspace();
    const backupDir = createBackup({ ...ws, reason: "path-bound", beforeHash: "hash" });
    const otherOpenclaw = join(ws.dir, "other-openclaw.json");
    const otherEnv = join(ws.dir, "other.env");
    writeFileSync(otherOpenclaw, "{\"other\":true}\n");
    writeFileSync(otherEnv, "KEY=other\n");

    expect(() => restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir,
      openclawPath: otherOpenclaw,
      envPath: otherEnv
    })).toThrow(/备份路径与当前 active 路径不一致/);

    expect(readFileSync(otherOpenclaw, "utf8")).toBe("{\"other\":true}\n");
  });

  test("restores into current paths when mismatch is explicitly confirmed", () => {
    const ws = workspace();
    const backupDir = createBackup({ ...ws, reason: "path-bound", beforeHash: "hash" });
    const otherOpenclaw = join(ws.dir, "other-openclaw.json");
    const otherEnv = join(ws.dir, "other.env");
    writeFileSync(otherOpenclaw, "{\"other\":true}\n");
    writeFileSync(otherEnv, "KEY=other\n");

    const result = restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir,
      openclawPath: otherOpenclaw,
      envPath: otherEnv,
      allowPathMismatch: true
    });

    expect(readFileSync(otherOpenclaw, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(otherEnv, "utf8")).toBe("KEY=before\n");
    expect(readFileSync(join(result.safetyBackupDir, "openclaw.json"), "utf8")).toBe("{\"other\":true}\n");
  });

  test("reads backup metadata without exposing file contents", () => {
    const ws = workspace();
    const backupDir = createBackup({ ...ws, reason: "metadata", beforeHash: "hash" });

    const metadata = readBackupMetadata(backupDir);

    expect(metadata.openclawPath).toBe(ws.openclawPath);
    expect(metadata.envPath).toBe(ws.envPath);
    expect(JSON.stringify(metadata)).not.toContain("KEY=before");
  });

  test("rejects restore when backup metadata is missing", () => {
    const ws = workspace();
    const backupDir = createBackup({ ...ws, reason: "missing-metadata", beforeHash: "hash" });
    rmSync(join(backupDir, "metadata.json"));
    writeFileSync(ws.openclawPath, "{\"current\":true}\n");

    expect(() => restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath
    })).toThrow(/metadata/);

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"current\":true}\n");
  });

  test("records path sources and writes private backup permissions", () => {
    const ws = workspace();
    const backupDir = createBackup({
      ...ws,
      reason: "path metadata",
      beforeHash: "hash",
      pathSources: {
        openclawPath: "running-instance",
        envPath: "openclaw-default"
      }
    });

    const metadata = JSON.parse(readFileSync(join(backupDir, "metadata.json"), "utf8")) as {
      openclawPath: string;
      envPath: string;
      pathSources: { openclawPath: string; envPath: string };
    };
    expect(metadata.openclawPath).toBe(ws.openclawPath);
    expect(metadata.envPath).toBe(ws.envPath);
    expect(metadata.pathSources).toEqual({
      openclawPath: "running-instance",
      envPath: "openclaw-default"
    });
    expect(statSync(backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(backupDir, ".env")).mode & 0o777).toBe(0o600);
  });
});
