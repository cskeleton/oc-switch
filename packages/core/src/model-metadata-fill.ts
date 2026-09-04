/**
 * Models.dev 元数据 → OpenClawModel 的 fill-empty 映射（纯函数）。
 * 只产出目标条目当前缺失且候选值合法的字段；绝不覆盖已有值（spec §6）。
 */
import type { NormalizedModelMetadata } from "./model-metadata-catalog";
import type { OpenClawModel } from "./types";

/** OpenClaw 已知的输入模态集合；目录中的其它模态（如 pdf）不写入 */
export const KNOWN_INPUT_MODES: readonly string[] = ["text", "image", "audio", "video"];

export interface MetadataFill {
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

/** 统计五项参数字段中当前缺失的项数（name 空串/空白视为缺失，input 空数组视为缺失） */
export function missingMetadataFieldCount(model: OpenClawModel): number {
  let missing = 0;
  if (typeof model.name !== "string" || !model.name.trim()) missing++;
  if (model.reasoning === undefined) missing++;
  if (model.contextWindow === undefined) missing++;
  if (model.maxTokens === undefined) missing++;
  if (!Array.isArray(model.input) || model.input.length === 0) missing++;
  return missing;
}

/** 计算可回填字段；无可填（全有值或候选全缺/非法）返回 undefined */
export function computeMetadataFill(
  model: OpenClawModel,
  metadata: NormalizedModelMetadata
): MetadataFill | undefined {
  const fill: MetadataFill = {};
  if ((typeof model.name !== "string" || !model.name.trim()) && typeof metadata.name === "string" && metadata.name.trim()) {
    fill.name = metadata.name;
  }
  if (model.reasoning === undefined && typeof metadata.reasoning === "boolean") {
    fill.reasoning = metadata.reasoning;
  }
  if (model.contextWindow === undefined && metadata.contextWindow !== undefined) {
    fill.contextWindow = metadata.contextWindow;
  }
  if (model.maxTokens === undefined && metadata.maxTokens !== undefined) {
    fill.maxTokens = metadata.maxTokens;
  }
  if ((!Array.isArray(model.input) || model.input.length === 0) && Array.isArray(metadata.input)) {
    const modes = metadata.input.filter((mode) => KNOWN_INPUT_MODES.includes(mode));
    if (modes.length > 0) fill.input = modes;
  }
  return Object.keys(fill).length > 0 ? fill : undefined;
}

/** 应用填充，返回新对象；不改原对象，未知键穿透保留 */
export function applyMetadataFill(model: OpenClawModel, fill: MetadataFill): OpenClawModel {
  return { ...model, ...fill };
}
