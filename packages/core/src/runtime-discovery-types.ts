export type RuntimeDiscoveryConfidence = "confirmed" | "strong" | "inferred";

export type RuntimeDiscoveryStatus =
  | "resolved"
  | "gateway-detected-path-unresolved"
  | "gateway-not-detected"
  | "probe-failed";

export type RuntimeDiscoveryEvidence =
  | "process-cmdline"
  | "process-environ"
  | "systemd-unit"
  | "launchd-plist"
  | "cli-status"
  | "default-state-dir";

export type RuntimeDiscoveryDiagnosticCode =
  | "process-probe-failed"
  | "process-environ-denied"
  | "service-metadata-missing"
  | "service-pid-mismatch"
  | "service-args-invalid"
  | "user-id-unavailable"
  | "cli-status-timeout"
  | "cli-status-invalid"
  | "cli-status-output-too-large"
  | "path-evidence-conflict";

export interface RunningOpenClawInstance {
  instanceId: string;
  pid: number;
  openclawPath?: string;
  envPath?: string;
  stateDir?: string;
  serviceEnvPath?: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  confidence?: RuntimeDiscoveryConfidence;
  conflicted?: boolean;
  evidence: RuntimeDiscoveryEvidence[];
}

/** @deprecated 仅供旧版轻量进程探测兼容；生产路径解析应使用 RuntimeDiscoveryResult */
export interface LegacyRunningOpenClawInstance {
  pid: number;
  openclawPath?: string;
  envPath?: string;
}

export interface RuntimePathCandidateGroup {
  candidateId: string;
  instanceId: string;
  stateDir: string;
  openclawPath: string;
  envPath: string;
  serviceEnvPath?: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  pid: number;
  confidence?: RuntimeDiscoveryConfidence;
  conflicted?: boolean;
  evidence: RuntimeDiscoveryEvidence[];
}

export interface RuntimeDiscoveryResult {
  status: RuntimeDiscoveryStatus;
  instances: RunningOpenClawInstance[];
  candidateGroups: RuntimePathCandidateGroup[];
  diagnostics: RuntimeDiscoveryDiagnosticCode[];
}

export type RuntimeDiscoveryProvider = () => RuntimeDiscoveryResult;

export interface GatewayProcess {
  pid: number;
  argv: string[];
}

export interface RuntimeCommandResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
  outputTooLarge?: boolean;
}

export interface RuntimeDiscoveryDependencies {
  platform: NodeJS.Platform;
  homeDir: string;
  userId: number | undefined;
  listGatewayProcesses: () => GatewayProcess[];
  readTextFile: (path: string) => string;
  listDirectory: (path: string) => string[];
  runCommand: (
    command: string,
    args: string[],
    options: { timeoutMs: number; maxOutputBytes: number }
  ) => RuntimeCommandResult;
  pathExists: (path: string) => boolean;
}
