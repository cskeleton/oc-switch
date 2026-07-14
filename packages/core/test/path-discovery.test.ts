import { describe, expect, test } from "bun:test";
import {
  discoverOpenClawRuntime,
  discoverRunningOpenClawInstances
} from "../src/path-discovery";
import { deduplicateRuntimeCandidateGroups } from "../src/runtime-discovery-candidates";
import type { RuntimePathCandidateGroup } from "../src/runtime-discovery-types";
import type { RuntimeDiscoveryDependencies } from "../src/runtime-discovery-types";

function runtimeDependencies(
  overrides: Partial<RuntimeDiscoveryDependencies> = {}
): RuntimeDiscoveryDependencies {
  return {
    platform: "linux",
    homeDir: "/home/tester",
    userId: undefined,
    listGatewayProcesses: () => [],
    readTextFile: () => { throw new Error("ENOENT"); },
    listDirectory: () => [],
    runCommand: () => ({ status: 1, stdout: "", timedOut: false }),
    pathExists: () => false,
    ...overrides
  };
}

describe("discoverRunningOpenClawInstances", () => {
  test("parses pgrep output into running instance paths", () => {
    const instances = discoverRunningOpenClawInstances({
      probe: () => [
        "12345 openclaw gateway --config /data/openclaw/openclaw.json",
        "99999 unrelated"
      ].join("\n")
    });

    expect(instances).toEqual([{
      pid: 12345,
      openclawPath: "/data/openclaw/openclaw.json",
      envPath: "/data/openclaw/.env"
    }]);
  });

  test("returns empty array when probe fails", () => {
    expect(discoverRunningOpenClawInstances({
      probe: () => { throw new Error("pgrep unavailable"); }
    })).toEqual([]);
  });
});

describe("discoverOpenClawRuntime", () => {
  test("严格过滤非 Gateway、worker 与探测命令", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [
        { pid: 1, argv: ["codex", "app-server", "--openclaw"] },
        { pid: 2, argv: ["node", "/opt/openclaw/dist/index.js", "embedding-worker"] },
        { pid: 3, argv: ["pgrep", "-fl", "openclaw"] },
        { pid: 4, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] }
      ]
    }));

    expect(result.instances.map((instance) => instance.pid)).toEqual([4]);
    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.instances[0]?.confidence).toBeUndefined();
  });

  test("精确区分未检测、probe 失败、路径未解析与已解析", () => {
    const notDetected = discoverOpenClawRuntime(runtimeDependencies());
    const probeFailed = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => { throw new Error("denied"); }
    }));
    const unresolved = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }]
    }));
    const resolved = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      pathExists: (path) => path === "/home/tester/.openclaw/openclaw.json"
    }));

    expect([
      notDetected.status,
      probeFailed.status,
      unresolved.status,
      resolved.status
    ]).toEqual([
      "gateway-not-detected",
      "probe-failed",
      "gateway-detected-path-unresolved",
      "resolved"
    ]);
    expect(resolved.instances[0]).toMatchObject({
      stateDir: "/home/tester/.openclaw",
      confidence: "inferred",
      evidence: ["process-cmdline", "default-state-dir"]
    });
  });

  test("严格 Gateway 已发现但平台关联失败时仍为路径未解析", () => {
    const gateway = [{
      pid: 51,
      argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
    }];
    const base = {
      platform: "darwin" as const,
      homeDir: "/Users/alice",
      userId: 501,
      listGatewayProcesses: () => gateway,
      listDirectory: () => ["ai.openclaw.gateway.plist"],
      pathExists: () => false
    };
    const invalidPlist = discoverOpenClawRuntime({
      ...base,
      readTextFile: () => "<plist><dict></dict></plist>",
      runCommand: () => ({ status: 1, stdout: "", timedOut: false })
    });
    const pidMismatch = discoverOpenClawRuntime({
      ...base,
      readTextFile: (path) => path.endsWith(".plist")
        ? `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array>
<string>/Users/alice/.openclaw/service-env/gateway-env-wrapper.sh</string>
<string>/Users/alice/.openclaw/service-env/gateway.env</string>
<string>node</string><string>/opt/openclaw/dist/index.js</string><string>gateway</string>
</array></dict></plist>`
        : "",
      runCommand: () => ({ status: 0, stdout: "pid = 999", timedOut: false })
    });
    const uidMissing = discoverOpenClawRuntime({
      ...base,
      userId: undefined,
      readTextFile: (path) => path.endsWith(".plist")
        ? `<?xml version="1.0"?><plist><dict><key>ProgramArguments</key><array>
<string>/Users/alice/.openclaw/service-env/gateway-env-wrapper.sh</string>
<string>/Users/alice/.openclaw/service-env/gateway.env</string>
<string>node</string><string>/opt/openclaw/dist/index.js</string><string>gateway</string>
</array></dict></plist>`
        : "",
      runCommand: () => ({ status: 1, stdout: "", timedOut: false })
    });

    expect([
      invalidPlist.status,
      pidMismatch.status,
      uidMissing.status
    ]).toEqual([
      "gateway-detected-path-unresolved",
      "gateway-detected-path-unresolved",
      "gateway-detected-path-unresolved"
    ]);
  });

  test("默认 pgrep probe 的超时、oversize 与异常退出映射 probe-failed", () => {
    const calls: Array<{ timeoutMs: number; maxOutputBytes: number }> = [];
    const common = {
      platform: "linux" as const,
      homeDir: "/home/tester",
      userId: undefined,
      readTextFile: () => "",
      listDirectory: () => [],
      runCommand: () => ({ status: 1, stdout: "", timedOut: false }),
      pathExists: () => false
    };
    const timeout = discoverOpenClawRuntime({
      ...common,
      processProbe: (_command, _args, options) => {
        calls.push(options);
        return { status: null, stdout: "", timedOut: true };
      }
    });
    const oversize = discoverOpenClawRuntime({
      ...common,
      processProbe: () => ({
        status: null,
        stdout: "",
        timedOut: false,
        outputTooLarge: true
      })
    });
    const abnormal = discoverOpenClawRuntime({
      ...common,
      processProbe: () => ({ status: 2, stdout: "", timedOut: false })
    });

    expect(calls).toEqual([{ timeoutMs: 1_000, maxOutputBytes: 65_536 }]);
    expect([timeout.status, oversize.status, abnormal.status]).toEqual([
      "probe-failed",
      "probe-failed",
      "probe-failed"
    ]);
    expect(timeout.diagnostics).toContain("process-probe-failed");
    expect(oversize.diagnostics).toContain("process-probe-failed");
    expect(abnormal.diagnostics).toContain("process-probe-failed");
  });

  test("默认 Linux 使用 pgrep -af，旧 PID node 形态被过滤而完整 argv 可发现", () => {
    const calls: string[][] = [];
    const base = {
      platform: "linux" as const,
      homeDir: "/home/tester",
      userId: undefined,
      readTextFile: () => "",
      listDirectory: () => [],
      runCommand: () => ({ status: 1, stdout: "", timedOut: false }),
      pathExists: () => false
    };
    const oldShape = discoverOpenClawRuntime({
      ...base,
      processProbe: (_command, args) => {
        calls.push(args);
        return { status: 0, stdout: "123 node\n", timedOut: false };
      }
    });
    const fullShape = discoverOpenClawRuntime({
      ...base,
      processProbe: (_command, args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: "123 node /opt/openclaw/dist/index.js gateway\n",
          timedOut: false
        };
      }
    });

    expect(calls).toEqual([["-af", "openclaw"], ["-af", "openclaw"]]);
    expect(oldShape.status).toBe("gateway-not-detected");
    expect(fullShape.status).toBe("gateway-detected-path-unresolved");
  });

  test("CLI runner 抛异常映射 cli-status-invalid", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      runCommand: () => { throw new Error("spawn failed"); }
    }));

    expect(result.diagnostics).toContain("cli-status-invalid");
  });

  test("重复进程证据合并且 candidateId 稳定", () => {
    const process = {
      pid: 9,
      argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
    };
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [process, process],
      pathExists: () => true
    }));

    expect(result.instances).toHaveLength(1);
    expect(result.candidateGroups.map((candidate) => candidate.candidateId)).toEqual([
      expect.stringMatching(/^pid:9:[0-9a-f]{12}$/)
    ]);
  });

  test("只有无置信度 process 路径候选时不得 resolved", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      readTextFile: (path) => path === "/proc/9/environ"
        ? "OPENCLAW_STATE_DIR=/manual"
        : "",
      pathExists: () => true
    }));

    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.candidateGroups).toHaveLength(1);
    expect(result.candidateGroups[0]?.confidence).toBeUndefined();
  });

  test("同一 service 的路径证据冲突时不推荐并给诊断", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [
        { pid: 10, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] },
        { pid: 11, argv: ["node", "/opt/openclaw/dist/index.js", "gateway"] }
      ],
      readTextFile: (path) => {
        if (path === "/proc/10/environ") {
          return "OPENCLAW_SYSTEMD_UNIT=openclaw.service\0OPENCLAW_STATE_DIR=/one";
        }
        if (path === "/proc/11/environ") {
          return "OPENCLAW_SYSTEMD_UNIT=openclaw.service\0OPENCLAW_STATE_DIR=/two";
        }
        if (path === "/units/openclaw.service") {
          return "EnvironmentFile=/one/gateway.systemd.env";
        }
        throw new Error("ENOENT");
      },
      runCommand: (_command, _args) => ({
        status: 0,
        stdout: "MainPID=10\nFragmentPath=/units/openclaw.service",
        timedOut: false
      }),
      pathExists: () => true
    }));

    expect(result.diagnostics).toContain("path-evidence-conflict");
    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.candidateGroups).toHaveLength(2);
  });

  test("仅在歧义时用 CLI status 补充路径且限制输出参数", () => {
    const calls: Array<{ timeoutMs: number; maxOutputBytes: number }> = [];
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      runCommand: (command, _args, options) => {
        if (command === "openclaw") calls.push(options);
        return {
          status: 0,
          stdout: JSON.stringify({
            daemon: {
              pid: 9,
              configPath: "/runtime/custom.json",
              stateDir: "/runtime/state"
            },
            environment: { API_KEY: "never-return-this" }
          }),
          timedOut: false
        };
      }
    }));

    expect(calls).toEqual([{ timeoutMs: 1_500, maxOutputBytes: 65_536 }]);
    expect(result.instances[0]).toMatchObject({
      openclawPath: "/runtime/custom.json",
      stateDir: "/runtime/state",
      envPath: "/runtime/state/.env",
      evidence: ["process-cmdline", "cli-status"]
    });
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });

  test("CLI status 超时与无效 JSON 返回稳定诊断", () => {
    const gateway = [{
      pid: 9,
      argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
    }];
    const timedOut = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => gateway,
      runCommand: () => ({ status: null, stdout: "", timedOut: true })
    }));
    const invalid = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => gateway,
      runCommand: () => ({ status: 0, stdout: "{bad", timedOut: false })
    }));

    expect(timedOut.diagnostics).toContain("cli-status-timeout");
    expect(invalid.diagnostics).toContain("cli-status-invalid");
  });

  test("CLI status maxBuffer 与超长 stdout 返回 oversize 诊断", () => {
    const gateway = [{
      pid: 9,
      argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
    }];
    const maxBuffer = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => gateway,
      runCommand: () => ({
        status: null,
        stdout: "",
        timedOut: false,
        outputTooLarge: true
      })
    }));
    const longStdout = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => gateway,
      runCommand: () => ({
        status: 0,
        stdout: "x".repeat(65_537),
        timedOut: false
      })
    }));

    expect(maxBuffer.diagnostics).toContain("cli-status-output-too-large");
    expect(longStdout.diagnostics).toContain("cli-status-output-too-large");
  });

  test("CLI config path 不反推独立的 stateDir", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      runCommand: () => ({
        status: 0,
        stdout: JSON.stringify({
          daemon: { pid: 9, configPath: "/etc/openclaw/custom.json" }
        }),
        timedOut: false
      })
    }));

    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.instances[0]).toMatchObject({
      openclawPath: "/etc/openclaw/custom.json"
    });
    expect(result.instances[0]?.stateDir).toBeUndefined();
    expect(result.instances[0]?.envPath).toBeUndefined();
  });

  test("CLI PID 与 service metadata 一致时提升为 confirmed", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      readTextFile: (path) => {
        if (path === "/proc/9/environ") {
          return "OPENCLAW_SYSTEMD_UNIT=openclaw-custom.service";
        }
        if (path === "/units/openclaw-custom.service") {
          return "EnvironmentFile=/runtime/custom-service.env";
        }
        throw new Error("ENOENT");
      },
      runCommand: (command) => command === "systemctl"
        ? {
            status: 0,
            stdout: "MainPID=9\nFragmentPath=/units/openclaw-custom.service",
            timedOut: false
          }
        : {
            status: 0,
            stdout: JSON.stringify({
              daemon: {
                pid: 9,
                configPath: "/etc/openclaw/custom.json",
                stateDir: "/runtime/state"
              }
            }),
            timedOut: false
          }
    }));

    expect(result.instances[0]).toMatchObject({
      instanceId: "systemd:openclaw-custom.service",
      confidence: "confirmed",
      stateDir: "/runtime/state",
      openclawPath: "/etc/openclaw/custom.json",
      evidence: ["process-cmdline", "process-environ", "systemd-unit", "cli-status"]
    });
  });

  test("CLI 与 process/service 路径冲突时保留各候选且不提升 confirmed", () => {
    const result = discoverOpenClawRuntime(runtimeDependencies({
      listGatewayProcesses: () => [{
        pid: 9,
        argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
      }],
      readTextFile: (path) => {
        if (path === "/proc/9/environ") {
          return [
            "OPENCLAW_SYSTEMD_UNIT=openclaw.service",
            "OPENCLAW_STATE_DIR=/process"
          ].join("\0");
        }
        throw new Error("ENOENT");
      },
      runCommand: (command) => command === "systemctl"
        ? {
            status: 0,
            stdout: [
              "MainPID=9",
              "FragmentPath=/units/openclaw.service",
              "EnvironmentFiles=/service/gateway.systemd.env (ignore_errors=no)"
            ].join("\n"),
            timedOut: false
          }
        : {
            status: 0,
            stdout: JSON.stringify({
              daemon: {
                pid: 9,
                configPath: "/cli/openclaw.json",
                stateDir: "/cli"
              }
            }),
            timedOut: false
          },
      pathExists: () => true
    }));

    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.diagnostics).toContain("path-evidence-conflict");
    expect(result.candidateGroups.map((group) => group.stateDir).sort()).toEqual([
      "/cli",
      "/process",
      "/service"
    ]);
    expect(result.instances[0]?.confidence).toBeUndefined();
    expect(result.candidateGroups.every((group) => group.confidence === undefined)).toBe(true);
    expect(new Set(result.candidateGroups.map((group) => group.candidateId)).size).toBe(3);
  });

  test("相同 candidateId 合并 evidence、较强 confidence 与 service metadata", () => {
    const base: RuntimePathCandidateGroup = {
      candidateId: "systemd:openclaw.service:abc",
      instanceId: "systemd:openclaw.service",
      stateDir: "/state",
      openclawPath: "/state/openclaw.json",
      envPath: "/state/.env",
      serviceManager: "systemd",
      serviceId: "openclaw.service",
      pid: 9,
      confidence: "strong",
      evidence: ["systemd-unit"]
    };
    const merged = deduplicateRuntimeCandidateGroups([
      base,
      {
        ...base,
        serviceEnvPath: "/state/gateway.systemd.env",
        confidence: "confirmed",
        evidence: ["cli-status", "process-cmdline"]
      }
    ]);

    expect(merged).toEqual([{
      ...base,
      serviceEnvPath: "/state/gateway.systemd.env",
      confidence: "confirmed",
      evidence: ["systemd-unit", "cli-status", "process-cmdline"]
    }]);
  });
});
