import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, readBackupMetadata, restoreBackup, restoreBackupSafely } from "../src/backup-manager";
import { prepareGatewayEnvTarget, withTestHome } from "./gateway-sync-fixture";

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

    const result = withTestHome(homeDir, () => restoreBackupSafely({
      stateDir: ws.stateDir,
      backupDir: restoreTarget,
      openclawPath: ws.openclawPath,
      envPath: ws.envPath
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
      envPath: ws.envPath
    }));

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(ws.envPath, "utf8")).toContain("RESTORED_KEY=restored-secret");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      targetKind: "launchd",
      targetPath: "",
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n")).toContain("openclaw gateway install --force");
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
