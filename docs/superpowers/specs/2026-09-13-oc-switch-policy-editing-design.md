# oc-switch Policy（modelPolicy.allow）规则编辑设计

- 日期：2026-09-13
- 状态：草稿（实现后更新为已实施 + Sync Audit）
- 关联规格：`2026-09-13-oc-switch-three-layer-write-model-design.md`（三层写模型与写入纪律）、`2026-09-09-oc-switch-runtime-model-management-design.md`（§11.3 Policy 规则视图——本文**取代**其「wildcard 本期只读」结论）、`2026-09-11-model-picker-and-disable-design.md`（wildcard 写入纪律的停用限定例外）

## 1. 背景与问题

`agents.defaults.modelPolicy.allow` 当前只有间接写入（启用模型时同步 exact、Provider/插件停用的限定例外、sync push 整树覆盖）与一种显式编辑（`removeModelPolicyExactRef` 删除 exact 引用）。Models 页 Policy 规则面板中 wildcard 只读、没有任何添加入口。用户要收紧/放宽策略（如删掉 `cpa/*` 改用精确枚举、为新 Provider 加一条通配）只能手工编辑 JSON，绕过 oc-switch 的备份与守卫。

本文新增**用户显式指令驱动**的规则编辑：添加规则（exact 或 wildcard）与删除 wildcard 规则。显式增删不是「隐式改写 wildcard」——三层写模型 spec §3 的纪律（永不隐式改写/挖洞/去重/改大小写）约束的是 oc-switch 的自动行为，用户在规则视图里点「添加/删除」是对 policy 的直接 authoring。

## 2. 范围与明确不做

范围内（三端一致）：

1. **添加规则**：`provider/model` 精确规则或 `provider/*` / `provider/namespace/*` 通配规则，按 `/*` 后缀自动识别。
2. **删除通配规则**：按完全相同字符串删除（含全部重复副本）。
3. 既有「删除 exact 引用」（`removeModelPolicyExactRef`）保持不变。

明确不做：

- **不创建/清空 policy、不做模式切换**：规则编辑仅在 `restricted` 模式可用；legacy / unrestricted 下拒绝并提示当前模式（模式切换如未来需要，是独立 spec）。
- restricted → legacy 任何情况下不做（OpenClaw 迁移单向）。
- 不编辑/重排/去重/改大小写**已有**规则；invalid 非字符串条目永远只读、不回显值。
- 不做规则命中实时预览（服务端为权威校验）。
- per-agent `agents.entries.*.modelPolicy.allow` 不在范围。
- API Key、目录、metadata、主模型/fallback 均不在本功能写入范围。

## 3. Core 契约（`packages/core/src/model-policy-edit.ts`，新文件）

纯 mutation（输入 config 先 `structuredClone`，自身不修改入参），错误一律 `ModelPolicyEditError`（结构化 code），由 Server 映射 400 / CLI 映射非零退出。

```ts
export type ModelPolicyEditErrorCode =
  | "invalid-rule-format"
  | "duplicate-rule"
  | "policy-not-restricted"
  | "policy-rule-not-found"
  | "primary-model-referenced"
  | "fallback-referenced"
  | "last-rule-removal";

export class ModelPolicyEditError extends Error { readonly code: ModelPolicyEditErrorCode; }
export function isModelPolicyEditError(error: unknown): error is ModelPolicyEditError;

export function addModelPolicyRule(
  config: OpenClawConfig,
  rule: string,
  options?: { knownProviderIds?: Iterable<string> }
): OperationResult & { rule: string; kind: "exact" | "wildcard" };

export function removeModelPolicyWildcard(
  config: OpenClawConfig,
  value: string,
  options?: { inventory?: ModelInventory }
): OperationResult & { removedCount: number };
```

### 3.1 `addModelPolicyRule`

校验顺序（任一失败即抛，不落盘）：

1. `rule.trim()` 为空 → `invalid-rule-format`。
2. 以 `/*` 结尾 = wildcard：去掉后缀的 body 必须非空、不得再含 `*`、第一段（首个 `/` 之前）非空，否则 `invalid-rule-format`。否则为 exact：`parseModelRef` 必须成功，否则 `invalid-rule-format`。
3. **模式门禁**：`getModelPolicyMode(config) !== "restricted"` → `policy-not-restricted`，报错文案说明当前模式（legacy/unrestricted），不创建 policy。
4. exact：被现有 exact 条目覆盖（`exactEntryMatches` 语义，Provider 折叠 + model 敏感）→ `duplicate-rule`；仅被 wildcard 覆盖 → **允许写入** + warning「已被通配 `<w>` 覆盖，该精确规则当前冗余」。
5. wildcard：raw 中已存在完全相同字符串 → `duplicate-rule`；被更宽的现有 wildcard 覆盖（用 `findPolicyWildcardForRef(config, body + "/_")` 探测）→ 允许 + warning「已被更宽的通配 `<w>` 覆盖」。
6. `options.knownProviderIds` 提供时（大小写折叠比较）：规则 provider 段不在集合内 → warning「Provider `<id>` 不在已知目录中，该规则当前不命中任何模型」。不提供则不提示。

写入：仅向 raw allow 数组末尾 `push` 新规则——exact 按 `normalizeModelRefForStorage` 归一存储，wildcard 按用户输入原样存储（仅 trim）。**不动**其它条目的大小写、顺序、重复次数与非字符串条目。返回扩展的 `rule`（实际存储值）与 `kind`。

### 3.2 `removeModelPolicyWildcard`

校验顺序：

1. `value.trim()` 不以 `/*` 结尾 → `invalid-rule-format`（报错指引 exact 走 `removeModelPolicyExactRef`）。
2. 模式门禁同上：`policy-not-restricted`。
3. raw 中不存在完全相同字符串 → `policy-rule-not-found`。
4. **防清空（fail closed，无 force）**：移除所有完全相同条目后 raw 变 `[]`（会变成 unrestricted）→ `last-rule-removal`。非字符串条目计入剩余（与 `assertPolicyRemovalPreservesRestrictedMode` 既有语义一致）。
5. **primary/fallback 覆盖保护（fail closed，无 force）**：primary 或任一 fallback ref 当前被该 wildcard 覆盖、且剩余规则（exact + 其他 wildcard，经 `isPolicyAllowsRef`）不再覆盖它 → `primary-model-referenced` / `fallback-referenced`。

写入：`allow = raw.filter(e => e !== value)`（删除全部相同副本），返回 `removedCount`；`removedCount > 1` 时 warning「已移除 N 条相同规则」。`options.inventory` 提供时追加 warning「删除后 K 个模型将失去策略放行：`<ref…>`」（K = 被该 wildcard 覆盖且不被任何剩余规则覆盖的 inventory 模型行数，ref 列表最多列 5 个）。

### 3.3 `model-policy.ts` 归一层新增

- `findPolicyExactEntryForRef(config, ref): string | undefined`：restricted 时返回覆盖 ref 的首个 exact 条目（供 duplicate 检测）。

不需要新的导出匹配器：`isPolicyAllowsRef` / `findPolicyWildcardForRef` / `readModelPolicyAllowRaw` / `getModelPolicyMode` 均为公开。

### 3.4 inventory 投影（`model-inventory.ts`）

- `ModelInventory` 顶层新增 **`policyMode: ModelPolicyMode`**（必填；`schemaVersion` 保持 2，新增字段不影响前后端一致性检查）。
- `projectPolicyRules`：wildcard 的 `removable` 由守卫事实计算（与 `removeModelPolicyWildcard` 语义严格对齐）——移除该值的所有完全相同字符串条目后：
  a. raw 仍剩 ≥1 条（含非字符串条目）；
  b. 无 protected identity（primary/fallback，identity 形式）在失去该 wildcard 后不被任何剩余字符串规则覆盖（`exactEntryCovers` / `wildcardEntryCovers`）。
  两者都满足才 `removable: true`。exact / invalid 逻辑不变。

## 4. Server API（`packages/server/src/routes/model-inventory.ts`）

两个新端点，完全复用 `DELETE /api/model-policy/exact-ref` 的事务模板：`writeOpenClawTransaction` + `normalizeConfig:false` + 事务内 `buildCurrentInventory({ refresh: true, config, paths })` + 闭包透传 warnings + `postWriteConfirmation`。

- `POST /api/model-policy/rules`，body `{ rule: string }`（`schemas.ts` 新增 `requireAddModelPolicyRuleInput`）。事务内以 fresh inventory 的 `providers[].providerId` 作 `knownProviderIds`。响应 `{ ok: true, rule, kind, backupId, warnings, runtimeConfirmed, diagnostics, inventory }`。
- `DELETE /api/model-policy/wildcard`，body `{ value: string }`（新增 `requireRemoveModelPolicyWildcardInput`）。事务内 fresh inventory 传入 operation 以计算失去放行 warning。响应 `{ ok: true, value, removedCount, backupId, warnings, runtimeConfirmed, diagnostics, inventory }`。

`errors.ts`：`isModelPolicyEditError` 并入 400 + `code` 分支。diff-guard 白名单已含 `agents.defaults.modelPolicy.allow`，无需改动。

## 5. CLI（`packages/cli/src/commands/models.ts`）

- `model add-policy-rule <rule>`（`--json`）：添加 exact 或 wildcard。**不要求 `--yes`**（只扩大选择范围，与 `model enable` 同级）；仍走事务 + 自动备份。
- `model remove-policy-wildcard <value>`（`--yes`、`--json`）：非 TTY 无 `--yes` 走既有 `requireNonInteractiveYes` fail closed。

两者均 `normalizeConfig:false` + 事务内 fresh inventory。

## 6. Web

- `api.ts`：`ModelInventory` 加 `policyMode?: ModelPolicyMode`（旧后端缺字段时前端隐藏添加入口，安全回退）；client 新增 `addModelPolicyRule(rule)`、`removeModelPolicyWildcard(value)`。
- `ModelPolicyPanel`：props 扩展为 `{ rules, policyMode?, busy?, onAddRule: () => void, onRemoveRule: (rule: ModelPolicyRuleEntry) => void }`。
  - 头部操作区：`policyMode === "restricted"` 显示「添加规则」按钮；否则 muted 提示「当前为 legacy / unrestricted 模式，规则编辑仅适用于 restricted 模式」。
  - wildcard 行：`removable` 时渲染删除按钮（不再一律「只读」）；不可删时 Pill「受保护」+ title 说明（主模型/fallback 覆盖或为避免清空策略）。区段提示文案更新为「通配规则可显式删除；oc-switch 绝不自动改写」。invalid 行维持只读不回显值。
- `ModelsView`：`PendingModelAction.kind` 增加 `"add-policy-rule"` / `"remove-policy-wildcard"`；`onRemoveRule` 按 `rule.kind` 分发到 exact（旧流程）或 wildcard（新流程）。
  - 添加对话框：单输入框 + 静态格式提示（`provider/model` 或 `provider/*`；不做前端实时命中预览），错误内联（沿用 `actionError` 模式）。
  - 删 wildcard 确认对话框：`ConfirmDialog` danger，展示该规则的 `matchedModelCount` / `unavailableModelCount`，文案明确「删除后仅由该规则放行的模型将从选择器消失；目录、metadata 与 API Key 不变」。gating 从当前 inventory 重读 `rule.removable`。
  - 成功后 toast 展示 warnings 并 `await load()`。
- 所有确认文案明确「只改 modelPolicy.allow」。

## 7. 写入纪律与安全边界

- Core 仍是唯一 writer；事务 + 文件锁 + 自动备份 + diff-guard 不变。
- fail-closed 守卫（`force` 不存在、不可绕过）：模式门禁、防清空、primary/fallback 覆盖保护。
- 添加规则只扩大选择范围，无需 --yes/confirm；删除 wildcard 收窄选择范围，CLI 必须 `--yes`、Web 必须确认对话框。
- 永不回显非字符串条目的值；错误与响应不含密钥。
- 探测未知（unknown）不阻断规则编辑（编辑的是 policy 层，不是可用性断言）；仅影响 warning 的完整度。

## 8. 测试与验收

- **core**（新 `test/model-policy-edit.test.ts`）：添加 exact/wildcard 成功；legacy/unrestricted 拒绝；格式非法；duplicate；冗余覆盖 warning；unknown provider warning；删除 wildcard 成功（含重复副本计数）；not-found / 防清空 / primary / fallback 拒绝；非字符串条目与其它规则的大小写、顺序、重复原样保留。`model-inventory.test.ts` 扩展：wildcard `removable` 投影矩阵 + 顶层 `policyMode`。
- **server**（`test/app.test.ts` 扩展）：两端点成功 / 各 400 code / warnings 透传 / runtimeConfirmed 形态；注入式隔离（`runtimeModelCatalogProvider` / `pluginCatalogProvider`）。
- **cli**（`test/cli.test.ts` 扩展）：`OC_SWITCH_MOCK_RUNTIME_MODELS` fixture 下 add 成功 / 模式拒绝；remove 无 `--yes` fail closed、`--json` 契约、守卫拒绝非零退出。
- **web**（`runtime-models.test.tsx`）：按 policyMode 显隐添加入口；wildcard 删除按钮 gating；两个对话框提交 / 错误 / warnings toast；`api.test.ts` client 契约。
- **acceptance**（`scripts/acceptance-smoke.ts`）：fake openclaw fixture 下 add exact → add wildcard → remove wildcard 全链路 + 守卫场景；断言 policy 之外字节不变。
- **E2E**（`test/e2e/runtime-models.e2e.ts`）：Policy 区段添加 / 删除流程；桌面 + 手机断言表不横滚（沿用 §11.3 既有断言模式）。
- 验证：`bun run check`、`bun run acceptance`、`bun run test:e2e` 全绿。
