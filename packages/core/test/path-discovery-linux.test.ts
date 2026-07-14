import { describe, expect, test } from "bun:test";
import { discoverLinuxOpenClawRuntime } from "../src/path-discovery-linux";
import type { RuntimeDiscoveryDependencies } from "../src/runtime-discovery-types";

function dependencies(
  overrides: Partial<RuntimeDiscoveryDependencies> = {}
): RuntimeDiscoveryDependencies {
  const files = new Map<string, string>([
    ["/proc/41/environ", [
      "HOME=/home/alice",
      "OPENCLAW_STATE_DIR=/srv/alpha",
      "OPENCLAW_CONFIG_PATH=/etc/openclaw/alpha.json",
      "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service",
      "SECRET_TOKEN=never-return-this"
    ].join("\0")],
    ["/home/alice/.config/systemd/user/openclaw-alpha.service", [
      "[Service]",
      "EnvironmentFile=-\"/srv/alpha/runtime/custom gateway.env\""
    ].join("\n")]
  ]);
  return {
    platform: "linux",
    homeDir: "/home/alice",
    userId: undefined,
    listGatewayProcesses: () => [{
      pid: 41,
      argv: ["node", "/opt/openclaw/dist/index.js", "gateway"]
    }],
    readTextFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    listDirectory: (path) => path.endsWith("/systemd/user")
      ? ["openclaw-alpha.service"]
      : [],
    runCommand: (command, args) => {
      if (command === "systemctl" && args.includes("show")) {
        return {
          status: 0,
          stdout: "MainPID=41\nFragmentPath=/home/alice/.config/systemd/user/openclaw-alpha.service\n",
          timedOut: false
        };
      }
      return { status: 1, stdout: "", timedOut: false };
    },
    pathExists: (path) => path === "/etc/openclaw/alpha.json",
    ...overrides
  };
}

describe("discoverLinuxOpenClawRuntime", () => {
  test("关联 MainPID、显式路径与非 canonical EnvironmentFile", () => {
    const result = discoverLinuxOpenClawRuntime(dependencies());

    expect(result.instances).toEqual([{
      instanceId: "systemd:openclaw-alpha.service",
      pid: 41,
      stateDir: "/srv/alpha",
      openclawPath: "/etc/openclaw/alpha.json",
      envPath: "/srv/alpha/.env",
      serviceEnvPath: "/srv/alpha/runtime/custom gateway.env",
      serviceManager: "systemd",
      serviceId: "openclaw-alpha.service",
      confidence: "confirmed",
      evidence: ["process-cmdline", "process-environ", "systemd-unit"]
    }]);
    expect(JSON.stringify(result)).not.toContain("never-return-this");
  });

  test("proc denied 时保留 systemd 证据并给稳定诊断", () => {
    const deps = dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") throw new Error("EACCES");
        if (path.endsWith("openclaw-alpha.service")) {
          return "[Service]\nEnvironmentFile=/srv/alpha/gateway.systemd.env";
        }
        throw new Error("ENOENT");
      }
    });

    const result = discoverLinuxOpenClawRuntime(deps);

    expect(result.diagnostics).toContain("process-environ-denied");
    expect(result.instances[0]).toMatchObject({
      stateDir: "/srv/alpha",
      openclawPath: "/srv/alpha/openclaw.json",
      envPath: "/srv/alpha/.env",
      confidence: "strong"
    });
  });

  test("MainPID 不匹配时保留进程证据但不绑定 service", () => {
    const deps = dependencies({
      runCommand: () => ({
        status: 0,
        stdout: "MainPID=99\nFragmentPath=/home/alice/.config/systemd/user/openclaw-alpha.service\n",
        timedOut: false
      })
    });

    const result = discoverLinuxOpenClawRuntime(deps);

    expect(result.diagnostics).toContain("service-pid-mismatch");
    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.instances[0]).toMatchObject({
      instanceId: "pid:41",
      stateDir: "/srv/alpha",
      openclawPath: "/etc/openclaw/alpha.json"
    });
    expect(result.instances[0]?.confidence).toBeUndefined();
    expect(result.candidateGroups[0]?.confidence).toBeUndefined();
    expect(result.instances[0]?.serviceManager).toBeUndefined();
  });

  test("profile unit 由进程白名单标识关联", () => {
    const deps = dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") {
          return "HOME=/home/alice\0OPENCLAW_PROFILE=work\0OPENCLAW_SYSTEMD_UNIT=openclaw-work.service";
        }
        if (path.endsWith("openclaw-work.service")) {
          return "EnvironmentFile=-/home/alice/.openclaw-work/gateway.systemd.env";
        }
        throw new Error("ENOENT");
      },
      runCommand: () => ({
        status: 0,
        stdout: "MainPID=41\nFragmentPath=/home/alice/.config/systemd/user/openclaw-work.service\n",
        timedOut: false
      }),
      pathExists: () => true
    });

    expect(discoverLinuxOpenClawRuntime(deps).instances[0]).toMatchObject({
      instanceId: "systemd:openclaw-work.service",
      stateDir: "/home/alice/.openclaw-work",
      serviceEnvPath: "/home/alice/.openclaw-work/gateway.systemd.env"
    });
  });

  test("proc denied 时可由 systemd 已加载列表发现 custom unit", () => {
    const deps = dependencies({
      listDirectory: () => { throw new Error("ENOENT"); },
      readTextFile: (path) => {
        if (path === "/proc/41/environ") throw new Error("EACCES");
        if (path === "/etc/systemd/user/my-gateway@blue.service") {
          return "EnvironmentFile=/srv/blue/gateway.systemd.env";
        }
        throw new Error("ENOENT");
      },
      runCommand: (_command, args) => {
        if (args.includes("list-units")) {
          return {
            status: 0,
            stdout: "my-gateway@blue.service loaded active running custom gateway\n",
            timedOut: false
          };
        }
        return {
          status: 0,
          stdout: "MainPID=41\nFragmentPath=/etc/systemd/user/my-gateway@blue.service\n",
          timedOut: false
        };
      },
      pathExists: () => true
    });

    expect(discoverLinuxOpenClawRuntime(deps).instances[0]).toMatchObject({
      instanceId: "systemd:my-gateway@blue.service",
      stateDir: "/srv/blue",
      confidence: "strong"
    });
  });

  test("优先使用 systemctl show 的 effective EnvironmentFiles", () => {
    const showCalls: string[][] = [];
    const deps = dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") {
          return "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service";
        }
        if (path === "/units/openclaw-alpha.service") {
          return "EnvironmentFile=/stale/gateway.systemd.env";
        }
        throw new Error("ENOENT");
      },
      runCommand: (_command, args) => {
        showCalls.push(args);
        return {
          status: 0,
          stdout: [
            "MainPID=41",
            "FragmentPath=/units/openclaw-alpha.service",
            "EnvironmentFiles=/effective/gateway.systemd.env (ignore_errors=yes)"
          ].join("\n"),
          timedOut: false
        };
      },
      pathExists: () => true
    });

    const result = discoverLinuxOpenClawRuntime(deps);

    expect(showCalls).toContainEqual([
      "--user",
      "show",
      "openclaw-alpha.service",
      "--property=MainPID",
      "--property=FragmentPath",
      "--property=EnvironmentFiles"
    ]);
    expect(result.instances[0]).toMatchObject({
      stateDir: "/effective",
      serviceEnvPath: "/effective/gateway.systemd.env"
    });
  });

  test("多个 effective EnvironmentFiles 目标标记冲突并分别保留候选", () => {
    const deps = dependencies({
      readTextFile: (path) => path === "/proc/41/environ"
        ? "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service"
        : "",
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=41",
          "FragmentPath=/units/openclaw-alpha.service",
          "EnvironmentFiles=/one/gateway.systemd.env (ignore_errors=no) /two/gateway.systemd.env (ignore_errors=yes)"
        ].join("\n"),
        timedOut: false
      }),
      pathExists: () => true
    });

    const first = discoverLinuxOpenClawRuntime(deps);
    const second = discoverLinuxOpenClawRuntime(deps);

    expect(first.status).toBe("gateway-detected-path-unresolved");
    expect(first.diagnostics).toContain("path-evidence-conflict");
    expect(first.candidateGroups.map((group) => group.stateDir)).toEqual(["/one", "/two"]);
    expect(new Set(first.candidateGroups.map((group) => group.candidateId)).size).toBe(2);
    expect(first.candidateGroups.map((group) => group.candidateId)).toEqual(
      second.candidateGroups.map((group) => group.candidateId)
    );
    expect(first.candidateGroups.every((group) => !group.candidateId.includes("41"))).toBe(true);
    expect(first.instances[0]?.confidence).toBeUndefined();
    expect(first.candidateGroups.every((group) => group.confidence === undefined)).toBe(true);
  });

  test("显式 process stateDir 与 service env 布局冲突时保留两组路径", () => {
    const deps = dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") {
          return [
            "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service",
            "OPENCLAW_STATE_DIR=/explicit"
          ].join("\0");
        }
        throw new Error("ENOENT");
      },
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=41",
          "FragmentPath=/units/openclaw-alpha.service",
          "EnvironmentFiles=/service/gateway.systemd.env (ignore_errors=no)"
        ].join("\n"),
        timedOut: false
      }),
      pathExists: () => true
    });

    const result = discoverLinuxOpenClawRuntime(deps);

    expect(result.status).toBe("gateway-detected-path-unresolved");
    expect(result.diagnostics).toContain("path-evidence-conflict");
    expect(result.candidateGroups.map((group) => group.stateDir)).toEqual([
      "/explicit",
      "/service"
    ]);
    expect(result.instances[0]?.confidence).toBeUndefined();
    expect(result.candidateGroups.every((group) => group.confidence === undefined)).toBe(true);
  });

  test("大量无关 unit 不触发 show 且 gateway unit 按稳定顺序探测", () => {
    const shownUnits: string[] = [];
    const unrelated = Array.from({ length: 100 }, (_, index) => `worker-${index}.service`);
    const deps = dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") return "";
        if (path.endsWith("openclaw-z.service")) {
          return "EnvironmentFile=/z/gateway.systemd.env";
        }
        throw new Error("ENOENT");
      },
      listDirectory: () => [
        ...unrelated,
        "openclaw-z.service",
        "openclaw-a.service",
        "openclaw-z.service"
      ],
      runCommand: (_command, args) => {
        if (args.includes("list-units")) {
          return {
            status: 0,
            stdout: [...unrelated, "openclaw-z.service", "openclaw-a.service"]
              .map((unit) => `${unit} loaded active running`)
              .join("\n"),
            timedOut: false
          };
        }
        const unit = args[2]!;
        shownUnits.push(unit);
        return {
          status: 0,
          stdout: unit === "openclaw-z.service"
            ? "MainPID=41\nFragmentPath=/units/openclaw-z.service"
            : "MainPID=0\nFragmentPath=/units/openclaw-a.service",
          timedOut: false
        };
      },
      pathExists: () => true
    });

    discoverLinuxOpenClawRuntime(deps);

    expect(shownUnits).toEqual([
      "openclaw-a.service",
      "openclaw-z.service",
      "openclaw-z.service"
    ]);
    expect(shownUnits.every((unit) => unit.includes("openclaw"))).toBe(true);
  });

  test("canonical EnvironmentFile 加 generic env 时不冲突", () => {
    const result = discoverLinuxOpenClawRuntime(dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") {
          return "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service";
        }
        if (path === "/srv/alpha/extra.env") return "OTHER=value";
        if (path === "/srv/alpha/gateway.systemd.env") return "";
        throw new Error("ENOENT");
      },
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=41",
          "FragmentPath=/units/openclaw-alpha.service",
          "EnvironmentFiles=/srv/alpha/extra.env (ignore_errors=no) /srv/alpha/gateway.systemd.env (ignore_errors=no)"
        ].join("\n"),
        timedOut: false
      }),
      pathExists: () => true
    }));

    expect(result.status).toBe("resolved");
    expect(result.diagnostics).not.toContain("path-evidence-conflict");
    expect(result.instances[0]?.serviceEnvPath).toBe("/srv/alpha/gateway.systemd.env");
  });

  test("marker 唯一标识 custom gateway service env", () => {
    const result = discoverLinuxOpenClawRuntime(dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") {
          return "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service";
        }
        if (path === "/runtime/custom.env") {
          return "OPENCLAW_SERVICE_MARKER=openclaw\nOPENCLAW_SERVICE_KIND=gateway";
        }
        if (path === "/runtime/extra.env") return "OTHER=value";
        throw new Error("ENOENT");
      },
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=41",
          "FragmentPath=/units/openclaw-alpha.service",
          "EnvironmentFiles=/runtime/extra.env (ignore_errors=no) /runtime/custom.env (ignore_errors=no)"
        ].join("\n"),
        timedOut: false
      })
    }));

    expect(result.instances[0]?.serviceEnvPath).toBe("/runtime/custom.env");
    expect(result.diagnostics).not.toContain("path-evidence-conflict");
  });

  test("process 与 service 路径先 canonicalize 再比较和生成 ID", () => {
    const deps = dependencies({
      readTextFile: (path) => {
        if (path === "/proc/41/environ") {
          return [
            "HOME=/home/alice",
            "OPENCLAW_SYSTEMD_UNIT=openclaw-alpha.service",
            "OPENCLAW_STATE_DIR=~/runtime/../runtime"
          ].join("\0");
        }
        throw new Error("ENOENT");
      },
      runCommand: () => ({
        status: 0,
        stdout: [
          "MainPID=41",
          "FragmentPath=/units/openclaw-alpha.service",
          "EnvironmentFiles=/home/alice/runtime/../runtime/gateway.systemd.env (ignore_errors=no)"
        ].join("\n"),
        timedOut: false
      }),
      pathExists: () => true
    });

    const result = discoverLinuxOpenClawRuntime(deps);

    expect(result.diagnostics).not.toContain("path-evidence-conflict");
    expect(result.instances[0]?.stateDir).toBe("/home/alice/runtime");
    expect(result.candidateGroups).toHaveLength(1);
  });
});
