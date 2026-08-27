import {
  Archive,
  Box,
  Cpu,
  LayoutDashboard,
  Layers,
  Loader2,
  Settings
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createApiClient } from "./api";
import {
  clearAuthSession,
  persistAuth,
  readAuthSnapshot,
  shouldAutoLogin,
  type AuthPreferences
} from "./auth-storage";
import { BackupsView } from "./views/BackupsView";
import { Dashboard } from "./views/Dashboard";
import { ModelsView } from "./views/ModelsView";
import { PresetsView } from "./views/PresetsView";
import { ProvidersView } from "./views/ProvidersView";
import { SettingsView } from "./views/SettingsView";
import { ThemeToggle } from "./components/ThemeToggle";
import { ToastProvider } from "./components/Toast";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";

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
  { id: "providers", label: "Providers", icon: Box },
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

/** 品牌区：渐变方块 logo + 字标 */
function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-brand/75 text-white shadow-sm">
        <Box className="h-4 w-4" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-foreground">oc-switch</p>
        <p className="text-[11px] text-muted-foreground">OpenClaw 配置管理</p>
      </div>
    </div>
  );
}

/** 应用主壳：顶栏 + 响应式导航（桌面侧栏 / 移动端横滚 tab） */
export function App() {
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

  const client = useMemo(
    () => createApiClient({ baseUrl, token }),
    [baseUrl, token, tick]
  );

  const refresh = useCallback(() => setTick((n) => n + 1), []);

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
    <ToastProvider>
      <div className="flex min-h-screen flex-col">
        {/* 顶栏：全宽，移动端同样保留 */}
        <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur-md">
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 md:px-6">
            <BrandMark />
            <div className="flex items-center gap-2 md:gap-3">
              <span className="hidden items-center gap-1.5 font-mono text-xs text-muted-foreground sm:flex">
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

        <div className="flex flex-1">
          {/* 桌面侧栏：选中态为 brand 左竖条 + bg-brand/10 圆角块；底部为遗留分区 */}
          <aside className="hidden w-56 shrink-0 border-r border-border bg-card md:block">
            <nav className="flex min-h-full flex-col gap-1 p-3">
              {NAV_MAIN.map(({ id, label, icon: Icon }) => {
                const active = route === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRoute(id)}
                    className={cn(
                      "relative flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-brand/10 font-medium text-brand"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    {active ? (
                      <span className="absolute left-0.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                    ) : null}
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                );
              })}
              <div className="mt-auto border-t border-border pt-3">
                <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  遗留
                </p>
                {NAV_LEGACY.map(({ id, label, icon: Icon }) => {
                  const active = route === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setRoute(id)}
                      className={cn(
                        "relative flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-brand/10 font-medium text-brand"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {active ? (
                        <span className="absolute left-0.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                      ) : null}
                      <Icon className="h-4 w-4" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </nav>
          </aside>

          <main className="flex-1 overflow-auto p-4 md:p-6">
            <div className="mx-auto w-full max-w-6xl">{renderRoute()}</div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
