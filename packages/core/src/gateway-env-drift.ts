import { normalize } from "node:path";
import {
  readGatewaySystemdEnv,
  readLaunchdServiceEnv,
  readManagedBlockEntries,
  type GatewayServiceEnvTarget
} from "./gateway-service-env-sync";
import type { GatewayRuntimeTargetErrorCode } from "./gateway-runtime-target";
import type { OcSwitchPaths } from "./paths";
import type { RuntimeDiscoveryResult } from "./runtime-discovery-types";

// 与 gateway-service-env-sync 的托管块标记保持一致（该文件未导出这两个常量）
const MANAGED_BLOCK_START = "# oc-switch:start";
const MANAGED_BLOCK_END = "# oc-switch:end";

export type GatewayEnvDriftState =
  | "equal"
  | "missing-in-service"
  | "different"
  | "extra-in-service"
  | "outside-conflict";

export type GatewayEnvDriftSeverity = "blocking" | "warning" | "info";

export type GatewayEnvDriftUnsyncable = "empty-value" | "multiline-value";

export interface GatewayEnvDriftEntry {
  envVar: string;
  state: GatewayEnvDriftState;
  severity: GatewayEnvDriftSeverity;
  /** 源托管块值无法经 sync 同步（空值 / 多行值，与 assertServiceFriendlyValue 拒绝语义一致） */
  unsyncable?: GatewayEnvDriftUnsyncable;
}

export interface GatewayEnvDriftTarget {
  candidateId: string;
  targetKind: "systemd" | "launchd";
  serviceEnvPath: string;
}

export interface GatewayEnvDriftSummary {
  checked: number;
  equal: number;
  missingInService: number;
  different: number;
  extraInService: number;
  outsideConflict: number;
  unsyncable: number;
}

export interface GatewayEnvDriftUnavailableCandidate {
  candidateId: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  serviceEnvPath?: string;
}

/**
 * 文件级分叉报告：只含变量名与状态枚举，绝不包含任何 env value。
 * 进程 env 固定于启动时，报告不代表运行中进程的实际环境，修复需 sync-env / apply 并重启。
 */
export interface GatewayEnvDriftReport {
  version: 1;
  status: "ok" | "unavailable";
  target?: GatewayEnvDriftTarget;
  entries: GatewayEnvDriftEntry[];
  summary: GatewayEnvDriftSummary;
  warnings: string[];
  unavailable?: {
    code: GatewayRuntimeTargetErrorCode | "service-env-unreadable";
    message: string;
    candidates?: GatewayEnvDriftUnavailableCandidate[];
  };
}

const SEVERITY_RANK: Record<GatewayEnvDriftSeverity, number> = { blocking: 0, warning: 1, info: 2 };

/** 与 assertServiceFriendlyValue 的拒绝条件保持一致 */
function unsyncableReason(value: string): GatewayEnvDriftUnsyncable | undefined {
  if (value.includes("\n") || value.includes("\r")) return "multiline-value";
  if (value.length === 0) return "empty-value";
  return undefined;
}

/** 收集目标文件中托管块外出现的 key（systemd：全文减托管块；launchd：块外 export 行） */
function readOutsideManagedKeys(content: string): Set<string> {
  const lines = content.length ? content.split(/\n/) : [];
  const startIndex = lines.indexOf(MANAGED_BLOCK_START);
  const endIndex = lines.indexOf(MANAGED_BLOCK_END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const keys = new Set<string>();
  lines.forEach((line, index) => {
    const insideBlock = hasBlock && index > startIndex && index < endIndex;
    if (insideBlock) return;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match?.[1]) keys.add(match[1]);
  });
  return keys;
}

/**
 * 纯函数：比较源 .env 托管块与 Gateway service env 快照（文件级，不探测运行中进程）。
 * serviceEnvContent 为 null 表示目标文件不存在，按全部 missing-in-service 计算。
 * 文件读取与目标解析由调用方负责；本函数不向输出写入任何值。
 */
export function inspectGatewayEnvDrift(input: {
  envContent: string;
  target: GatewayServiceEnvTarget;
  serviceEnvContent: string | null;
}): GatewayEnvDriftReport {
  const sourceManaged = readManagedBlockEntries(input.envContent);
  const warnings: string[] = [];
  const entries: GatewayEnvDriftEntry[] = [];

  let targetAll: Record<string, string> = {};
  let targetManaged: Record<string, string> = {};
  let outsideKeys = new Set<string>();
  if (input.serviceEnvContent !== null) {
    targetManaged = readManagedBlockEntries(input.serviceEnvContent);
    outsideKeys = readOutsideManagedKeys(input.serviceEnvContent);
    targetAll = input.target.targetKind === "launchd"
      ? { ...readLaunchdServiceEnv(input.serviceEnvContent), ...targetManaged }
      : readGatewaySystemdEnv(input.serviceEnvContent);
  } else {
    warnings.push(
      `Gateway service env file not found at ${input.target.targetPath}; all managed keys reported as missing-in-service`
    );
  }

  for (const [key, value] of Object.entries(sourceManaged)) {
    const unsyncable = unsyncableReason(value);
    let state: GatewayEnvDriftState;
    if (input.serviceEnvContent === null) {
      state = "missing-in-service";
    } else if (targetManaged[key] !== undefined && outsideKeys.has(key)) {
      // 同名 key 同时在托管块内外：托管块由 sync 追加在文件末尾，运行时块内值生效，块外属残留
      state = "outside-conflict";
    } else {
      // 仅块外存在的同名 key 没有块内条目压制，其值实际生效，必须落入值比较（不同即 different/blocking）
      const serviceValue = targetAll[key];
      // 快照空值视为 different（快照旧值/空值会覆盖 .env，进程加载它），与三态比较原语语义一致
      state = serviceValue !== undefined
        && serviceValue.trim().length > 0
        && serviceValue === value
        ? "equal"
        : "different";
      if (serviceValue === undefined) state = "missing-in-service";
    }
    const severity: GatewayEnvDriftSeverity =
      state === "different" ? "blocking"
        : state === "outside-conflict" || unsyncable ? "warning"
          : "info";
    entries.push({ envVar: key, state, severity, ...(unsyncable ? { unsyncable } : {}) });
  }

  // extra 只统计目标托管块内的残留；systemd 块外服务元变量、launchd 块外 export 属合法块外内容
  if (input.serviceEnvContent !== null) {
    for (const key of Object.keys(targetManaged)) {
      if (sourceManaged[key] !== undefined) continue;
      entries.push({ envVar: key, state: "extra-in-service", severity: "warning" });
    }
  }

  entries.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.envVar.localeCompare(b.envVar)
  );

  const count = (state: GatewayEnvDriftState) => entries.filter((entry) => entry.state === state).length;
  return {
    version: 1,
    status: "ok",
    target: {
      candidateId: input.target.candidateId ?? "",
      targetKind: input.target.targetKind,
      serviceEnvPath: input.target.targetPath
    },
    entries,
    summary: {
      checked: entries.length,
      equal: count("equal"),
      missingInService: count("missing-in-service"),
      different: count("different"),
      extraInService: count("extra-in-service"),
      outsideConflict: count("outside-conflict"),
      unsyncable: entries.filter((entry) => entry.unsyncable !== undefined).length
    },
    warnings
  };
}

/** 目标解析或读取失败时构造 unavailable 报告（恒为 200 的读报告语义） */
export function unavailableGatewayEnvDriftReport(input: {
  code: GatewayRuntimeTargetErrorCode | "service-env-unreadable";
  message: string;
  candidates?: GatewayEnvDriftUnavailableCandidate[];
}): GatewayEnvDriftReport {
  return {
    version: 1,
    status: "unavailable",
    entries: [],
    summary: {
      checked: 0,
      equal: 0,
      missingInService: 0,
      different: 0,
      extraInService: 0,
      outsideConflict: 0,
      unsyncable: 0
    },
    warnings: [],
    unavailable: {
      code: input.code,
      message: input.message,
      ...(input.candidates ? { candidates: input.candidates } : {})
    }
  };
}

/**
 * 歧义时列出可带 candidateId 重试的候选组：
 * 仅含 active 路径匹配且带非空 serviceEnvPath 的组（与 resolveGatewayRuntimeTarget automatic 的歧义集一致），不猜测其一。
 */
export function listAmbiguousGatewayEnvDriftCandidates(
  activePaths: Pick<OcSwitchPaths, "openclawPath" | "envPath">,
  discovery: RuntimeDiscoveryResult
): GatewayEnvDriftUnavailableCandidate[] {
  const samePath = (left: string, right: string) => normalize(left) === normalize(right);
  return discovery.candidateGroups
    .filter((group) =>
      Boolean(group.serviceEnvPath?.trim())
      && samePath(group.openclawPath, activePaths.openclawPath)
      && samePath(group.envPath, activePaths.envPath))
    .map((group) => ({
      candidateId: group.candidateId,
      ...(group.serviceManager ? { serviceManager: group.serviceManager } : {}),
      ...(group.serviceId ? { serviceId: group.serviceId } : {}),
      ...(group.serviceEnvPath ? { serviceEnvPath: group.serviceEnvPath } : {})
    }));
}
