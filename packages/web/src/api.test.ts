import { describe, expect, test } from "bun:test";
import { createApiClient } from "./api";

describe("createApiClient", () => {
  test("sends bearer token and parses JSON", async () => {
    const calls: Request[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "secret",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true, providerCount: 0, providerModelCount: 0, allowlistModelCount: 0 }), {
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(await client.getStatus()).toEqual({
      ok: true,
      providerCount: 0,
      providerModelCount: 0,
      allowlistModelCount: 0
    });
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer secret");
  });
});
