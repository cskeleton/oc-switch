import { useCallback, useEffect, useState } from "react";
import type { ApiClient, SettingsResponse } from "../api";

interface SettingsViewProps {
  baseUrl: string;
  client: ApiClient;
}

/** 非敏感服务器与配置设置展示 */
export function SettingsView({ baseUrl, client }: SettingsViewProps) {
  let host = "127.0.0.1";
  let port = 7420;
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = Number(url.port || (url.protocol === "https:" ? "443" : "80"));
  } catch {
    // 使用默认值
  }

  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSettings(await client.getSettings());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCleanupOrphans() {
    try {
      await client.cleanupOrphanEnvKeys();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失败");
    }
  }

  const effective = settings ?? {
    configPath: "~/.openclaw/openclaw.json（可通过 OPENCLAW_CONFIG_PATH 覆盖）",
    bindAddress: host,
    port,
    backupRetention: 20,
    gatewayRestartCommand: "openclaw gateway restart",
    orphanEnvKeys: []
  };

  const items = [
    { label: "配置路径", value: effective.configPath },
    { label: "Bind 地址", value: effective.bindAddress },
    { label: "端口", value: String(effective.port) },
    { label: "备份保留份数", value: `${effective.backupRetention}（默认）` },
    { label: "Gateway 重启命令", value: effective.gatewayRestartCommand }
  ];

  return (
    <section data-testid="settings-view">
      <h1 className="mb-4 text-xl font-semibold">设置</h1>
      {error ? <p className="mb-3 text-red-400">{error}</p> : null}
      <dl className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-xs uppercase tracking-wide text-slate-400">{item.label}</dt>
            <dd className="mt-1 break-all text-sm text-slate-100">{item.value}</dd>
          </div>
        ))}
      </dl>
      {effective.orphanEnvKeys.length ? (
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-slate-300">Orphan env keys</h2>
            <button
              type="button"
              onClick={() => void handleCleanupOrphans()}
              className="rounded bg-sky-600 px-3 py-1.5 text-sm hover:bg-sky-500"
            >
              清理 orphan keys
            </button>
          </div>
          <ul className="space-y-1 text-sm text-slate-100">
            {effective.orphanEnvKeys.map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-4 text-xs text-slate-500">访问 Token 仅存于 sessionStorage，不会显示在界面上。</p>
    </section>
  );
}
