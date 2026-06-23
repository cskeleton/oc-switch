import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateToken,
  readPersistedToken,
  resolveServeToken,
  rotatePersistedToken,
  writePersistedToken
} from "../src/token-manager";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-token-"));
  tempDirs.push(dir);
  return dir;
}

describe("token manager", () => {
  test("generateToken returns non-empty random string", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.length).toBeGreaterThan(20);
    expect(a).not.toBe(b);
  });

  test("write and read persisted token", () => {
    const dir = stateDir();
    writePersistedToken(dir, "persisted-secret");
    expect(readPersistedToken(dir)).toBe("persisted-secret");
    const tokenPath = join(dir, "token.json");
    expect(existsSync(tokenPath)).toBe(true);
    const mode = statSync(tokenPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("rotate writes new persisted token", () => {
    const dir = stateDir();
    writePersistedToken(dir, "old-token");
    const next = rotatePersistedToken(dir);
    expect(next).not.toBe("old-token");
    expect(readPersistedToken(dir)).toBe(next);
  });

  test("localhost without token generates ephemeral token", () => {
    const dir = stateDir();
    const result = resolveServeToken({ host: "127.0.0.1", stateDir: dir });
    expect(result.ephemeral).toBe(true);
    expect(result.token.length).toBeGreaterThan(10);
    expect(readPersistedToken(dir)).toBeUndefined();
  });

  test("0.0.0.0 without explicit or persisted token throws", () => {
    const dir = stateDir();
    expect(() => resolveServeToken({ host: "0.0.0.0", stateDir: dir })).toThrow(/0\.0\.0\.0/);
  });

  test("0.0.0.0 with persisted token uses it", () => {
    const dir = stateDir();
    writePersistedToken(dir, "saved-token");
    const result = resolveServeToken({ host: "0.0.0.0", stateDir: dir });
    expect(result).toEqual({ token: "saved-token", ephemeral: false });
  });

  test("explicit token overrides ephemeral generation", () => {
    const dir = stateDir();
    const result = resolveServeToken({ host: "127.0.0.1", token: "explicit", stateDir: dir });
    expect(result).toEqual({ token: "explicit", ephemeral: false });
  });
});
