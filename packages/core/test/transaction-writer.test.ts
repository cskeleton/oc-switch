import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { writePrimaryModelRef } from "../src/primary-model";
import { writeEnvTransaction, writeOpenClawTransaction } from "../src/transaction-writer";
import type { RuntimeDiscoveryResult, RuntimePathCandidateGroup } from "../src/runtime-discovery-types";
import { expectedGatewayEnvPath, prepareGatewayEnvTarget, withTestHome, withTestHomeAsync } from "./gateway-sync-fixture";

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
      runtimeDiscoveryProvider: () => discoveryResult([]),
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
      targetPath: "",
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n").length).toBeGreaterThan(0);
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
      runtimeDiscoveryProvider: () => discoveryResult([]),
      mutateEnv() {
        return "# oc-switch:start\nSETTINGS_KEY=settings-secret\n# oc-switch:end\n";
      }
    }));

    expect(readFileSync(ws.envPath, "utf8")).toContain("SETTINGS_KEY=settings-secret");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      targetPath: "",
      syncedKeys: [],
      removedKeys: []
    });
    expect(result.gatewayEnvSync?.warnings.join("\n").length).toBeGreaterThan(0);
  });
});

describe("writeOpenClawTransaction discovery-backed gateway sync", () => {
  test("verified env write with one exact candidate syncs to its service env", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    const serviceEnvPath = join(ws.dir, "custom", "gateway.env");
    mkdirSync(join(ws.dir, "custom"), { recursive: true });
    writeFileSync(serviceEnvPath, "HTTP_PROXY=http://proxy\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    const provider = () => discoveryResult([
      discoveryGroup({
        candidateId: "systemd:openclaw-gateway.service:aaa",
        instanceId: "systemd:openclaw-gateway.service",
        stateDir: ws.dir,
        openclawPath: ws.openclawPath,
        envPath: ws.envPath,
        serviceEnvPath,
        serviceId: "openclaw-gateway.service"
      })
    ]);

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "unique candidate sync",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      runtimeDiscoveryProvider: provider,
      mutate(config) {
        return config;
      }
    });

    expect(result.gatewayEnvSync).toMatchObject({
      ok: true,
      targetKind: "systemd",
      targetPath: serviceEnvPath,
      syncedKeys: ["NVIDIA_API_KEY"],
      candidateId: "systemd:openclaw-gateway.service:aaa"
    });
    expect(readFileSync(serviceEnvPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(readFileSync(serviceEnvPath, "utf8")).toContain("HTTP_PROXY=http://proxy");
    expect(JSON.stringify(result)).not.toContain("new-secret");
  });

  test("unmatched manual active path succeeds with gatewayEnvSync.ok=false", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    const otherEnv = join(ws.dir, "other", ".env");
    const otherServiceEnv = join(ws.dir, "other", "gateway.env");
    mkdirSync(join(ws.dir, "other"), { recursive: true });
    writeFileSync(otherServiceEnv, "");
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "manual unmatched path",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:other:bbb",
          instanceId: "systemd:other",
          stateDir: join(ws.dir, "other"),
          openclawPath: join(ws.dir, "other", "openclaw.json"),
          envPath: otherEnv,
          serviceEnvPath: otherServiceEnv
        })
      ]),
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    });

    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(JSON.parse(readFileSync(ws.openclawPath, "utf8")).agents.defaults.model)
      .toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(result.gatewayEnvSync).toMatchObject({
      ok: false,
      syncedKeys: [],
      removedKeys: []
    });
    expect(readFileSync(otherServiceEnv, "utf8")).toBe("");
  });

  test("ambiguous A/B candidates skip automatic sync and isolate writes", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    const serviceEnvA = join(ws.dir, "a", "gateway.env");
    const serviceEnvB = join(ws.dir, "b", "gateway.env");
    mkdirSync(join(ws.dir, "a"), { recursive: true });
    mkdirSync(join(ws.dir, "b"), { recursive: true });
    writeFileSync(serviceEnvA, "KEEP_A=1\n");
    writeFileSync(serviceEnvB, "KEEP_B=1\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    const twinGroups = [
      discoveryGroup({
        candidateId: "systemd:openclaw-gateway.service:aaa",
        instanceId: "systemd:openclaw-gateway.service",
        stateDir: ws.dir,
        openclawPath: ws.openclawPath,
        envPath: ws.envPath,
        serviceEnvPath: serviceEnvA,
        pid: 1
      }),
      discoveryGroup({
        candidateId: "systemd:openclaw-gateway.service:bbb",
        instanceId: "systemd:openclaw-gateway.service:twin",
        stateDir: ws.dir,
        openclawPath: ws.openclawPath,
        envPath: ws.envPath,
        serviceEnvPath: serviceEnvB,
        pid: 2
      })
    ];

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "ambiguous A/B",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      runtimeDiscoveryProvider: () => discoveryResult(twinGroups),
      mutate(config) {
        return config;
      }
    });

    expect(result.gatewayEnvSync?.ok).toBe(false);
    expect(readFileSync(serviceEnvA, "utf8")).toBe("KEEP_A=1\n");
    expect(readFileSync(serviceEnvB, "utf8")).toBe("KEEP_B=1\n");
    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
  });

  test("A writes never modify B service env", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
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
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "A/B isolation",
      envUpdates: { NVIDIA_API_KEY: "secret-a" },
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
      ]),
      mutate(config) {
        return config;
      }
    });

    expect(readFileSync(serviceEnvA, "utf8")).toContain("NVIDIA_API_KEY=secret-a");
    expect(readFileSync(serviceEnvB, "utf8")).toBe("KEEP_B=1\n");
  });

  test("target write failure after association rolls back the transaction", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    const missingParentTarget = join(ws.dir, "missing-parent", "gateway.env");
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");
    const beforeConfig = readFileSync(ws.openclawPath, "utf8");

    await expect(writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "associated write failure",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:openclaw-gateway.service:fail",
          instanceId: "systemd:openclaw-gateway.service",
          stateDir: ws.dir,
          openclawPath: ws.openclawPath,
          envPath: ws.envPath,
          serviceEnvPath: missingParentTarget
        })
      ]),
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    })).rejects.toThrow(/parent directory does not exist|Gateway service env/);

    expect(readFileSync(ws.openclawPath, "utf8")).toBe(beforeConfig);
    expect(readFileSync(ws.envPath, "utf8")).toBe("# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");
  });

  test("target-discovery failure does not roll back the primary env write", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "discovery skip",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      runtimeDiscoveryProvider: () => discoveryResult([]),
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    });

    expect(result.gatewayEnvSync?.ok).toBe(false);
    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(JSON.parse(readFileSync(ws.openclawPath, "utf8")).agents.defaults.model)
      .toBe("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("records runtimeInstanceId and serviceEnvPath in backup metadata when resolvable", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    const serviceEnvPath = join(ws.dir, "svc", "gateway.env");
    mkdirSync(join(ws.dir, "svc"), { recursive: true });
    writeFileSync(serviceEnvPath, "");
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old\n# oc-switch:end\n");

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "metadata association",
      envUpdates: { NVIDIA_API_KEY: "new" },
      runtimeDiscoveryProvider: () => discoveryResult([
        discoveryGroup({
          candidateId: "systemd:gw:meta",
          instanceId: "systemd:gw",
          stateDir: ws.dir,
          openclawPath: ws.openclawPath,
          envPath: ws.envPath,
          serviceEnvPath
        })
      ]),
      mutate(config) {
        return config;
      }
    });

    const metadata = JSON.parse(readFileSync(join(result.backupDir, "metadata.json"), "utf8")) as {
      runtimeInstanceId?: string;
      serviceEnvPath?: string;
    };
    expect(metadata.runtimeInstanceId).toBe("systemd:gw");
    expect(metadata.serviceEnvPath).toBe(serviceEnvPath);
  });

  test("second discovery empty skips sync and does not write first-resolved service env", async () => {
    const ws = makeWorkspace({ prepareGateway: false });
    const serviceEnvPath = join(ws.dir, "svc", "gateway.env");
    mkdirSync(join(ws.dir, "svc"), { recursive: true });
    writeFileSync(serviceEnvPath, "KEEP_FIRST=1\n");
    writeFileSync(ws.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");

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
      return discoveryCalls === 1 ? discoveryResult([uniqueGroup]) : discoveryResult([]);
    };

    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "stale second discovery",
      envUpdates: { NVIDIA_API_KEY: "new-secret" },
      runtimeDiscoveryProvider: provider,
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    });

    expect(discoveryCalls).toBeGreaterThanOrEqual(2);
    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
    expect(JSON.parse(readFileSync(ws.openclawPath, "utf8")).agents.defaults.model)
      .toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(result.gatewayEnvSync?.ok).toBe(false);
    expect(readFileSync(serviceEnvPath, "utf8")).toBe("KEEP_FIRST=1\n");

    const metadata = JSON.parse(readFileSync(join(result.backupDir, "metadata.json"), "utf8")) as {
      serviceEnvPath?: string;
    };
    expect(metadata.serviceEnvPath).toBe(serviceEnvPath);
  });
});

describe("writeOpenClawTransaction 对象形态主模型", () => {
  test("对象形态事务写入落盘保留 primary/fallbacks/未知键结构", async () => {
    const ws = makeWorkspace();
    // 预置对象形态主模型
    const seeded = JSON.parse(readFileSync(ws.openclawPath, "utf8")) as Record<string, unknown>;
    (seeded.agents as { defaults: Record<string, unknown> }).defaults.model = {
      primary: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"],
      customFlag: true
    };
    writeFileSync(ws.openclawPath, `${JSON.stringify(seeded, null, 2)}\n`);

    await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "switch primary",
      mutate(config) {
        writePrimaryModelRef(config, "nvidia/deepseek-ai/deepseek-v4-flash");
        return config;
      }
    });

    const persisted = JSON.parse(readFileSync(ws.openclawPath, "utf8")) as {
      agents: { defaults: { model: Record<string, unknown> } };
    };
    expect(persisted.agents.defaults.model).toEqual({
      primary: "nvidia/deepseek-ai/deepseek-v4-flash",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"],
      customFlag: true
    });
  });

  test("非 primary 写入不顺手修复畸形 agents.defaults.model", async () => {
    const ws = makeWorkspace();
    const seeded = JSON.parse(readFileSync(ws.openclawPath, "utf8")) as Record<string, unknown>;
    (seeded.agents as { defaults: Record<string, unknown> }).defaults.model = { primary: 42 };
    writeFileSync(ws.openclawPath, `${JSON.stringify(seeded, null, 2)}\n`);

    await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "allowlist alias",
      mutate(config) {
        config.agents!.defaults!.models!["minimax-portal/MiniMax-M3"] = { alias: "mm3-new" };
        return config;
      }
    });

    const persisted = JSON.parse(readFileSync(ws.openclawPath, "utf8")) as {
      agents: { defaults: { model: unknown } };
    };
    // 畸形值原样穿透：oc-switch 不做后台自动修复
    expect(persisted.agents.defaults.model).toEqual({ primary: 42 });
  });
});
