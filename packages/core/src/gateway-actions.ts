import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ALLOWED_COMMAND = "openclaw";
const ALLOWED_ARGS = ["gateway", "restart"] as const;
const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_LIMIT = 2000;

export interface GatewayRestartResult {
  ok: boolean;
  exitCode: number | null;
  message: string;
}

export type GatewayRestartExecutor = (
  command: string,
  args: string[],
  options: { timeoutMs: number }
) => Promise<{ exitCode: number | null; stderr: string }>;

/** serve 进程 PATH 常不含 ~/.npm-global/bin，补全常见 OpenClaw 安装路径 */
function gatewayRestartEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const prefix = [
    join(home, ".npm-global/bin"),
    join(home, ".bun/bin"),
    join(home, ".local/bin"),
    "/usr/local/bin"
  ].join(":");
  const path = process.env.PATH ? `${prefix}:${process.env.PATH}` : prefix;
  return { ...process.env, PATH: path };
}

function defaultExecutor(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: gatewayRestartEnv()
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`gateway restart timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stderr });
    });
  });
}

function assertAllowedRestart(command: string, args: string[]): void {
  if (command !== ALLOWED_COMMAND) {
    throw new Error(`unsupported gateway command: ${command}`);
  }
  if (args.length !== ALLOWED_ARGS.length || args.some((arg, index) => arg !== ALLOWED_ARGS[index])) {
    throw new Error("only openclaw gateway restart is allowed");
  }
}

/** 执行白名单内的 Gateway 重启命令 */
export async function restartGateway(input?: {
  executor?: GatewayRestartExecutor;
  timeoutMs?: number;
}): Promise<GatewayRestartResult> {
  const command = ALLOWED_COMMAND;
  const args = [...ALLOWED_ARGS];
  assertAllowedRestart(command, args);

  const executor = input?.executor ?? defaultExecutor;
  const timeoutMs = input?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const { exitCode, stderr } = await executor(command, args, { timeoutMs });
    const ok = exitCode === 0;
    return {
      ok,
      exitCode,
      message: ok ? "Gateway restarted" : (stderr.trim() || `gateway restart failed with exit code ${exitCode}`)
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: null,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
