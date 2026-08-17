import { normalizeModelRefForIdentity } from "./model-ref";
import type { OpenClawConfig, OpenClawPrimaryModelObject } from "./types";

/**
 * `agents.defaults.model` 双形态归一层（唯一访问入口）。
 *
 * OpenClaw 允许该字段为字符串 ModelRef 或对象 `{ primary?, fallbacks? }`。
 * core 内禁止直接读写该字段：读取统一经 read*（trim + 校验、永不抛错），
 * 写入统一经 writePrimaryModelRef（形状守恒，绝不丢 fallbacks 与未知键）。
 */

/** 非 null、非数组 record 判断（数组也是 object，必须显式排除） */
function isPrimaryModelRecord(value: unknown): value is OpenClawPrimaryModelObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 不抛错的 ModelRef 归一器：trim 后按 oc-switch ModelRef 规则校验
 * （第一个 `/` 前后均非空），保留大小写与 model ID 内部斜杠。
 */
function normalizeRefValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return undefined;
  return trimmed;
}

/**
 * 归一读取主模型 ModelRef。
 * 缺失、空白、非法 ref、对象缺 primary、数组、数字、null 一律返回 undefined（读取路径永不抛错）。
 */
export function readPrimaryModelRef(config: OpenClawConfig): string | undefined {
  const value = config.agents?.defaults?.model;
  if (typeof value === "string") return normalizeRefValue(value);
  if (isPrimaryModelRecord(value)) return normalizeRefValue(value.primary);
  return undefined;
}

/**
 * 归一读取 fallback 回退链中的合法 ModelRef（保持顺序）。
 * 非法/空白条目不参与依赖保护；非数组/缺失/畸形形态返回空数组，且不修改原始配置。
 */
export function readFallbackModelRefs(config: OpenClawConfig): string[] {
  const value = config.agents?.defaults?.model;
  if (!isPrimaryModelRecord(value)) return [];
  const fallbacks = value.fallbacks;
  if (!Array.isArray(fallbacks)) return [];
  const refs: string[] = [];
  for (const entry of fallbacks) {
    const ref = normalizeRefValue(entry);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

/**
 * 形状守恒写入主模型：
 * - 当前值为非 null、非数组 record → 仅更新其 primary 键，保留 fallbacks 与未知键
 * - 当前值为字符串、缺失或非 record 畸形值 → 写纯字符串
 * string↔object 永不互转；仅用于显式 primary 写入，不做后台自动修复。
 */
export function writePrimaryModelRef(config: OpenClawConfig, ref: string): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  const current = config.agents.defaults.model;
  config.agents.defaults.model = isPrimaryModelRecord(current) ? { ...current, primary: ref } : ref;
}

/** 当前主模型归一 ref 是否等于给定 ref（两种形态等价比较；非法/缺失 primary 永不命中） */
export function isPrimaryModelRef(config: OpenClawConfig, ref: string): boolean {
  const primary = readPrimaryModelRef(config);
  const normalized = normalizeRefValue(ref);
  if (primary === undefined || normalized === undefined) return false;
  if (primary === normalized) return true;
  try {
    return normalizeModelRefForIdentity(primary) === normalizeModelRefForIdentity(normalized);
  } catch {
    return false;
  }
}
