import { describe, expect, test } from "bun:test";
import { discoverRuntimeModelCatalog } from "../src/runtime-model-catalog";
import type { RuntimeModelCatalogDependencies, RuntimeModelCommandResult } from "../src/runtime-model-catalog";

/** 用 fixture map 构造按「完整命令串」分发的假 runner，返回确定性输出。 */
function fakeRunner(
  outputs: Record<string, { status: number | null; stdout?: string; timedOut?: boolean }>,
  fallback: { status: number | null; stdout?: string; timedOut?: boolean } = { status: 0, stdout: "", timedOut: false }
) {
  const calls: { command: string; args: string[]; options: { timeoutMs: number; maxOutputBytes: number } }[] = [];
  const runCommand: RuntimeModelCatalogDependencies["runCommand"] = (command, args, options) => {
    calls.push({ command, args, options });
    // fixture key 用 args 串（如 "models status --json"），不含 "openclaw" 前缀
    const hit = outputs[args.join(" ")] ?? outputs[[command, ...args].join(" ")] ?? fallback;
    return { status: hit.status, stdout: hit.stdout ?? "", timedOut: hit.timedOut ?? false };
  };
  return { runCommand, calls };
}

const healthyOutputs = {
  "--version": { status: 0, stdout: "OpenClaw 2026.9.3 (abc)" },
  "models status --json": {
    status: 0,
    stdout: JSON.stringify({
      agentDir: "/tmp/agent",
      defaultModel: "cpa/main",
      fallbacks: ["cpa/fallback"],
      allowed: ["cpa/main", "ghost/missing"],
      // auth 内容包含敏感值，parser 必须丢弃，不得透传到 snapshot
      auth: { providers: [{ provider: "ghost", effective: { detail: "SECRET" } }] }
    })
  },
  "models list --json": {
    status: 0,
    stdout: JSON.stringify({ models: [{ key: "cpa/main", name: "Main", available: true, missing: false, tags: ["configured"] }] })
  },
  "models list --all --json": {
    status: 0,
    stdout: JSON.stringify({ models: [{ key: "cpa/main", name: "Main", available: true, missing: false, tags: ["configured"] }] })
  }
};

describe("discoverRuntimeModelCatalog（成功路径）", () => {
  test("解析三份确定性 JSON，只保留必要字段并脱敏 auth", () => {
    const snapshot = discoverRuntimeModelCatalog({ runCommand: fakeRunner(healthyOutputs).runCommand });

    expect(snapshot.openClawVersion).toBe("OpenClaw 2026.9.3 (abc)");
    expect(snapshot.agentDir).toBe("/tmp/agent");
    expect(snapshot.defaultModel).toBe("cpa/main");
    expect(snapshot.fallbackRefs).toEqual(["cpa/fallback"]);
    expect(snapshot.allowedRefs).toEqual(["cpa/main", "ghost/missing"]);
    expect(snapshot.configuredModels).toEqual([
      { ref: "cpa/main", name: "Main", available: true, missing: false, tags: ["configured"] }
    ]);
    expect(snapshot.allModels).toEqual([
      { ref: "cpa/main", name: "Main", available: true, missing: false, tags: ["configured"] }
    ]);
    expect(snapshot.completeness).toEqual({ status: true, configuredList: true, allList: true });
    expect(snapshot.diagnostics).toEqual([]);
    // auth 原文（含密钥）绝不出现在序列化 snapshot 中
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
    // capturedAt 是 ISO 时间戳（精确值由注入 now() 的用例锁定）
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("capturedAt 走注入的 now()", () => {
    const fixed = new Date("2026-09-09T00:00:00.000Z");
    // 不依赖默认 runner：注入最小 stub，避免测试 shell-out 到真实 openclaw
    const snapshot = discoverRuntimeModelCatalog({ runCommand: () => ({ status: 1, stdout: "", timedOut: false }), now: () => fixed });
    expect(snapshot.capturedAt).toBe(fixed.toISOString());
  });

  test("命令走白名单且带 8s 超时与 1 MiB 输出上限", () => {
    const { runCommand, calls } = fakeRunner(healthyOutputs);
    discoverRuntimeModelCatalog({ runCommand });
    expect(calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "openclaw --version",
      "openclaw models status --json",
      "openclaw models list --json",
      "openclaw models list --all --json"
    ]);
    for (const call of calls) {
      expect(call.command).toBe("openclaw");
      expect(call.options.timeoutMs).toBe(8_000);
      expect(call.options.maxOutputBytes).toBe(1_048_576);
    }
  });
});

describe("discoverRuntimeModelCatalog（失败矩阵）", () => {
  test("命令缺失（ENOENT：status null 且非超时）→ code=missing，对应 completeness 为 false", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: () => ({ status: null, stdout: "", timedOut: false })
    });
    expect(snapshot.completeness).toEqual({ status: false, configuredList: false, allList: false });
    expect(snapshot.diagnostics.map(({ command, code }) => ({ command, code }))).toEqual([
      { command: "version", code: "missing" },
      { command: "status", code: "missing" },
      { command: "list", code: "missing" },
      { command: "list-all", code: "missing" }
    ]);
  });

  test("超时 → code=timeout，不抛错", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: () => ({ status: null, stdout: "", timedOut: true })
    });
    expect(snapshot.completeness).toEqual({ status: false, configuredList: false, allList: false });
    expect(snapshot.diagnostics.map(({ command, code }) => ({ command, code }))).toEqual([
      { command: "version", code: "timeout" },
      { command: "status", code: "timeout" },
      { command: "list", code: "timeout" },
      { command: "list-all", code: "timeout" }
    ]);
  });

  test("非零退出 → code=non-zero-exit，diagnostics 记录数值退出码而非 stdout/stderr 原文", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: () => ({ status: 2, stdout: "boom: SECRET", timedOut: false })
    });
    expect(snapshot.completeness).toEqual({ status: false, configuredList: false, allList: false });
    for (const diagnostic of snapshot.diagnostics) {
      expect(diagnostic.code).toBe("non-zero-exit");
      expect(diagnostic.message).toContain("exited with status 2");
    }
    // diagnostics 绝不含命令输出原文（可能带密钥）
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain("SECRET");
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain("boom");
  });

  test("invalid JSON → code=invalid-json", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        "--version": { status: 0, stdout: "OpenClaw 2026.9.3 (abc)" },
        "models status --json": { status: 0, stdout: "not json", timedOut: false },
        "models list --json": { status: 0, stdout: "{ broken", timedOut: false },
        "models list --all --json": { status: 0, stdout: "[]", timedOut: false }
      }).runCommand
    });
    // `[]` 能 JSON.parse 但缺 models 数组 → invalid-shape 而非 invalid-json
    expect(snapshot.diagnostics.map(({ command, code }) => ({ command, code }))).toEqual([
      { command: "status", code: "invalid-json" },
      { command: "list", code: "invalid-json" },
      { command: "list-all", code: "invalid-shape" }
    ]);
    expect(snapshot.openClawVersion).toBe("OpenClaw 2026.9.3 (abc)");
    expect(snapshot.completeness).toEqual({ status: false, configuredList: false, allList: false });
  });

  test("status 缺 allowed 必需字段 → code=invalid-shape，其余字段与成功来源保留", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        ...healthyOutputs,
        "models status --json": {
          status: 0,
          stdout: JSON.stringify({ agentDir: "/tmp/agent", defaultModel: "cpa/main", fallbacks: ["cpa/fallback"] }),
          timedOut: false
        }
      }).runCommand
    });
    expect(snapshot.completeness.status).toBe(false);
    expect(snapshot.allowedRefs).toEqual([]);
    // agentDir/defaultModel/fallbacks 与其余两个 list 仍保留（部分成功）
    expect(snapshot.agentDir).toBe("/tmp/agent");
    expect(snapshot.defaultModel).toBe("cpa/main");
    expect(snapshot.fallbackRefs).toEqual(["cpa/fallback"]);
    expect(snapshot.completeness.configuredList).toBe(true);
    expect(snapshot.completeness.allList).toBe(true);
    expect(snapshot.diagnostics.map(({ command, code }) => ({ command, code }))).toEqual([
      { command: "status", code: "invalid-shape" }
    ]);
  });

  test("list 缺 models 必需字段 → code=invalid-shape，completeness.configuredList 为 false，allowed 保留", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        ...healthyOutputs,
        "models list --json": { status: 0, stdout: JSON.stringify({ total: 3 }), timedOut: false }
      }).runCommand
    });
    expect(snapshot.completeness).toEqual({ status: true, configuredList: false, allList: true });
    expect(snapshot.allowedRefs).toEqual(["cpa/main", "ghost/missing"]);
    expect(snapshot.configuredModels).toEqual([]);
    expect(snapshot.allModels).toHaveLength(1);
    expect(snapshot.diagnostics.map(({ command, code }) => ({ command, code }))).toEqual([
      { command: "list", code: "invalid-shape" }
    ]);
  });

  test("非字符串 ref 被过滤并标记来源不完整", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        ...healthyOutputs,
        "models status --json": {
          status: 0,
          stdout: JSON.stringify({
            allowed: ["cpa/main", 42, null, "ghost/missing", "cpa/main"],
            fallbacks: ["cpa/fallback", { nested: true }]
          }),
          timedOut: false
        },
        "models list --json": {
          status: 0,
          stdout: JSON.stringify({
            models: [
              { key: "cpa/main", tags: ["configured"] },
              { key: 99, tags: [] },
              { key: null, tags: [] },
              "not-an-object"
            ]
          }),
          timedOut: false
        }
      }).runCommand
    });
    // 非字符串条目丢弃、重复 ref 去重保序
    expect(snapshot.allowedRefs).toEqual(["cpa/main", "ghost/missing"]);
    expect(snapshot.fallbackRefs).toEqual(["cpa/fallback"]);
    expect(snapshot.configuredModels.map((entry) => entry.ref)).toEqual(["cpa/main"]);
    expect(snapshot.completeness).toEqual({ status: false, configuredList: false, allList: true });
    expect(snapshot.diagnostics.map(d => d.command)).toEqual(["status", "list"]);
  });

  test("models 内重复 ref 去重保序，异常 tags 过滤", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        ...healthyOutputs,
        "models list --all --json": {
          status: 0,
          stdout: JSON.stringify({
            models: [
              { key: "cpa/main", name: "Main", tags: ["configured", 7, null, "fast"] },
              { key: "cpa/main", name: "重复条目", tags: "not-array" },
              { key: "ghost/other", tags: [{ deep: "obj" }] }
            ]
          }),
          timedOut: false
        }
      }).runCommand
    });
    expect(snapshot.allModels).toEqual([
      { ref: "cpa/main", name: "Main", tags: ["configured", "fast"] },
      { ref: "ghost/other", tags: [] }
    ]);
    expect(snapshot.diagnostics).toEqual([]);
  });

  test("version 失败不影响模型事实；version stdout 为空也算失败", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        ...healthyOutputs,
        "--version": { status: 0, stdout: "   ", timedOut: false }
      }).runCommand
    });
    expect(snapshot.openClawVersion).toBeUndefined();
    expect(snapshot.diagnostics.map(({ command, code }) => ({ command, code }))).toEqual([
      { command: "version", code: "invalid-shape" }
    ]);
    expect(snapshot.allowedRefs).toEqual(["cpa/main", "ghost/missing"]);
  });

  test("部分成功：models list 失败但 status 成功，allowed 保留且 configuredList=false", () => {
    const snapshot = discoverRuntimeModelCatalog({
      runCommand: fakeRunner({
        ...healthyOutputs,
        "models list --json": { status: 127, stdout: "SECRET in output", timedOut: false }
      }).runCommand
    });
    expect(snapshot.completeness).toEqual({ status: true, configuredList: false, allList: true });
    expect(snapshot.allowedRefs).toEqual(["cpa/main", "ghost/missing"]);
    expect(snapshot.allModels).toHaveLength(1);
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]).toMatchObject({ command: "list", code: "non-zero-exit" });
    // diagnostics 不含 stdout 原文（可能携带密钥）
    expect(JSON.stringify(snapshot)).not.toContain("SECRET");
  });
});
