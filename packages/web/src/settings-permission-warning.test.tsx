import "./test-setup";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createApiClient,
  type ApiClient,
  type ConfigStatusIssue
} from "./api";
import { ToastProvider } from "./components/Toast";
import { SettingsView } from "./views/SettingsView";

afterEach(() => {
  cleanup();
  mock.restore();
});

/** 与 views.test.tsx 同款：真实 client 为底，按需覆盖方法；未覆盖的端点返回最小 {ok:true} */
function baseClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
  });
  return { ...client, ...overrides };
}

const PATH_SETTINGS = {
  active: { openclawPath: "/fixture/openclaw.json", envPath: "/fixture/.env", stateDir: "/fixture/.oc-switch" },
  openclawPaths: [],
  envPaths: [],
  runtimeDiscovery: { status: "gateway-not-detected" as const, instances: [], diagnostics: [] },
  runtimeCandidateGroups: []
};

const SETTINGS = {
  configPath: "/fixture/openclaw.json",
  bindAddress: "127.0.0.1",
  port: 7420,
  backupRetention: 20,
  gatewayRestartCommand: "openclaw gateway restart",
  orphanEnvKeys: []
};

const ENV_ISSUE: ConfigStatusIssue = {
  id: "paths:permissions-too-open:env",
  severity: "warning",
  source: "paths",
  title: ".env 权限过宽",
  detail: "当前权限 0644，group/other 可读：/fixture/.env",
  action: "chmod 600 /fixture/.env"
};

function configStatusReport(issues: ConfigStatusIssue[]) {
  return {
    version: 1 as const,
    health: { caseDuplicateGroups: [], summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 } },
    disabledProviders: [],
    orphanEnvKeys: [],
    envWarnings: [],
    modelPolicy: {
      mode: "legacy" as const,
      policyEntryCount: 0,
      effectiveCatalogCount: 0,
      unknownProviderRefs: [],
      policyOnlyExactRefs: [],
      knownProviderUnknownModelRefs: []
    },
    issues,
    summary: {
      issueCount: issues.length,
      blockingIssueCount: 0,
      warningIssueCount: issues.length,
      duplicateGroupCount: 0,
      disabledProviderCount: 0,
      orphanEnvKeyCount: 0
    }
  };
}

function renderSettingsView(client: ApiClient) {
  return render(
    <ToastProvider>
      <SettingsView baseUrl="http://127.0.0.1:7420" client={client} />
    </ToastProvider>
  );
}

function clientWithIssues(issues: ConfigStatusIssue[], overrides: Partial<ApiClient> = {}) {
  return baseClient({
    getSettings: async () => SETTINGS,
    getPathSettings: async () => PATH_SETTINGS,
    getEnvIndex: async () => ({ variables: [], warnings: [] }),
    getConfigStatus: async () => configStatusReport(issues),
    ...overrides
  });
}

describe("SettingsView 配置文件权限警告（chmod warning spec §4）", () => {
  test("有过宽 issue 时在路径 tab 显示 warning banner，含权限位与 chmod 命令", async () => {
    const { findByRole } = renderSettingsView(clientWithIssues([ENV_ISSUE]));

    await userEvent.click(await findByRole("tab", { name: "路径" }));
    const alert = await findByRole("alert");
    expect(alert.textContent).toContain(".env 权限过宽");
    expect(alert.textContent).toContain("0644");
    expect(alert.textContent).toContain("chmod 600 /fixture/.env");
  });

  test("无权限 issue 时不显示 banner", async () => {
    const { findByRole, findByText, queryByRole } = renderSettingsView(clientWithIssues([]));

    await userEvent.click(await findByRole("tab", { name: "路径" }));
    await findByText("openclaw.json 路径");
    expect(queryByRole("alert")).toBeNull();
  });

  test("config-status 拉取失败时静默（无 banner、无错误提示）", async () => {
    const getConfigStatus = mock(async () => {
      throw new Error("config-status unavailable");
    });
    const { findByRole, findByText, queryByRole, queryByText } = renderSettingsView(
      clientWithIssues([], { getConfigStatus })
    );

    await userEvent.click(await findByRole("tab", { name: "路径" }));
    await findByText("openclaw.json 路径");
    await waitFor(() => expect(getConfigStatus).toHaveBeenCalled());
    expect(queryByRole("alert")).toBeNull();
    expect(queryByText(/config-status unavailable/)).toBeNull();
    expect(queryByText("加载失败")).toBeNull();
  });
});
