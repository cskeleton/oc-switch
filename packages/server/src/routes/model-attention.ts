import { buildModelAttention, applyAttentionDecisions, setAttentionIgnored, withFileLock, inspectConfigStatus } from "@oc-switch/core";
import { join } from "node:path";
import type { Hono } from "hono";
import { readConfig, readEnvContent, type AppRuntime } from "../context";
import { requireJsonObject } from "../schemas";

export function registerModelAttentionRoutes(app: Hono, runtime: AppRuntime): void {
  let decisionQueue = Promise.resolve();
  function decisionLock<T>(stateDir: string, action: () => T): Promise<T> {
    const result = decisionQueue.then(() => withFileLock(join(stateDir, "attention.lock"), async () => action()));
    // 只让队列继续；本次错误仍通过 result 返回请求方。
    decisionQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  async function current(refresh = false) {
    const paths = runtime.currentPaths();
    const inventory = await runtime.buildCurrentInventory({ paths, refresh });
    const config = readConfig(paths);
    const issues = buildModelAttention(config, inventory);
    // 无法加载的配置问题不能被闲置/忽略规则吞掉，沿用现有健康检查事实。
    const blocking = inspectConfigStatus({ config, paths, envContent: readEnvContent(paths) ?? "", pluginProviders: await runtime.currentPluginProviders({ paths }) }).issues.filter(issue => issue.severity === "blocking");
    for (const issue of blocking) issues.push({ id: issue.id, revision: issue.id, kind: "dependency", ownerType: "runtime", ownerId: "configuration", providerIds: [], refs: [], protectedRefs: [], canIgnore: false, canDisable: false, title: issue.title, detail: [issue.detail, issue.action].filter(Boolean).join("；") });
    const scope = `${paths.openclawPath}\0${paths.envPath}\0default`;
    return { paths, scope, issues };
  }
  app.get("/api/model-attention", async c => {
    const { paths, scope, issues } = await current();
    const report = await decisionLock(paths.stateDir, () => applyAttentionDecisions(paths.stateDir, scope, issues));
    return c.json({ schemaVersion: 2, ...report });
  });
  app.patch("/api/model-attention/decision", async c => {
    const body = await requireJsonObject(c.req);
    if (typeof body.issueId !== "string" || typeof body.revision !== "string" || typeof body.ignored !== "boolean") return c.json({ error: "issueId/revision/ignored are required" }, 400);
    const { paths, scope, issues } = await current(true);
    const issue = issues.find(i => i.id === body.issueId);
    if (!issue || issue.revision !== body.revision) return c.json({ error: "问题已变化，请刷新后重新决定。" }, 409);
    if (body.ignored && !issue.canIgnore) return c.json({ error: "实际依赖或探测问题不能忽略，请先修复或替换依赖。" }, 400);
    const report = await decisionLock(paths.stateDir, () => {
      setAttentionIgnored(paths.stateDir, scope, issue, body.ignored as boolean);
      return applyAttentionDecisions(paths.stateDir, scope, issues);
    });
    return c.json({ schemaVersion: 2, ...report });
  });
}
