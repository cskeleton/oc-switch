import {
  Archive,
  Box,
  Cpu,
  LayoutDashboard,
  Layers,
  Settings
} from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { createApiClient } from "./api";
import { BackupsView } from "./views/BackupsView";
import { Dashboard } from "./views/Dashboard";
import { ModelsView } from "./views/ModelsView";
import { PresetsView } from "./views/PresetsView";
import { ProvidersView } from "./views/ProvidersView";
import { SettingsView } from "./views/SettingsView";

const TOKEN_KEY = "oc-switch-token";
const BASE_URL_KEY = "oc-switch-base-url";
const DEFAULT_BASE_URL = "http://127.0.0.1:7420";

export type AppRoute = "dashboard" | "providers" | "models" | "presets" | "backups" | "settings";

const NAV: Array<{ id: AppRoute; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "仪表盘", icon: LayoutDashboard },
  { id: "providers", label: "Providers", icon: Box },
  { id: "models", label: "模型", icon: Cpu },
  { id: "backups", label: "备份", icon: Archive },
  { id: "settings", label: "设置", icon: Settings },
  { id: "presets", label: "预设", icon: Layers }
];

function readSession(key: string): string {
  try {
    return typeof window === "undefined" ? "" : window.sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeSession(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 忽略存储失败
  }
}

function defaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.origin && window.location.origin !== "null") {
    return window.location.origin;
  }
  return DEFAULT_BASE_URL;
}

/** 应用主壳：连接配置 + 响应式导航 */
export function App() {
  const [token, setToken] = useState(() => readSession(TOKEN_KEY));
  const [baseUrl, setBaseUrl] = useState(() => readSession(BASE_URL_KEY) || defaultBaseUrl());
  const [connected, setConnected] = useState(() => Boolean(readSession(TOKEN_KEY)));
  const [route, setRoute] = useState<AppRoute>("dashboard");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const client = useMemo(
    () => createApiClient({ baseUrl, token }),
    [baseUrl, token, tick]
  );

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setConnectError(null);
    const testClient = createApiClient({ baseUrl, token });
    try {
      await testClient.getStatus();
      writeSession(TOKEN_KEY, token);
      writeSession(BASE_URL_KEY, baseUrl);
      setConnected(true);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "连接失败");
    }
  }

  function handleDisconnect() {
    try {
      window.sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // 忽略
    }
    setConnected(false);
    setToken("");
  }

  if (!connected) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <form onSubmit={(e) => void handleConnect(e)} className="w-full max-w-md space-y-4 rounded-lg border border-slate-700 bg-slate-900 p-6">
          <h1 className="text-xl font-semibold">oc-switch</h1>
          <p className="text-sm text-slate-400">输入 API 地址与 Token 以连接本地服务</p>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">API 地址</span>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
              placeholder={DEFAULT_BASE_URL}
              aria-label="API 地址"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">Token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
              autoComplete="off"
            />
          </label>
          {connectError ? <p className="text-sm text-red-400">{connectError}</p> : null}
          <button type="submit" className="w-full rounded bg-sky-600 py-2 text-sm font-medium hover:bg-sky-500">
            连接
          </button>
        </form>
      </div>
    );
  }

  function renderRoute() {
    switch (route) {
      case "dashboard":
        return <Dashboard client={client} />;
      case "providers":
        return <ProvidersView client={client} onRefresh={refresh} />;
      case "models":
        return <ModelsView client={client} />;
      case "presets":
        return <PresetsView client={client} onRefresh={refresh} />;
      case "backups":
        return <BackupsView client={client} onRefresh={refresh} />;
      case "settings":
        return <SettingsView baseUrl={baseUrl} client={client} />;
      default:
        return null;
    }
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="border-b border-slate-700 bg-slate-900 md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-semibold">oc-switch</span>
          <button type="button" onClick={handleDisconnect} className="text-xs text-slate-400 hover:text-slate-200">
            断开
          </button>
        </div>
        <nav className="flex overflow-x-auto border-t border-slate-700">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setRoute(id)}
              className={`flex shrink-0 items-center gap-1 px-3 py-2 text-xs ${
                route === id ? "border-b-2 border-sky-500 text-sky-300" : "text-slate-400"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
      </header>

      <aside className="hidden w-52 shrink-0 flex-col border-r border-slate-700 bg-slate-900 md:flex">
        <div className="flex items-center justify-between border-b border-slate-700 px-4 py-4">
          <span className="font-semibold">oc-switch</span>
          <button type="button" onClick={handleDisconnect} className="text-xs text-slate-400 hover:text-slate-200">
            断开
          </button>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-2">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setRoute(id)}
              className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${
                route === id ? "bg-sky-900/50 text-sky-200" : "text-slate-300 hover:bg-slate-800"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-auto p-4 md:p-6">{renderRoute()}</main>
    </div>
  );
}
