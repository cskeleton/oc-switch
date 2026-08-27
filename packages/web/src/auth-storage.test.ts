import "./test-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAuthSession,
  normalizeAuthPreferences,
  persistAuth,
  readAuthSnapshot,
  shouldAutoLogin
} from "./auth-storage";

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

const FALLBACK = "http://127.0.0.1:7420";

describe("auth-storage", () => {
  test("无历史记录时回落到默认地址且不自动登录", () => {
    const snapshot = readAuthSnapshot(FALLBACK);
    expect(snapshot).toEqual({
      token: "",
      baseUrl: FALLBACK,
      rememberToken: false,
      autoLogin: false,
      sessionActive: false
    });
    expect(shouldAutoLogin(snapshot)).toBe(false);
  });

  test("记住密码 + 自动登录：跨会话恢复 Token 并触发自动登录", () => {
    persistAuth({
      token: "tok-1",
      baseUrl: "http://example:7420",
      rememberToken: true,
      autoLogin: true
    });
    // 模拟新的浏览器会话：sessionStorage 丢失，localStorage 保留
    window.sessionStorage.clear();

    const snapshot = readAuthSnapshot(FALLBACK);
    expect(snapshot.token).toBe("tok-1");
    expect(snapshot.baseUrl).toBe("http://example:7420");
    expect(snapshot.rememberToken).toBe(true);
    expect(snapshot.autoLogin).toBe(true);
    expect(snapshot.sessionActive).toBe(false);
    expect(shouldAutoLogin(snapshot)).toBe(true);
  });

  test("仅记住密码：预填 Token 但不自动登录", () => {
    persistAuth({ token: "tok-1", baseUrl: FALLBACK, rememberToken: true, autoLogin: false });
    window.sessionStorage.clear();

    const snapshot = readAuthSnapshot(FALLBACK);
    expect(snapshot.token).toBe("tok-1");
    expect(snapshot.autoLogin).toBe(false);
    expect(shouldAutoLogin(snapshot)).toBe(false);
  });

  test("未勾记住密码时不落盘 Token，并清掉此前记住的陈旧凭据", () => {
    persistAuth({ token: "tok-old", baseUrl: FALLBACK, rememberToken: true, autoLogin: true });
    persistAuth({ token: "tok-new", baseUrl: FALLBACK, rememberToken: false, autoLogin: false });

    expect(window.localStorage.getItem("oc-switch-token")).toBeNull();
    // 同 tab 会话内仍可凭 sessionStorage 恢复
    expect(readAuthSnapshot(FALLBACK).sessionActive).toBe(true);

    window.sessionStorage.clear();
    const snapshot = readAuthSnapshot(FALLBACK);
    expect(snapshot.token).toBe("");
    expect(snapshot.rememberToken).toBe(false);
    expect(shouldAutoLogin(snapshot)).toBe(false);
  });

  test("不变量：未记住密码时自动登录一律无效（写入侧）", () => {
    persistAuth({ token: "tok-1", baseUrl: FALLBACK, rememberToken: false, autoLogin: true });
    expect(window.localStorage.getItem("oc-switch-auto-login")).toBe("0");
    expect(normalizeAuthPreferences({ rememberToken: false, autoLogin: true })).toEqual({
      rememberToken: false,
      autoLogin: false
    });
  });

  test("不变量：读取侧同样强制（存储被外部改成 remember=0/auto=1）", () => {
    window.localStorage.setItem("oc-switch-remember-token", "0");
    window.localStorage.setItem("oc-switch-auto-login", "1");
    window.localStorage.setItem("oc-switch-token", "tok-1");

    const snapshot = readAuthSnapshot(FALLBACK);
    expect(snapshot.autoLogin).toBe(false);
    expect(snapshot.token).toBe("");
    expect(shouldAutoLogin(snapshot)).toBe(false);
  });

  test("显式断开：清会话 token 与自动登录，保留记住的 Token", () => {
    persistAuth({ token: "tok-1", baseUrl: FALLBACK, rememberToken: true, autoLogin: true });
    clearAuthSession();

    const snapshot = readAuthSnapshot(FALLBACK);
    expect(snapshot.sessionActive).toBe(false);
    expect(snapshot.token).toBe("tok-1");
    expect(snapshot.rememberToken).toBe(true);
    expect(snapshot.autoLogin).toBe(false);
    expect(shouldAutoLogin(snapshot)).toBe(false);
  });

  test("会话 token 优先于记住的 Token", () => {
    persistAuth({ token: "tok-remembered", baseUrl: FALLBACK, rememberToken: true, autoLogin: true });
    window.sessionStorage.setItem("oc-switch-token", "tok-session");

    expect(readAuthSnapshot(FALLBACK).token).toBe("tok-session");
  });
});
