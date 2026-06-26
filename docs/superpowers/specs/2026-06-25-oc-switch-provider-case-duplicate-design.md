# oc-switch Provider 大小写重复（Case Duplicate）设计规格

> 日期：2026-06-25  
> 状态：待评审  
> 目标：定义 oc-switch 如何识别、解释并帮助用户处理「同一逻辑来源、不同大小写 Provider ID」的配置问题，避免用户在模型页/Providers 页误以为存在两个独立 Provider。

---

## 1. 背景与问题场景

### 1.1 用户可见现象

在 WebGUI **模型页**左侧 Provider 列表中，用户可能看到成对条目，仅大小写不同，例如：

| Provider ID（列表中） | 模型数 | 典型含义 |
|----------------------|--------|----------|
| `9r` / `9R` | 相同或接近 | 同一套自部署 9 Router |
| `deepseek` / `DeepSeek` | 相同或接近 | 同一 DeepSeek 来源 |
| `joverna` / `Joverna` | 相同或接近 | 同一自定义站 |
| `openrouter` / `OpenRouter` | 可能不同 | allowlist 与 provider 定义分散在两套 ID 上 |

用户困惑点：

- 这是两个 Provider 还是同一个？
- 应该保留哪一个、删除哪一个？
- 是否需要统一成全大写或全小写？

### 1.2 技术根因

OpenClaw 与 oc-switch 对 Provider ID **大小写敏感**，且**不自动 normalize**（见 `2026-06-23-oc-switch-design.md` §2.5）：

- `models.providers["9r"]` 与 `models.providers["9R"]` 是**两个独立 key**
- allowlist（`agents.defaults.models`）的 ModelRef 前缀必须与 provider key **逐字符一致**
- `9r/foo` 与 `9R/foo` 是两条不同的 allowlist 条目

重复通常来自：

1. **多次导入/迁移**：不同工具或不同时间写入时大小写不一致
2. **手改 JSON**：用户或脚本改过 provider key 但未同步 allowlist
3. **preset 与历史配置混用**：builtin preset 倾向小写（`deepseek`），旧配置可能是 `DeepSeek`
4. **自定义 Provider 手填 ID**：oc-switch 添加自定义 Provider 时默认生成小写 ID，但历史数据可能是 `9R` 等

### 1.3 产品结论（原则）

| 问题 | 结论 |
|------|------|
| 两个都得留着吗？ | **否**。逻辑上同一来源应只保留 **一个** canonical Provider ID |
| 全局统一成全大写/全小写？ | **否**。不应批量改写所有 provider；只对「已判定同源」的重复对做合并 |
| 自定义站（如 9 Router） | 高概率同源；以 `baseUrl`、主模型、配置完整度判断，**不是**让用户猜 |
| oc-switch 当前责任 | 已能读写配置，但**未检测、未标注、未引导合并**；模型页合并展示 ID 会**放大困惑** |

本规格定义 oc-switch 应如何补齐这一能力。

---

## 2. 目标

### 2.1 首版目标（Phase 1：检测与建议）

- Core 能扫描当前 `openclaw.json`，输出结构化的 **Case Duplicate 报告**
- 明确区分问题类型，并给出**建议保留 / 建议移除**的 Provider ID 及理由
- WebGUI 在**仪表盘配置健康**、**Providers 页**、**模型页 Provider 侧栏**展示告警，不让重复 ID 看起来像两个正常 Provider
- CLI 提供只读诊断命令（或扩展现有 `status`）输出同类信息

### 2.2 后续目标（Phase 2：引导合并）

- 提供「合并重复 Provider」向导：用户确认 canonical ID → preview diff → 自动备份 → 提交
- 合并范围：迁移 allowlist、合并 `models.providers.*.models`、更新主模型、删除重复 provider key
- **不**自动删除 `.env` 中的 API Key；删除侧 provider 的 env 引用标为 orphan（与现有删除 Provider 行为一致）

### 2.3 预防目标（Phase 1 可并行）

- 添加自定义 Provider、从 preset 写入、import 前：若已存在 case-insensitive 同名 provider，**阻断并提示合并**，不静默创建第二套

## 3. 非目标

- 不修改 OpenClaw 对 Provider ID 大小写敏感的语义
- 不在后台静默 normalize 用户配置
- 不强制全局命名规范（例如所有 provider 必须小写）
- 首版不处理「非大小写差异的重复 provider」（例如 `openrouter` 与 `open-router` 同 baseUrl）——可列为后续增强
- 首版不处理「仅 allowlist 孤立、provider 块已不存在」的 general stale ref 全量清理（与 case duplicate 有交集但规格更广，可另立文档）

---

## 4. 问题分类

扫描器应识别以下类型（可叠加）：

### 4.1 `provider-duplicate`（Provider 级重复）

`models.providers` 中存在多个 key，其 `toLowerCase()` 相同。

示例：`9r` 与 `9R` 同时存在于 `models.providers`。

### 4.2 `allowlist-drift`（Allowlist 前缀漂移）

allowlist 中存在 `9R/...`，但 `models.providers` 只有 `9r`（或反之）；或两边 provider 都存在但 allowlist 分散。

示例：`openrouter` 显示 2 条、`OpenRouter` 显示 1 条。

### 4.3 `same-origin-hint`（同源信号）

同一重复组内，多个 provider 的 `baseUrl`（normalize 后）相同，或 `apiKey.id` / `authHeader.id` 指向同一 env 变量。

用于提高「建议合并」的置信度，并在 UI 文案中说明「大概率同一来源」。

### 4.4 `primary-split`（主模型落在重复组）

`agents.defaults.model` 的 provider 前缀属于某重复组，但组内还有其他 ID 仍持有模型或 allowlist。

合并时必须提示主模型将迁移到 canonical ID。

---

## 5. 建议保留哪一个（Recommendation Engine）

对每一组 case-insensitive 重复 ID，输出：

- `canonicalId`：建议保留
- `duplicateIds`：建议合并后删除
- `reasons[]`：可读说明（供 UI 展示）
- `confidence`：`high` | `medium` | `low`

### 5.1 评分规则（按优先级）

| 优先级 | 规则 | 说明 |
|--------|------|------|
| 1 | **主模型前缀** | `agents.defaults.model` 解析出的 `providerId` 在组内 → 该 ID +2 分 |
| 2 | **配置完整度** | 有 `baseUrl`、有 `apiKey`/`authHeader`、有非空 `models` 列表 → 各 +1 分 |
| 3 | **allowlist 条目数** | 组内该 ID 前缀下的 allowlist 条数更多 → +1 分 |
| 4 | **自定义 Provider 偏小写** | 若组内无上述强信号且均为自定义站 → 小写 ID +1 分（与 `CustomProviderDialog` 默认行为一致） |
| 5 | **builtin preset 对齐** | 若组内某一 ID 与仓库 builtin preset `id` 完全一致 → 该 ID +1 分 |

平局时：

- 优先保留**字典序稳定**的 ID（避免每次扫描结果翻转），但在 UI 中标注「建议人工确认」，`confidence` 降为 `medium`

### 5.2 明确不采用的策略

- **不**因「模型数多」单独决定保留方（`openrouter` 2 vs `OpenRouter` 1 可能是孤立 allowlist 导致）
- **不**默认保留 PascalCase 或默认保留全小写；必须基于上述规则逐组计算

### 5.3 输出示例

```json
{
  "groupKey": "9r",
  "kind": "provider-duplicate",
  "confidence": "high",
  "sameOrigin": true,
  "canonicalId": "9r",
  "duplicateIds": ["9R"],
  "reasons": [
    "主模型当前为 9r/deepseek-v3",
    "9r 与 9R 的 baseUrl 相同",
    "allowlist：9r 11 条，9R 0 条（仅 provider 块重复）"
  ],
  "impact": {
    "primaryModel": "9r/deepseek-v3",
    "allowlistRefsToMigrate": ["9R/foo → 9r/foo"],
    "providersToRemove": ["9R"]
  }
}
```

---

## 6. Core 设计

### 6.1 新模块：`config-health.ts`（名称可调整）

```typescript
export type CaseDuplicateKind =
  | "provider-duplicate"
  | "allowlist-drift"
  | "same-origin-hint"
  | "primary-split";

export interface CaseDuplicateGroup {
  groupKey: string;           // toLowerCase() 归一 key，仅用于分组展示
  ids: string[];              // 实际出现的 provider ID（保留原始大小写）
  kinds: CaseDuplicateKind[];
  confidence: "high" | "medium" | "low";
  sameOrigin: boolean;
  canonicalId: string;
  duplicateIds: string[];
  reasons: string[];
  details: {
    baseUrls: Record<string, string | undefined>;
    allowlistCounts: Record<string, number>;
    modelCounts: Record<string, number>;
    primaryModel?: string;
    envVars: Record<string, string | undefined>;
  };
}

export interface ConfigHealthReport {
  caseDuplicateGroups: CaseDuplicateGroup[];
  summary: {
    duplicateGroupCount: number;
    affectedProviderCount: number;
    affectedAllowlistCount: number;
  };
}

export function inspectConfigHealth(config: OpenClawConfig): ConfigHealthReport;
```

实现要点：

- 从 `models.providers` 与 `agents.defaults.models` 收集 provider 前缀
- 按 `toLowerCase()` 分组，仅当组内 `ids.length > 1` 或存在 allowlist/provider 不一致时上报
- `baseUrl` 比较前做轻度 normalize（trim、去末尾 `/`、小写 host 可选——首版仅 trim + 去尾斜杠）
- 纯函数、可单测；不读写磁盘

### 6.2 Phase 2 合并操作：`mergeProviderCaseDuplicates`

```typescript
export interface MergeCaseDuplicateInput {
  groupKey: string;
  canonicalId: string;
  removeIds: string[];
}

export function mergeProviderCaseDuplicates(
  config: OpenClawConfig,
  input: MergeCaseDuplicateInput
): OperationResult;
```

合并语义：

1. 对每个 `removeId`：
   - 将其 `models.providers[removeId].models` 合并进 `canonicalId`（按 model `id` 去重，保留 canonical 侧字段优先）
   - 将 allowlist 中 `removeId/` 前缀的 key 改写为 `canonicalId/`（modelId 不变）
   - 若主模型前缀为 `removeId`，更新为 `canonicalId`
   - 删除 `models.providers[removeId]`
2. 不修改 `.env` 文件；删除侧 env 引用由 manifest 标 orphan（复用现有 `deleteProvider` 逻辑）

必须通过 `diff-guard` 语义范围校验。

---

## 7. API 设计

### 7.1 Phase 1

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` 或 `/api/config/health` | 返回 `ConfigHealthReport` + 现有 status 摘要 |

可选：扩展 `GET /api/status` 嵌入 `health.caseDuplicates` 摘要，避免额外请求。

### 7.2 Phase 2

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/providers/merge-case-duplicates/preview` | body: `{ groupKey, canonicalId, removeIds }`，返回 config diff |
| `POST` | `/api/providers/merge-case-duplicates` | 备份后提交合并 |

错误码：

- `409`：合并会导致 model id 冲突且无法自动解决
- `400`：`canonicalId` 不在组内或 `removeIds` 含 canonical

---

## 8. WebGUI 设计

### 8.1 仪表盘 · 配置健康

在现有「与最近备份 diff」之外，增加**结构性健康问题**：

- 文案示例：`发现 4 组 Provider 大小写重复（含 9r/9R）`
- 列出每组：`建议保留 9r，合并并删除 9R` + 展开理由
- 操作：`查看详情` → Providers 页或专用抽屉；Phase 2 显示 `合并` 按钮

### 8.2 Providers 页

- 对属于重复组的 Provider 卡片加 **⚠ 重复** 徽章
- 组内条目视觉分组（缩进或折叠），显示「与 9R 同源，建议保留 9r」
- Phase 2：`合并重复` 入口

### 8.3 模型页 · Provider 侧栏（当前痛点来源）

**现状问题**：侧栏合并 `listProviders()` 与 `listModels()` 的 `providerId`，重复 ID 并列展示且无解释。

**改进**：

- 按 case-insensitive 分组展示；组标题用 canonical 建议 ID
- 组内若仍有多个实际 ID，显示为「9r（推荐）」「9R（重复）」而非两个平等条目
- 点击重复 ID 时顶部 banner 提示合并建议

### 8.4 添加 Provider / Import（预防）

- 提交前调用 health 检查：若新 ID 与已有 ID case-insensitive 冲突 → 阻断，提示「已存在 9r，是否要合并到现有 Provider？」
- Phase 1 可仅阻断 + 文案；Phase 2 链到合并向导

---

## 9. CLI 设计

Phase 1 扩展：

```bash
oc-switch health
# 或
oc-switch status --health
```

输出每组重复及 `canonicalId` 建议，便于 SSH 到 VPS 快速诊断。

Phase 2：

```bash
oc-switch providers merge-duplicates --group 9r --keep 9r --remove 9R --dry-run
oc-switch providers merge-duplicates --group 9r --keep 9r --remove 9R
```

---

## 10. 测试策略

### 10.1 Core 单测

| 用例 | 说明 |
|------|------|
| `9r` + `9R` 同 baseUrl | 检测为 `provider-duplicate`，`sameOrigin: true` |
| 仅 allowlist 有 `DeepSeek/...`，provider 为 `deepseek` | `allowlist-drift` |
| 主模型在 `9R/...` | `canonicalId` 应为 `9R` |
| 自定义站无强信号 | 偏小写，`confidence: medium` |
| `openrouter` / `OpenRouter` 不同 allowlist 数 | 不因数量 alone 选错；结合 baseUrl/主模型 |

### 10.2 合并单测（Phase 2）

- allowlist 前缀迁移后 modelId 不变
- 主模型更新
- 两侧 models 数组合并去重
- 删除 provider 不删 env key

### 10.3 Web 测试

- 仪表盘展示重复组摘要
- 模型页侧栏分组展示，重复 ID 带警告态

---

## 11. 分阶段交付建议

| 阶段 | 范围 | 用户价值 |
|------|------|----------|
| **Phase 1a** | Core `inspectConfigHealth` + API + CLI | 能回答「留哪个、删哪个」 |
| **Phase 1b** | 仪表盘 / Providers / 模型页标注 | 不再误导为两个正常 Provider |
| **Phase 1c** | 添加 Provider 时防重复 | 新配置不再恶化 |
| **Phase 2** | 合并 preview/commit + 向导 | 一键修复存量 |

与现有计划的关系：`2026-06-25-e2e-browser-review-improvements.md` 已明确 full cleanup engine 需独立 Core/API 设计；**本文档即该独立设计**。

---

## 12. 与用户沟通文案（草案）

**问题说明（短）：**

> Provider ID 大小写不同（如 `9r` 和 `9R`）在 OpenClaw 里算作两个 Provider。若它们指向同一服务，应合并为一个 ID，否则模型列表和主模型可能指向错误条目。

**建议操作（短）：**

> 建议保留 **9r**，删除 **9R**。理由：主模型使用该前缀，且两者 baseUrl 相同。合并将统一模型列表与已启用模型，不会删除 API Key，仅将未使用的 env 引用标为可清理。

---

## 13. 开放问题（待评审）

1. **Phase 1 是否足够**：仅检测+标注、不做合并，是否满足首版发布门槛？
2. **baseUrl 相同但 apiKey 不同**：是否视为「可能同源但 credential 分叉」，`confidence` 降为 `low` 并禁止一键合并？
3. **三组及以上**（极少见）：`9r` / `9R` / `9router` 同组时 UI 如何展示？
4. **模型页侧栏**：是否 Phase 1 就改为只显示 canonical 组名，重复 ID 收进折叠？

---

## 14. 参考

- `docs/superpowers/specs/2026-06-23-oc-switch-design.md` §2.5 ModelRef 大小写敏感
- `docs/superpowers/specs/2026-06-24-oc-switch-custom-provider-design.md` Provider ID 规则
- `docs/2026-06-25-e2e-browser-review.md` — 清理陈旧 ref 缺口
- `docs/superpowers/plans/2026-06-25-e2e-browser-review-improvements.md` — cleanup engine 推迟说明
- `packages/web/src/components/CustomProviderDialog.tsx` — 默认小写 ID 生成
- `packages/web/src/views/ModelsView.tsx` — Provider 侧栏合并来源
