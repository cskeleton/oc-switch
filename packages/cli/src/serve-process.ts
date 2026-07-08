import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/** 默认绑定地址 */
export const DEFAULT_HOST = "127.0.0.1";
/** 默认监听端口 */
export const DEFAULT_PORT = 7420;

const PID_FILENAME = "serve.pid";
const LOG_FILENAME = "serve.log";

/** serve.pid 文件路径 */
export function servePidPath(stateDir: string): string {
  return join(stateDir, PID_FILENAME);
}

/** serve.log 文件路径 */
export function serveLogPath(stateDir: string): string {
  return join(stateDir, LOG_FILENAME);
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // 尽力收紧权限
  }
}

/** 写入后台 serve 进程 PID（权限 0600） */
export function writeServePid(stateDir: string, pid: number): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  safeChmod(stateDir, 0o700);
  const path = servePidPath(stateDir);
  writeFileSync(path, `${pid}\n`, { mode: 0o600 });
  safeChmod(path, 0o600);
}

/** 读取 PID；文件不存在或内容无效时返回 undefined */
export function readServePid(stateDir: string): number | undefined {
  const path = servePidPath(stateDir);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

/** 删除 PID 文件（不存在时静默） */
export function clearServePid(stateDir: string): void {
  const path = servePidPath(stateDir);
  if (!existsSync(path)) return;
  rmSync(path, { force: true });
}

/** 检测进程是否存活（signal 0，不实际发送信号） */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断命令行是否像 oc-switch 后台 serve（与 spawnDetachedServe argv 对齐）。
 * 导出供单测直接覆盖，避免依赖真实进程。
 */
export function looksLikeOcSwitchServeCommand(commandLine: string): boolean {
  const normalized = commandLine.replace(/\s+/g, " ").trim();
  // bun run <...>/packages/cli/src/index.ts serve [--host ...]
  return /packages\/cli\/src\/index\.ts\s+serve(\s|$)/.test(normalized);
}

/** 读取进程命令行；失败返回 undefined */
export function readProcessCommandLine(pid: number): string | undefined {
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "args="], {
      stdout: "pipe",
      stderr: "pipe"
    });
    if (proc.exitCode !== 0) return undefined;
    const text = Buffer.from(proc.stdout).toString("utf8").trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 存活且命令行匹配 oc-switch serve */
export function isOcSwitchServeProcess(pid: number): boolean {
  if (!isPidAlive(pid)) return false;
  const args = readProcessCommandLine(pid);
  if (!args) return false;
  return looksLikeOcSwitchServeCommand(args);
}

/** TCP 探测端口是否已有进程在听 */
export function isPortListening(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** 构造默认 serve URL */
export function defaultServeUrl(host = DEFAULT_HOST, port = DEFAULT_PORT): string {
  return `http://${host}:${port}`;
}

/** 后台拉起 serve 子进程，stdout/stderr 追加到 serve.log */
export function spawnDetachedServe(opts: {
  cliEntry: string;
  stateDir: string;
  host?: string;
  port?: number;
}): number {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
  const logPath = serveLogPath(opts.stateDir);
  const logFd = openSync(logPath, "a");

  const child = Bun.spawn(
    ["bun", "run", opts.cliEntry, "serve", "--host", host, "--port", String(port)],
    {
      stdout: logFd,
      stderr: logFd,
      stdin: "ignore",
      detached: true
    }
  );
  child.unref();
  return child.pid;
}

const WAIT_POLL_MS = 100;

/** 轮询 HTTP 端点，连接成功或收到任意 HTTP 响应（含 401）视为就绪 */
export async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1000, timeoutMs)) });
      void response;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("401") || message.includes("Unauthorized")) {
        return true;
      }
    }
    await Bun.sleep(WAIT_POLL_MS);
  }
  return false;
}

/**
 * 等待「本进程拉起的」serve 就绪：子进程仍存活，且 HTTP 可连。
 * 子进程已退出 → exited（常见于端口占用导致 bind 失败）。
 */
export async function waitForOwnedServe(opts: {
  url: string;
  pid: number;
  timeoutMs: number;
}): Promise<"ready" | "exited" | "timeout"> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(opts.pid)) {
      return "exited";
    }
    try {
      const response = await fetch(opts.url, {
        signal: AbortSignal.timeout(Math.min(1000, opts.timeoutMs))
      });
      void response;
      if (isPidAlive(opts.pid)) {
        return "ready";
      }
      return "exited";
    } catch {
      // 继续轮询
    }
    await Bun.sleep(WAIT_POLL_MS);
  }
  return isPidAlive(opts.pid) ? "timeout" : "exited";
}

/** macOS 上用系统 open 打开浏览器 */
export function openBrowser(url: string): void {
  if (process.platform !== "darwin") return;
  const proc = Bun.spawn(["open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

const STOP_GRACE_MS = 1500;

/** 停止 start 记录的后台 serve 进程（仅杀命令行匹配的 oc-switch serve） */
export async function stopServePid(stateDir: string): Promise<{ stopped: boolean; message: string }> {
  const pidPath = servePidPath(stateDir);
  const hadPidFile = existsSync(pidPath);
  if (!hadPidFile) {
    return { stopped: false, message: "serve 未在运行" };
  }

  const pid = readServePid(stateDir);
  clearServePid(stateDir);

  if (pid === undefined) {
    return { stopped: false, message: "serve PID 文件无效，已清理" };
  }

  if (!isPidAlive(pid)) {
    return { stopped: false, message: "serve 进程已不存在，已清理陈旧 PID 文件" };
  }

  if (!isOcSwitchServeProcess(pid)) {
    return {
      stopped: false,
      message: `PID ${pid} 不是 oc-switch serve，已清理 PID 文件（未发送信号）`
    };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { stopped: false, message: `无法向 PID ${pid} 发送 SIGTERM` };
  }

  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline && isPidAlive(pid)) {
    await Bun.sleep(50);
  }

  if (isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return { stopped: false, message: `无法向 PID ${pid} 发送 SIGKILL` };
    }
    await Bun.sleep(50);
  }

  if (isPidAlive(pid)) {
    return { stopped: false, message: `PID ${pid} 仍在运行` };
  }

  return { stopped: true, message: "已停止 serve" };
}
