import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearServePid,
  defaultServeUrl,
  isPidAlive,
  isPortListening,
  looksLikeOcSwitchServeCommand,
  readServePid,
  servePidPath,
  stopServePid,
  waitForHttp,
  waitForOwnedServe,
  writeServePid
} from "./serve-process";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-serve-"));
  tempDirs.push(dir);
  return dir;
}

describe("serve-process pid file", () => {
  test("write/read/clear pid round-trip", () => {
    const stateDir = tempStateDir();
    const pid = 4242;

    writeServePid(stateDir, pid);

    const pidPath = servePidPath(stateDir);
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, "utf8")).toBe(`${pid}\n`);
    expect(statSync(pidPath).mode & 0o777).toBe(0o600);
    expect(readServePid(stateDir)).toBe(pid);

    clearServePid(stateDir);
    expect(existsSync(pidPath)).toBe(false);
    expect(readServePid(stateDir)).toBeUndefined();
  });

  test("readServePid returns undefined when file missing", () => {
    expect(readServePid(tempStateDir())).toBeUndefined();
  });
});

describe("isPidAlive", () => {
  test("returns true for current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for huge fake pid", () => {
    expect(isPidAlive(2_147_483_647)).toBe(false);
  });
});

describe("defaultServeUrl", () => {
  test("uses default host and port", () => {
    expect(defaultServeUrl()).toBe("http://127.0.0.1:7420");
  });

  test("accepts custom host and port", () => {
    expect(defaultServeUrl("0.0.0.0", 8080)).toBe("http://0.0.0.0:8080");
  });
});

describe("looksLikeOcSwitchServeCommand", () => {
  test("matches spawnDetachedServe-style argv", () => {
    expect(
      looksLikeOcSwitchServeCommand(
        "bun run /repo/packages/cli/src/index.ts serve --host 127.0.0.1 --port 7420"
      )
    ).toBe(true);
  });

  test("rejects unrelated processes", () => {
    expect(looksLikeOcSwitchServeCommand("node server.js")).toBe(false);
    expect(looksLikeOcSwitchServeCommand("bun run packages/cli/src/index.ts status")).toBe(false);
  });
});

describe("isPortListening", () => {
  test("returns true when something listens", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok");
      }
    });
    try {
      expect(await isPortListening("127.0.0.1", Number(server.port))).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("returns false when nothing listens", async () => {
    expect(await isPortListening("127.0.0.1", 1, 200)).toBe(false);
  });
});

describe("stopServePid", () => {
  test("returns not-running when pid file missing", async () => {
    const stateDir = tempStateDir();
    const result = await stopServePid(stateDir);
    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/未在运行/);
    expect(existsSync(servePidPath(stateDir))).toBe(false);
  });

  test("cleans stale pid file when process is dead", async () => {
    const stateDir = tempStateDir();
    writeServePid(stateDir, 2_147_483_647);

    const result = await stopServePid(stateDir);
    expect(result.stopped).toBe(false);
    expect(existsSync(servePidPath(stateDir))).toBe(false);
  });

  test("does not signal alive non-serve pid; clears pid file", async () => {
    const stateDir = tempStateDir();
    // 当前测试进程存活，但命令行不是 oc-switch serve
    writeServePid(stateDir, process.pid);

    const result = await stopServePid(stateDir);
    expect(result.stopped).toBe(false);
    expect(result.message).toMatch(/不是 oc-switch serve/);
    expect(existsSync(servePidPath(stateDir))).toBe(false);
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe("waitForOwnedServe", () => {
  test("returns exited when pid is already dead even if HTTP responds", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("other");
      }
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const result = await waitForOwnedServe({
        url,
        pid: 2_147_483_647,
        timeoutMs: 800
      });
      expect(result).toBe("exited");
    } finally {
      server.stop();
    }
  });

  test("returns ready when owned pid is alive and HTTP responds", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok");
      }
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      const result = await waitForOwnedServe({
        url,
        pid: process.pid,
        timeoutMs: 3000
      });
      expect(result).toBe("ready");
    } finally {
      server.stop();
    }
  });
});

describe("waitForHttp", () => {
  test("returns true when server responds with 200", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok");
      }
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect(await waitForHttp(url, 5000)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("returns true when server responds with 401", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("unauthorized", { status: 401 });
      }
    });
    try {
      const url = `http://127.0.0.1:${server.port}`;
      expect(await waitForHttp(url, 5000)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("returns false on timeout when nothing listens", async () => {
    expect(await waitForHttp("http://127.0.0.1:1", 300)).toBe(false);
  });
});
