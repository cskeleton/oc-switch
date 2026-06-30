import { describe, expect, test } from "bun:test";
import { restartGateway } from "../src/gateway-actions";

describe("restartGateway", () => {
  test("returns ok when executor exits with code 0", async () => {
    const result = await restartGateway({
      executor: async () => ({ exitCode: 0, stderr: "" })
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("returns failure message when executor exits non-zero", async () => {
    const result = await restartGateway({
      executor: async () => ({ exitCode: 1, stderr: "service not found" })
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("service not found");
  });

  test("rejects non-whitelisted commands at executor boundary", async () => {
    const result = await restartGateway({
      executor: async (command, args) => {
        expect(command).toBe("openclaw");
        expect(args).toEqual(["gateway", "restart"]);
        return { exitCode: 0, stderr: "" };
      }
    });
    expect(result.ok).toBe(true);
  });
});
