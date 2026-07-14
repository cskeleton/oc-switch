import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_LAUNCHD_LABEL = "ai.openclaw.gateway";

/** 在测试 HOME 下安装 LaunchAgent fixture，使 macOS 同步指向指定 gateway env 文件 */
export function installLaunchdGatewayFixture(homeDir: string, serviceEnvPath: string): void {
  const launchAgentsDir = join(homeDir, "Library/LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(dirname(serviceEnvPath), { recursive: true });
  // 与共享 LaunchAgent parser 一致：wrapper 与 env 同属 service-env
  const wrapperPath = join(dirname(serviceEnvPath), "ai.openclaw.gateway-env-wrapper.sh");
  writeFileSync(wrapperPath, "#!/bin/sh\n");
  const nodePath = "/usr/bin/node";
  const openclawEntry = "/opt/homebrew/lib/node_modules/openclaw/dist/index.js";
  const plistPath = join(launchAgentsDir, `${DEFAULT_LAUNCHD_LABEL}.plist`);
  writeFileSync(plistPath, [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/sh</string>",
    `    <string>${wrapperPath}</string>`,
    `    <string>${serviceEnvPath}</string>`,
    `    <string>${nodePath}</string>`,
    `    <string>${openclawEntry}</string>`,
    "    <string>gateway</string>",
    "  </array>",
    "</dict>",
    "</plist>"
  ].join("\n"));
}

/** 当前平台测试期望的 gateway env 文件路径 */
export function expectedGatewayEnvPath(dir: string): string {
  if (process.platform === "darwin") {
    return join(dir, "service-env", "ai.openclaw.gateway.env");
  }
  return join(dir, "gateway.systemd.env");
}

/** 为测试准备 gateway env 目标：Linux 用同目录文件；macOS 安装 LaunchAgent fixture */
export function prepareGatewayEnvTarget(dir: string, homeDir: string): string {
  if (process.platform === "darwin") {
    const serviceEnvPath = join(dir, "service-env", "ai.openclaw.gateway.env");
    mkdirSync(dirname(serviceEnvPath), { recursive: true });
    installLaunchdGatewayFixture(homeDir, serviceEnvPath);
    return serviceEnvPath;
  }
  return join(dir, "gateway.systemd.env");
}

/** 在测试期间临时覆盖 HOME，确保 gateway sync 不触碰真实 LaunchAgent 目标 */
export function withTestHome<T>(homeDir: string, run: () => T): T {
  const previous = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

export async function withTestHomeAsync<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}
