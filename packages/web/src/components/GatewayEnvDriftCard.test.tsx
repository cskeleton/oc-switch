import "../test-setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createApiClient,
  type ApiClient,
  type GatewayEnvDriftReport,
  type GatewayEnvDriftUnavailableCandidate,
  type GatewayEnvDriftUnavailableCode
} from "../api";
import { GatewayEnvDriftCard } from "./GatewayEnvDriftCard";

afterEach(() => {
  cleanup();
  mock.restore();
});

function mockClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  return { ...base, ...overrides };
}

/** 字段齐全的 summary（与 core DTO 同名同值） */
function summary(overrides: Partial<GatewayEnvDriftReport["summary"]> = {}) {
  return {
    checked: 0,
    equal: 0,
    missingInService: 0,
    different: 0,
    extraInService: 0,
    outsideConflict: 0,
    unsyncable: 0,
    ...overrides
  };
}

function okReport(
  entries: GatewayEnvDriftReport["entries"],
  summaryOverrides: Partial<GatewayEnvDriftReport["summary"]> = {}
): GatewayEnvDriftReport {
  return {
    version: 1,
    status: "ok",
    target: { candidateId: "launchd:gw:abc", targetKind: "launchd", serviceEnvPath: "/tmp/service-env/gw.env" },
    entries,
    summary: summary(summaryOverrides),
    warnings: []
  };
}

function unavailableReport(
  code: GatewayEnvDriftUnavailableCode,
  candidates?: GatewayEnvDriftUnavailableCandidate[]
): GatewayEnvDriftReport {
  return {
    version: 1,
    status: "unavailable",
    entries: [],
    summary: summary(),
    warnings: [],
    unavailable: { code, message: `${code} 原因`, ...(candidates ? { candidates } : {}) }
  };
}

describe("GatewayEnvDriftCard", () => {
  test("ok 有分叉：徽章、danger 文案、逐 key 行（无 value）与同步 CTA", async () => {
    const getGatewayEnvDrift = mock(async () => ({
      ok: true as const,
      report: okReport(
        [
          { envVar: "ANTHROPIC_API_KEY", state: "different", severity: "blocking" },
          { envVar: "OPENAI_API_KEY", state: "equal", severity: "info" },
          { envVar: "STALE_KEY", state: "extra-in-service", severity: "warning" }
        ],
        { checked: 3, equal: 1, different: 1, extraInService: 1 }
      )
    }));
    const { findByText, getByText, queryByText, container } = render(
      <GatewayEnvDriftCard client={mockClient({ getGatewayEnvDrift })} />
    );

    expect(await findByText("2 项分叉")).toBeTruthy();
    expect(getByText("运行中 Gateway 可能仍使用旧值，重启后生效。")).toBeTruthy();
    // equal 行不进入详情；逐 key 行只有变量名与状态，绝不出现 value
    await userEvent.click(getByText("展开详情"));
    expect(getByText("ANTHROPIC_API_KEY")).toBeTruthy();
    expect(getByText("值不同")).toBeTruthy();
    expect(getByText("STALE_KEY")).toBeTruthy();
    expect(getByText("快照残留")).toBeTruthy();
    expect(queryByText("OPENAI_API_KEY")).toBeNull();
    expect(container.textContent).not.toContain("sk-secret-value");
    expect(getByText("同步")).toBeTruthy();
    expect(getByText("同步并重启")).toBeTruthy();
    expect(getGatewayEnvDrift).toHaveBeenCalledTimes(1);
  });

  test("一致态：徽章「一致」，无详情与 CTA", async () => {
    const getGatewayEnvDrift = mock(async () => ({
      ok: true as const,
      report: okReport(
        [{ envVar: "ANTHROPIC_API_KEY", state: "equal", severity: "info" }],
        { checked: 1, equal: 1 }
      )
    }));
    const { findByText, queryByText } = render(
      <GatewayEnvDriftCard client={mockClient({ getGatewayEnvDrift })} />
    );

    expect(await findByText("一致")).toBeTruthy();
    expect(queryByText("展开详情")).toBeNull();
    expect(queryByText("同步")).toBeNull();
    expect(queryByText("同步并重启")).toBeNull();
  });

  test("ambiguous-match：列出候选，选择后带 candidateId 重取", async () => {
    const getGatewayEnvDrift = mock(async (candidateId?: string) => ({
      ok: true as const,
      report: candidateId
        ? okReport(
            [{ envVar: "ANTHROPIC_API_KEY", state: "different", severity: "blocking" }],
            { checked: 1, different: 1 }
          )
        : unavailableReport("ambiguous-match", [
            { candidateId: "cand-1", serviceManager: "launchd", serviceId: "com.openclaw.gw1", serviceEnvPath: "/tmp/gw1.env" },
            { candidateId: "cand-2", serviceManager: "systemd", serviceId: "openclaw-gateway", serviceEnvPath: "/tmp/gw2.env" }
          ])
    }));
    const { findByLabelText, findByText } = render(
      <GatewayEnvDriftCard client={mockClient({ getGatewayEnvDrift })} />
    );

    expect(await findByText(/检测到多个可关联的 Gateway 运行实例/)).toBeTruthy();
    expect(getGatewayEnvDrift).toHaveBeenCalledTimes(1);
    await userEvent.click(await findByLabelText("环境分叉目标 cand-2"));
    await waitFor(() => expect(getGatewayEnvDrift).toHaveBeenCalledWith("cand-2"));
    expect(await findByText("1 项分叉")).toBeTruthy();
  });

  test("其他 unavailable：弱化内联提示，不渲染候选组", async () => {
    const getGatewayEnvDrift = mock(async () => ({
      ok: true as const,
      report: unavailableReport("no-matching-group")
    }));
    const { findByText, queryByText } = render(
      <GatewayEnvDriftCard client={mockClient({ getGatewayEnvDrift })} />
    );

    expect(await findByText(/未发现可关联的 Gateway 服务环境/)).toBeTruthy();
    expect(queryByText("检测到多个可关联的 Gateway 运行实例")).toBeNull();
  });

  test("同步确认后调用 syncGatewayEnv 并重新拉取 drift", async () => {
    const getGatewayEnvDrift = mock(async () => ({
      ok: true as const,
      report: okReport(
        [{ envVar: "ANTHROPIC_API_KEY", state: "different", severity: "blocking" }],
        { checked: 1, different: 1 }
      )
    }));
    const syncGatewayEnv = mock(async (candidateId?: string) => ({
      ok: true,
      sync: {
        ok: true,
        targetKind: "launchd" as const,
        targetPath: "/tmp/service-env/gw.env",
        syncedKeys: ["ANTHROPIC_API_KEY"],
        removedKeys: [],
        warnings: [],
        ...(candidateId ? { candidateId } : {})
      }
    }));
    const { findByText } = render(
      <GatewayEnvDriftCard
        client={mockClient({ getGatewayEnvDrift, syncGatewayEnv })}
        candidateId="launchd:gw:abc"
      />
    );

    await userEvent.click(await findByText("同步"));
    await userEvent.click(await findByText("确认同步"));
    await waitFor(() => expect(syncGatewayEnv).toHaveBeenCalledWith("launchd:gw:abc"));
    // 操作成功后重新拉取 drift（初次加载 1 次 + 重取）
    await waitFor(() => expect(getGatewayEnvDrift.mock.calls.length).toBe(2));
  });
});
