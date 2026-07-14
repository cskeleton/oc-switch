import "../test-setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApiClient, type ApiClient } from "../api";
import { GatewayApplyBanner } from "./GatewayApplyBanner";

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

describe("GatewayApplyBanner", () => {
  test("successful auto-sync restarts with candidateId", async () => {
    const restartGateway = mock(async (candidateId?: string) => ({
      ok: true,
      restart: { ok: true, exitCode: 0, message: "Gateway restarted" },
      candidateId
    }));
    const { getByText, findByText } = render(
      <GatewayApplyBanner
        client={mockClient({ restartGateway })}
        envWrite={{
          verified: true,
          entries: [{ envVar: "K", verified: true, managed: true }]
        }}
        gatewayEnvSync={{
          ok: true,
          targetPath: "/tmp/service.env",
          syncedKeys: ["K"],
          removedKeys: [],
          warnings: [],
          candidateId: "launchd:gw:abc"
        }}
      />
    );

    expect(getByText("重启 Gateway")).toBeTruthy();
    await userEvent.click(getByText("重启 Gateway"));
    await waitFor(() => expect(restartGateway).toHaveBeenCalledWith("launchd:gw:abc"));
    expect(await findByText(/Gateway 已重启/)).toBeTruthy();
  });

  test("without candidateId guides selection instead of global restart", async () => {
    const restartGateway = mock(async () => ({
      ok: true,
      restart: { ok: true, exitCode: 0, message: "Gateway restarted" }
    }));
    const applyGateway = mock(async () => ({
      ok: true,
      sync: { ok: true, syncedKeys: [], removedKeys: [], warnings: [] },
      restart: { ok: true, exitCode: 0, message: "Gateway restarted" }
    }));
    const { getByText, queryByText } = render(
      <GatewayApplyBanner
        client={mockClient({ restartGateway, applyGateway })}
        envWrite={{
          verified: true,
          entries: [{ envVar: "K", verified: true, managed: true }]
        }}
        gatewayEnvSync={{
          ok: false,
          syncedKeys: [],
          removedKeys: [],
          warnings: ["ambiguous"]
        }}
      />
    );

    expect(getByText(/确认目标/)).toBeTruthy();
    expect(queryByText("重启 Gateway")).toBeNull();
    expect(queryByText("同步并重启 Gateway")).toBeNull();
    expect(restartGateway).not.toHaveBeenCalled();
    expect(applyGateway).not.toHaveBeenCalled();
  });
});
