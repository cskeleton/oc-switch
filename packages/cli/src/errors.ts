/** 解析/内部异常可能包含原始配置或 auth 内容；只输出安全失败类别，不打印堆栈。 */
export function commandErrorMessage(error: unknown): string {
  if (error instanceof SyntaxError) return "Invalid JSON input or configuration";
  if (error instanceof TypeError) return "Internal command error";
  return error instanceof Error ? error.message : "Command failed";
}
