import { generateToken, readPersistedToken, writePersistedToken } from "@oc-switch/core";
import type { Command } from "commander";
import { join } from "node:path";
import { repoRoot, type CommandContext } from "../command-context";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  clearServePid,
  defaultServeUrl,
  isOcSwitchServeProcess,
  isPortListening,
  openBrowser,
  readServePid,
  serveLogPath,
  spawnDetachedServe,
  stopServePid,
  waitForOwnedServe,
  writeServePid
} from "../serve-process";
import { webDistReady } from "../web-dist";

/** start 等待 HTTP 就绪的超时（毫秒） */
const START_WAIT_MS = 10_000;

export function registerLifecycleCommands(program: Command, context: CommandContext): void {
  program
    .command("start")
    .description("Start oc-switch Web GUI in background")
    .action(async () => {
      if (!webDistReady()) {
        console.error("Web GUI 不可用：请先在仓库根目录执行 bun run build");
        process.exit(1);
      }

      const paths = context.activePaths();
      const stateDir = paths.stateDir;
      const url = defaultServeUrl(DEFAULT_HOST, DEFAULT_PORT);

      const existingPid = readServePid(stateDir);
      if (existingPid !== undefined && isOcSwitchServeProcess(existingPid)) {
        console.log(`serve 已在运行: ${url}`);
        openBrowser(url);
        return;
      }

      // 存活但非 oc-switch serve，或进程已死：清陈旧 PID，不误杀
      if (existingPid !== undefined) {
        clearServePid(stateDir);
      }

      // 端口已被占用（如前台 serve）时拒绝启动，避免误连到他人服务
      if (await isPortListening(DEFAULT_HOST, DEFAULT_PORT)) {
        console.error(
          `端口 ${DEFAULT_PORT} 已被占用。请先停止占用进程，或使用前台 serve 的现有实例。`
        );
        process.exit(1);
      }

      if (!readPersistedToken(stateDir)) {
        writePersistedToken(stateDir, generateToken());
      }

      const cliEntry = join(repoRoot, "packages/cli/src/index.ts");
      const childPid = spawnDetachedServe({
        cliEntry,
        stateDir,
        host: DEFAULT_HOST,
        port: DEFAULT_PORT
      });
      writeServePid(stateDir, childPid);

      const ready = await waitForOwnedServe({
        url,
        pid: childPid,
        timeoutMs: START_WAIT_MS
      });
      if (ready !== "ready") {
        const logHint = serveLogPath(stateDir);
        if (ready === "exited") {
          console.error(`serve 子进程已退出（可能端口占用或启动失败），请查看 ${logHint}`);
        } else {
          console.error(`serve 启动超时（${START_WAIT_MS}ms），请查看 ${logHint}`);
        }
        await stopServePid(stateDir);
        process.exit(1);
      }

      console.log(`oc-switch Web GUI: ${url}`);
      openBrowser(url);
      console.log("使用已持久化的 API token 登录；若需轮换请执行 oc-switch token rotate");
    });

  program
    .command("stop")
    .description("Stop background oc-switch serve started by start")
    .action(async () => {
      const paths = context.activePaths();
      const result = await stopServePid(paths.stateDir);
      console.log(result.message);
    });
}
