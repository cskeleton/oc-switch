import { describe, expect, test } from "bun:test";
import { discoverMacOSOpenClawRuntime } from "../src/path-discovery-macos";
import type { RuntimeDiscoveryDependencies } from "../src/runtime-discovery-types";

function plist(stateDir: string): string {
  return `<?xml version="1.0"?>
<plist><dict><key>ProgramArguments</key><array>
<string>/bin/sh</string>
<string>${stateDir}/service-env/gateway-env-wrapper.sh</string>
<string>${stateDir}/service-env/gateway.env</string>
<string>/usr/local/bin/node</string>
<string>/opt/openclaw/dist/index.js</string>
<string>gateway</string>
</array></dict></plist>`;
}

function dependencies(
  overrides: Partial<RuntimeDiscoveryDependencies> = {}
): RuntimeDiscoveryDependencies {
  const files = new Map<string, string>([
    ["/Users/alice/Library/LaunchAgents/ai.openclaw.gateway.plist", plist("/Users/alice/.openclaw")],
    ["/Users/alice/.openclaw/service-env/gateway.env", [
      "OPENCLAW_STATE_DIR=/Users/alice/.openclaw",
      "OPENCLAW_CONFIG_PATH=/etc/openclaw/live.json",
      "API_KEY=never-return-this"
    ].join("\n")]
  ]);
  return {
    platform: "darwin",
    homeDir: "/Users/alice",
    userId: 501,
    listGatewayProcesses: () => [{
      pid: 51,
      argv: ["/usr/local/bin/node", "/opt/openclaw/dist/index.js", "gateway"]
    }],
    readTextFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    listDirectory: (path) => path.endsWith("/LaunchAgents")
      ? ["ai.openclaw.gateway.plist"]
      : [],
    runCommand: (command) => command === "launchctl"
      ? { status: 0, stdout: "pid = 51\n", timedOut: false }
      : { status: 1, stdout: "", timedOut: false },
    pathExists: () => true,
    ...overrides
  };
}

describe("discoverMacOSOpenClawRuntime", () => {
  test("关联 launchd PID 并从白名单 service env 提取显式路径", () => {
    const targets: string[] = [];
    const result = discoverMacOSOpenClawRuntime(dependencies({
      runCommand: (command, args) => {
        if (command === "launchctl") targets.push(args.join(" "));
        return { status: 0, stdout: "pid = 51\n", timedOut: false };
      }
    }));

    expect(targets).toEqual(["print gui/501/ai.openclaw.gateway"]);
    expect(result.instances).toEqual([{
      instanceId: "launchd:ai.openclaw.gateway",
      pid: 51,
      stateDir: "/Users/alice/.openclaw",
      openclawPath: "/etc/openclaw/live.json",
      envPath: "/Users/alice/.openclaw/.env",
      serviceEnvPath: "/Users/alice/.openclaw/service-env/gateway.env",
      serviceManager: "launchd",
      serviceId: "ai.openclaw.gateway",
      confidence: "strong",
      evidence: ["process-cmdline", "launchd-plist"]
    }]);
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });

  test("多个已加载 profile 分别返回且 candidateId 不含 PID", () => {
    const deps = dependencies({
      listGatewayProcesses: () => [
        { pid: 51, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] },
        { pid: 52, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] }
      ],
      listDirectory: () => [
        "ai.openclaw.gateway.plist",
        "ai.openclaw.work.plist"
      ],
      readTextFile: (path) => {
        if (path.endsWith("ai.openclaw.gateway.plist")) return plist("/Users/alice/.openclaw");
        if (path.endsWith("ai.openclaw.work.plist")) return plist("/Users/alice/.openclaw-work");
        if (path.endsWith("gateway.env")) return "";
        throw new Error("ENOENT");
      },
      runCommand: (_command, args) => ({
        status: 0,
        stdout: args.some((arg) => arg.includes("work")) ? "pid = 52" : "pid = 51",
        timedOut: false
      })
    });

    const result = discoverMacOSOpenClawRuntime(deps);

    expect(result.candidateGroups.map((candidate) => candidate.candidateId)).toEqual([
      expect.stringMatching(/^launchd:ai\.openclaw\.gateway:[0-9a-f]{12}$/),
      expect.stringMatching(/^launchd:ai\.openclaw\.work:[0-9a-f]{12}$/)
    ]);
    expect(result.instances.map((instance) => instance.stateDir)).toEqual([
      "/Users/alice/.openclaw",
      "/Users/alice/.openclaw-work"
    ]);
  });

  test("未加载 plist 不标记为 running instance", () => {
    const result = discoverMacOSOpenClawRuntime(dependencies({
      runCommand: () => ({ status: 1, stdout: "", timedOut: false })
    }));

    expect(result.instances).toEqual([]);
    expect(result.diagnostics).toContain("service-metadata-missing");
  });

  test("无法取得 uid 时不调用 launchctl 并返回稳定诊断", () => {
    let called = false;
    const result = discoverMacOSOpenClawRuntime(dependencies({
      userId: undefined,
      runCommand: () => {
        called = true;
        return { status: 0, stdout: "pid = 51", timedOut: false };
      }
    }));

    expect(called).toBe(false);
    expect(result.instances).toEqual([]);
    expect(result.diagnostics).toContain("user-id-unavailable");
  });

  test("service PID mismatch 时拒绝绑定并给诊断", () => {
    const result = discoverMacOSOpenClawRuntime(dependencies({
      runCommand: () => ({ status: 0, stdout: "pid = 999", timedOut: false })
    }));

    expect(result.instances).toEqual([]);
    expect(result.diagnostics).toContain("service-pid-mismatch");
  });

  test("无显式变量时由 service-env 布局推导 stateDir", () => {
    const result = discoverMacOSOpenClawRuntime(dependencies({
      readTextFile: (path) => path.endsWith(".plist")
        ? plist("/Users/alice/.openclaw")
        : "UNRELATED_SECRET=hidden"
    }));

    expect(result.instances[0]).toMatchObject({
      stateDir: "/Users/alice/.openclaw",
      openclawPath: "/Users/alice/.openclaw/openclaw.json",
      envPath: "/Users/alice/.openclaw/.env",
      confidence: "strong"
    });
    expect(JSON.stringify(result)).not.toContain("hidden");
  });

  test("显式 state 与 service-env 布局冲突时保留两组且 config 保持独立", () => {
    const deps = dependencies({
      readTextFile: (path) => {
        if (path.endsWith(".plist")) return plist("/Users/alice/layout-state");
        if (path.endsWith("gateway.env")) {
          return [
            "OPENCLAW_STATE_DIR=/Users/alice/explicit-state",
            "OPENCLAW_CONFIG_PATH=/etc/openclaw/custom.json"
          ].join("\n");
        }
        throw new Error("ENOENT");
      }
    });

    const first = discoverMacOSOpenClawRuntime(deps);
    const second = discoverMacOSOpenClawRuntime(deps);

    expect(first.status).toBe("gateway-detected-path-unresolved");
    expect(first.diagnostics).toContain("path-evidence-conflict");
    expect(first.instances[0]?.confidence).toBeUndefined();
    expect(first.candidateGroups.map((group) => group.stateDir).sort()).toEqual([
      "/Users/alice/explicit-state",
      "/Users/alice/layout-state"
    ]);
    expect(first.candidateGroups.map((group) => group.openclawPath)).toEqual([
      "/etc/openclaw/custom.json",
      "/etc/openclaw/custom.json"
    ]);
    expect(new Set(first.candidateGroups.map((group) => group.candidateId)).size).toBe(2);
    expect(first.candidateGroups.every((group) => group.confidence === undefined)).toBe(true);
    expect(first.candidateGroups.map((group) => group.candidateId)).toEqual(
      second.candidateGroups.map((group) => group.candidateId)
    );
  });

  test("坏 profile 冲突不移除健康实例的 strong confidence", () => {
    const deps = dependencies({
      listGatewayProcesses: () => [
        { pid: 51, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] },
        { pid: 52, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] }
      ],
      listDirectory: () => [
        "ai.openclaw.good.plist",
        "ai.openclaw.bad.plist"
      ],
      readTextFile: (path) => {
        if (path.endsWith("good.plist")) return plist("/Users/alice/good");
        if (path.endsWith("bad.plist")) return plist("/Users/alice/layout");
        if (path === "/Users/alice/good/service-env/gateway.env") return "";
        if (path === "/Users/alice/layout/service-env/gateway.env") {
          return "OPENCLAW_STATE_DIR=/Users/alice/explicit";
        }
        throw new Error("ENOENT");
      },
      runCommand: (_command, args) => ({
        status: 0,
        stdout: args.some((arg) => arg.includes("bad")) ? "pid = 52" : "pid = 51",
        timedOut: false
      })
    });

    const result = discoverMacOSOpenClawRuntime(deps);

    expect(result.status).toBe("resolved");
    expect(result.diagnostics).toContain("path-evidence-conflict");
    expect(result.instances.find((instance) => instance.serviceId === "ai.openclaw.good")?.confidence)
      .toBe("strong");
    expect(result.instances.find((instance) => instance.serviceId === "ai.openclaw.bad")?.confidence)
      .toBeUndefined();
  });

  test("规范化 HOME 展开与遍历路径并拒绝相对路径", () => {
    const normalized = discoverMacOSOpenClawRuntime(dependencies({
      readTextFile: (path) => {
        if (path.endsWith(".plist")) return plist("/Users/alice/layout");
        return [
          "HOME=/Users/alice",
          "OPENCLAW_STATE_DIR=~/profiles/../runtime",
          "OPENCLAW_CONFIG_PATH=/Users/alice/runtime/../runtime/openclaw.json"
        ].join("\n");
      }
    }));
    const relative = discoverMacOSOpenClawRuntime(dependencies({
      readTextFile: (path) => path.endsWith(".plist")
        ? plist("/Users/alice/layout")
        : "OPENCLAW_STATE_DIR=relative/state"
    }));

    expect(normalized.instances[0]).toMatchObject({
      stateDir: "/Users/alice/runtime",
      openclawPath: "/Users/alice/runtime/openclaw.json"
    });
    expect(relative.instances[0]?.stateDir).toBe("/Users/alice/layout");
  });
});
