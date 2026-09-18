import { isModelPolicyEditError, isModelReconciliationError, isPluginStateError } from "@oc-switch/core";

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("must be");
}

export function jsonError(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  // JSON 解析和内部 TypeError 可能带原始输入，不能将其当业务错误回显。
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON input or configuration" }, 400);
  if (error instanceof TypeError) return c.json({ error: "Internal server error" }, 500);
  if (isModelReconciliationError(error) || isPluginStateError(error) || isModelPolicyEditError(error)) {
    // policy 过期编辑冲突是独立的 409（2026-09-16 spec §5），其余结构化 blocker 仍为 400；
    // Core 携带触发 ref 时结构化透出，供 UI 逐条标注（stale cleanup spec §4）
    const status = isModelPolicyEditError(error) && error.code === "policy-revision-conflict" ? 409 : 400;
    const details = isModelPolicyEditError(error) && error.refs !== undefined && error.refs.length > 0
      ? { details: { refs: error.refs } }
      : {};
    return c.json({ error: error.message, code: error.code, ...details }, status);
  }
  if (isValidationError(error)) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ error: "Internal server error" }, 500);
}
