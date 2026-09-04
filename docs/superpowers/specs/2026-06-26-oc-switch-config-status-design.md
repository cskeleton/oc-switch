# oc-switch Config Status 设计规格

> 日期：2026-06-26  
> 状态：待 review  
> 关联计划：`docs/superpowers/plans/2026-06-26-oc-switch-architecture-optimization-slices-2-6.md`（Slice 6）  
> 关联草案：`docs/superpowers/specs/2026-06-26-oc-switch-architecture-optimization-draft.md`（Slice 6）

---

## 1. 背景与目标

oc-switch 已具备多种「配置状态」读取能力，分散在不同 Core 函数与 REST 端点：

| 能力 | 现有入口 |
|------|----------|
| Provider 大小写重复 | `inspectConfigHealth` → `GET /api/health` |
| 孤立 env key | `listOrphanEnvKeys` |
| env 缺失/重复/复杂值警告 | `inspectEnvFile` |
| 已禁用 Provider | `readProviderStates` |
| 活动路径可读/可写 | `resolveOpenClawPathCandidates` |

这些能力在 Web Dashboard、Providers、Models、Settings 等页面各自消费，缺少统一、去重后的「行动列表」。Slice 6 新增 `GET /api/config-status`，聚合上述来源为单一读取入口，同时**不破坏**现有 `/api/health` 契约。

### 1.1 非目标（首版）

- 不扩展 `/api/health` 响应 shape。
- 不新建 shared contracts 包。
- 不在 Dashboard、Providers、Models、Settings 页面接入 UI（另开后续产品/UI spec）。
- 不暴露 `.env` 密钥明文或 disabled provider 的 allowlist 快照内容。

---

## 2. 端点边界

### 2.1 `GET /api/health`（长期冻结）

- **角色**：legacy case-duplicate health endpoint。
- **响应**：仅 `ConfigHealthReport`（`caseDuplicateGroups` + `summary`），与当前实现完全一致。
- **约束**：不得向此端点添加 orphan env、path warning、disabled provider 等新类别。
- **日后变更**：若需 alias、deprecate 或合并到 `/api/config-status`，须单独写兼容性规格。

### 2.2 `GET /api/config-status`（v1 新增）

- **角色**：统一配置状态读取入口。
- **响应**：`ConfigStatusReport`（见 §3）。
- **认证**：与现有 REST API 相同（Bearer token）。
- **副作用**：只读；不修改 `openclaw.json`、`.env` 或 oc-switch 状态文件。
- **实现位置**（spec 接受后）：
  - Core：`inspectConfigStatus`
  - Server：`packages/server/src/routes/health.ts`（与 status/diff 同模块）
  - Web：`packages/web/src/api.ts` 镜像类型 + `getConfigStatus()`

### 2.3 `GET /api/status`

- 保持不变；继续返回 adapter `getStatus()` 的运行时摘要（主模型、计数等），**不是**健康问题聚合。

---

## 3. 响应契约：`ConfigStatusReport` v1

`ConfigStatusReport` 是 `/api/config-status` 的**版本化 v1 DTO**。类型由 **Core 定义**（`packages/core/src/config-status.ts`），Web 在 `packages/web/src/api.ts` **手动镜像**，不建 shared contracts 包。

```ts
/** 去重后的单条可行动问题 */
export interface ConfigStatusIssue {
  /** 去重 key，格式 `${source}:${id}`，全局唯一 */
  id: string;
  severity: "info" | "warning" | "blocking";
  source: "health" | "env" | "paths" | "providers";
  title: string;
  detail?: string;
  /** 建议操作描述（CLI 命令、Settings 入口等），非机器可执行字段 */
  action?: string;
}

/** disabled provider 摘要（不含 allowlist 快照） */
export interface DisabledProviderStatus {
  providerId: string;
  disabledAt: string;
  openclawPath: string;
  /** 禁用时隐藏的 allowlist 条目数 */
  hiddenModelCount: number;
}

export interface ConfigStatusReport {
  version: 1;
  /** raw facts：完整 case-duplicate 健康报告，等同 inspectConfigHealth 输出 */
  health: ConfigHealthReport;
  /** raw facts：modelPolicy.allow 的模式、计数与未知 Provider exact refs */
  modelPolicy: ConfigStatusModelPolicy;
  /** raw facts：当前禁用的 provider 摘要列表 */
  disabledProviders: DisabledProviderStatus[];
  /** raw facts：manifest 中标记为 orphan 的 env key 名（无值） */
  orphanEnvKeys: string[];
  /** raw facts：inspectEnvFile 产生的警告字符串列表 */
  envWarnings: string[];
  /** 唯一去重后的行动列表 */
  issues: ConfigStatusIssue[];
  summary: {
    /** 仅统计 issues[] */
    issueCount: number;
    blockingIssueCount: number;
    warningIssueCount: number;
    /** 以下三项统计 raw source 数组，供 drill-down 与 issues 计数解耦 */
    duplicateGroupCount: number;
    disabledProviderCount: number;
    orphanEnvKeyCount: number;
  };
}
```

`ConfigHealthReport` 复用 `packages/core/src/config-health.ts` 现有定义，不在此重复。

### 3.1 模型 policy 摘要兼容契约

`ConfigStatusReport` 所消费的模型/状态 DTO 必须使用以下精确类型：

```ts
export type ModelPolicyMode = "legacy" | "unrestricted" | "restricted";
export type ModelSelectionSource = "legacy" | "unrestricted" | "policy-exact" | "policy-wildcard";
```

`ConfigStatusReport` 增加以下 additive raw fact；字段名和嵌套结构固定，后续实现不得另造同义 DTO：

```ts
export interface ConfigStatusModelPolicy {
  mode: ModelPolicyMode;
  /** raw agents.defaults.modelPolicy.allow 条目数；缺失时为 0 */
  policyEntryCount: number;
  /** 本地 Provider 目录中经过 disabled state 与 policy 判定后有效的模型数 */
  effectiveCatalogCount: number;
  /** policy 中 Provider 不在 models.providers 的字符串 exact ModelRef */
  unknownProviderRefs: string[];
}
```

`policyEntryCount` 对缺失和显式 `[]` 都为 `0`，两者的区别只由 `mode` 表达；非字符串 policy 条目仍计入该 raw count，但不计入匹配结果。`unknownProviderRefs` 只包含 policy 中的字符串 exact ModelRef，且其 Provider 在本地 `models.providers` 中不存在；wildcard、非字符串条目和本地目录已有 Provider 的 refs 不进入该数组。该数组只返回 refs，不返回任何 secret、Provider credentials 或 `.env` 值，并按原 policy 顺序去重。

`ModelSummary` 增加 `selectionSource: ModelSelectionSource`。`StatusSummary` 增加 `modelPolicyMode: ModelPolicyMode` 和 `effectiveModelCount: number`，同时保留 `allowlistModelCount: number` 供既有客户端使用。`allowlistModelCount` 只统计 `agents.defaults.models` 条目，`effectiveModelCount` 统计经过 Provider disabled state 与 model policy 判定后的有效模型；两者不可互换。

`modelPolicy.allow` 的 precedence 固定如下：字段缺失为 `legacy`，effective enabled 由 `agents.defaults.models` exact ref 决定；字段存在且为 `[]` 为 `unrestricted`，本地 Provider 目录中的模型在 Provider 未 disabled 时有效；字段存在且非空为 `restricted`，仅 `modelPolicy.allow` 的 exact ref、`provider/*` provider-wide wildcard 或 `provider/namespace/*` namespace wildcard 命中时有效。restricted 模式下 `agents.defaults.models` 只提供 alias/per-model metadata，不是 authoritative selection allowlist。Provider disabled state 独立于 policy availability，并优先阻止模型有效启用。

读取必须保留缺失与 `[]` 的区别。任何读取 DTO 都必须报告 `selectionSource`：legacy/unrestricted 直接对应模式，restricted 命中 exact 为 `policy-exact`，命中 wildcard 为 `policy-wildcard`。若多个 wildcard 命中，仍不得改写 policy；实现应按最具体匹配优先报告来源（namespace wildcard 优先于 provider-wide wildcard），exact 优先于所有 wildcard。

### 3.2 malformed policy 的兼容与 issue 映射

- `agents.defaults.modelPolicy.allow` 缺失仍为 `legacy`。
- `allow` 存在但不是数组时，为兼容旧配置按 `legacy` 计算 effective enabled；同时必须产生一个 blocking issue：`source: "health"`、`id: "health:invalid-model-policy-allow:modelPolicy.allow"`、`severity: "blocking"`。`detail` 必须说明 `modelPolicy.allow` 不是数组、已按 legacy 解释且未用于 selection；`action` 必须指导用户将其修正为数组或删除该字段。此错误形态不得被报告为 `unrestricted` 或 `restricted`。
- `allow` 是数组时，非字符串条目原样保留在配置和 raw count 中，但忽略匹配；每个条目必须产生一个 blocking issue：`source: "health"`、`id: "health:invalid-model-policy-entry:modelPolicy.allow[<index>]"`、`severity: "blocking"`。`detail` 必须指出数组索引和“非字符串、未参与匹配”；`action` 必须指导用户删除或改为字符串 exact/wildcard entry。issue ID 使用 zero-based 原数组 index，确保重复值也可区分且可测试。
- malformed policy issue 不得泄露配置中除该 policy entry 以外的 secret；非字符串值的 detail 只描述类型，不序列化其内容。`unknownProviderRefs` 仍只收集字符串 exact refs，并为 informational raw fact，不额外产生 blocking issue。

若 `openclaw.json` 缺失、不可读或 JSON/JSON5 解析失败，`GET /api/config-status` 仍返回 `ConfigStatusReport`，不得直接 400。此时：

- `health` 返回空报告（`caseDuplicateGroups: []`，summary 三项为 0）。
- `issues[]` 加入对应 `paths:*:openclaw` blocking issue。
- 依赖 `OpenClawConfig` 的来源（case duplicate、provider env refs）跳过；仍可读取 provider-states、manifest、路径状态等 oc-switch 自有状态。

---

## 4. `issues[]` 与分项 raw facts 的分工

| 字段 | 角色 | 消费者用途 |
|------|------|------------|
| `health` | raw facts | 展示 case-duplicate 组详情、合并预览、drill-down |
| `disabledProviders` | raw facts | 展示禁用时间、路径、隐藏模型数 |
| `orphanEnvKeys` | raw facts | Settings 孤儿 key 清理列表 |
| `envWarnings` | raw facts | env 文件层级的原始警告文案 |
| `issues[]` | **唯一行动列表** | 仪表盘徽章、统一「待处理」列表、CLI 摘要 |

**规则：**

1. `summary.issueCount`、`summary.blockingIssueCount`、`summary.warningIssueCount` **仅**从 `issues[]` 派生。
2. `summary.duplicateGroupCount` = `health.summary.duplicateGroupCount`。
3. `summary.disabledProviderCount` = `disabledProviders.length`。
4. `summary.orphanEnvKeyCount` = `orphanEnvKeys.length`。
5. 路径可读/可写问题**只**出现在 `issues[]`（`source: "paths"`），不设独立 top-level raw 数组。
6. `issues[]` 不重复携带 raw facts 全文；`detail`/`action` 为简短人类可读摘要，完整数据从对应 raw 字段 drill-down。

---

## 5. 去重规则：`source:kind:subject`

每条 `ConfigStatusIssue` 的 `id` 字段即为去重 key，格式 **`${source}:${kind}:${subject}`**。

- `source` 必须与 `ConfigStatusIssue.source` 一致。
- `kind` 表示问题类型，例如 `missing`、`duplicate`、`disabled`。
- `subject` 是具体对象标识，例如 env var、provider id 或路径类别。
- `subject` 中的冒号必须编码为 `%3A`；实现可统一使用 `encodeURIComponent(subject)` 生成该段。

`issues[]` 中不得存在两条相同 `id` 的条目。`source` 字段与 id 前缀一致。

### 5.1 Issue 生成映射

| source | 完整 id 模式 | severity 默认 | 触发条件 |
|--------|---------------|---------------|----------|
| `health` | `health:duplicate:${groupKey}` | `warning` | `health.caseDuplicateGroups` 每组一条；`mergeable` 只影响 `detail`/`action` 文案 |
| `health` | `health:secret-ref-migration:${providerId}` | `warning` | `apiKey` 使用 `${ENV_VAR}`、`$ENV_VAR` 或旧两字段 EnvRef，可在 Providers 页确认迁移 |
| `health` | `health:invalid-auth-header-ref:${providerId}` | `blocking` | `authHeader` 错写为密钥引用 |
| `health` | `health:missing-model-name:${providerId}/${modelId}` | `blocking` | provider model 缺少 OpenClaw 必填 name |
| `health` | `health:model-policy-not-covered:modelPolicy.allow` | `warning` | legacy metadata refs（`agents.defaults.models` exact refs）未被非空 `modelPolicy.allow` exact/wildcard 覆盖 |
| `health` | `health:invalid-model-policy-allow:modelPolicy.allow` | `blocking` | `modelPolicy.allow` 存在但不是数组；按 legacy 解释但要求修复 |
| `health` | `health:invalid-model-policy-entry:modelPolicy.allow[<index>]` | `blocking` | 数组中的该索引不是字符串；保留但忽略匹配 |
| `env` | `env:missing:${envVar}` | `warning` | provider 引用 env var 在 `.env` 中缺失 |
| `env` | `env:duplicate:${envVar}` | `warning` | 同一 env var 在 `.env` 出现多次 |
| `env` | `env:orphan:${envVar}` | `info` | `orphanEnvKeys` 中的 key（与 `listOrphanEnvKeys` 一致） |
| `env` | `env:complex:${envVar}` | `info` | env 值为复杂表达式（`inspectEnvFile` variables.complex） |
| `providers` | `providers:disabled:${providerId}` | `info` | `readProviderStates` 中存在的 disabled provider |
| `paths` | `paths:unreadable:openclaw` | `blocking` | 活动 `openclaw.json` 路径存在但不可读 |
| `paths` | `paths:unwritable:openclaw` | `warning` | 活动 `openclaw.json` 路径存在但不可写 |
| `paths` | `paths:invalid:openclaw` | `blocking` | 活动 `openclaw.json` 存在且可读，但 JSON/JSON5 解析失败 |
| `paths` | `paths:unreadable:env` | `blocking` | 活动 `.env` 路径存在但不可读 |
| `paths` | `paths:unwritable:env` | `warning` | 活动 `.env` 路径存在但不可写 |
| `paths` | `paths:missing:openclaw` | `blocking` | 活动 `openclaw.json` 路径不存在 |
| `paths` | `paths:missing:env` | `warning` | 活动 `.env` 路径不存在 |

**跨来源去重示例：** 同一 env key `MY_API_KEY` 若同时被 provider ref 检测为 missing、又被 orphan 列表收录，只产生 **一条** `env:missing:MY_API_KEY`（missing 优先于 orphan，不重复发 `env:orphan:MY_API_KEY`）。

`envWarnings` 中的自由文本警告若已映射到结构化 issue，不再为同一 `source:kind:subject` 重复建 issue。

### 5.2 模型 policy 与 wildcard 状态规则

config-status 可报告模型 selection 的 mode、source 和计数，但不得把用户 wildcard 展开为 exact 条目，也不得因状态读取删除或改写 wildcard。policy-only exact ref 应可被识别为 restricted selection；不在本地 Provider 目录中的 exact ref 可作为 `modelPolicy.unknownProviderRefs` informational raw fact，但不能被计入 `effectiveModelCount`。当非空 policy 存在且 `agents.defaults.models` 中的 legacy metadata ref 未被 exact 或 wildcard 覆盖时，必须产生唯一的 `health:model-policy-not-covered:modelPolicy.allow` warning；其 `detail` 应说明 legacy metadata 仍存在但不参与 restricted selection，`action` 应指导用户将 ref 加入 policy、调整 wildcard，或移除不再需要的 metadata。该 issue 是全局 policy issue，不按 ref 追加 ID。

当单模型或 Provider 的 disable、rename、批量清理会要求重写 wildcard 才能保持结果时，写入操作必须采用 fail-closed 错误；`force` 不得绕过。Provider disabled state 只能影响 effective availability，不得被解释为 policy entry，也不得改变 `modelPolicy.allow` 的存在性或内容。per-agent `agents.entries.*.modelPolicy.allow` 不属于本契约范围。

---

## 6. Core 聚合函数（实现指引）

spec 接受后实现：

```ts
export interface InspectConfigStatusInput {
  /** best-effort 读取到的配置；读取失败时省略 */
  config?: OpenClawConfig;
  /** openclaw.json 存在但解析失败或读取失败时的简短错误文案 */
  configReadError?: string;
  paths: OcSwitchPaths;
  envContent: string;
  runningInstances?: RunningOpenClawInstance[];
}

export function inspectConfigStatus(input: InspectConfigStatusInput): ConfigStatusReport;
```

**依赖调用（只读）：**

1. `config ? inspectConfigHealth(config) : emptyConfigHealthReport()` → `health`
2. `readProviderStates(paths.stateDir)` → 映射为 `disabledProviders`（`hiddenModelCount` = `Object.keys(allowlistEntries).length`，**不**返回 `allowlistEntries`）
3. `listOrphanEnvKeys(paths.stateDir)` → `orphanEnvKeys`
4. `inspectEnvFile({ content, providerRefs: config ? listProviderEnvRefs(config) : [], manifest: readManifest(paths.stateDir) })` → `envWarnings` + issue 推导
5. 直接检查 `input.paths.openclawPath` / `input.paths.envPath` 的 exists/readable/writable；路径 issue 必须基于 `input.paths`，不得使用 `resolveOpenClawPathCandidates(...).active` 推导出的其他默认路径替代。
6. 可额外调用 `resolveOpenClawPathCandidates({ stateDir: input.paths.stateDir, runningInstances, manualOpenClawPaths: [input.paths.openclawPath], manualEnvPaths: [input.paths.envPath] })` 作为候选路径 drill-down 参考，但首版不把候选列表放入 response。

---

## 7. Web 首版范围

**仅 API client，不接 UI。**

| 包含 | 不包含 |
|------|--------|
| `ConfigStatusIssue`、`DisabledProviderStatus`、`ConfigStatusReport` 类型镜像 | Dashboard 健康徽章 |
| `createApiClient().getConfigStatus()` → `GET /api/config-status` | Providers 页 case-duplicate 标注改造 |
| `packages/web/src/api.test.ts` 请求路径与 auth 断言 | Models / Settings 页状态展示 |

UI 接入需另开产品/UI spec，可基于 `issues[]` 与 raw facts drill-down 设计。

---

## 8. 安全与隐私

- 响应不得包含 API key 明文、`.env` 变量值、token。
- `disabledProviders` 仅含 `providerId`、`disabledAt`、`openclawPath`、`hiddenModelCount`。
- `orphanEnvKeys` 仅含变量名。
- `health` 沿用现有 `ConfigHealthReport`，不新增密钥字段。

---

## 9. 验收标准

### 9.1 Core（`inspectConfigStatus`）

- [ ] 无问题时 `issues` 为空，`summary.issueCount === 0`。
- [ ] case-duplicate 组计入 `summary.duplicateGroupCount` 且产生 `health:duplicate:*` issue。
- [ ] disabled provider 计入 `summary.disabledProviderCount` 且产生 `providers:disabled:*` issue。
- [ ] orphan env key 计入 `summary.orphanEnvKeyCount`；若未同时 missing，产生 `env:orphan:*` issue。
- [ ] 缺失 provider env key 产生 `env:missing:*` issue（不与 orphan 重复）。
- [ ] 活动配置路径缺失、不可读或解析失败时，仍返回 report，并产生 `paths:*:openclaw` blocking issue。
- [ ] restricted 配置中的 `cpa/*` 与 `grok2api/*` 按 provider-wide wildcard 识别，且不展开为 exact entries。
- [ ] policy-only exact refs 可识别为 restricted/policy-exact，但不虚构本地 Provider 模型目录。
- [ ] 缺失 policy 与空 policy 分别报告 `legacy` 与 `unrestricted`，不可合并。
- [ ] `ModelSummary.selectionSource` 与 `StatusSummary.modelPolicyMode` / `effectiveModelCount` 正确，同时保留 `allowlistModelCount`。
- [ ] wildcard toggle rejection、Provider disabled 与 policy availability、model rename 和 batch cleanup 均遵守 fail-closed 与不改写 wildcard 规则。
- [ ] 活动 env 路径缺失时产生 `paths:missing:env` warning；不可读时产生 `paths:unreadable:env` blocking issue。
- [ ] `issues[]` 中所有 `id` 唯一（`source:kind:subject` 无重复）。

### 9.2 Server

- [ ] `GET /api/config-status` 返回 200 + `ConfigStatusReport`。
- [ ] `openclaw.json` 缺失或解析失败时，`GET /api/config-status` 仍返回 200 + path blocking issue。
- [ ] `GET /api/health` 响应 shape **不变**（回归现有 `app.test.ts`）。
- [ ] 禁用 provider 后 `summary.disabledProviderCount === 1` 且 `disabledProviders[0].providerId` 正确。

### 9.3 Web

- [ ] `getConfigStatus()` 请求 `GET /api/config-status` 并携带 Bearer auth。
- [ ] 不修改 Dashboard / Providers / Models / Settings 组件与测试。

### 9.4 全量回归

```bash
bun run check
```

---

## 10. 测试策略

| 层级 | 文件 | 覆盖重点 |
|------|------|----------|
| Core 单元 | `packages/core/test/config-status.test.ts` | issue 生成、去重、summary 派生、path/env/health 组合场景 |
| Core 回归 | `config-health.test.ts`、`env-inspector.test.ts`、`provider-states.test.ts` | 确保聚合未改变底层语义 |
| Server 集成 | `packages/server/test/app.test.ts` | 端点存在、disabled provider 场景、`/api/health` 不变 |
| Web API | `packages/web/src/api.test.ts` | client 方法与 auth |

测试 fixture 优先复用现有 `openclaw.sample.json` 与 operations/provider-states 测试辅助模式；不依赖真实用户 `~/.openclaw` 路径。

---

## 11. 门禁与后续

1. **本 spec 须用户 review/接受后**，方可编写 Slice 6 实现代码（Core → Server → Web API client）。
2. `/api/health` 的 alias/deprecate 不在 Slice 6 范围内。
3. Web UI 消费 `issues[]` 另开 spec。
4. 若 review 修改响应 shape，须同步更新 plan Task 12–14 后再实现。

---

## 12. 用户已确认决策（2026-06-26）

与 plan「用户确认决策」一致：

1. `ConfigStatusReport` 为 v1 DTO；Core 定义、Web 镜像；不建 shared contracts 包。
2. `issues[]` 为唯一去重行动列表；分项字段保留 raw facts；去重 key 为 `source:kind:subject`。
3. Web 首版仅 API client。
4. `/api/health` 长期冻结；新能力走 `/api/config-status`。
5. Slice 6 实现 gated on 本 spec 接受。
