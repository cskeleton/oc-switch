import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ReadJsonStateOptions<T> {
  stateDir: string;
  filename: string;
  fallback: () => T;
  normalize?: (value: unknown) => T;
  /** 仅约束「文件可读但 JSON 坏 / normalize 失败」；文件不可读（EACCES 等）任何模式下都抛出 */
  invalidJson?: "fallback" | "throw";
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
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // 区分「不存在」与「不可读」：ENOENT（含存在性检查后的竞态删除）仍是正常空状态；
    // EACCES 等 I/O 失败对任何状态用途都不是缺省值，抛出以免静默回退制造伪事实。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return options.fallback();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (options.invalidJson === "throw") throw error;
    return options.fallback();
  }
  try {
    return options.normalize ? options.normalize(parsed) : (parsed as T);
  } catch (error) {
    if (options.invalidJson === "throw") throw error;
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
