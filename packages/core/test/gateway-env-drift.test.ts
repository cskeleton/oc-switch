import { describe, expect, test } from "bun:test";
import {
  inspectGatewayEnvDrift,
  listAmbiguousGatewayEnvDriftCandidates,
  unavailableGatewayEnvDriftReport,
  type GatewayEnvDriftReport
} from "../src/gateway-env-drift";
import type { GatewayServiceEnvTarget } from "../src/gateway-service-env-sync";

function systemdTarget(targetPath = "/tmp/gateway.systemd.env"): GatewayServiceEnvTarget {
  return { targetKind: "systemd", targetPath, candidateId: "test:candidate" };
}

function launchdTarget(targetPath = "/tmp/service-env/ai.openclaw.gateway.env"): GatewayServiceEnvTarget {
  return { targetKind: "launchd", targetPath, candidateId: "test:candidate" };
}

/** 汇总各 state 的 envVar 列表，便于断言 */
function varsByState(report: GatewayEnvDriftReport, state: string): string[] {
  return report.entries.filter((entry) => entry.state === state).map((entry) => entry.envVar);
}

describe("inspectGatewayEnvDrift", () => {
  test("systemd 目标五态分类：equal / different / missing-in-service / extra-in-service / 块外元变量不误报", () => {
    const envContent = [
      "# oc-switch:start",
      "SAME_KEY=same-value",
      "DIFF_KEY=new-value",
      "MISSING_KEY=missing-value",
      "# oc-switch:end"
    ].join("\n") + "\n";
    // systemd 快照：全文裸 KEY=VALUE；托管块内残留 EXTRA_KEY；块外有服务元变量
    const serviceEnvContent = [
      "HTTP_PROXY=http://proxy.example",
      "OPENCLAW_STATE_DIR=/var/lib/openclaw",
      "# oc-switch:start",
      "SAME_KEY=same-value",
      "DIFF_KEY=old-value",
      "EXTRA_KEY=extra-value",
      "# oc-switch:end"
    ].join("\n") + "\n";

    const report = inspectGatewayEnvDrift({ envContent, target: systemdTarget(), serviceEnvContent });

    expect(report.status).toBe("ok");
    expect(report.version).toBe(1);
    expect(report.target).toEqual({
      candidateId: "test:candidate",
      targetKind: "systemd",
      serviceEnvPath: "/tmp/gateway.systemd.env"
    });
    expect(varsByState(report, "equal")).toEqual(["SAME_KEY"]);
    expect(varsByState(report, "different")).toEqual(["DIFF_KEY"]);
    expect(varsByState(report, "missing-in-service")).toEqual(["MISSING_KEY"]);
    expect(varsByState(report, "extra-in-service")).toEqual(["EXTRA_KEY"]);
    // 块外服务元变量不属于托管块，不得误报为分叉
    expect(report.entries.some((entry) => entry.envVar === "HTTP_PROXY")).toBe(false);
    expect(report.entries.some((entry) => entry.envVar === "OPENCLAW_STATE_DIR")).toBe(false);
    expect(report.summary).toEqual({
      checked: 4,
      equal: 1,
      missingInService: 1,
      different: 1,
      extraInService: 1,
      outsideConflict: 0,
      unsyncable: 0
    });
  });

  test("快照空值判为 different(blocking)", () => {
    const envContent = "# oc-switch:start\nEMPTY_KEY=real-value\n# oc-switch:end\n";
    const serviceEnvContent = "# oc-switch:start\nEMPTY_KEY=\n# oc-switch:end\n";
    const report = inspectGatewayEnvDrift({ envContent, target: systemdTarget(), serviceEnvContent });
    const entry = report.entries.find((item) => item.envVar === "EMPTY_KEY");
    expect(entry?.state).toBe("different");
    expect(entry?.severity).toBe("blocking");
  });

  test("systemd 仅块外同名 key 按值比较（不同值 = different/blocking）；块内外同时存在才是 outside-conflict", () => {
    const envContent = "# oc-switch:start\nOUT_KEY=source-value\nBOTH_KEY=source-value\n# oc-switch:end\n";
    const serviceEnvContent = [
      "OUT_KEY=outside-value",
      "# oc-switch:start",
      "BOTH_KEY=inside-value",
      "# oc-switch:end",
      "BOTH_KEY=outside-value"
    ].join("\n") + "\n";
    const report = inspectGatewayEnvDrift({ envContent, target: systemdTarget(), serviceEnvContent });
    const out = report.entries.find((item) => item.envVar === "OUT_KEY");
    const both = report.entries.find((item) => item.envVar === "BOTH_KEY");
    // 仅块外存在：块外值运行时生效，是覆盖漂移而非残留
    expect(out?.state).toBe("different");
    expect(out?.severity).toBe("blocking");
    // 块内外同时存在：块内值（sync 追加在末尾）生效，块外是残留
    expect(both?.state).toBe("outside-conflict");
    expect(both?.severity).toBe("warning");
  });

  test("launchd 仅块外 export 同名 key 按值比较（不同值 = different）；块外其余 export 不误报", () => {
    const envContent = "# oc-switch:start\nOUT_KEY=source-value\nSAME_KEY=same-value\n# oc-switch:end\n";
    const serviceEnvContent = [
      "#!/bin/sh",
      "export PATH=/usr/local/bin:$PATH",
      "export OUT_KEY=outside-value",
      "# oc-switch:start",
      "export SAME_KEY='same-value'",
      "# oc-switch:end"
    ].join("\n") + "\n";
    const report = inspectGatewayEnvDrift({ envContent, target: launchdTarget(), serviceEnvContent });
    expect(varsByState(report, "different")).toEqual(["OUT_KEY"]);
    expect(varsByState(report, "equal")).toEqual(["SAME_KEY"]);
    expect(report.entries.some((entry) => entry.envVar === "PATH")).toBe(false);
  });

  test("launchd 托管块内残留 key 判为 extra-in-service", () => {
    const envContent = "# oc-switch:start\nKEEP_KEY=keep-value\n# oc-switch:end\n";
    const serviceEnvContent = [
      "export PATH=/usr/local/bin",
      "# oc-switch:start",
      "export KEEP_KEY='keep-value'",
      "export STALE_KEY='stale-value'",
      "# oc-switch:end"
    ].join("\n") + "\n";
    const report = inspectGatewayEnvDrift({ envContent, target: launchdTarget(), serviceEnvContent });
    expect(varsByState(report, "equal")).toEqual(["KEEP_KEY"]);
    expect(varsByState(report, "extra-in-service")).toEqual(["STALE_KEY"]);
    expect(report.entries.some((entry) => entry.envVar === "PATH")).toBe(false);
  });

  test("源托管块空值附 unsyncable(empty-value)，severity ≥ warning，state 照常计算", () => {
    const envContent = [
      "# oc-switch:start",
      "EMPTY_KEY=",
      "OK_KEY=ok-value",
      "# oc-switch:end"
    ].join("\n") + "\n";
    const serviceEnvContent = [
      "# oc-switch:start",
      "EMPTY_KEY=",
      "OK_KEY=ok-value",
      "# oc-switch:end"
    ].join("\n") + "\n";
    const report = inspectGatewayEnvDrift({ envContent, target: systemdTarget(), serviceEnvContent });
    const empty = report.entries.find((item) => item.envVar === "EMPTY_KEY");
    const ok = report.entries.find((item) => item.envVar === "OK_KEY");
    expect(empty?.unsyncable).toBe("empty-value");
    // 快照空值按 different 语义 → blocking（≥ warning 满足「至少 warning」），unsyncable 仍须保留
    expect(empty?.state).toBe("different");
    expect(empty?.severity).toBe("blocking");
    expect(ok?.unsyncable).toBeUndefined();
    expect(ok?.severity).toBe("info");
    expect(report.summary.unsyncable).toBe(1);
  });

  test("serviceEnvContent 为 null：全部 missing-in-service 并附快照缺失 warning", () => {
    const envContent = "# oc-switch:start\nA_KEY=a-value\nB_KEY=b-value\n# oc-switch:end\n";
    const report = inspectGatewayEnvDrift({
      envContent,
      target: systemdTarget("/tmp/missing/gateway.systemd.env"),
      serviceEnvContent: null
    });
    expect(report.status).toBe("ok");
    expect(varsByState(report, "missing-in-service")).toEqual(["A_KEY", "B_KEY"]);
    expect(report.summary.missingInService).toBe(2);
    expect(report.warnings.some((warning) => warning.includes("missing"))).toBe(true);
  });

  test("排序：blocking → warning → info，同级按 envVar 字母序", () => {
    const envContent = [
      "# oc-switch:start",
      "INFO_B=in-b",
      "BLOCK_A=block-a",
      "OUT_B=warn-b",
      "INFO_A=in-a",
      "OUT_A=warn-a",
      "BLOCK_B=block-b",
      "# oc-switch:end"
    ].join("\n") + "\n";
    // 块内外同时存在的同名 key 触发 warning（outside-conflict）；托管块内同名不同值触发 blocking
    const serviceEnvContent = [
      "OUT_A=outside-a",
      "OUT_B=outside-b",
      "# oc-switch:start",
      "INFO_B=in-b",
      "BLOCK_A=stale-a",
      "INFO_A=in-a",
      "BLOCK_B=stale-b",
      "OUT_A=warn-a",
      "OUT_B=warn-b",
      "# oc-switch:end"
    ].join("\n") + "\n";
    const report = inspectGatewayEnvDrift({ envContent, target: systemdTarget(), serviceEnvContent });
    expect(report.entries.map((entry) => entry.envVar)).toEqual([
      "BLOCK_A", "BLOCK_B", "OUT_A", "OUT_B", "INFO_A", "INFO_B"
    ]);
    expect(report.entries.map((entry) => entry.severity)).toEqual([
      "blocking", "blocking", "warning", "warning", "info", "info"
    ]);
  });

  test("报告 DTO 不含任何 env value（含快照与源值）", () => {
    const envContent = "# oc-switch:start\nSECRET_KEY=source-secret\n# oc-switch:end\n";
    const serviceEnvContent = "# oc-switch:start\nSECRET_KEY=stale-secret\nEXTRA_KEY=extra-secret\n# oc-switch:end\n";
    const report = inspectGatewayEnvDrift({ envContent, target: systemdTarget(), serviceEnvContent });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("source-secret");
    expect(serialized).not.toContain("stale-secret");
    expect(serialized).not.toContain("extra-secret");
  });

  test("源托管块为空时报告为空且 summary 全零", () => {
    const report = inspectGatewayEnvDrift({ envContent: "", target: systemdTarget(), serviceEnvContent: "" });
    expect(report.entries).toEqual([]);
    expect(report.summary.checked).toBe(0);
  });
});

describe("unavailableGatewayEnvDriftReport / listAmbiguousGatewayEnvDriftCandidates", () => {
  test("构造 unavailable 报告，DTO 无 value", () => {
    const report = unavailableGatewayEnvDriftReport({
      code: "no-matching-group",
      message: "No runtime candidate group uniquely matches the active OpenClaw config and env paths"
    });
    expect(report.status).toBe("unavailable");
    expect(report.unavailable?.code).toBe("no-matching-group");
    expect(report.entries).toEqual([]);
    expect(report.version).toBe(1);
  });

  test("歧义候选只列出 active 路径匹配且带 serviceEnvPath 的组", () => {
    const discovery = {
      status: "resolved" as const,
      instances: [],
      candidateGroups: [
        {
          candidateId: "a", instanceId: "a", stateDir: "/s", openclawPath: "/cfg/openclaw.json", envPath: "/cfg/.env",
          serviceEnvPath: "/svc/a.env", serviceManager: "systemd" as const, serviceId: "openclaw-gateway.service",
          pid: 1, evidence: ["process-environ" as const]
        },
        {
          candidateId: "b", instanceId: "b", stateDir: "/s", openclawPath: "/cfg/openclaw.json", envPath: "/cfg/.env",
          serviceEnvPath: "/svc/b.env", serviceManager: "launchd" as const, serviceId: "ai.openclaw.gateway",
          pid: 2, evidence: ["process-environ" as const]
        },
        {
          // 无 serviceEnvPath，不参与歧义候选
          candidateId: "c", instanceId: "c", stateDir: "/s", openclawPath: "/cfg/openclaw.json", envPath: "/cfg/.env",
          pid: 3, evidence: ["process-environ" as const]
        },
        {
          // 路径不匹配，不参与
          candidateId: "d", instanceId: "d", stateDir: "/other", openclawPath: "/other/openclaw.json", envPath: "/other/.env",
          serviceEnvPath: "/svc/d.env", serviceManager: "systemd" as const,
          pid: 4, evidence: ["process-environ" as const]
        }
      ],
      diagnostics: []
    };
    const candidates = listAmbiguousGatewayEnvDriftCandidates(
      { openclawPath: "/cfg/openclaw.json", envPath: "/cfg/.env" },
      discovery
    );
    expect(candidates.map((item) => item.candidateId)).toEqual(["a", "b"]);
    expect(candidates[0]).toEqual({
      candidateId: "a",
      serviceManager: "systemd",
      serviceId: "openclaw-gateway.service",
      serviceEnvPath: "/svc/a.env"
    });
  });
});
