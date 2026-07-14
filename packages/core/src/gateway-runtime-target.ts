import { dirname, normalize } from "node:path";
import type { OcSwitchPaths } from "./paths";
import type {
  GatewayServiceEnvSyncResult,
  GatewayServiceEnvTarget,
  GatewayServiceEnvTargetKind
} from "./gateway-service-env-sync";
import type {
  RuntimeDiscoveryResult,
  RuntimePathCandidateGroup
} from "./runtime-discovery-types";

export type GatewayRestartEnvKey =
  | "OPENCLAW_HOME"
  | "OPENCLAW_STATE_DIR"
  | "OPENCLAW_CONFIG_PATH"
  | "OPENCLAW_PROFILE"
  | "OPENCLAW_LAUNCHD_LABEL"
  | "OPENCLAW_SYSTEMD_UNIT";

export interface GatewayRuntimeTarget {
  candidateId: string;
  instanceId: string;
  envPath: string;
  serviceEnvTarget: GatewayServiceEnvTarget;
  restartEnv: Partial<Record<GatewayRestartEnvKey, string>>;
}

export type GatewayRuntimeTargetErrorCode =
  | "no-matching-group"
  | "ambiguous-match"
  | "missing-candidate-id"
  | "stale-candidate"
  | "candidate-mismatch"
  | "no-service-env"
  | "missing-service-manager";

export class GatewayRuntimeTargetError extends Error {
  readonly code: GatewayRuntimeTargetErrorCode;
  readonly candidateId?: string;

  constructor(code: GatewayRuntimeTargetErrorCode, message: string, candidateId?: string) {
    super(message);
    this.name = "GatewayRuntimeTargetError";
    this.code = code;
    if (candidateId) this.candidateId = candidateId;
  }
}

export function isGatewayRuntimeTargetError(error: unknown): error is GatewayRuntimeTargetError {
  return error instanceof GatewayRuntimeTargetError;
}

/** 将 automatic 关联失败转为可返回的 sync 结果（不写盘、不回滚主写入） */
export function gatewayRuntimeTargetErrorToSyncResult(
  error: GatewayRuntimeTargetError
): GatewayServiceEnvSyncResult {
  const guidance =
    "check openclaw gateway status / openclaw gateway install --force";
  return {
    ok: false,
    targetPath: "",
    syncedKeys: [],
    removedKeys: [],
    warnings: [`${error.message}; ${guidance}`],
    ...(error.candidateId ? { candidateId: error.candidateId } : {})
  };
}

function samePath(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function matchesActivePaths(
  group: RuntimePathCandidateGroup,
  activePaths: Pick<OcSwitchPaths, "openclawPath" | "envPath">
): boolean {
  return samePath(group.openclawPath, activePaths.openclawPath)
    && samePath(group.envPath, activePaths.envPath);
}

function resolveTargetKind(
  group: RuntimePathCandidateGroup
): GatewayServiceEnvTargetKind {
  if (group.serviceManager === "launchd" || group.serviceManager === "systemd") {
    return group.serviceManager;
  }
  throw new GatewayRuntimeTargetError(
    "missing-service-manager",
    "Matched runtime candidate is missing serviceManager; cannot infer Gateway service env target kind",
    group.candidateId
  );
}

function launchdProfile(serviceId: string | undefined): string | undefined {
  if (!serviceId) return undefined;
  const match = /^ai\.openclaw\.(.+)$/.exec(serviceId);
  const profile = match?.[1];
  if (!profile || profile === "gateway") return undefined;
  return profile;
}

/** 仅从候选组生成白名单 restart selector，禁止透传任意环境变量名 */
export function buildGatewayRestartEnv(
  group: RuntimePathCandidateGroup
): Partial<Record<GatewayRestartEnvKey, string>> {
  const restartEnv: Partial<Record<GatewayRestartEnvKey, string>> = {
    OPENCLAW_HOME: dirname(group.stateDir),
    OPENCLAW_STATE_DIR: group.stateDir,
    OPENCLAW_CONFIG_PATH: group.openclawPath
  };
  const profile = launchdProfile(group.serviceId);
  if (profile) restartEnv.OPENCLAW_PROFILE = profile;
  if (group.serviceManager === "launchd" && group.serviceId) {
    restartEnv.OPENCLAW_LAUNCHD_LABEL = group.serviceId;
  }
  if (group.serviceManager === "systemd" && group.serviceId) {
    restartEnv.OPENCLAW_SYSTEMD_UNIT = group.serviceId;
  }
  return restartEnv;
}

function toRuntimeTarget(group: RuntimePathCandidateGroup): GatewayRuntimeTarget {
  const serviceEnvPath = group.serviceEnvPath?.trim();
  if (!serviceEnvPath) {
    throw new GatewayRuntimeTargetError(
      "no-service-env",
      "Matched runtime candidate has no service env path; sync/restart skipped",
      group.candidateId
    );
  }
  return {
    candidateId: group.candidateId,
    instanceId: group.instanceId,
    envPath: group.envPath,
    serviceEnvTarget: {
      targetKind: resolveTargetKind(group),
      targetPath: serviceEnvPath,
      candidateId: group.candidateId
    },
    restartEnv: buildGatewayRestartEnv(group)
  };
}

function resolveAutomatic(
  activePaths: Pick<OcSwitchPaths, "openclawPath" | "envPath">,
  discovery: RuntimeDiscoveryResult
): GatewayRuntimeTarget {
  const matching = discovery.candidateGroups.filter((group) => matchesActivePaths(group, activePaths));
  if (matching.length === 0) {
    throw new GatewayRuntimeTargetError(
      "no-matching-group",
      "No runtime candidate group uniquely matches the active OpenClaw config and env paths"
    );
  }

  const withServiceEnv = matching.filter((group) => Boolean(group.serviceEnvPath?.trim()));
  if (withServiceEnv.length === 0) {
    throw new GatewayRuntimeTargetError(
      "no-service-env",
      "Matched runtime candidate has no service env path; sync/restart skipped",
      matching[0]?.candidateId
    );
  }
  if (withServiceEnv.length > 1) {
    throw new GatewayRuntimeTargetError(
      "ambiguous-match",
      "Multiple runtime candidate groups match the active paths; provide candidateId"
    );
  }
  return toRuntimeTarget(withServiceEnv[0]!);
}

function resolveExplicit(
  activePaths: Pick<OcSwitchPaths, "openclawPath" | "envPath">,
  discovery: RuntimeDiscoveryResult,
  candidateId: string | undefined
): GatewayRuntimeTarget {
  if (!candidateId) {
    if (discovery.candidateGroups.length > 1) {
      throw new GatewayRuntimeTargetError(
        "missing-candidate-id",
        "Multiple runtime candidates detected; candidateId is required for explicit sync/restart"
      );
    }
    return resolveAutomatic(activePaths, discovery);
  }

  const group = discovery.candidateGroups.find((item) => item.candidateId === candidateId);
  if (!group) {
    throw new GatewayRuntimeTargetError(
      "stale-candidate",
      `Runtime candidate "${candidateId}" is no longer present in discovery`,
      candidateId
    );
  }
  if (!matchesActivePaths(group, activePaths)) {
    throw new GatewayRuntimeTargetError(
      "candidate-mismatch",
      `Runtime candidate "${candidateId}" does not match the active OpenClaw config/env paths`,
      candidateId
    );
  }
  return toRuntimeTarget(group);
}

/** 将 active 路径与 discovery 候选组解析为唯一 sync/restart 目标 */
export function resolveGatewayRuntimeTarget(input: {
  activePaths: Pick<OcSwitchPaths, "openclawPath" | "envPath">;
  discovery: RuntimeDiscoveryResult;
  candidateId?: string;
  mode: "automatic" | "explicit";
}): GatewayRuntimeTarget {
  if (input.mode === "explicit") {
    return resolveExplicit(input.activePaths, input.discovery, input.candidateId);
  }
  if (input.candidateId) {
    // automatic 模式忽略 candidateId，始终按 active 路径唯一匹配
    return resolveAutomatic(input.activePaths, input.discovery);
  }
  return resolveAutomatic(input.activePaths, input.discovery);
}
