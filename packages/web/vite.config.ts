import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// preview 代理目标可经 VITE_PROXY_TARGET 覆盖（Task 9 Step 8 隔离 e2e 用 17420，
// 避免与用户常驻的 oc-switch serve 7420 冲突）
const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:7420";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // vendor 分包：框架与组件库独立缓存，业务 chunk 随路由按需加载
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules[\\/]react-dom/.test(id) || /node_modules[\\/]react[\\/]/.test(id)) return "react-vendor";
          if (id.includes("node_modules/@radix-ui")) return "radix";
          if (id.includes("node_modules/lucide-react")) return "icons";
          return undefined;
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": proxyTarget
    }
  },
  preview: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": proxyTarget
    }
  }
});
