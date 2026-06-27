import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { writeOpenClawTransaction } from "../src/transaction-writer";

const tempDirs: string[] = [];

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-test-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(envPath, "USER_DEFINED_API_KEY=keep\n");
  return { dir, openclawPath, envPath, stateDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeOpenClawTransaction", () => {
  test("writes config and env with backup package", async () => {
    const ws = makeWorkspace();
    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "test write",
      envUpdates: { NVIDIA_API_KEY: "secret" },
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    });

    expect(result.backupDir).toContain(".oc-switch/backups/");
    expect(readFileSync(ws.openclawPath, "utf8")).toContain("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=secret");
    expect(readFileSync(join(result.backupDir, "openclaw.json"), "utf8")).toContain("minimax-portal/MiniMax-M3");
    expect(readFileSync(join(result.backupDir, ".env"), "utf8")).toContain("USER_DEFINED_API_KEY=keep");
  });

  test("rejects unmanaged env collisions before writing config", async () => {
    const ws = makeWorkspace();
    await expect(writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "collision",
      envUpdates: { USER_DEFINED_API_KEY: "replace" },
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    })).rejects.toThrow("env var migration requires confirmation");

    expect(readFileSync(ws.openclawPath, "utf8")).toContain("minimax-portal/MiniMax-M3");
  });

  test("restores openclaw.json when afterWrite fails", async () => {
    const ws = makeWorkspace();

    await expect(writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "afterWrite failure test",
      mutate(config) {
        delete config.agents!.defaults!.models!["nvidia/deepseek-ai/deepseek-v4-flash"];
        return config;
      },
      afterWrite() {
        throw new Error("state write failed");
      }
    })).rejects.toThrow("state write failed");

    const restored = JSON.parse(readFileSync(ws.openclawPath, "utf8"));
    expect(restored.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash",
      agentRuntime: { id: "codex" }
    });
  });

  test("writeOpenClawTransaction returns verified env write summary", async () => {
    const ws = makeWorkspace();
    writeFileSync(ws.envPath, "# oc-switch:start\nELYSIVER_API_KEY=old-value\n# oc-switch:end\n");

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "edit provider elysiver",
      envUpdates: { ELYSIVER_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456" },
      mutate(config) {
        return config;
      }
    });

    expect(result.envWrite).toEqual({
      verified: true,
      entries: [
        {
          envVar: "ELYSIVER_API_KEY",
          verified: true,
          managed: true,
          maskedValue: "sk-abc********123456"
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  test("rolls back config and env when env write verification fails", async () => {
    const ws = makeWorkspace();
    writeFileSync(ws.envPath, "# oc-switch:start\nELYSIVER_API_KEY=old-value\n# oc-switch:end\n");

    await expect(writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "verification failure",
      envUpdates: { ELYSIVER_API_KEY: "line-one\nline-two" },
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    })).rejects.toThrow("env write verification failed");

    const restored = JSON.parse(readFileSync(ws.openclawPath, "utf8"));
    expect(restored.agents.defaults.model).toBe("minimax-portal/MiniMax-M3");
    expect(readFileSync(ws.envPath, "utf8")).toBe("# oc-switch:start\nELYSIVER_API_KEY=old-value\n# oc-switch:end\n");
  });

  test("does not create env file when no env updates are requested", async () => {
    const ws = makeWorkspace();
    rmSync(ws.envPath, { force: true });

    await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "json only",
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    });

    expect(existsSync(ws.envPath)).toBe(false);
  });
});
