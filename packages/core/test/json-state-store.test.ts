import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonStatePath, readJsonState, writeJsonState } from "../src/json-state-store";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-switch-json-state-"));
}

describe("json-state-store", () => {
  test("returns fallback when state file is missing or invalid", () => {
    const stateDir = tempStateDir();
    try {
      expect(readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: true })
      })).toEqual({ ok: true });

      writeFileSync(jsonStatePath(stateDir, "sample.json"), "{bad json");
      expect(readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: false })
      })).toEqual({ ok: false });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("can rethrow invalid JSON for strict state files", () => {
    const stateDir = tempStateDir();
    try {
      writeFileSync(jsonStatePath(stateDir, "sample.json"), "{bad json");
      expect(() => readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: false }),
        invalidJson: "throw"
      })).toThrow(SyntaxError);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("区分不存在与不可读：EACCES 状态文件在两种模式下都抛出而不是静默回退", () => {
    if (process.platform === "win32") return;
    const stateDir = tempStateDir();
    const path = jsonStatePath(stateDir, "sample.json");
    writeFileSync(path, "{\"ok\":true}");
    chmodSync(path, 0o000);
    try {
      // 不可读必须可辨认：默认模式不允许吞成缺省值（与「文件不存在」区分开）
      expect(() => readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: false })
      })).toThrow();
      expect(() => readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: false }),
        invalidJson: "throw"
      })).toThrow();
    } finally {
      chmodSync(path, 0o600);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("EACCES 修复可读后恢复正常读取", () => {
    if (process.platform === "win32") return;
    const stateDir = tempStateDir();
    const path = jsonStatePath(stateDir, "sample.json");
    writeFileSync(path, "{\"ok\":true}");
    chmodSync(path, 0o000);
    try {
      expect(() => readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: false })
      })).toThrow();
      chmodSync(path, 0o600);
      expect(readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ ok: false })
      })).toEqual({ ok: true });
    } finally {
      chmodSync(path, 0o600);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("normalizes parsed data and writes with private permissions and newline", () => {
    const stateDir = tempStateDir();
    try {
      writeJsonState({
        stateDir,
        filename: "sample.json",
        value: { enabled: true }
      });

      const path = jsonStatePath(stateDir, "sample.json");
      expect(existsSync(path)).toBe(true);
      expect(statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
      expect(readJsonState({
        stateDir,
        filename: "sample.json",
        fallback: () => ({ enabled: false }),
        normalize(value) {
          const parsed = value as { enabled?: unknown };
          return { enabled: parsed.enabled === true };
        }
      })).toEqual({ enabled: true });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
