import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createStaticAwareFetch } from "./static-web";

const tempDirs: string[] = [];

function createDistFixture() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-static-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!DOCTYPE html><html><body>SPA</body></html>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app');");
  return dir;
}

function mockApiFetch() {
  return async (request: Request) =>
    new Response(JSON.stringify({ api: true, path: new URL(request.url).pathname }), {
      headers: { "content-type": "application/json" }
    });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createStaticAwareFetch", () => {
  test("GET / serves index.html", async () => {
    const distDir = createDistFixture();
    const fetch = createStaticAwareFetch(mockApiFetch(), distDir);
    const response = await fetch(new Request("http://localhost/"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("SPA");
  });

  test("GET asset file with correct content-type (js)", async () => {
    const distDir = createDistFixture();
    const fetch = createStaticAwareFetch(mockApiFetch(), distDir);
    const response = await fetch(new Request("http://localhost/assets/app.js"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toBe("console.log('app');");
  });

  test("unknown path SPA fallback to index.html", async () => {
    const distDir = createDistFixture();
    const fetch = createStaticAwareFetch(mockApiFetch(), distDir);
    const response = await fetch(new Request("http://localhost/providers/42"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("SPA");
  });

  test("/api and /api/... forwarded to api handler", async () => {
    const distDir = createDistFixture();
    const fetch = createStaticAwareFetch(mockApiFetch(), distDir);

    const rootApi = await fetch(new Request("http://localhost/api"));
    expect(rootApi.headers.get("content-type")).toContain("application/json");
    expect(await rootApi.json()).toEqual({ api: true, path: "/api" });

    const nestedApi = await fetch(new Request("http://localhost/api/status"));
    expect(nestedApi.headers.get("content-type")).toContain("application/json");
    expect(await nestedApi.json()).toEqual({ api: true, path: "/api/status" });
  });

  test("POST non-api path returns 404 (not index.html)", async () => {
    const distDir = createDistFixture();
    const fetch = createStaticAwareFetch(mockApiFetch(), distDir);
    const response = await fetch(
      new Request("http://localhost/unknown", { method: "POST", body: "payload" })
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("SPA");
  });

  test("path traversal must not read outside dist", async () => {
    const distDir = createDistFixture();
    const parentDir = dirname(distDir);
    const secretBasename = "oc-switch-static-secret.txt";
    const secretPath = join(parentDir, secretBasename);
    writeFileSync(secretPath, "SECRET_OUTSIDE_DIST");
    tempDirs.push(secretPath);

    const fetch = createStaticAwareFetch(mockApiFetch(), distDir);

    // URL 解析会规范化字面 ../，此请求不会命中 resolveSafePath 的 traversal guard
    const normalized = await fetch(new Request(`http://localhost/../${secretBasename}`));
    expect(await normalized.text()).not.toContain("SECRET_OUTSIDE_DIST");

    // 编码 traversal 保留在 pathname 中，decodeURIComponent 后由 resolveSafePath 拦截
    const encodedTraversalUrls = [
      `http://localhost/..%2f${secretBasename}`,
      `http://localhost/%2e%2e%2f${secretBasename}`,
      `http://localhost/..%2f..%2f${secretBasename}`
    ];

    for (const url of encodedTraversalUrls) {
      const response = await fetch(new Request(url));
      const body = await response.text();
      expect(body).not.toContain("SECRET_OUTSIDE_DIST");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("SPA");
    }
  });

  test("missing index.html returns 503 for SPA fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-static-no-index-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", "app.js"), "console.log('app');");

    const fetch = createStaticAwareFetch(mockApiFetch(), dir);
    const response = await fetch(new Request("http://localhost/unknown-route"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service Unavailable");
  });

  test("webDistDir undefined → all requests go to api", async () => {
    const fetch = createStaticAwareFetch(mockApiFetch(), undefined);
    const response = await fetch(new Request("http://localhost/"));
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ api: true, path: "/" });
  });
});
