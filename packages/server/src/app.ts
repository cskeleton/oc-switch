import { Hono } from "hono";
import { createAppRuntime, type AppOptions } from "./context";
import { registerBackupRoutes } from "./routes/backups";
import { registerEnvRoutes } from "./routes/env";
import { registerHealthRoutes } from "./routes/health";
import { registerModelRoutes } from "./routes/models";
import { registerPresetRoutes } from "./routes/presets";
import { registerProviderRoutes } from "./routes/providers";
import { registerSettingsRoutes } from "./routes/settings";

export type { AppOptions } from "./context";

/** 创建带 Bearer 认证的 Hono REST 应用 */
export function createApp(options: AppOptions) {
  const runtime = createAppRuntime(options);

  const app = new Hono();

  // 允许 WebGUI 跨端口访问 REST API
  app.use("/api/*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${options.token}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  registerHealthRoutes(app, runtime);
  registerProviderRoutes(app, runtime);
  registerModelRoutes(app, runtime);
  registerPresetRoutes(app, runtime);
  registerBackupRoutes(app, runtime);
  registerSettingsRoutes(app, runtime);
  registerEnvRoutes(app, runtime);

  return app;
}
