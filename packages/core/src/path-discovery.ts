import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { RunningOpenClawInstance } from "./paths";

export interface DiscoverRunningInstancesOptions {
  /** 测试注入：替代 pgrep 探测 */
  probe?: () => string;
}

function deriveEnvPath(openclawPath: string): string {
  return join(dirname(openclawPath), ".env");
}

function parsePgrepLine(line: string): RunningOpenClawInstance | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)\s+(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  const pid = Number(match[1]);
  if (!Number.isFinite(pid)) return null;
  const command = match[2];

  const flagMatch = command.match(/--config[=\s]+(\S+)/);
  const pathMatch = command.match(/(\S+openclaw\.json)/);
  const openclawPath = flagMatch?.[1] ?? pathMatch?.[1];
  if (!openclawPath) return { pid };

  return {
    pid,
    openclawPath,
    envPath: deriveEnvPath(openclawPath)
  };
}

function defaultProbe(): string {
  const result = spawnSync("pgrep", ["-fl", "openclaw"], { encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) return "";
  return result.stdout ?? "";
}

/** 轻量探测运行中的 OpenClaw 实例；失败时返回空数组 */
export function discoverRunningOpenClawInstances(options: DiscoverRunningInstancesOptions = {}): RunningOpenClawInstance[] {
  try {
    const output = (options.probe ?? defaultProbe)();
    const instances: RunningOpenClawInstance[] = [];
    const seen = new Set<number>();
    for (const line of output.split(/\n/)) {
      const parsed = parsePgrepLine(line);
      if (!parsed?.openclawPath || seen.has(parsed.pid)) continue;
      seen.add(parsed.pid);
      instances.push(parsed);
    }
    return instances;
  } catch {
    return [];
  }
}
