import { extname, join, resolve, sep } from "node:path";

/** 扩展名 → Content-Type 映射 */
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function mimeForPath(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 将 URL 路径安全解析到静态根目录内；目录穿越或非法路径返回 null。
 */
function resolveSafePath(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) {
    return null;
  }

  const rootResolved = resolve(rootDir);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(rootResolved, relative);

  if (candidate !== rootResolved && !candidate.startsWith(`${rootResolved}${sep}`)) {
    return null;
  }

  return candidate;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * 包装 API fetch：在提供 webDistDir 时同端口托管 SPA 静态资源。
 * - `/api` 与 `/api/*` 始终交给 apiFetch
 * - 无 webDistDir 时所有请求交给 apiFetch
 * - 非 GET/HEAD 且非 API 返回 404
 * - 安全解析静态文件；不存在则 SPA fallback 到 index.html
 */
export function createStaticAwareFetch(
  apiFetch: (request: Request) => Response | Promise<Response>,
  webDistDir?: string
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const { pathname } = new URL(request.url);

    if (isApiPath(pathname) || !webDistDir) {
      return apiFetch(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Not Found", { status: 404 });
    }

    const safePath = resolveSafePath(webDistDir, pathname);
    if (safePath) {
      const file = Bun.file(safePath);
      if (await file.exists()) {
        const stat = await file.stat();
        if (stat.isFile()) {
          return new Response(request.method === "HEAD" ? null : file, {
            headers: { "Content-Type": mimeForPath(safePath) }
          });
        }
      }
    }

    const indexFile = Bun.file(join(webDistDir, "index.html"));
    if (await indexFile.exists()) {
      return new Response(request.method === "HEAD" ? null : indexFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    return new Response("Service Unavailable", { status: 503 });
  };
}
