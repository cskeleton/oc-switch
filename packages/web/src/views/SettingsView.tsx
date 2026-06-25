import { useCallback, useEffect, useState } from "react";
import type { ApiClient, EnvIndexResponse, EnvVariableSummary, PathSettingsResponse, SettingsResponse } from "../api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";

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
  const [manualOpenClawPath, setManualOpenClawPath] = useState("");
  const [manualEnvPath, setManualEnvPath] = useState("");
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
    { label: ".env 路径", value: effective.envPath ?? pathSettings?.active.envPath ?? "未知" },
    { label: "Bind 地址", value: effective.bindAddress },
    { label: "端口", value: String(effective.port) },
    { label: "备份保留份数", value: `${effective.backupRetention}（默认）` },
    { label: "Gateway 重启命令", value: effective.gatewayRestartCommand }
  ];

  return (
    <section data-testid="settings-view" className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">管理 OpenClaw 配置、路径与环境变量。</p>
      </div>

      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

      <Tabs defaultValue="general" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="general">通用</TabsTrigger>
          <TabsTrigger value="paths">路径</TabsTrigger>
          <TabsTrigger value="environment">环境变量</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>服务器信息</CardTitle>
              <CardDescription>当前服务器运行状态与基础配置。</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                {items.map((item) => (
                  <div key={item.label} className="space-y-1 rounded-md border p-3">
                    <dt className="text-xs uppercase tracking-wide text-muted-foreground">{item.label}</dt>
                    <dd className="break-all text-sm font-medium">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          {effective.orphanEnvKeys.length > 0 && (
            <Card className="border-amber-500/50">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="space-y-1">
                  <CardTitle className="text-amber-500">Orphan env keys</CardTitle>
                  <CardDescription>发现未关联任何 Provider 的环境变量。</CardDescription>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCleanupOrphans()}
                  className="inline-flex h-9 items-center justify-center rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-amber-600/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  清理 orphan keys
                </button>
              </CardHeader>
              <CardContent>
                <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                  {effective.orphanEnvKeys.map((key) => (
                    <li key={key}>{key}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="paths">
          {pathSettings ? (
            <Card>
              <CardHeader>
                <CardTitle>OpenClaw 路径</CardTitle>
                <CardDescription>配置 openclaw.json 和 .env 的文件路径。</CardDescription>
              </CardHeader>
              <CardContent>
                {!pathSettings.envPaths.some((item) => item.source === "running-instance") ? (
                  <p className="mb-4 text-sm font-medium text-amber-500">
                    未能确认运行中 OpenClaw 使用的 env 文件。请选择候选路径，或向当前 OpenClaw 实例确认实际 runtime env 文件。
                  </p>
                ) : null}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      openclaw.json 路径
                    </label>
                    <select
                      aria-label="openclaw.json 路径"
                      value={selectedOpenClawPath}
                      onChange={(event) => setSelectedOpenClawPath(event.target.value)}
                      className="flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pathSettings.openclawPaths.map((item) => (
                        <option key={`${item.source}:${item.path}`} value={item.path}>
                          {item.path}（{item.label}{item.recommended ? "，推荐" : ""}）
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      .env 路径
                    </label>
                    <select
                      aria-label=".env 路径"
                      value={selectedEnvPath}
                      onChange={(event) => setSelectedEnvPath(event.target.value)}
                      className="flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pathSettings.envPaths.map((item) => (
                        <option key={`${item.source}:${item.path}`} value={item.path}>
                          {item.path}（{item.label}{item.recommended ? "，推荐" : ""}）
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="mt-6 space-y-4 rounded-lg border bg-muted/50 p-4">
                  <div className="grid gap-4 md:grid-cols-[1fr_1fr_auto] items-end">
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none">手动 openclaw.json 路径</label>
                      <input
                        aria-label="手动 openclaw.json 路径"
                        value={manualOpenClawPath}
                        onChange={(event) => setManualOpenClawPath(event.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none">手动 .env 路径</label>
                      <input
                        aria-label="手动 .env 路径"
                        value={manualEnvPath}
                        onChange={(event) => setManualEnvPath(event.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (manualOpenClawPath.trim()) setSelectedOpenClawPath(manualOpenClawPath.trim());
                        if (manualEnvPath.trim()) setSelectedEnvPath(manualEnvPath.trim());
                      }}
                      className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      使用手动路径
                    </button>
                  </div>
                </div>

                <div className="mt-6">
                  <button
                    type="button"
                    onClick={() => void handleSwitchPaths()}
                    className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    切换路径
                  </button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-muted-foreground">加载路径配置中…</p>
          )}
        </TabsContent>

        <TabsContent value="environment" className="space-y-6">
          {envIndex ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>Provider 密钥（常规）</CardTitle>
                  <CardDescription>
                    管理当前 OpenClaw runtime `.env`（{pathSettings?.active.envPath ?? effective.envPath ?? "未知"}）。
                    不显示旧值；备份会包含 .env 明文。
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                        <tr>
                          <th className="px-4 py-3 font-medium">变量</th>
                          <th className="px-4 py-3 font-medium">Provider</th>
                          <th className="px-4 py-3 font-medium">状态</th>
                          <th className="px-4 py-3 font-medium">风险</th>
                          <th className="px-4 py-3 font-medium">新值</th>
                          <th className="px-4 py-3 font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {providerVars.map((item) => (
                          <tr key={item.envVar} className="hover:bg-muted/50">
                            <td className="px-4 py-3 font-mono text-xs">{item.envVar}</td>
                            <td className="px-4 py-3 text-muted-foreground">{item.providerIds.join(", ")}</td>
                            <td className="px-4 py-3 text-muted-foreground">{renderStatus(item)}</td>
                            <td className="px-4 py-3 text-muted-foreground">{renderRisk(item)}</td>
                            <td className="px-4 py-3">
                              <input
                                type="password"
                                aria-label={`${item.envVar} 新值`}
                                value={valueInputs[item.envVar] ?? ""}
                                onChange={(event) => setInputValue(item.envVar, event.target.value)}
                                className="flex h-8 w-full min-w-[8rem] rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                autoComplete="off"
                              />
                            </td>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                onClick={() => void submitEnvUpsert(item.envVar, valueInputs[item.envVar] ?? "")}
                                className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              >
                                {item.missing ? "填写" : "重填"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>高级：额外托管变量</CardTitle>
                      <CardDescription>管理未绑定特定 Provider 的系统级或额外环境变量。</CardDescription>
                    </div>
                    <button
                      type="button"
                      aria-expanded={advancedOpen}
                      onClick={() => setAdvancedOpen((open) => !open)}
                      className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {advancedOpen ? "收起" : "展开"}
                    </button>
                  </div>
                </CardHeader>
                {advancedOpen && (
                  <CardContent className="space-y-6 pt-0">
                    <div className="overflow-hidden rounded-md border">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                          <tr>
                            <th className="px-4 py-3 font-medium">变量</th>
                            <th className="px-4 py-3 font-medium">状态</th>
                            <th className="px-4 py-3 font-medium">备注</th>
                            <th className="px-4 py-3 font-medium">新值</th>
                            <th className="px-4 py-3 font-medium">重命名为</th>
                            <th className="px-4 py-3 font-medium text-right">操作</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {extraVars.map((item) => (
                            <tr key={item.envVar} className="hover:bg-muted/50">
                              <td className="px-4 py-3 font-mono text-xs">{item.envVar}</td>
                              <td className="px-4 py-3 text-muted-foreground">{renderRisk(item)}</td>
                              <td className="px-4 py-3 text-muted-foreground">{item.note ?? "—"}</td>
                              <td className="px-4 py-3">
                                <input
                                  type="password"
                                  aria-label={`${item.envVar} 新值`}
                                  value={valueInputs[item.envVar] ?? ""}
                                  onChange={(event) => setInputValue(item.envVar, event.target.value)}
                                  className="flex h-8 w-full min-w-[6rem] rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                  autoComplete="off"
                                />
                              </td>
                              <td className="px-4 py-3">
                                <input
                                  aria-label={`${item.envVar} 新变量名`}
                                  value={renameInputs[item.envVar] ?? ""}
                                  onChange={(event) => setRenameValue(item.envVar, event.target.value)}
                                  className="flex h-8 w-full min-w-[6rem] rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                />
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void submitEnvUpsert(item.envVar, valueInputs[item.envVar] ?? "", item.note)}
                                    className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                                  >
                                    重填
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void submitEnvRename(item.envVar, renameInputs[item.envVar] ?? "", item.note)}
                                    className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                                  >
                                    重命名
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void submitEnvDelete(item.envVar)}
                                    className="inline-flex h-8 items-center justify-center rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground shadow-sm hover:bg-destructive/90"
                                  >
                                    删除
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="rounded-lg border bg-muted/50 p-4">
                      <h4 className="mb-3 text-sm font-medium">新增额外变量</h4>
                      <div className="grid gap-3 md:grid-cols-4">
                        <input
                          aria-label="新变量名"
                          placeholder="变量名"
                          value={newExtraVar}
                          onChange={(event) => setNewExtraVar(event.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <input
                          type="password"
                          aria-label="新变量值"
                          placeholder="新值"
                          value={newExtraValue}
                          onChange={(event) => setNewExtraValue(event.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          autoComplete="off"
                        />
                        <input
                          aria-label="用途备注"
                          placeholder="备注（可选）"
                          value={newExtraNote}
                          onChange={(event) => setNewExtraNote(event.target.value)}
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <button
                          type="button"
                          onClick={() => void submitEnvUpsert(newExtraVar.trim(), newExtraValue, newExtraNote.trim() || undefined)}
                          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          新增托管变量
                        </button>
                      </div>
                    </div>
                  </CardContent>
                )}
              </Card>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">加载环境变量中…</p>
          )}
        </TabsContent>
      </Tabs>

      {pendingAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-label="确认环境变量操作">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold leading-none tracking-tight">确认操作</h3>
            <p className="mt-4 text-sm text-muted-foreground">
              {pendingAction.confirmMigration
                ? "该变量当前不在 oc-switch 托管区。更新后会迁移到托管块；旧值不会显示。"
                : pendingAction.confirmComplex
                  ? "该变量存在重复或复杂 .env 语法。迁移会写成标准 KEY=<新值>，可能改变 OpenClaw 解析结果。"
                  : "请确认继续此环境变量操作。备份将包含 .env 明文。"}
            </p>
            {pendingAction.warnings.length ? (
              <ul className="mt-4 list-inside list-disc text-sm font-medium text-amber-500">
                {pendingAction.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingAction(null)}
                className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmPendingAction()}
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="mt-6 text-xs text-muted-foreground text-center">
        访问 Token 仅存于 sessionStorage，不会显示在界面上。
      </p>
    </section>
  );
}
