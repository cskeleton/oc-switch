import { describe, expect, test } from "bun:test";
import {
  GatewayRuntimeTargetError,
  isGatewayRuntimeTargetError,
  resolveGatewayRuntimeTarget
} from "../src/gateway-runtime-target";
import type { RuntimeDiscoveryResult, RuntimePathCandidateGroup } from "../src/runtime-discovery-types";

function group(partial: Partial<RuntimePathCandidateGroup> & Pick<
  RuntimePathCandidateGroup,
  "candidateId" | "instanceId" | "stateDir" | "openclawPath" | "envPath"
>): RuntimePathCandidateGroup {
  return {
    pid: 42,
    evidence: ["systemd-unit"],
    ...partial
  };
}

function discovery(groups: RuntimePathCandidateGroup[]): RuntimeDiscoveryResult {
  return {
    status: groups.some((g) => g.confidence) ? "resolved" : "gateway-detected-path-unresolved",
    instances: groups.map((g) => ({
      instanceId: g.instanceId,
      pid: g.pid,
      openclawPath: g.openclawPath,
      envPath: g.envPath,
      stateDir: g.stateDir,
      ...(g.serviceEnvPath ? { serviceEnvPath: g.serviceEnvPath } : {}),
      ...(g.serviceManager ? { serviceManager: g.serviceManager } : {}),
      ...(g.serviceId ? { serviceId: g.serviceId } : {}),
      ...(g.confidence ? { confidence: g.confidence } : {}),
      evidence: g.evidence
    })),
    candidateGroups: groups,
    diagnostics: []
  };
}

const activeA = {
  openclawPath: "/home/user/.openclaw/openclaw.json",
  envPath: "/home/user/.openclaw/.env"
};

const groupA = group({
  candidateId: "systemd:openclaw-gateway.service:aaa111",
  instanceId: "systemd:openclaw-gateway.service",
  stateDir: "/home/user/.openclaw",
  openclawPath: activeA.openclawPath,
  envPath: activeA.envPath,
  serviceEnvPath: "/home/user/.openclaw/custom/gateway.env",
  serviceManager: "systemd",
  serviceId: "openclaw-gateway.service",
  confidence: "strong",
  evidence: ["systemd-unit", "process-environ"]
});

const groupB = group({
  candidateId: "systemd:openclaw-gateway@work.service:bbb222",
  instanceId: "systemd:openclaw-gateway@work.service",
  stateDir: "/home/user/.openclaw-work",
  openclawPath: "/home/user/.openclaw-work/openclaw.json",
  envPath: "/home/user/.openclaw-work/.env",
  serviceEnvPath: "/home/user/.openclaw-work/gateway.systemd.env",
  serviceManager: "systemd",
  serviceId: "openclaw-gateway@work.service",
  confidence: "strong",
  evidence: ["systemd-unit"]
});

const macGroup = group({
  candidateId: "launchd:ai.openclaw.gateway:ccc333",
  instanceId: "launchd:ai.openclaw.gateway",
  stateDir: "/Users/gc/.openclaw",
  openclawPath: "/Users/gc/.openclaw/openclaw.json",
  envPath: "/Users/gc/.openclaw/.env",
  serviceEnvPath: "/Users/gc/.openclaw/service-env/ai.openclaw.gateway.env",
  serviceManager: "launchd",
  serviceId: "ai.openclaw.gateway",
  confidence: "confirmed",
  evidence: ["launchd-plist", "cli-status"]
});

describe("resolveGatewayRuntimeTarget automatic", () => {
  test("returns unique exact active config/env match with service env", () => {
    const target = resolveGatewayRuntimeTarget({
      activePaths: activeA,
      discovery: discovery([groupA, groupB]),
      mode: "automatic"
    });

    expect(target.candidateId).toBe(groupA.candidateId);
    expect(target.instanceId).toBe(groupA.instanceId);
    expect(target.envPath).toBe(groupA.envPath);
    expect(target.serviceEnvTarget).toEqual({
      targetKind: "systemd",
      targetPath: "/home/user/.openclaw/custom/gateway.env",
      candidateId: groupA.candidateId
    });
    // Linux 必须用 unit 实际 EnvironmentFile，不得猜 dirname(envPath)/gateway.systemd.env
    expect(target.serviceEnvTarget.targetPath).not.toBe("/home/user/.openclaw/gateway.systemd.env");
  });

  test("rejects ambiguous exact matches without candidateId", () => {
    const twin = group({
      ...groupA,
      candidateId: "systemd:openclaw-gateway.service:twin",
      instanceId: "systemd:openclaw-gateway.service:twin",
      pid: 99
    });
    expect(() => resolveGatewayRuntimeTarget({
      activePaths: activeA,
      discovery: discovery([groupA, twin]),
      mode: "automatic"
    })).toThrow(GatewayRuntimeTargetError);

    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([groupA, twin]),
        mode: "automatic"
      });
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("ambiguous-match");
    }
  });

  test("selects sole syncable group when another path match lacks serviceEnv", () => {
    const withoutServiceEnv = group({
      candidateId: "pid:77:nosync",
      instanceId: "pid:77",
      stateDir: "/home/user/.openclaw",
      openclawPath: activeA.openclawPath,
      envPath: activeA.envPath,
      pid: 77,
      confidence: "inferred",
      evidence: ["default-state-dir"]
    });
    const target = resolveGatewayRuntimeTarget({
      activePaths: activeA,
      discovery: discovery([withoutServiceEnv, groupA]),
      mode: "automatic"
    });
    expect(target.candidateId).toBe(groupA.candidateId);
    expect(target.serviceEnvTarget.targetPath).toBe(groupA.serviceEnvPath!);
  });

  test("returns structured skip when matched group has no service env", () => {
    const withoutServiceEnv = group({
      candidateId: "pid:1:ddd444",
      instanceId: "pid:1",
      stateDir: "/home/user/.openclaw",
      openclawPath: activeA.openclawPath,
      envPath: activeA.envPath,
      confidence: "inferred",
      evidence: ["default-state-dir"]
    });

    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([withoutServiceEnv]),
        mode: "automatic"
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("no-service-env");
    }
  });

  test("rejects when no group matches active paths", () => {
    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([groupB]),
        mode: "automatic"
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("no-matching-group");
    }
  });

  test("rejects match with serviceEnvPath but missing serviceManager", () => {
    const withoutManager = group({
      candidateId: "pid:7:fff666",
      instanceId: "pid:7",
      stateDir: "/home/user/.openclaw",
      openclawPath: activeA.openclawPath,
      envPath: activeA.envPath,
      serviceEnvPath: "/home/user/.openclaw/custom/unit.env",
      confidence: "strong",
      evidence: ["process-environ"]
    });

    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([withoutManager]),
        mode: "automatic"
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("missing-service-manager");
    }
  });
});

describe("resolveGatewayRuntimeTarget explicit", () => {
  test("requires candidateId when multiple groups exist", () => {
    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([groupA, groupB]),
        mode: "explicit"
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("missing-candidate-id");
    }
  });

  test("rejects stale candidateId", () => {
    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([groupA, groupB]),
        candidateId: "systemd:missing:zzzzzz",
        mode: "explicit"
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("stale-candidate");
    }
  });

  test("rejects candidate that mismatches active env/config", () => {
    try {
      resolveGatewayRuntimeTarget({
        activePaths: activeA,
        discovery: discovery([groupA, groupB]),
        candidateId: groupB.candidateId,
        mode: "explicit"
      });
      throw new Error("expected throw");
    } catch (error) {
      expect(isGatewayRuntimeTargetError(error)).toBe(true);
      expect((error as GatewayRuntimeTargetError).code).toBe("candidate-mismatch");
    }
  });

  test("resolves macOS launchd service env from candidate group", () => {
    const target = resolveGatewayRuntimeTarget({
      activePaths: {
        openclawPath: macGroup.openclawPath,
        envPath: macGroup.envPath
      },
      discovery: discovery([macGroup]),
      candidateId: macGroup.candidateId,
      mode: "explicit"
    });

    expect(target.serviceEnvTarget).toEqual({
      targetKind: "launchd",
      targetPath: "/Users/gc/.openclaw/service-env/ai.openclaw.gateway.env",
      candidateId: macGroup.candidateId
    });
  });
});

describe("resolveGatewayRuntimeTarget restartEnv", () => {
  test("only emits allowlisted OpenClaw selector keys", () => {
    const profileGroup = group({
      candidateId: "launchd:ai.openclaw.work:eee555",
      instanceId: "launchd:ai.openclaw.work",
      stateDir: "/Users/gc/.openclaw-work",
      openclawPath: "/Users/gc/.openclaw-work/openclaw.json",
      envPath: "/Users/gc/.openclaw-work/.env",
      serviceEnvPath: "/Users/gc/.openclaw-work/service-env/ai.openclaw.work.env",
      serviceManager: "launchd",
      serviceId: "ai.openclaw.work",
      confidence: "strong",
      evidence: ["launchd-plist"]
    });

    const target = resolveGatewayRuntimeTarget({
      activePaths: {
        openclawPath: profileGroup.openclawPath,
        envPath: profileGroup.envPath
      },
      discovery: discovery([profileGroup]),
      candidateId: profileGroup.candidateId,
      mode: "explicit"
    });

    expect(Object.keys(target.restartEnv).sort()).toEqual([
      "OPENCLAW_CONFIG_PATH",
      "OPENCLAW_HOME",
      "OPENCLAW_LAUNCHD_LABEL",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR"
    ]);
    expect(target.restartEnv).toEqual({
      OPENCLAW_HOME: "/Users/gc",
      OPENCLAW_STATE_DIR: "/Users/gc/.openclaw-work",
      OPENCLAW_CONFIG_PATH: "/Users/gc/.openclaw-work/openclaw.json",
      OPENCLAW_PROFILE: "work",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work"
    });
  });

  test("systemd selectors use OPENCLAW_SYSTEMD_UNIT", () => {
    const target = resolveGatewayRuntimeTarget({
      activePaths: activeA,
      discovery: discovery([groupA]),
      mode: "automatic"
    });

    expect(target.restartEnv.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(target.restartEnv.OPENCLAW_LAUNCHD_LABEL).toBeUndefined();
    expect(target.restartEnv.OPENCLAW_STATE_DIR).toBe(groupA.stateDir);
    expect(target.restartEnv.OPENCLAW_CONFIG_PATH).toBe(groupA.openclawPath);
  });
});
