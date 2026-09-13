import { expect, test } from "bun:test";
import * as catalog from "../src/runtime-model-catalog";

test("异步探测并行执行并以 Gateway 选择器保留可见集合，不回显认证原文", async () => {
  const discover = (catalog as any).discoverRuntimeModelCatalogAsync;
  expect(typeof discover).toBe("function");
  let running = 0;
  let peak = 0;
  const result = await discover({ runCommand: async (_: string, args: string[]) => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 10));
    running--;
    const payload = args[0] === "--version" ? "OpenClaw 2026.9.3" : JSON.stringify(
      args[0] === "gateway" ? { models: [{ provider: "active", id: "one", available: true, apiKey: "SECRET" }] } :
      args[1] === "status" ? { allowed: ["active/one"], auth: { token: "SECRET" } } :
      { models: [{ key: "active/one", available: true }, { key: "idle/two", available: null }] }
    );
    return { status: 0, stdout: payload, timedOut: false };
  }});
  expect(peak).toBeGreaterThan(1);
  expect(result.pickerModels.map((row: any) => row.ref)).toEqual(["active/one"]);
  expect(result.pickerSource).toBe("gateway");
  expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("Gateway 失败保留 CLI 证据但明确标注推算，不能声称 IM 一致", async () => {
  const discover = (catalog as any).discoverRuntimeModelCatalogAsync;
  expect(typeof discover).toBe("function");
  const result = await discover({ runCommand: async (_: string, args: string[]) => ({
    status: args[0] === "gateway" ? 1 : 0,
    stdout: args[0] === "--version" ? "2026.9.3" : JSON.stringify({ allowed: [], models: [] }), timedOut: false
  }) });
  expect(result.pickerSource).toBe("inferred");
  expect(result.pickerModels).toBeUndefined();
  expect(result.diagnostics.some((d: any) => d.command === "picker")).toBe(true);
});

test("Gateway 属于其他配置或尚未应用当前配置时不能冒充所选配置的 IM 目录", async () => {
  for (const scope of [{ path: "/other/openclaw.json" }, { path: "/selected/openclaw.json", configRevisionHash: "new", appliedConfigHash: "old" }]) {
    const result = await catalog.discoverRuntimeModelCatalogAsync({ configPath: "/selected/openclaw.json", runCommand: async (_, args) => ({
      status: 0, timedOut: false,
      stdout: args[0] === "--version" ? "2026.9.3" : JSON.stringify(args.includes("config.get") ? scope : { models: [{ provider: "other", id: "one", key: "other/one", available: true }], allowed: [] })
    }) });
    expect(result.pickerSource).toBe("inferred");
    expect(result.pickerModels).toBeUndefined();
  }
});
