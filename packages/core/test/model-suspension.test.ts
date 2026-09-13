import { expect, test } from "bun:test";
import * as suspension from "../src/model-suspension";

const config = () => ({ models: { providers: { idle: { models: [{ id: "one" }] } } }, agents: { defaults: {
  model: { primary: "active/main" }, models: { "idle/one": { alias: "saved" } },
  modelPolicy: { allow: ["active/main", "idle/*", "idle/exact", "other/*"] }
} } });

test("Provider 停用移出目标 exact/wildcard，保留 metadata 和其他规则并可恢复", () => {
  const before = config();
  const result = suspension.suspendModelProviders(before, ["idle"]);
  expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual(["active/main", "other/*"]);
  expect(result.config.agents?.defaults?.models).toEqual({ "idle/one": { alias: "saved" } });
  expect(result.policyEntries).toEqual(["idle/*", "idle/exact"]);
  expect(suspension.restoreModelProviderSelection(result.config, result.policyEntries).agents?.defaults?.modelPolicy?.allow).toEqual(["active/main", "other/*", "idle/*", "idle/exact"]);
  expect(before.agents.defaults.modelPolicy.allow).toEqual(["active/main", "idle/*", "idle/exact", "other/*"]);
});

test("清理 metadata 是独立选项；停用主模型或其他 Agent 的显式依赖必须拒绝", () => {
  expect(suspension.suspendModelProviders(config(), ["idle"], { cleanupMetadata: true }).config.agents?.defaults?.models).toEqual({});
  expect(() => suspension.suspendModelProviders(config(), ["active"])).toThrow("primary");
  expect(() => suspension.suspendModelProviders({ ...config(), agents: { ...config().agents, entries: { work: { modelPolicy: { allow: ["idle/*"] } } } } }, ["idle"])).toThrow("work");
});

test("开放策略不把保留 Key 当启用意图；有可靠可见集合才建立剩余模型策略", () => {
  const before = config(); before.agents.defaults.modelPolicy.allow = [];
  expect(() => suspension.suspendModelProviders(before, ["idle"])).toThrow("picker");
  const result = suspension.suspendModelProviders(before, ["idle"], { visibleRefs: ["active/main", "idle/one", "other/two"] });
  expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual(["active/main", "other/two"]);
  expect(() => suspension.suspendModelProviders({ agents: { defaults: { modelPolicy: { allow: ["idle/*"] } } } }, ["idle"])).toThrow("unrestricted");
});

test("停用/恢复保留 wildcard 重复次数；恢复不能越过独立的 Provider 停用", () => {
  const before = config();
  before.agents.defaults.modelPolicy.allow = ["active/main", "other/*", "other/*", "idle/*", "idle/*"];
  const off = suspension.suspendModelProviders(before, ["idle"]);
  expect(off.config.agents?.defaults?.modelPolicy?.allow).toEqual(["active/main", "other/*", "other/*"]);
  expect(suspension.restoreModelProviderSelection(off.config, off.policyEntries).agents?.defaults?.modelPolicy?.allow).toEqual(["active/main", "other/*", "other/*", "idle/*", "idle/*"]);
  expect(() => suspension.restoreModelProviderSelection(off.config, off.policyEntries, { blockedProviderIds: ["idle"] })).toThrow("disabled");
});

test("其他 Agent 的开放策略和 image/utility 依赖阻止假停用；畸形 policy 不被修成开放", () => {
  for (const override of [{ modelPolicy: { allow: [] } }, { imageModel: "idle/one" }, { utilityModel: "idle/one" }]) {
    expect(() => suspension.suspendModelProviders({ ...config(), agents: { ...config().agents, entries: { im: override } } }, ["idle"])).toThrow("im");
  }
  expect(() => suspension.suspendModelProviders({ agents: { defaults: { modelPolicy: { allow: "broken" as never } } } }, ["idle"], { visibleRefs: ["active/main"] })).toThrow("invalid");
});
