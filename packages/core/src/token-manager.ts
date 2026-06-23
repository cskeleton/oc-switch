import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = "token.json";

interface TokenFile {
  token: string;
}

/** 生成随机 Bearer token */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 读取持久化 token，不存在或无效时返回 undefined */
export function readPersistedToken(stateDir: string): string | undefined {
  const path = join(stateDir, TOKEN_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as TokenFile;
    return typeof data.token === "string" && data.token.length > 0 ? data.token : undefined;
  } catch {
    return undefined;
  }
}

/** 将 token 写入 stateDir/token.json，权限 0600 */
export function writePersistedToken(stateDir: string, token: string): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, TOKEN_FILE);
  writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 等平台可能不支持 chmod
  }
}

/** 轮换持久化 token 并返回新值 */
export function rotatePersistedToken(stateDir: string): string {
  const token = generateToken();
  writePersistedToken(stateDir, token);
  return token;
}

function isLocalhostHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isPublicBind(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

/**
 * 解析 serve 命令使用的 token：
 * - 显式 --token 优先
 * - 其次读取持久化 token
 * - localhost 可生成临时 token
 * - 0.0.0.0 无 token 时拒绝启动
 */
export function resolveServeToken(input: {
  host: string;
  token?: string;
  stateDir: string;
}): { token: string; ephemeral: boolean } {
  if (input.token) {
    return { token: input.token, ephemeral: false };
  }
  const persisted = readPersistedToken(input.stateDir);
  if (persisted) {
    return { token: persisted, ephemeral: false };
  }
  if (isPublicBind(input.host)) {
    throw new Error("Binding to 0.0.0.0 requires --token or a persisted token");
  }
  if (isLocalhostHost(input.host)) {
    return { token: generateToken(), ephemeral: true };
  }
  throw new Error(`Binding to ${input.host} requires --token or a persisted token`);
}
