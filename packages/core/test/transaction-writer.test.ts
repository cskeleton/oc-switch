import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { writeEnvTransaction, writeOpenClawTransaction } from "../src/transaction-writer";
import { expectedGatewayEnvPath, prepareGatewayEnvTarget, withTestHome, withTestHomeAsync } from "./gateway-sync-fixture";

const tempDirs: string[] = [];

function makeWorkspace(options: { prepareGateway?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-test-"));
  tempDirs.push(dir);
  const homeDir = join(dir, "home");
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  const prepareGateway = options.prepareGateway ?? true;
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(envPath, "USER_DEFINED_API_KEY=keep\n");
  if (prepareGateway) prepareGatewayEnvTarget(dir, homeDir);
  return { dir, homeDir, openclawPath, envPath, stateDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const darwinTest = process.platform === "darwin" ? test : test.skip;

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

  test("does not sync gateway systemd env before afterWrite succeeds", async () => {
    const ws = makeWorkspace();
    const gatewayPath = expectedGatewayEnvPath(ws.dir);
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");
    writeFileSync(gatewayPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    await withTestHome(ws.homeDir, () => expect(writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "afterWrite failure with env",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      mutate(config) {
        return config;
      },
      afterWrite() {
        throw new Error("state write failed");
      }
    })).rejects.toThrow("state write failed"));

    expect(readFileSync(gatewayPath, "utf8")).toBe("# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");
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

  darwinTest("keeps config and env writes when automatic gateway sync target is missing", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    const result = await withTestHomeAsync(ws.homeDir, () => writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "missing launchd target",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    }));

    expect(JSON.parse(readFileSync(ws.openclawPath, "utf8")).agents.defaults.model)
      .toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      targetKind: "launchd",
      targetPath: "",
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n")).toContain("openclaw gateway install --force");
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

describe("writeEnvTransaction", () => {
  darwinTest("keeps env writes when automatic gateway sync target is missing", async () => {
    const ws = makeWorkspace({ prepareGateway: false });

    const result = await withTestHomeAsync(ws.homeDir, () => writeEnvTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "settings env update missing launchd target",
      verifyEnvUpdates: { SETTINGS_KEY: "settings-secret" },
      mutateEnv() {
        return "# oc-switch:start\nSETTINGS_KEY=settings-secret\n# oc-switch:end\n";
      }
    }));

    expect(readFileSync(ws.envPath, "utf8")).toContain("SETTINGS_KEY=settings-secret");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      targetKind: "launchd",
      targetPath: "",
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n")).toContain("openclaw gateway install --force");
  });
});
