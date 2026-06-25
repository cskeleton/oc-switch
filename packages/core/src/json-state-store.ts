import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ReadJsonStateOptions<T> {
  stateDir: string;
  filename: string;
  fallback: () => T;
  normalize?: (value: unknown) => T;
}

export interface WriteJsonStateOptions<T> {
  stateDir: string;
  filename: string;
  value: T;
}

export function jsonStatePath(stateDir: string, filename: string): string {
  return join(stateDir, filename);
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // 尽力收紧权限，macOS/Linux 本地文件系统通常成功
  }
}

export function readJsonState<T>(options: ReadJsonStateOptions<T>): T {
  const path = jsonStatePath(options.stateDir, options.filename);
  if (!existsSync(path)) return options.fallback();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return options.normalize ? options.normalize(parsed) : (parsed as T);
  } catch {
    return options.fallback();
  }
}

export function writeJsonState<T>(options: WriteJsonStateOptions<T>): void {
  mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
  safeChmod(options.stateDir, 0o700);
  const path = jsonStatePath(options.stateDir, options.filename);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(options.value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, path);
    safeChmod(path, 0o600);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}
