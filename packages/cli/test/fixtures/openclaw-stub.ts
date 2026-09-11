// CLI 测试用只读 OpenClaw：回放测试插件目录，并根据临时配置提供可用模型事实。
// 仅通过 runCli 的 PATH wrapper 调用；不读取开发机的配置/插件/认证状态。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import type { OpenClawConfig } from "@oc-switch/core";

const pluginsPath = process.env.OC_SWITCH_TEST_PLUGINS_PATH;
if (!pluginsPath || !process.env.HOME) throw new Error("test fixture environment required");
const command = process.argv.slice(2).join(" ");
if (command === "--version") {
  console.log("OpenClaw 2026.9.3 (fixture)");
  process.exit(0);
}
const settingsPath = join(process.env.HOME, ".oc-switch", "settings.json");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const configPath = process.env.OPENCLAW_CONFIG_PATH ?? settings.openclawPath ?? join(process.env.HOME, ".openclaw", "openclaw.json");
const config: OpenClawConfig = existsSync(configPath) ? JSON5.parse(readFileSync(configPath, "utf8")) : {};
const payload = JSON.parse(readFileSync(pluginsPath, "utf8"));
for (const plugin of payload.plugins ?? []) {
  const configured = config.plugins?.entries?.[plugin.id]?.enabled;
  if (typeof configured === "boolean") plugin.enabled = configured;
}
if (command === "plugins list --json") {
  console.log(JSON.stringify(payload));
  process.exit(0);
}
const models: { key: string; available: boolean; tags: string[] }[] = [];
for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
  for (const model of provider.models ?? []) models.push({ key: `${providerId}/${model.id}`, available: true, tags: [] });
}
for (const plugin of payload.plugins ?? []) {
  if (!plugin.enabled || !plugin.rootDir) continue;
  const manifestPath = join(plugin.rootDir, "openclaw.plugin.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const [providerId, provider] of Object.entries(manifest.modelCatalog?.providers ?? {}) as [string, { models?: { id: string }[] }][]) {
    for (const model of provider.models ?? []) models.push({ key: `${providerId}/${model.id}`, available: true, tags: [] });
  }
}
if (command === "models status --json") {
  console.log(JSON.stringify({ allowed: Object.keys(config.agents?.defaults?.models ?? {}) }));
} else if (command === "models list --json" || command === "models list --all --json") {
  console.log(JSON.stringify({ models }));
} else {
  process.exit(67);
}
