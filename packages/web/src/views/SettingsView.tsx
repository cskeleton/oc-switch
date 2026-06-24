import { useCallback, useEffect, useState } from "react";
import type { ApiClient, EnvIndexResponse, EnvVariableSummary, PathSettingsResponse, SettingsResponse } from "../api";

interface SettingsViewProps {
  baseUrl: string;
  client: ApiClient;
}

interface PendingEnvAction {
  envVar?: string;
  fromEnvVar?: string;
  toEnvVar?: string;
  type: "upsert" | "delete" | "rename";
  value?: string;
  note?: string;
  warnings: string[];
  confirmMigration?: boolean;
  confirmComplex?: boolean;
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
  const [pathSettings, setPathSettings] = useState<PathSettingsResponse | null>(null);
  const [envIndex, setEnvIndex] = useState<EnvIndexResponse | null>(null);
  const [selectedOpenClawPath, setSelectedOpenClawPath] = useState("");
  const [selectedEnvPath, setSelectedEnvPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [valueInputs, setValueInputs] = useState<Record<string, string>>({});
  const [renameInputs, setRenameInputs] = useState<Record<string, string>>({});
  const [newExtraVar, setNewExtraVar] = useState("");
  const [newExtraValue, setNewExtraValue] = useState("");
  const [newExtraNote, setNewExtraNote] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingEnvAction | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextSettings, nextPaths, nextEnv] = await Promise.all([
        client.getSettings(),
        client.getPathSettings(),
        client.getEnvIndex()
      ]);
      setSettings(nextSettings);
      setPathSettings(nextPaths);
      setEnvIndex(nextEnv);
      setSelectedOpenClawPath(nextPaths.active.openclawPath);
      setSelectedEnvPath(nextPaths.active.envPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerVars = envIndex?.variables.filter((item) => item.providerRef) ?? [];
  const extraVars = envIndex?.variables.filter((item) => item.extraManaged || (item.managed && !item.providerRef)) ?? [];

  function setInputValue(envVar: string, value: string) {
    setValueInputs((prev) => ({ ...prev, [envVar]: value }));
  }

  function setRenameValue(envVar: string, value: string) {
    setRenameInputs((prev) => ({ ...prev, [envVar]: value }));
  }

  async function submitEnvUpsert(envVar: string, value: string, note?: string) {
    if (!value.trim()) {
      setError("请输入新值");
      return;
    }
    setError(null);
    try {
      const preview = await client.previewEnvVar({ type: "upsert", envVar, ...(note ? { note } : {}) });
      const summary = envIndex?.variables.find((item) => item.envVar === envVar);
      const needsMigration = Boolean(summary?.present && !summary.managed);
      const needsComplex = Boolean(summary?.complex || summary?.duplicate);
      if (preview.requiresConfirmation || needsMigration || needsComplex) {
        setPendingAction({
          envVar,
          type: "upsert",
          value,
          warnings: preview.warnings,
          confirmMigration: needsMigration,
          confirmComplex: needsComplex,
          ...(note ? { note } : {})
        });
        return;
      }
      await client.updateEnvVar({ type: "upsert", envVar, value, ...(note ? { note } : {}) });
      setValueInputs((prev) => ({ ...prev, [envVar]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新失败");
    }
  }

  async function submitEnvDelete(envVar: string) {
    setError(null);
    try {
      const preview = await client.previewEnvVar({ type: "delete", envVar });
      const summary = envIndex?.variables.find((item) => item.envVar === envVar);
      const needsComplex = Boolean(summary?.complex || summary?.duplicate);
      if (preview.requiresConfirmation || needsComplex) {
        setPendingAction({
          envVar,
          type: "delete",
          warnings: preview.warnings,
          confirmComplex: needsComplex
        });
        return;
      }
      await client.deleteEnvVar({ type: "delete", envVar });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function submitEnvRename(fromEnvVar: string, toEnvVar: string, note?: string) {
    if (!toEnvVar.trim()) {
      setError("请输入新变量名");
      return;
    }
    setError(null);
    try {
      const nextName = toEnvVar.trim();
      const preview = await client.previewEnvVar({ type: "rename", fromEnvVar, toEnvVar: nextName, ...(note ? { note } : {}) });
      const summary = envIndex?.variables.find((item) => item.envVar === fromEnvVar);
      const needsComplex = Boolean(summary?.complex || summary?.duplicate);
      if (preview.requiresConfirmation || needsComplex) {
        setPendingAction({
          fromEnvVar,
          toEnvVar: nextName,
          type: "rename",
          warnings: preview.warnings,
          confirmComplex: needsComplex,
          ...(note ? { note } : {})
        });
        return;
      }
      await client.renameEnvVar({ type: "rename", fromEnvVar, toEnvVar: nextName, ...(note ? { note } : {}) });
      setRenameInputs((prev) => ({ ...prev, [fromEnvVar]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "重命名失败");
    }
  }

  async function confirmPendingAction() {
    if (!pendingAction) return;
    setError(null);
    try {
      if (pendingAction.type === "upsert" && pendingAction.value && pendingAction.envVar) {
        const envVar = pendingAction.envVar;
        await client.updateEnvVar({
          type: "upsert",
          envVar,
          value: pendingAction.value,
          ...(pendingAction.note ? { note: pendingAction.note } : {}),
          ...(pendingAction.confirmMigration ? { confirmMigration: true } : {}),
          ...(pendingAction.confirmComplex ? { confirmComplex: true } : {})
        });
        setValueInputs((prev) => ({ ...prev, [envVar]: "" }));
      } else if (pendingAction.type === "delete" && pendingAction.envVar) {
        await client.deleteEnvVar({
          type: "delete",
          envVar: pendingAction.envVar,
          ...(pendingAction.confirmComplex ? { confirmComplex: true } : {})
        });
      } else if (pendingAction.type === "rename" && pendingAction.fromEnvVar && pendingAction.toEnvVar) {
        const fromEnvVar = pendingAction.fromEnvVar;
        await client.renameEnvVar({
          type: "rename",
          fromEnvVar,
          toEnvVar: pendingAction.toEnvVar,
          ...(pendingAction.note ? { note: pendingAction.note } : {}),
          ...(pendingAction.confirmComplex ? { confirmComplex: true } : {})
        });
        setRenameInputs((prev) => ({ ...prev, [fromEnvVar]: "" }));
      }
      setPendingAction(null);
      if (pendingAction.type === "upsert" && pendingAction.envVar === newExtraVar) {
        setNewExtraVar("");
        setNewExtraValue("");
        setNewExtraNote("");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function handleCleanupOrphans() {
    try {
      await client.cleanupOrphanEnvKeys();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失败");
    }
  }

  async function handleSwitchPaths() {
    try {
      await client.updatePathSettings(selectedOpenClawPath, selectedEnvPath);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换路径失败");
    }
  }

  function renderStatus(item: EnvVariableSummary) {
    if (item.missing) return "缺失";
    if (item.managed) return "托管";
    return "未托管";
  }

  function renderRisk(item: EnvVariableSummary) {
    return [item.duplicate ? "重复" : "", item.complex ? "复杂" : "", item.orphan ? "orphan" : ""].filter(Boolean).join("、") || "正常";
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
      {pathSettings ? (
        <div className="mt-4 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-3 text-sm font-medium text-slate-300">OpenClaw 路径</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-slate-400">openclaw.json 路径</span>
              <select
                aria-label="openclaw.json 路径"
                value={selectedOpenClawPath}
                onChange={(event) => setSelectedOpenClawPath(event.target.value)}
                className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
              >
                {pathSettings.openclawPaths.map((item) => (
                  <option key={`${item.source}:${item.path}`} value={item.path}>
                    {item.path}（{item.label}{item.recommended ? "，推荐" : ""}）
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-slate-400">.env 路径</span>
              <select
                aria-label=".env 路径"
                value={selectedEnvPath}
                onChange={(event) => setSelectedEnvPath(event.target.value)}
                className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2"
              >
                {pathSettings.envPaths.map((item) => (
                  <option key={`${item.source}:${item.path}`} value={item.path}>
                    {item.path}（{item.label}{item.recommended ? "，推荐" : ""}）
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="button" onClick={() => void handleSwitchPaths()} className="mt-3 rounded bg-sky-600 px-3 py-1.5 text-sm hover:bg-sky-500">
            切换路径
          </button>
        </div>
      ) : null}
      {envIndex ? (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-slate-500">
            管理当前 OpenClaw runtime `.env`（{pathSettings?.active.envPath ?? effective.envPath ?? "未知"}）。不显示旧值；备份会包含 .env 明文。
          </p>
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
            <h2 className="text-sm font-medium text-slate-300">Provider 密钥（常规）</h2>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-400">
                  <tr>
                    <th className="py-2 pr-3">变量</th>
                    <th className="py-2 pr-3">Provider</th>
                    <th className="py-2 pr-3">状态</th>
                    <th className="py-2 pr-3">风险</th>
                    <th className="py-2 pr-3">新值</th>
                    <th className="py-2 pr-3">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {providerVars.map((item) => (
                    <tr key={item.envVar} className="border-t border-slate-700">
                      <td className="py-2 pr-3 font-mono text-xs text-slate-100">{item.envVar}</td>
                      <td className="py-2 pr-3 text-slate-300">{item.providerIds.join(", ")}</td>
                      <td className="py-2 pr-3 text-slate-300">{renderStatus(item)}</td>
                      <td className="py-2 pr-3 text-slate-300">{renderRisk(item)}</td>
                      <td className="py-2 pr-3">
                        <input
                          type="password"
                          aria-label={`${item.envVar} 新值`}
                          value={valueInputs[item.envVar] ?? ""}
                          onChange={(event) => setInputValue(item.envVar, event.target.value)}
                          className="w-full min-w-[8rem] rounded border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-xs"
                          autoComplete="off"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          onClick={() => void submitEnvUpsert(item.envVar, valueInputs[item.envVar] ?? "")}
                          className="rounded bg-sky-600 px-2 py-1 text-xs hover:bg-sky-500"
                        >
                          {item.missing ? "填写" : "重填"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((open) => !open)}
              className="text-sm font-medium text-slate-300"
            >
              高级：额外托管变量 {advancedOpen ? "▾" : "▸"}
            </button>
            {advancedOpen ? (
              <div className="mt-3 space-y-4">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase text-slate-400">
                      <tr>
                        <th className="py-2 pr-3">变量</th>
                        <th className="py-2 pr-3">状态</th>
                        <th className="py-2 pr-3">备注</th>
                        <th className="py-2 pr-3">新值</th>
                        <th className="py-2 pr-3">重命名为</th>
                        <th className="py-2 pr-3">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {extraVars.map((item) => (
                        <tr key={item.envVar} className="border-t border-slate-700">
                          <td className="py-2 pr-3 font-mono text-xs text-slate-100">{item.envVar}</td>
                          <td className="py-2 pr-3 text-slate-300">{renderRisk(item)}</td>
                          <td className="py-2 pr-3 text-slate-300">{item.note ?? "—"}</td>
                          <td className="py-2 pr-3">
                            <input
                              type="password"
                              aria-label={`${item.envVar} 新值`}
                              value={valueInputs[item.envVar] ?? ""}
                              onChange={(event) => setInputValue(item.envVar, event.target.value)}
                              className="w-full min-w-[8rem] rounded border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-xs"
                              autoComplete="off"
                            />
                          </td>
                          <td className="py-2 pr-3">
                            <input
                              aria-label={`${item.envVar} 新变量名`}
                              value={renameInputs[item.envVar] ?? ""}
                              onChange={(event) => setRenameValue(item.envVar, event.target.value)}
                              className="w-full min-w-[8rem] rounded border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-xs"
                            />
                          </td>
                          <td className="py-2 pr-3 space-x-2">
                            <button
                              type="button"
                              onClick={() => void submitEnvUpsert(item.envVar, valueInputs[item.envVar] ?? "", item.note)}
                              className="rounded bg-sky-600 px-2 py-1 text-xs hover:bg-sky-500"
                            >
                              重填
                            </button>
                            <button
                              type="button"
                              onClick={() => void submitEnvDelete(item.envVar)}
                              className="rounded bg-red-700 px-2 py-1 text-xs hover:bg-red-600"
                            >
                              删除
                            </button>
                            <button
                              type="button"
                              onClick={() => void submitEnvRename(item.envVar, renameInputs[item.envVar] ?? "", item.note)}
                              className="rounded bg-slate-700 px-2 py-1 text-xs hover:bg-slate-600"
                            >
                              重命名
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid gap-2 md:grid-cols-4">
                  <input
                    aria-label="新变量名"
                    placeholder="变量名"
                    value={newExtraVar}
                    onChange={(event) => setNewExtraVar(event.target.value)}
                    className="rounded border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-xs"
                  />
                  <input
                    type="password"
                    aria-label="新变量值"
                    placeholder="新值"
                    value={newExtraValue}
                    onChange={(event) => setNewExtraValue(event.target.value)}
                    className="rounded border border-slate-600 bg-slate-950 px-2 py-1 font-mono text-xs"
                    autoComplete="off"
                  />
                  <input
                    aria-label="用途备注"
                    placeholder="备注（可选）"
                    value={newExtraNote}
                    onChange={(event) => setNewExtraNote(event.target.value)}
                    className="rounded border border-slate-600 bg-slate-950 px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void submitEnvUpsert(newExtraVar.trim(), newExtraValue, newExtraNote.trim() || undefined)}
                    className="rounded bg-sky-600 px-2 py-1 text-xs hover:bg-sky-500"
                  >
                    新增托管变量
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
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
      {pendingAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-label="确认环境变量操作">
          <div className="max-w-md rounded-lg border border-slate-600 bg-slate-900 p-4 shadow-xl">
            <h3 className="text-sm font-medium text-slate-100">确认操作</h3>
            <p className="mt-2 text-sm text-slate-300">
              {pendingAction.confirmMigration
                ? "该变量当前不在 oc-switch 托管区。更新后会迁移到托管块；旧值不会显示。"
                : pendingAction.confirmComplex
                  ? "该变量存在重复或复杂 .env 语法。迁移会写成标准 KEY=<新值>，可能改变 OpenClaw 解析结果。"
                  : "请确认继续此环境变量操作。备份将包含 .env 明文。"}
            </p>
            {pendingAction.warnings.length ? (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-300">
                {pendingAction.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setPendingAction(null)} className="rounded border border-slate-600 px-3 py-1.5 text-sm">
                取消
              </button>
              <button type="button" onClick={() => void confirmPendingAction()} className="rounded bg-sky-600 px-3 py-1.5 text-sm hover:bg-sky-500">
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <p className="mt-4 text-xs text-slate-500">访问 Token 仅存于 sessionStorage，不会显示在界面上。</p>
    </section>
  );
}
