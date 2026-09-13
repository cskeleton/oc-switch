import { expect, test } from "bun:test";
import { buildModelInventory } from "../src/model-inventory";
import * as attention from "../src/model-attention";
import type { OpenClawConfig } from "../src/types";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const config: OpenClawConfig = { agents: { defaults: { model: "active/main", modelPolicy: { allow: ["active/main", "idle/one", "idle/two"] } } } };
  const inventory = buildModelInventory({ config, plugins: [{ id: "idle-plugin", enabled: true, origin: "bundled", providerIds: ["idle"], nonModelCapabilities: [] }], runtime: {
    configuredModels: [{ ref: "active/main", available: true, tags: [] }, { ref: "idle/one", available: false, tags: [] }, { ref: "idle/two", available: false, tags: [] }], allModels: [], allowedRefs: [], fallbackRefs: [], completeness: { status: true, configuredList: true, allList: true }, diagnostics: [], capturedAt: "2026-09-11"
  } });
  return { config, inventory };
}

test("同插件两个未就绪模型只有一项行动问题，未使用插件安静", () => {
  const { config, inventory } = fixture();
  const issues = attention.buildModelAttention(config, inventory);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ ownerType: "plugin", ownerId: "idle-plugin", canIgnore: true, refs: ["idle/one", "idle/two"] });
  inventory.models.forEach(m => { if (m.providerId === "idle") { m.inactive = true; m.pickerVisible = false; m.policyAllowed = false; } });
  expect(attention.buildModelAttention(config, inventory)).toEqual([]);
});

test("忽略跨重读有效，配置路径隔离，重新引用/关键依赖和健康后复发恢复提醒", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-attention-"));
  try {
    const { config, inventory } = fixture();
    const issues = attention.buildModelAttention(config, inventory);
    attention.setAttentionIgnored(dir, "/one.json", issues[0]!, true);
    expect(attention.applyAttentionDecisions(dir, "/one.json", issues).pending).toEqual([]);
    expect(attention.applyAttentionDecisions(dir, "/two.json", issues).pending).toHaveLength(1);
    const changed = structuredClone(config); changed.agents!.defaults!.model = "idle/one";
    const protectedIssues = attention.buildModelAttention(changed, inventory);
    expect(protectedIssues.some(i => !i.canIgnore)).toBe(true);
    expect(attention.applyAttentionDecisions(dir, "/one.json", protectedIssues).pending.length).toBeGreaterThan(0);
    attention.applyAttentionDecisions(dir, "/one.json", []);
    expect(attention.applyAttentionDecisions(dir, "/one.json", issues).pending).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true }); }
});

test("探测失败聚合一项，不制造每模型 unknown 任务", () => {
  const { config, inventory } = fixture();
  inventory.models.forEach(m => { m.availability = "unknown"; });
  inventory.diagnostics = [{ command: "list", code: "timeout", message: "timeout" }];
  const issues = attention.buildModelAttention(config, inventory);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ kind: "probe", canIgnore: false });
});

test("同 Provider 仍有健康来源时，只停用故障模型，不联动关闭健康插件", () => {
  const { config, inventory } = fixture();
  inventory.models.find(m => m.ref === "idle/two")!.availability = "available";
  const issues = attention.buildModelAttention(config, inventory);
  expect(issues).toHaveLength(1);
  expect(issues[0]?.ownerType).toBe("model");
  expect(issues[0]?.ownerId).toBe("idle/one");
});
