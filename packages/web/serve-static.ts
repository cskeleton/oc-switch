import { join } from "path";

const port = 5173;
const distDir = join(import.meta.dir, "dist");

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === "/") path = "/index.html";
    
    const file = Bun.file(join(distDir, path));
    if (await file.exists()) {
      return new Response(file);
    }
    // Fallback to index.html for SPA routing
    return new Response(Bun.file(join(distDir, "index.html")));
  }
});
console.log(`Static server running at http://localhost:${port}`);
