import { describe, expect, test } from "bun:test";
import { restartGateway } from "../src/gateway-actions";
import type { GatewayRuntimeTarget } from "../src/gateway-runtime-target";

const sampleTarget: GatewayRuntimeTarget = {
  candidateId: "systemd:openclaw-gateway.service:aaa111",
  instanceId: "systemd:openclaw-gateway.service",
  envPath: "/home/user/.openclaw/.env",
  serviceEnvTarget: {
    targetKind: "systemd",
    targetPath: "/home/user/.openclaw/gateway.systemd.env",
    candidateId: "systemd:openclaw-gateway.service:aaa111"
  },
  restartEnv: {
    OPENCLAW_STATE_DIR: "/home/user/.openclaw",
    OPENCLAW_CONFIG_PATH: "/home/user/.openclaw/openclaw.json",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service"
  }
};

describe("restartGateway", () => {
  test("returns ok when executor exits with code 0", async () => {
    const result = await restartGateway({
      target: sampleTarget,
      executor: async () => ({ exitCode: 0, stderr: "" })
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("returns failure message when executor exits non-zero", async () => {
    const result = await restartGateway({
      target: sampleTarget,
      executor: async () => ({ exitCode: 1, stderr: "service not found" })
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("service not found");
  });

  test("only allows openclaw gateway restart and merges selector env", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    const result = await restartGateway({
      target: sampleTarget,
      executor: async (command, args, options) => {
        expect(command).toBe("openclaw");
        expect(args).toEqual(["gateway", "restart"]);
        seenEnv = options.env;
        return { exitCode: 0, stderr: "" };
      }
    });
    expect(result.ok).toBe(true);
    expect(seenEnv?.OPENCLAW_STATE_DIR).toBe("/home/user/.openclaw");
    expect(seenEnv?.OPENCLAW_CONFIG_PATH).toBe("/home/user/.openclaw/openclaw.json");
    expect(seenEnv?.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw-gateway.service");
    expect(seenEnv?.OPENCLAW_LAUNCHD_LABEL).toBeUndefined();
    // 不得把任意调用方 env 名混入；仅白名单 selector
    expect(Object.keys(sampleTarget.restartEnv).every((key) => key.startsWith("OPENCLAW_"))).toBe(true);
  });
});
