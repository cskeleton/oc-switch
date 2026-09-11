import { isModelReconciliationError, isPluginStateError } from "@oc-switch/core";

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("must be");
}

export function jsonError(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  // JSON 解析和内部 TypeError 可能带原始输入，不能将其当业务错误回显。
  if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON input or configuration" }, 400);
  if (error instanceof TypeError) return c.json({ error: "Internal server error" }, 500);
  if (isModelReconciliationError(error) || isPluginStateError(error)) {
    return c.json({ error: error.message, code: error.code }, 400);
  }
  if (isValidationError(error)) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ error: "Internal server error" }, 500);
}
