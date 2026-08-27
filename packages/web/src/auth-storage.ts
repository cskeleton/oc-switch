/**
 * Web 登录凭据与偏好的浏览器持久化层。
 *
 * - sessionStorage：维持当前标签页会话（同 tab 刷新可直接恢复，历史行为）。
 * - localStorage：承载「记住密码」与「自动登录」，跨浏览器会话生效。
 *
 * 不变量：未勾选「记住密码」时「自动登录」一律无效——读、写两侧都强制，
 * 避免任何路径落盘出 remember=0 且 autoLogin=1 的组合。
 */

const TOKEN_KEY = "oc-switch-token";
const BASE_URL_KEY = "oc-switch-base-url";
const REMEMBER_KEY = "oc-switch-remember-token";
const AUTO_LOGIN_KEY = "oc-switch-auto-login";

export interface AuthPreferences {
  /** 记住密码：Token 写入 localStorage，下次打开预填 */
  rememberToken: boolean;
  /** 自动登录：打开页面即用记住的 Token 尝试连接 */
  autoLogin: boolean;
}

export interface AuthSnapshot extends AuthPreferences {
  token: string;
  baseUrl: string;
  /** 当前标签页会话内已连接过，可跳过校验直接恢复 */
  sessionActive: boolean;
}

function storage(kind: "session" | "local"): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return kind === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

function read(kind: "session" | "local", key: string): string {
  try {
    return storage(kind)?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(kind: "session" | "local", key: string, value: string) {
  try {
    storage(kind)?.setItem(key, value);
  } catch {
    // 忽略存储失败（隐私模式 / storage 被禁用）
  }
}

function remove(kind: "session" | "local", key: string) {
  try {
    storage(kind)?.removeItem(key);
  } catch {
    // 忽略存储失败
  }
}

/** 强制不变量：不记住密码就不可能自动登录 */
export function normalizeAuthPreferences(prefs: AuthPreferences): AuthPreferences {
  return {
    rememberToken: prefs.rememberToken,
    autoLogin: prefs.rememberToken && prefs.autoLogin
  };
}

/** 读取初始登录态；`fallbackBaseUrl` 在无任何历史记录时兜底 */
export function readAuthSnapshot(fallbackBaseUrl: string): AuthSnapshot {
  const rememberToken = read("local", REMEMBER_KEY) === "1";
  const { autoLogin } = normalizeAuthPreferences({
    rememberToken,
    autoLogin: read("local", AUTO_LOGIN_KEY) === "1"
  });
  const sessionToken = read("session", TOKEN_KEY);
  return {
    // 会话 token 优先；否则仅在记住密码时回落到 localStorage
    token: sessionToken || (rememberToken ? read("local", TOKEN_KEY) : ""),
    baseUrl: read("session", BASE_URL_KEY) || read("local", BASE_URL_KEY) || fallbackBaseUrl,
    rememberToken,
    autoLogin,
    sessionActive: sessionToken !== ""
  };
}

/** 是否应在打开页面时直接尝试自动登录 */
export function shouldAutoLogin(snapshot: AuthSnapshot): boolean {
  return !snapshot.sessionActive && snapshot.autoLogin && snapshot.token !== "";
}

/** 连接成功后落盘：会话态始终写入，持久态按偏好决定 */
export function persistAuth(input: { token: string; baseUrl: string } & AuthPreferences): void {
  const { rememberToken, autoLogin } = normalizeAuthPreferences(input);
  write("session", TOKEN_KEY, input.token);
  write("session", BASE_URL_KEY, input.baseUrl);
  write("local", BASE_URL_KEY, input.baseUrl);
  write("local", REMEMBER_KEY, rememberToken ? "1" : "0");
  write("local", AUTO_LOGIN_KEY, autoLogin ? "1" : "0");
  if (rememberToken) {
    write("local", TOKEN_KEY, input.token);
  } else {
    // 取消记住密码时必须清掉此前记住的陈旧凭据
    remove("local", TOKEN_KEY);
  }
}

/**
 * 显式断开：清当前会话 token 并关闭自动登录，避免刷新后又被自动登录回去。
 * 「记住密码」与已记住的 Token 保留，便于回到登录页时预填。
 */
export function clearAuthSession(): void {
  remove("session", TOKEN_KEY);
  write("local", AUTO_LOGIN_KEY, "0");
}
