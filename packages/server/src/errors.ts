function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("must be");
}

export function jsonError(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  if (isValidationError(error)) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ error: "Internal server error" }, 500);
}
