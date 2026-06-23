import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, restoreBackup, restoreBackupSafely } from "../src/backup-manager";

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
});
