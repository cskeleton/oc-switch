import { spawn } from "node:child_process";
import type { RuntimeModelCommandResult } from "./runtime-model-catalog";

/** 有界、异步的只读目录命令；只返回 stdout，stderr 可能含凭据，直接丢弃。 */
export function runCatalogCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number },
  configPath?: string
): Promise<RuntimeModelCommandResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ...(configPath ? { OPENCLAW_CONFIG_PATH: configPath } : {}) }
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxOutputBytes) { overflow = true; child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.on("error", () => { clearTimeout(timer); resolve({ status: null, stdout: "", timedOut: false }); });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ status: overflow ? -1 : code, stdout: overflow ? "" : Buffer.concat(chunks).toString("utf8"), timedOut });
    });
  });
}
