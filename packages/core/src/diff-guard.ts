import type { OpenClawConfig } from "./types";

type Path = Array<string | number>;

function pathToString(path: Path): string {
  return path.join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAllowedPath(path: Path): boolean {
  if (path[0] === "models" && path[1] === "providers") {
    return true;
  }

  if (path[0] === "agents" && path[1] === "defaults" && path[2] === "model") {
    return true;
  }

  if (path[0] === "agents" && path[1] === "defaults" && path[2] === "models") {
    return true;
  }

  return false;
}

function collectChangedPaths(before: unknown, after: unknown, path: Path = []): Path[] {
  if (Object.is(before, after)) return [];

  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [path];
    return before.flatMap((item, index) => collectChangedPaths(item, after[index], [...path, index]));
  }

  if (Array.isArray(before) || Array.isArray(after)) return [path];

  if (!isRecord(before) && isRecord(after)) return collectChangedPaths({}, after, path);
  if (isRecord(before) && !isRecord(after)) return collectChangedPaths(before, {}, path);
  if (!isRecord(before) || !isRecord(after)) return [path];

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(keys).flatMap((key) => collectChangedPaths(before[key], after[key], [...path, key]));
}

export function assertAllowedSemanticChange(before: OpenClawConfig, after: OpenClawConfig): void {
  for (const path of collectChangedPaths(before, after)) {
    if (!isAllowedPath(path)) {
      throw new Error(`Diff guard blocked change to ${pathToString(path)}`);
    }
  }
}
