import { useCallback, useEffect, useState } from "react";
import type {
  ApiClient,
  EnvIndexResponse,
  EnvVariableSummary,
  EnvWriteVerification,
  GatewayEnvSyncResult,
  PathSettingsResponse,
  RuntimePathCandidateGroup,
  SettingsResponse
} from "../api";
import { formatEnvWriteSuccess, formatGatewayServiceEnvLabel, nextStepHintForGatewayEnvSync } from "../env-feedback";
import { DataTable } from "../components/DataTable";
import { EnvMigrationConfirmDialog } from "../components/EnvMigrationConfirmDialog";
import { GatewayApplyBanner } from "../components/GatewayApplyBanner";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui/button";
import { Pill } from "../components/ui/pill";
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
  const toast = useToast();
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
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
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
  const [gatewayApply, setGatewayApply] = useState<{
    envWrite: EnvWriteVerification;
    gatewayEnvSync?: GatewayEnvSyncResult;
  } | null>(null);
  const [gatewayManualLoading, setGatewayManualLoading] = useState(false);
  const [gatewayApplyCandidateId, setGatewayApplyCandidateId] = useState<string | null>(null);

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
      const matchedGroup = (nextPaths.runtimeCandidateGroups ?? []).find(
        (group) =>
          group.openclawPath === nextPaths.active.openclawPath &&
          group.envPath === nextPaths.active.envPath
      );
      setSelectedCandidateId(matchedGroup?.candidateId ?? null);
      setGatewayApplyCandidateId(matchedGroup?.candidateId ?? null);
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

  function showGatewayApply(result: { envWrite?: EnvWriteVerification | undefined; gatewayEnvSync?: GatewayEnvSyncResult }) {
    if (!result.envWrite?.verified) {
      setGatewayApply(null);
      return;
    }
    setGatewayApply({
      envWrite: result.envWrite,
      ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
    });
  }

  function withGatewayHint(message: string, result: { gatewayEnvSync?: GatewayEnvSyncResult }) {
    return `${message} ${nextStepHintForGatewayEnvSync(result.gatewayEnvSync)}`;
  }

  async function handleManualGatewayApply() {
    setGatewayManualLoading(true);
    setError(null);
    try {
      const groups = pathSettings?.runtimeCandidateGroups ?? [];
      if (groups.length > 1 && !gatewayApplyCandidateId) {
        setError("请先选择运行实例后再同步并重启 Gateway");
        return;
      }
      const candidateId = gatewayApplyCandidateId
        ?? (groups.length === 1 ? groups[0]?.candidateId : undefined);
      const result = await client.applyGateway(candidateId);
      if (!result.ok) throw new Error(result.restart.message);
      toast.success(`已同步托管块到 ${formatGatewayServiceEnvLabel(result.sync)} 并重启 Gateway。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gateway 操作失败");
    } finally {
      setGatewayManualLoading(false);
    }
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
      const needsMigration = preview.requiresMigration || Boolean(summary?.present && !summary.managed);
      const needsComplex = preview.requiresComplex || Boolean(summary?.complex || summary?.duplicate);
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
      const result = await client.updateEnvVar({ type: "upsert", envVar, value, ...(note ? { note } : {}) });
      setValueInputs((prev) => ({ ...prev, [envVar]: "" }));
      toast.success(formatEnvWriteSuccess({
        label: envVar,
        envWrite: result.envWrite,
        gatewayEnvSync: result.gatewayEnvSync,
        fallback: `${envVar} 已写入新值`
      }));
      showGatewayApply(result);
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
      const needsComplex = preview.requiresComplex || Boolean(summary?.complex || summary?.duplicate);
      if (preview.requiresConfirmation || needsComplex) {
        setPendingAction({
          envVar,
          type: "delete",
          warnings: preview.warnings,
          confirmComplex: needsComplex
        });
        return;
      }
      const result = await client.deleteEnvVar({ type: "delete", envVar });
      toast.success(withGatewayHint(`${envVar} 已删除`, result));
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
      const needsComplex = preview.requiresComplex || Boolean(summary?.complex || summary?.duplicate);
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
      const result = await client.renameEnvVar({ type: "rename", fromEnvVar, toEnvVar: nextName, ...(note ? { note } : {}) });
      setRenameInputs((prev) => ({ ...prev, [fromEnvVar]: "" }));
      toast.success(withGatewayHint(`${fromEnvVar} 已重命名为 ${nextName}`, result));
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
        const result = await client.updateEnvVar({
          type: "upsert",
          envVar,
          value: pendingAction.value,
          ...(pendingAction.note ? { note: pendingAction.note } : {}),
          ...(pendingAction.confirmMigration ? { confirmMigration: true } : {}),
          ...(pendingAction.confirmComplex ? { confirmComplex: true } : {})
        });
        setValueInputs((prev) => ({ ...prev, [envVar]: "" }));
        toast.success(formatEnvWriteSuccess({
          label: envVar,
          envWrite: result.envWrite,
          gatewayEnvSync: result.gatewayEnvSync,
          fallback: pendingAction.confirmMigration
            ? `${envVar} 已迁入托管块并写入新值`
            : pendingAction.confirmComplex
              ? `${envVar} 已改写为标准格式并写入新值`
              : `${envVar} 已写入新值`
        }));
        showGatewayApply(result);
      } else if (pendingAction.type === "delete" && pendingAction.envVar) {
        const result = await client.deleteEnvVar({
          type: "delete",
          envVar: pendingAction.envVar,
          ...(pendingAction.confirmComplex ? { confirmComplex: true } : {})
        });
        toast.success(withGatewayHint(`${pendingAction.envVar} 已删除`, result));
      } else if (pendingAction.type === "rename" && pendingAction.fromEnvVar && pendingAction.toEnvVar) {
        const fromEnvVar = pendingAction.fromEnvVar;
        const result = await client.renameEnvVar({
          type: "rename",
          fromEnvVar,
          toEnvVar: pendingAction.toEnvVar,
          ...(pendingAction.note ? { note: pendingAction.note } : {}),
          ...(pendingAction.confirmComplex ? { confirmComplex: true } : {})
        });
        setRenameInputs((prev) => ({ ...prev, [fromEnvVar]: "" }));
        toast.success(withGatewayHint(`${fromEnvVar} 已重命名为 ${pendingAction.toEnvVar}`, result));
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
      toast.success("orphan keys 已清理");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "清理失败");
    }
  }

  async function handleSwitchPaths() {
    try {
        const matchedCandidateId =
        selectedCandidateId &&
        (pathSettings?.runtimeCandidateGroups ?? []).some(
          (group) =>
            group.candidateId === selectedCandidateId &&
            group.openclawPath === selectedOpenClawPath &&
            group.envPath === selectedEnvPath
        )
          ? selectedCandidateId
          : undefined;
      if (matchedCandidateId) {
        await client.updatePathSettings(
          selectedOpenClawPath,
          selectedEnvPath,
          matchedCandidateId
        );
      } else {
        await client.updatePathSettings(selectedOpenClawPath, selectedEnvPath);
      }
      await load();
      toast.success("路径已切换");
    } catch (err) {
      setError(err instanceof Error ? err.message : "切换路径失败");
    }
  }

  function selectRuntimeGroup(group: RuntimePathCandidateGroup) {
    setSelectedOpenClawPath(group.openclawPath);
    setSelectedEnvPath(group.envPath);
    setSelectedCandidateId(group.candidateId);
    setManualOpenClawPath("");
    setManualEnvPath("");
  }

  function applyManualPaths() {
    if (manualOpenClawPath.trim()) setSelectedOpenClawPath(manualOpenClawPath.trim());
    if (manualEnvPath.trim()) setSelectedEnvPath(manualEnvPath.trim());
    setSelectedCandidateId(null);
  }

  function runtimeStatusCopy(settings: PathSettingsResponse): {
    text: string;
    tone: "neutral" | "warning" | "none";
  } | null {
    const status = settings.runtimeDiscovery?.status;
    if (!status) return null;
    if (status === "resolved") {
      const confidences = [
        ...(settings.runtimeDiscovery?.instances ?? []).map((item) => item.confidence),
        ...(settings.runtimeCandidateGroups ?? []).map((item) => item.confidence)
      ].filter(Boolean);
      if (confidences.some((item) => item === "confirmed" || item === "strong")) {
        return { text: "已确认管理源", tone: "neutral" };
      }
      if (confidences.some((item) => item === "inferred")) {
        return {
          text: "由运行中 Gateway 与默认 state dir 推断",
          tone: "neutral"
        };
      }
      return { text: "已确认管理源", tone: "neutral" };
    }
    if (status === "gateway-detected-path-unresolved") {
      return {
        text: "检测到 Gateway，但无法确认其管理源 .env",
        tone: "warning"
      };
    }
    if (status === "gateway-not-detected") {
      return { text: "未检测到运行中的 Gateway", tone: "neutral" };
    }
    if (status === "probe-failed") {
      return { text: "运行实例探测失败，当前路径未改变", tone: "neutral" };
    }
    return null;
  }

  function renderStatusPill(item: EnvVariableSummary) {
    if (item.missing) return <Pill variant="warning">缺失</Pill>;
    if (item.managed) return <Pill variant="success">托管</Pill>;
    return <Pill variant="muted">未托管</Pill>;
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
      {gatewayApply ? (
        <GatewayApplyBanner
          client={client}
          envWrite={gatewayApply.envWrite}
          {...(gatewayApply.gatewayEnvSync ? { gatewayEnvSync: gatewayApply.gatewayEnvSync } : {})}
          onDismiss={() => setGatewayApply(null)}
        />
      ) : null}

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

          <Card>
            <CardHeader>
              <CardTitle>Gateway 环境</CardTitle>
              <CardDescription>
                将 oc-switch 托管块同步到 Gateway 服务环境文件并重启 Gateway，使运行中进程加载新密钥。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                命令等价于 <code className="rounded bg-muted px-1">{effective.gatewayRestartCommand}</code>，会先执行 sync-env。
              </p>
              {(pathSettings?.runtimeCandidateGroups?.length ?? 0) > 1 ? (
                <div className="space-y-2" role="radiogroup" aria-label="Gateway 目标运行实例">
                  <p className="text-sm text-muted-foreground">检测到多个运行实例，请先选择要同步/重启的目标：</p>
                  {(pathSettings?.runtimeCandidateGroups ?? []).map((group) => (
                    <label
                      key={group.candidateId}
                      className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/40"
                    >
                      <input
                        type="radio"
                        name="gateway-apply-candidate"
                        className="mt-1"
                        checked={gatewayApplyCandidateId === group.candidateId}
                        aria-label={`Gateway 目标运行实例 ${group.candidateId}`}
                        onChange={() => setGatewayApplyCandidateId(group.candidateId)}
                      />
                      <span className="min-w-0 break-all">
                        <span className="font-medium">{group.candidateId}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{group.envPath}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
              <Button
                disabled={gatewayManualLoading}
                onClick={() => void handleManualGatewayApply()}
              >
                {gatewayManualLoading ? "处理中…" : "同步并重启 Gateway"}
              </Button>
            </CardContent>
          </Card>

          {effective.orphanEnvKeys.length > 0 && (
            <Card className="border-warning/50">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <div className="space-y-1">
                  <CardTitle className="text-warning">Orphan env keys</CardTitle>
                  <CardDescription>发现未关联任何 Provider 的环境变量。</CardDescription>
                </div>
                <Button
                  onClick={() => void handleCleanupOrphans()}
                  className="bg-warning text-warning-foreground hover:bg-warning/90"
                >
                  清理 orphan keys
                </Button>
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
                {(() => {
                  const statusCopy = runtimeStatusCopy(pathSettings);
                  if (!statusCopy) return null;
                  return (
                    <p
                      className={
                        statusCopy.tone === "warning"
                          ? "mb-4 text-sm font-medium text-warning"
                          : "mb-4 text-sm text-muted-foreground"
                      }
                    >
                      {statusCopy.text}
                    </p>
                  );
                })()}

                {(pathSettings.runtimeCandidateGroups ?? []).length > 0 ? (
                  <div className="mb-6 space-y-3">
                    <p className="text-sm font-medium">运行中实例候选</p>
                    <div className="space-y-3">
                      {(pathSettings.runtimeCandidateGroups ?? []).map((group) => {
                        const selected = selectedCandidateId === group.candidateId;
                        return (
                          <button
                            key={group.candidateId}
                            type="button"
                            aria-label={`选择运行实例 ${group.candidateId}`}
                            aria-pressed={selected}
                            onClick={() => selectRuntimeGroup(group)}
                            className={
                              selected
                                ? "w-full rounded-lg border border-primary bg-primary/5 p-4 text-left"
                                : "w-full rounded-lg border border-input bg-background p-4 text-left hover:bg-accent/40"
                            }
                          >
                            <div className="space-y-1 text-sm">
                              <p className="font-medium">{group.instanceId}</p>
                              <p className="break-all text-muted-foreground">config: {group.openclawPath}</p>
                              <p className="break-all text-muted-foreground">.env: {group.envPath}</p>
                              {group.confidence ? (
                                <p className="text-muted-foreground">
                                  置信度：{group.confidence}
                                  {group.confidence === "confirmed" || group.confidence === "strong"
                                    ? "（已确认管理源）"
                                    : ""}
                                </p>
                              ) : null}
                              {group.serviceEnvPath ? (
                                <p className="break-all text-muted-foreground">
                                  <code className="rounded bg-muted px-1">{group.serviceEnvPath}</code>
                                  <span className="ml-2">Gateway 运行时快照，由 sync 维护，不作为 active .env。</span>
                                </p>
                              ) : null}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                      openclaw.json 路径
                    </label>
                    <select
                      aria-label="openclaw.json 路径"
                      value={selectedOpenClawPath}
                      onChange={(event) => {
                        setSelectedOpenClawPath(event.target.value);
                        setSelectedCandidateId(null);
                      }}
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
                      onChange={(event) => {
                        setSelectedEnvPath(event.target.value);
                        setSelectedCandidateId(null);
                      }}
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
                        onChange={(event) => {
                          setManualOpenClawPath(event.target.value);
                          setSelectedCandidateId(null);
                        }}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium leading-none">手动 .env 路径</label>
                      <input
                        aria-label="手动 .env 路径"
                        value={manualEnvPath}
                        onChange={(event) => {
                          setManualEnvPath(event.target.value);
                          setSelectedCandidateId(null);
                        }}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    </div>
                    <Button variant="outline" onClick={applyManualPaths}>
                      使用手动路径
                    </Button>
                  </div>
                  {!selectedCandidateId ? (
                    <p className="text-sm text-muted-foreground">
                      当前为手动模式：未验证配对，不会附带运行实例 candidateId。
                    </p>
                  ) : null}
                </div>

                <div className="mt-6">
                  <Button onClick={() => void handleSwitchPaths()}>
                    切换路径
                  </Button>
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
                <CardContent>
                  <DataTable
                    rows={providerVars}
                    rowKey={(item) => item.envVar}
                    emptyMessage="暂无 Provider 环境变量"
                    minWidthClass="min-w-[19rem] md:min-w-[34rem] lg:min-w-[52rem]"
                    columns={[
                      {
                        key: "envVar",
                        header: "变量",
                        wrap: "anywhere",
                        className: "min-w-[11rem]",
                        render: (item) => <span className="font-mono text-xs">{item.envVar}</span>
                      },
                      {
                        key: "provider",
                        header: "Provider",
                        className: "hidden lg:table-cell",
                        render: (item) => <span className="text-muted-foreground">{item.providerIds.join(", ")}</span>
                      },
                      { key: "status", header: "状态", wrap: "nowrap", render: renderStatusPill },
                      {
                        key: "risk",
                        header: "风险",
                        className: "hidden md:table-cell",
                        render: (item) => <span className="text-muted-foreground">{renderRisk(item)}</span>
                      },
                      {
                        key: "value",
                        header: "新值",
                        className: "min-w-[9rem]",
                        render: (item) => (
                          <input
                            type="password"
                            aria-label={`${item.envVar} 新值`}
                            value={valueInputs[item.envVar] ?? ""}
                            onChange={(event) => setInputValue(item.envVar, event.target.value)}
                            className="flex h-8 w-full min-w-[8rem] rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            autoComplete="off"
                          />
                        )
                      },
                      {
                        key: "actions",
                        header: "操作",
                        wrap: "nowrap",
                        render: (item) => (
                          <Button
                            size="sm"
                            onClick={() => void submitEnvUpsert(item.envVar, valueInputs[item.envVar] ?? "")}
                          >
                            {item.missing ? "填写" : "重填"}
                          </Button>
                        )
                      }
                    ]}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>高级：额外托管变量</CardTitle>
                      <CardDescription>管理未绑定特定 Provider 的系统级或额外环境变量。</CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      aria-expanded={advancedOpen}
                      onClick={() => setAdvancedOpen((open) => !open)}
                    >
                      {advancedOpen ? "收起" : "展开"}
                    </Button>
                  </div>
                </CardHeader>
                {advancedOpen && (
                  <CardContent className="space-y-6 pt-0">
                    <DataTable
                      rows={extraVars}
                      rowKey={(item) => item.envVar}
                      emptyMessage="暂无额外托管变量"
                      minWidthClass="min-w-[19rem] md:min-w-[32rem] lg:min-w-[46rem]"
                      columns={[
                        {
                          key: "envVar",
                          header: "变量",
                          wrap: "anywhere",
                          className: "min-w-[11rem]",
                          render: (item) => <span className="font-mono text-xs">{item.envVar}</span>
                        },
                        {
                          key: "risk",
                          header: "状态",
                          wrap: "nowrap",
                          render: (item) => <span className="text-muted-foreground">{renderRisk(item)}</span>
                        },
                        {
                          key: "note",
                          header: "备注",
                          className: "hidden lg:table-cell",
                          render: (item) => <span className="text-muted-foreground">{item.note ?? "—"}</span>
                        },
                        {
                          key: "value",
                          header: "新值",
                          render: (item) => (
                            <input
                              type="password"
                              aria-label={`${item.envVar} 新值`}
                              value={valueInputs[item.envVar] ?? ""}
                              onChange={(event) => setInputValue(item.envVar, event.target.value)}
                              className="flex h-8 w-full min-w-[6rem] rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                              autoComplete="off"
                            />
                          )
                        },
                        {
                          key: "rename",
                          header: "重命名为",
                          render: (item) => (
                            <input
                              aria-label={`${item.envVar} 新变量名`}
                              value={renameInputs[item.envVar] ?? ""}
                              onChange={(event) => setRenameValue(item.envVar, event.target.value)}
                              className="flex h-8 w-full min-w-[6rem] rounded-md border border-input bg-transparent px-3 py-1 font-mono text-xs shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            />
                          )
                        },
                        {
                          key: "actions",
                          header: "操作",
                          align: "right",
                          render: (item) => (
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void submitEnvUpsert(item.envVar, valueInputs[item.envVar] ?? "", item.note)}
                              >
                                重填
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void submitEnvRename(item.envVar, renameInputs[item.envVar] ?? "", item.note)}
                              >
                                重命名
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => void submitEnvDelete(item.envVar)}
                              >
                                删除
                              </Button>
                            </div>
                          )
                        }
                      ]}
                    />

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
                        <Button
                          onClick={() => void submitEnvUpsert(newExtraVar.trim(), newExtraValue, newExtraNote.trim() || undefined)}
                        >
                          新增托管变量
                        </Button>
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
        <EnvMigrationConfirmDialog
          open
          warnings={pendingAction.warnings}
          {...(pendingAction.confirmMigration ? { confirmMigration: true } : {})}
          {...(pendingAction.confirmComplex ? { confirmComplex: true } : {})}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => void confirmPendingAction()}
        />
      ) : null}

      <p className="mt-6 text-xs text-muted-foreground text-center">
        访问 Token 仅存于 sessionStorage，不会显示在界面上。
      </p>
    </section>
  );
}
