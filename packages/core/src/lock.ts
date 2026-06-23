import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    throw new Error("Another oc-switch write is already running");
  }

  try {
    writeFileSync(fd, `${process.pid}\n`);
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}
