interface SettingsViewProps {
  baseUrl: string;
}

/** 非敏感服务器与配置设置展示 */
export function SettingsView({ baseUrl }: SettingsViewProps) {
  let host = "127.0.0.1";
  let port = "7420";
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    // 使用默认值
  }

  const items = [
    { label: "配置路径", value: "~/.openclaw/openclaw.json（可通过 OPENCLAW_CONFIG_PATH 覆盖）" },
    { label: "Bind 地址", value: host },
    { label: "端口", value: port },
    { label: "备份保留份数", value: "10（默认）" },
    { label: "Gateway 重启命令", value: "openclaw gateway restart" }
  ];

  return (
    <section data-testid="settings-view">
      <h1 className="mb-4 text-xl font-semibold">设置</h1>
      <dl className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
        {items.map((item) => (
          <div key={item.label}>
            <dt className="text-xs uppercase tracking-wide text-slate-400">{item.label}</dt>
            <dd className="mt-1 break-all text-sm text-slate-100">{item.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-slate-500">访问 Token 仅存于 sessionStorage，不会显示在界面上。</p>
    </section>
  );
}
