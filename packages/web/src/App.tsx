import {
  Archive,
  Box,
  Cpu,
  LayoutDashboard,
  Layers,
  Loader2,
  Settings
} from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createApiClient } from "./api";
import {
  clearAuthSession,
  persistAuth,
  readAuthSnapshot,
  shouldAutoLogin,
  type AuthPreferences
} from "./auth-storage";
import { ThemeToggle } from "./components/ThemeToggle";
import { ToastProvider } from "./components/Toast";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Skeleton } from "./components/ui/skeleton";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";

// 路由级代码分割：各视图按需加载，首屏只拉壳 + 登录页
const Dashboard = lazy(() => import("./views/Dashboard").then((m) => ({ default: m.Dashboard })));
const ProvidersView = lazy(() => import("./views/ProvidersView").then((m) => ({ default: m.ProvidersView })));
const ModelsView = lazy(() => import("./views/ModelsView").then((m) => ({ default: m.ModelsView })));
const PresetsView = lazy(() => import("./views/PresetsView").then((m) => ({ default: m.PresetsView })));
const BackupsView = lazy(() => import("./views/BackupsView").then((m) => ({ default: m.BackupsView })));
const SettingsView = lazy(() => import("./views/SettingsView").then((m) => ({ default: m.SettingsView })));

const DEFAULT_BASE_URL = "http://127.0.0.1:7420";

export type AppRoute = "dashboard" | "providers" | "models" | "presets" | "backups" | "settings";

interface NavItem {
  id: AppRoute;
  label: string;
  icon: typeof LayoutDashboard;
}

// 主导航；「预设」为遗留入口，在桌面侧栏底部单独分区
const NAV_MAIN: NavItem[] = [
  { id: "dashboard", label: "仪表盘", icon: LayoutDashboard },
  { id: "providers", label: "服务商", icon: Box },
  { id: "models", label: "模型", icon: Cpu },
  { id: "backups", label: "备份", icon: Archive },
  { id: "settings", label: "设置", icon: Settings }
];

const NAV_LEGACY: NavItem[] = [{ id: "presets", label: "预设", icon: Layers }];

function defaultBaseUrl(): string {
  if (typeof window !== "undefined" && window.location.origin && window.location.origin !== "null") {
    return window.location.origin;
  }
  return DEFAULT_BASE_URL;
}

/** 品牌区：渐变方块 logo + 字标；compact 隐藏副标题（移动端顶栏） */
function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-brand/75 text-white shadow-sm">
        <Box className="h-4 w-4" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-foreground">oc-switch</p>
        {compact ? null : <p className="text-[11px] text-muted-foreground">OpenClaw 配置管理</p>}
      </div>
    </div>
  );
}

/** 侧栏导航项：选中态为 brand 底 + 左竖条 */
function SideNavButton({ item, active, onSelect }: { item: NavItem; active: boolean; onSelect: (id: AppRoute) => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
        active
          ? "bg-brand/10 font-medium text-brand"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {active ? (
        <span className="absolute left-0.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
      ) : null}
      <Icon className="h-4 w-4 shrink-0" />
      {item.label}
    </button>
  );
}

/** 路由懒加载 fallback：与典型页面结构相近的骨架 */
function RouteFallback() {
  return (
    <div role="status" aria-label="页面加载中" className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

/** 应用主壳：桌面全高侧栏 + 细顶栏；移动端顶栏品牌 + 横滚 tab */
export function App() {
  const [requestedProviderId, setRequestedProviderId] = useState<string | undefined>();
  // 初始快照只读一次，供下方各 state 的初始值共用
  const [initialAuth] = useState(() => readAuthSnapshot(defaultBaseUrl()));
  const [token, setToken] = useState(initialAuth.token);
  const [baseUrl, setBaseUrl] = useState(initialAuth.baseUrl);
  const [rememberToken, setRememberToken] = useState(initialAuth.rememberToken);
  const [autoLogin, setAutoLogin] = useState(initialAuth.autoLogin);
  const [connected, setConnected] = useState(initialAuth.sessionActive);
  const [autoLoginPending, setAutoLoginPending] = useState(() => shouldAutoLogin(initialAuth));
  const [route, setRoute] = useState<AppRoute>("dashboard");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [service, setService] = useState<{ ready: boolean; error?: string }>({ ready: false });

  const client = useMemo(
    () => createApiClient({ baseUrl, token }),
    [baseUrl, token, tick]
  );

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setService({ ready: false });
    void client.getServiceInfo().then(info => {
      if (info.protocolVersion !== 2) throw new Error("前后端版本不兼容，请重启 oc-switch 后刷新页面。");
      if (!cancelled) setService({ ready: true });
    }).catch(() => { if (!cancelled) setService({ ready: false, error: "无法确认服务版本。请重启 oc-switch 后刷新；依赖新版状态的操作暂不可用。" }); });
    return () => { cancelled = true; };
  }, [client, connected]);

  // 顶栏展示的连接 host（mono 字体 + 状态点）
  const hostLabel = useMemo(() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  }, [baseUrl]);

  // 校验通过后统一落盘并进入已连接态；手动连接与自动登录共用
  const finishConnect = useCallback(
    (nextToken: string, nextBaseUrl: string, prefs: AuthPreferences) => {
      persistAuth({ token: nextToken, baseUrl: nextBaseUrl, ...prefs });
      setConnectError(null);
      setConnected(true);
    },
    []
  );

  // 自动登录只在挂载时尝试一次：显式「断开」后不应被重新拉回已连接态
  useEffect(() => {
    if (!autoLoginPending) return;
    let cancelled = false;
    void (async () => {
      try {
        await createApiClient({ baseUrl: initialAuth.baseUrl, token: initialAuth.token }).getStatus();
        if (cancelled) return;
        finishConnect(initialAuth.token, initialAuth.baseUrl, {
          rememberToken: initialAuth.rememberToken,
          autoLogin: initialAuth.autoLogin
        });
      } catch (err) {
        if (cancelled) return;
        setConnectError(`自动登录失败：${err instanceof Error ? err.message : "连接失败"}`);
      } finally {
        if (!cancelled) setAutoLoginPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 依赖数组刻意留空：initialAuth / autoLoginPending 都是首屏快照，不参与重触发
  }, []);

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setConnectError(null);
    const testClient = createApiClient({ baseUrl, token });
    try {
      await testClient.getStatus();
      finishConnect(token, baseUrl, { rememberToken, autoLogin });
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : "连接失败");
    }
  }

  function handleDisconnect() {
    clearAuthSession();
    setAutoLogin(false);
    setConnected(false);
    // 记住密码时保留 Token 预填，方便直接重连
    if (!rememberToken) setToken("");
  }

  /** 取消「记住密码」时联动关闭「自动登录」——没有凭据可用 */
  function handleRememberChange(next: boolean) {
    setRememberToken(next);
    if (!next) setAutoLogin(false);
  }

  if (autoLoginPending) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md" data-testid="auto-login-pending">
          <CardContent className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-brand" />
            正在自动登录…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand to-brand/75 text-white shadow-sm">
              <Box className="h-5 w-5" />
            </span>
            <CardTitle className="text-xl">oc-switch</CardTitle>
            <CardDescription>输入 API 地址与 Token 以连接本地服务</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={(e) => void handleConnect(e)} className="space-y-4">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">API 地址</span>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                  aria-label="API 地址"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Token</span>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <div className="space-y-2.5 rounded-lg border border-border bg-muted/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="remember-token" className="cursor-pointer font-normal">
                    记住密码
                  </Label>
                  <Switch
                    id="remember-token"
                    checked={rememberToken}
                    onCheckedChange={(value) => handleRememberChange(value === true)}
                    aria-label="记住密码"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label
                    htmlFor="auto-login"
                    className={cn(
                      "cursor-pointer font-normal",
                      rememberToken ? undefined : "cursor-not-allowed text-muted-foreground"
                    )}
                  >
                    自动登录
                  </Label>
                  <Switch
                    id="auto-login"
                    checked={autoLogin}
                    onCheckedChange={(value) => setAutoLogin(value === true)}
                    disabled={!rememberToken}
                    aria-label="自动登录"
                    title={rememberToken ? undefined : "需先勾选「记住密码」"}
                  />
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {rememberToken
                    ? "Token 将保存在此浏览器本地；自动登录会在打开页面时直接连接。"
                    : "勾选「记住密码」后才能开启自动登录。"}
                </p>
              </div>
              {connectError ? <p className="text-sm text-destructive">{connectError}</p> : null}
              <Button type="submit" className="w-full">
                连接
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  function renderRoute() {
    if (!service.ready) return <div role="status" className="rounded-md border border-border p-4 text-sm">{service.error ?? "正在确认服务版本…"}{service.error ? <Button variant="outline" className="ml-3" onClick={refresh}>重试</Button> : null}</div>;
    switch (route) {
      case "dashboard":
        return <Dashboard client={client} onConfigureProvider={id => { setRequestedProviderId(id); setRoute("providers"); }} />;
      case "providers":
        return <ProvidersView client={client} requestedProviderId={requestedProviderId} onRequestHandled={() => setRequestedProviderId(undefined)} onRefresh={refresh} onOpenSettings={() => setRoute("settings")} onOpenModels={() => setRoute("models")} />;
      case "models":
        return <ModelsView client={client} onOpenProviders={id => { setRequestedProviderId(id); setRoute("providers"); }} />;
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
    <ToastProvider>
      <div className="flex min-h-screen">
        {/* 桌面侧栏：全高 sticky，顶部品牌区，底部遗留分区 */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
          <div className="border-b border-border/60 px-5 py-4">
            <BrandMark />
          </div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
            {NAV_MAIN.map((item) => (
              <SideNavButton key={item.id} item={item} active={route === item.id} onSelect={setRoute} />
            ))}
            <div className="mt-auto border-t border-border pt-3">
              <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                遗留
              </p>
              {NAV_LEGACY.map((item) => (
                <SideNavButton key={item.id} item={item} active={route === item.id} onSelect={setRoute} />
              ))}
            </div>
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 顶栏：移动端带紧凑品牌；右侧连接状态 + 主题 + 断开 */}
          <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
            <div className="flex h-12 items-center justify-between gap-3 px-4 md:px-6">
              <div className="md:hidden">
                <BrandMark compact />
              </div>
              <div className="ml-auto flex items-center gap-2 md:gap-3">
                <span className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-muted-foreground sm:flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  {hostLabel}
                </span>
                <ThemeToggle embedded className="w-auto" />
                <Button variant="ghost" size="sm" onClick={handleDisconnect}>
                  断开
                </Button>
              </div>
            </div>
            {/* 移动端：横滚 tab，选中为 brand 下划线 */}
            <nav className="flex overflow-x-auto px-2 md:hidden">
              {[...NAV_MAIN, ...NAV_LEGACY].map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setRoute(id)}
                  className={cn(
                    "flex shrink-0 items-center gap-1 border-b-2 px-3 py-2 text-xs transition-colors",
                    route === id
                      ? "border-brand font-medium text-brand"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              ))}
            </nav>
          </header>

          <main className="flex-1 overflow-auto p-4 md:p-6">
            {/* key 触发路由切换进入动效 */}
            <div key={route} className="mx-auto w-full max-w-6xl animate-view-enter">
              <Suspense fallback={<RouteFallback />}>{renderRoute()}</Suspense>
            </div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
