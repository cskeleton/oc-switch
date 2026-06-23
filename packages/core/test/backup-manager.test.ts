import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, restoreBackup } from "../src/backup-manager";

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
});
