# 悬空策略引用批量清理（stale policy refs cleanup）

- 日期：2026-09-19
- 状态：已实施（2026-09-19）。实现要点：Core `removeModelPolicyRules` / `canRemoveModelPolicyRules`（`ModelPolicyEditError` 新增 `refs` 字段携带触发规则）；API `POST /api/model-policy/rules/batch-remove`（409 冲突、400 带 `details.refs`、空 values no-op 跳过事务无备份）；CLI `model cleanup-stale-policy-refs`；Web `StalePolicyRefsCleanupDialog` + Models 页入口。验收：`bun run check`（core/server/cli 1203 pass、web 234 pass、typecheck、build）与 `bun run acceptance`（预览不写盘 → `--yes` 批量删除 stale 归零且有效 exact/wildcard 保留 → primary 指向未知 provider 被拒且零备份）全部通过。实施偏离：① CLI 预览无 `--yes` 时 exit 0（沿用 `model reconcile` 先例；预览本身不写盘即 fail-closed），本节 §5 已同步修正；② 未做 per-row `canRemoveModelPolicyRules` 投影禁用勾选（REST 无投影端点，原子批量 + 400 `details.refs` 逐条标红语义等价），§6 已同步修正。
- 基线：`2026-09-16-oc-switch-policy-rule-replacement-design.md`（规则原子编辑与纯规则删除）；`config-status.ts` 的三类悬空 ref 检测。
- 配套计划：`../plans/2026-09-19-stale-policy-refs-cleanup.md`。

## 1. 目标与判断

`GET /api/config-status` 已检测三类悬空 policy exact ref，但 Web 无任何消费者（`getConfigStatus` 在 `packages/web/src` 无引用），CLI 也只在 `sync diff` 对端报告里打印 unknownProviderRefs。用户无法发现、更无法批量清理。本期提供专用清理入口。

2026-09-19 源码核对结论（设计前提）：

- 三类列表在 `buildModelPolicyStatus`（`config-status.ts:335-404`）计算：只含**字符串 exact**（排除 wildcard、非字符串、非法 ref），按原始字符串去重保序；provider 段大小写折叠、modelId 敏感。
- **stale 集 = `unknownProviderRefs ∪ knownProviderUnknownModelRefs`**（两者互斥）。`policyOnlyExactRefs` 中「provider+model 都在目录、仅无 metadata」的子集是**有效规则**（`getModelSelectionSource` 只做字符串匹配，不依赖 metadata，`model-policy.ts:252-268`），删除会真实收窄选择范围，**不得进清理列表**。
- attention 工作流不能替代本功能：悬空 ref 仅在运行探测完整且判 `unavailable` 时才产生可用性待办，探测不完整（unknown）时不报，且不覆盖「有效但无 metadata」之外的配置漂移语义。
- 删除语义应走 `removeModelPolicyRule`（纯规则删除，允许删被 wildcard 覆盖的冗余 exact），不是 `removeModelPolicyExactRef` 的引用清理语义。
- policy 规则层没有任何批量删除入口（core/CLI/API 均无）。

## 2. 范围与兼容边界

本期：Core 批量纯规则删除 `removeModelPolicyRules`、REST 批量端点、CLI `model cleanup-stale-policy-refs`、Web Models 页 policy 区段「清理悬空引用」对话框。

**明确不做（本期）**：

- 不改动 config-status 的三类列表计算与 `issues[]`（不为悬空 ref 新增 issue 条目；远期候选）。
- 不清理 wildcard 规则、非字符串条目、`policyOnlyExactRefs` 的有效子集。
- 不提供按 metadata 缺失反查补登的功能（那是 sync-metadata 的领域）。
- 不做逐条独立事务的「部分成功」模式；批量一律单事务原子。
- 不并入 model-attention 待办列表。
- legacy / unrestricted 模式不提供本入口（与规则编辑门禁一致）。
- 不动 per-agent `agents.entries.*.modelPolicy`。

## 3. Core 契约

在 `packages/core/src/model-policy-edit.ts` 扩展，复用 §3.2 最终状态保护，不新建引擎：

```ts
removeModelPolicyRules(
  config: OpenClawConfig,
  values: string[],
  options?: RemoveModelPolicyWildcardOptions
): OperationResult & { removedCount: number };
```

- `values` 为原始字符串 exact 规则，逐条按完全相同字符串匹配（不 trim 旧值、不大小写折叠定位），删全部相同副本，`removedCount` 为删除的总副本数。`values` 内重复字符串按一条计。
- **单事务原子、先全量守卫后统一改**（参照 `batchRemoveProviderModels` 范式）：对「删除全部 values 后的最终 allow」一次性校验——① 当前 restricted（`policy-not-restricted`）；② 任一 value 不存在（`policy-rule-not-found`，消息列出缺失值）；③ 最终 raw 为空（`last-rule-removal`）；④ primary/fallback 编辑前被覆盖、编辑后不再覆盖（`primary-model-referenced` / `fallback-referenced`，消息列出触发 ref）。任一违规整体拒绝，不落盘、无备份、无部分提交。不新增 `force`。
- 错误沿用 `ModelPolicyEditError` 与既有错误码；消息可含多条违规 ref，但不回显非字符串条目内容。
- 新增可删性投影 `canRemoveModelPolicyRules(config, values)`：与批量成败严格一致（布尔 + 首条违规原因），供 Web 预投影；**服务器校验仍是权威**，投影仅用于勾选默认值与禁用提示。
- 输入空数组：返回 `removedCount: 0` 且不产生备份（no-op 成功），不视为错误。

## 4. REST

```text
POST /api/model-policy/rules/batch-remove  { values: string[], expectedRevision }
```

- 命名对齐既有 `POST /api/providers/:id/models/batch-remove`。`expectedRevision` 必填；缺失/非法 400，与事务内当前 revision 不同 409（`policy-revision-conflict`）。在 `writeOpenClawTransaction` mutate 内先比 revision 再校验与变更，`normalizeConfig:false`。
- 守卫失败 400，结构化 `{ error, code, details?: { refs: string[] } }`——`refs` 为触发违规的原始规则字符串，供 UI 逐条标注。
- 响应沿用 `{ ok, backupId, warnings, runtimeConfirmed, diagnostics, inventory }` + `removedCount`。
- 既有 POST/DELETE 单条入口契约不变。

## 5. CLI

```bash
oc-switch model cleanup-stale-policy-refs [--yes] [--json]
```

- 无参数发现模式：读取 config-status，stale 集（`unknownProviderRefs ∪ knownProviderUnknownModelRefs`）∩ 当前 restricted 规则，列出待清理 ref 与原因（Provider 不存在 / 模型不在目录），**默认只预览**（不写盘，exit 0，沿用 `model reconcile` 先例）；`--yes` 才执行批量删除。
- stale 集为空：打印「没有可清理的悬空引用」，exit 0，不产生备份。
- 模式非 restricted：明确提示不支持，非零退出。
- 执行路径：确认前读 `buildModelPolicyRevision` 作 `expectedRevision`，mutate 内比对，冲突非零退出不自动重试。JSON 输出 `{ ok, removed, removedCount, backupId, warnings }`，`removed` 为实际删除的 ref 列表；失败输出结构化错误与 `details.refs`。
- 守卫失败时逐条打印触发 ref 与原因；不自动剔除后重试（用户可手工逐条 `remove-policy-rule`）。

## 6. Web（Models 页 policy 区段）

- `ModelsView` 新增 `getConfigStatus()` 拉取（仅 restricted 且有规则时），计算 stale 集并与 `policyRules` 的 exact 规则按**原始字符串**求交；命中数 > 0 时 `ModelPolicyPanel` 顶部显示「清理悬空引用 (N)」按钮。
- 对话框：逐行列出 ref + 原因 Pill（Provider 不存在 / 模型不在目录），默认全选；复用 DataTable/Checkbox/ConfirmDialog 模式（先例 `ProviderModelsDialog`）；移动端不横向溢出。不做逐行可删性投影（批量单事务原子，不可删规则不会部分生效；守卫失败经 400 `details.refs` 逐条标红传达）。
- 确认时冻结 `policyRevision` 作 `expectedRevision`，单次 `batchRemoveModelPolicyRules(values, expectedRevision)` 调用；成功 toast + 刷新 inventory 与 config-status。
- 400 守卫失败：解析 `details.refs`，对话框内逐条标红并取消勾选，提示用户重新确认；不自动重试。409：保留勾选，提示「策略已变化，请刷新后重新核对」。
- 旧后端无批量端点时报「版本不支持」，不回退逐条循环 DELETE（避免部分提交）。
- 提示文案必须明确：「清理只删除选择策略中的悬空规则，不影响目录、metadata 与密钥」；有效但无 metadata 的规则不在列表中，不得误导用户以为会清理。

## 7. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| stale 集 = unknownProvider ∪ knownProviderUnknownModel | `policyOnlyExactRefs` 中目录有效子集不出现在任何清理列表 |
| 批量删除多条 stale exact（含重复副本、大小写变体） | 单事务成功，`removedCount` 为总副本数，其余规则原样保留 |
| 含不存在 value / 删后为空 / primary/fallback 失去覆盖 | 整体拒绝，磁盘不变、无新备份，错误附 `details.refs` |
| primary 指向未知 provider 的 ref | 仍被 `primary-model-referenced` 保护（provider 不存在不豁免） |
| 过期 expectedRevision | 409 / CLI 非零，无覆盖，Web 保留勾选 |
| 空 values | no-op 成功，`removedCount: 0`，无备份 |
| legacy / unrestricted 模式 | CLI 非零提示；Web 入口不出现 |
| wildcard / 非字符串条目 | 永不进入清理列表，批量删除不触碰 |
| 旧后端 | Web 显示「版本不支持」，无逐条 DELETE 回退 |

测试隔离沿用既有缝：core 内存 fixture；server `createTestApp` + 注入；CLI 进程内 `registerModelsCommands` + fake openclaw；acceptance 加「构造悬空 ref → CLI 预览 → --yes 批量删除 → config-status 归零」场景。不得读写真实 `~/.openclaw`。

## 8. 文档同步

实施后：本 spec 状态改「已实施」附验收结论；`AGENTS.md`「已知后续」移除 stale allowlist 项、能力摘要（配置健康节）补批量清理条目、规格索引登记本 spec。
