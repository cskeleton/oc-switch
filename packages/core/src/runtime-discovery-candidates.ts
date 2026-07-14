import { createHash } from "node:crypto";
import { join, normalize } from "node:path";
import type {
  RunningOpenClawInstance,
  RuntimeDiscoveryConfidence,
  RuntimeDiscoveryEvidence,
  RuntimePathCandidateGroup
} from "./runtime-discovery-types";

function pathDigest(stateDir: string, openclawPath: string): string {
  return createHash("sha256")
    .update(`${normalize(stateDir)}\0${normalize(openclawPath)}`)
    .digest("hex")
    .slice(0, 12);
}

/** 为路径候选生成不依赖 PID 的稳定标识 */
export function createRuntimeCandidateId(
  instance: Pick<RunningOpenClawInstance, "pid" | "serviceManager" | "serviceId">,
  stateDir: string,
  openclawPath: string
): string {
  const digest = pathDigest(stateDir, openclawPath);
  return instance.serviceManager && instance.serviceId
    ? `${instance.serviceManager}:${instance.serviceId}:${digest}`
    : `pid:${instance.pid}:${digest}`;
}

export interface RuntimeCandidateInput {
  instance: RunningOpenClawInstance;
  stateDir: string;
  openclawPath?: string;
  serviceEnvPath?: string;
  confidence?: RuntimeDiscoveryConfidence | undefined;
  evidence?: RuntimeDiscoveryEvidence[];
  conflicted?: boolean;
}

/** 从已关联实例与独立路径证据构建候选组 */
export function createRuntimeCandidateGroup(
  input: RuntimeCandidateInput
): RuntimePathCandidateGroup {
  const stateDir = normalize(input.stateDir);
  const openclawPath = normalize(
    input.openclawPath ?? join(stateDir, "openclaw.json")
  );
  const serviceEnvPath = input.serviceEnvPath
    ? normalize(input.serviceEnvPath)
    : undefined;
  const confidence = Object.hasOwn(input, "confidence")
    ? input.confidence
    : input.instance.confidence;
  return {
    candidateId: createRuntimeCandidateId(input.instance, stateDir, openclawPath),
    instanceId: input.instance.instanceId,
    stateDir,
    openclawPath,
    envPath: join(stateDir, ".env"),
    ...(serviceEnvPath ? { serviceEnvPath } : {}),
    ...(input.instance.serviceManager
      ? { serviceManager: input.instance.serviceManager }
      : {}),
    ...(input.instance.serviceId ? { serviceId: input.instance.serviceId } : {}),
    pid: input.instance.pid,
    ...(confidence ? { confidence } : {}),
    ...(input.conflicted ? { conflicted: true } : {}),
    evidence: input.evidence ?? input.instance.evidence
  };
}

export function deduplicateRuntimeCandidateGroups(
  candidates: RuntimePathCandidateGroup[]
): RuntimePathCandidateGroup[] {
  const merged = new Map<string, RuntimePathCandidateGroup>();
  const rank: Record<RuntimeDiscoveryConfidence, number> = {
    inferred: 1,
    strong: 2,
    confirmed: 3
  };
  for (const candidate of candidates) {
    const existing = merged.get(candidate.candidateId);
    if (!existing) {
      merged.set(candidate.candidateId, candidate);
      continue;
    }
    const actualPathConflict = (
      existing.stateDir !== candidate.stateDir ||
      existing.openclawPath !== candidate.openclawPath ||
      existing.envPath !== candidate.envPath ||
      (existing.serviceEnvPath !== undefined &&
        candidate.serviceEnvPath !== undefined &&
        existing.serviceEnvPath !== candidate.serviceEnvPath)
    );
    if (actualPathConflict) {
      const suffix = createHash("sha256")
        .update(candidate.serviceEnvPath ?? candidate.openclawPath)
        .digest("hex")
        .slice(0, 8);
      merged.set(`${candidate.candidateId}:${suffix}`, {
        ...candidate,
        candidateId: `${candidate.candidateId}:${suffix}`
      });
      continue;
    }
    const existingRank = existing.confidence ? rank[existing.confidence] : 0;
    const candidateRank = candidate.confidence ? rank[candidate.confidence] : 0;
    const confidence = candidateRank > existingRank
      ? candidate.confidence
      : existing.confidence;
    const conflicted = existing.conflicted || candidate.conflicted;
    const {
      confidence: _existingConfidence,
      conflicted: _existingConflict,
      ...existingMetadata
    } = existing;
    merged.set(candidate.candidateId, {
      ...existingMetadata,
      ...(existing.serviceEnvPath
        ? {}
        : candidate.serviceEnvPath
          ? { serviceEnvPath: candidate.serviceEnvPath }
          : {}),
      ...(existing.serviceManager
        ? {}
        : candidate.serviceManager
          ? { serviceManager: candidate.serviceManager }
          : {}),
      ...(existing.serviceId
        ? {}
        : candidate.serviceId
          ? { serviceId: candidate.serviceId }
          : {}),
      ...(!conflicted && confidence ? { confidence } : {}),
      ...(conflicted ? { conflicted: true } : {}),
      evidence: [...new Set([...existing.evidence, ...candidate.evidence])]
    });
  }
  return [...merged.values()];
}

export function omitRuntimeInstanceConfidence(
  instance: RunningOpenClawInstance
): RunningOpenClawInstance {
  const { confidence: _confidence, ...metadata } = instance;
  return metadata;
}

export function omitRuntimeCandidateConfidence(
  candidate: RuntimePathCandidateGroup
): RuntimePathCandidateGroup {
  const { confidence: _confidence, ...metadata } = candidate;
  return metadata;
}
