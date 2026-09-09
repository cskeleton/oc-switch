/**
 * 跨机同步的 SSH 远端执行器。
 *
 * 接口注入式（仿 PluginCatalogDependencies.runCommand），默认实现走系统 ssh；
 * 测试用 PATH 前置的假 ssh stub 替换进程级依赖，不需要 mock 本模块。
 */

export interface RemoteRunInput {
  host: string;
  command: string;
  stdin?: string;
  timeoutMs: number;
}

export interface RemoteRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type SyncRemoteExecutor = (input: RemoteRunInput) => Promise<RemoteRunResult>;

const DEFAULT_TIMEOUT_MS = 30_000;

/** 单引号 shell 转义 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 组装远端命令。非交互 ssh 的 PATH 通常不含用户级 bin（bun/oc-switch 常在
 * ~/.bun/bin、~/bin），须显式前置；远端 CLI 命令名可用 OC_SWITCH_REMOTE_CLI
 * 覆盖（本地 launcher 布局差异或测试）；--path 映射为远端进程的 OPENCLAW_CONFIG_PATH。
 */
export function buildRemoteCommand(agentArgs: string[], options: { openclawPath?: string } = {}): string {
  const cli = process.env.OC_SWITCH_REMOTE_CLI?.trim() || "oc-switch";
  const pathExport = 'export PATH="$HOME/.bun/bin:$HOME/bin:$HOME/.npm-global/bin:$PATH"';
  const envPrefix = options.openclawPath ? `OPENCLAW_CONFIG_PATH=${shellQuote(options.openclawPath)} ` : "";
  return `${pathExport}; ${envPrefix}${cli} ${agentArgs.map(shellQuote).join(" ")}`;
}

/** 默认执行器：ssh 非交互模式（BatchMode 免密失败即报错，不挂起等密码输入） */
export const sshRemoteExecutor: SyncRemoteExecutor = async ({ host, command, stdin, timeoutMs }) => {
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, command], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe"
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  if (stdin !== undefined) {
    const sink = proc.stdin;
    if (typeof sink === "object" && sink !== null && "write" in sink) {
      await sink.write(stdin);
      sink.end();
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [status, stdout, stderr] = await Promise.all([proc.exited, stdoutPromise, stderrPromise]);
    return { status, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

export interface RunSyncAgentOptions {
  /** 序列化为 JSON 走 stdin（sync-agent check/write/env-upsert 的入参） */
  input?: unknown;
  /** --path 透传：远端进程的 OPENCLAW_CONFIG_PATH */
  openclawPath?: string;
  executor?: SyncRemoteExecutor;
  timeoutMs?: number;
}

/**
 * 调用远端 `oc-switch sync-agent <args>` 并解析其 stdout JSON。
 * 非零退出 / 超时 / JSON 解析失败一律抛出带 stderr 摘要的明确错误；
 * 解析失败时不引用 stdout 内容（协议破坏时其中可能含 config 明文密钥）。
 */
export async function runSyncAgent<T>(host: string, agentArgs: string[], options: RunSyncAgentOptions = {}): Promise<T> {
  const executor = options.executor ?? sshRemoteExecutor;
  const command = buildRemoteCommand(["sync-agent", ...agentArgs], {
    ...(options.openclawPath ? { openclawPath: options.openclawPath } : {})
  });
  const result = await executor({
    host,
    command,
    ...(options.input !== undefined ? { stdin: JSON.stringify(options.input) } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });
  const label = `sync-agent ${agentArgs.join(" ")}`;
  if (result.timedOut) {
    throw new Error(`远端命令超时（${host}: ${label}）`);
  }
  if (result.status !== 0) {
    const excerpt = result.stderr.trim().split("\n").slice(-5).join("\n");
    throw new Error(`远端 ${label} 失败（exit ${result.status}）${excerpt ? `：${excerpt}` : ""}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`远端 ${label} 返回了无法解析的 JSON（stdout ${result.stdout.length} 字节，内容不予显示）`);
  }
}
