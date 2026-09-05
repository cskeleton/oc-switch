# oc-switch 模型参数批量同步（models.dev + CPAMP 模糊匹配 + 确认队列）设计

> 日期：2026-09-05
> 状态：已实现（2026-09-05 Sync Audit 完成，实现偏差已回写对应小节）
> 目标：为 Provider 目录中**已存在**的模型条目批量回填 models.dev 参数（name / reasoning / contextWindow / maxTokens / input），复用现有确定性 resolver，新增移植自 CPAMP（经 OpenClawUsage）的模糊匹配与确认队列；只填空缺字段，绝不覆盖已有值。

## 1. 背景

### 1.1 现状

- oc-switch 已有完整的 models.dev 只读链路：`model-metadata-catalog.ts`（双源加载、版本化缓存、24h fresh / 30 天 stale、ETag、超时与大小上限）+ `model-metadata-resolver.ts`（6 级确定性匹配，最多 5 条建议）+ `GET /api/model-metadata/suggestions`（只读）+ Web `ModelDialog`「查询参考参数」（仅应用 `contextWindow` / `maxTokens` / `input` 三项）。
- 但批量写入路径不存在：`batchAddProviderModels`（`packages/core/src/provider-model-batch.ts`）每条只写 `{ id, name?, reasoning: true }`（`reasoning: true` 为硬编码）；`discoverProviderModels` 只拉 `id/name`。
- Provider 目录条目（`OpenClawModel`，`packages/core/src/types.ts:16-28`）已有参数字段：`name` / `reasoning` / `contextWindow` / `contextTokens` / `maxTokens` / `input`。

### 1.2 参考实现

- **CPAMP**（github.com/seakee/CPA-Manager-Plus）：多索引匹配器、打分权重（tokenJaccard×0.86 / editSimilarity×0.82）、阈值（0.55 自动唯一 / 0.34 弱召回）、每 key 最多 8 候选、歧义确认队列。
- **OpenClawUsage**（2026-09-04 落地，规格 `OpenClawUsage/docs/superpowers/specs/2026-09-04-pricing-mechanism-redesign-design.md`）：`pricing-catalog-matcher.js` 移植了上述打分并增加官方条目启发式（`isOfficialEntry`）、token 严格包含禁止自动唯一、manual-protection、candidates 队列（`pricing-candidates-store.js`）、`POST /api/pricing/rematch` 批量重扫。

### 1.3 差距

本地模型经 discover/batch-add 进入 `provider.models[]` 后，除 `name` 外参数全空（`reasoning` 被硬编码为 `true`）；逐个打开弹窗查建议成本高。需要一条「对已存在条目批量回填参数」的路径。

## 2. 目标

### 2.1 用户目标

- Provider 级：一键为该 Provider 全部本地模型回填缺失参数
- Model 级：在模型列表多选后批量回填
- 低置信/歧义命中不自动落盘，进入确认队列由用户逐条 accept/dismiss
- 手工调整过的字段永不丢失（只填空缺）

### 2.2 工程目标

- core 是唯一写盘方；CLI / server / web 只做装配
- 现有 `resolveModelMetadata` 与「查询参考参数」行为零改变；模糊匹配为批量同步专用的新模块
- 模糊打分逻辑移植自 CPAMP/OpenClawUsage，参数（权重/阈值/候选数）保持一致，集中常量便于调整
- 同步与 accept 均走现有 openclaw.json 写入 + 自动备份机制

## 3. 非目标

- 不新增/删除模型条目，不改 discover / batch-add / batch-remove 契约；`MAX_PROVIDER_MODELS` 不涉及
- 不覆盖已有字段值（无 overwrite 模式；修错请走模型编辑弹窗）
- 不写 `contextTokens`（运行时预算，目录无此语义）、`cost`（无代码消费）、`enabled`、`api`、`alias`
- 不动 `agents.defaults.models`、allowlist、`modelPolicy.allow`、主模型双形态与 `fallbacks`
- 不做 CPAMP 式整表同步（不把远端全量目录灌进 `openclaw.json`）
- 不引入 OpenClawUsage 的 pricing 字段与 cache ×0.1 惯例
- 模糊层**不自动应用**（与 CPAMP 0.55 自动唯一不同，见 §5.3）

## 4. 总体架构与数据流

新增三个 core 模块，四端入口装配：

```
packages/core/src/model-metadata-matcher.ts   # CPAMP 模糊打分（纯函数）
packages/core/src/model-metadata-queue.ts     # 确认队列 store（基于 json-state-store）
packages/core/src/model-metadata-sync.ts      # 批量同步 orchestration（读配置→匹配→写盘/入队）
```

数据流（Provider 级与 Model 级共用）：

1. 入口给定 `providerId` + 可选 `modelIds[]`（缺省 = 该 Provider 全部本地模型）
2. 过滤待处理集合：五项参数字段（`name` / `reasoning` / `contextWindow` / `maxTokens` / `input`）**至少缺一项**的条目才进入匹配；全满的计入 `skipped`
3. `loadModelMetadataCatalog` 加载目录（缓存/TTL/stale 降级沿用现状）；两源均不可用时报错返回，**零写入**
4. 逐模型走匹配管线（§5），结果分流：自动应用 / 入队 / 未匹配
5. 自动应用集合按 §6 fill-empty 语义修改内存中的 config，**一次性写盘**（单事务，走现有备份）
6. 返回报告 DTO（§7）

## 5. 匹配管线

### 5.1 第一级：确定性 resolver

对每条待处理模型调用现有 `resolveModelMetadata({ providerId, baseUrl, modelId }, catalog)`：

- **恰好 1 条建议且 `confidence === "high"`**（matchKind ∈ provider-exact / endpoint-exact / model-key-exact）→ 自动应用
- 建议数 ≥1 但 confidence 为 medium/low，或多条建议 → 全部作为候选**入队**（`reason: "resolver-<matchKind>"`）
- 0 条建议 → 进入第二级

### 5.2 第二级：CPAMP 模糊匹配（新模块 `model-metadata-matcher.ts`）

移植 `OpenClawUsage/pricing-catalog-matcher.js`，改为对 `NormalizedModelMetadata[]` 工作：

- 集中常量：`FUZZY_SCORE_THRESHOLD = 0.55`、`FUZZY_WEAK_THRESHOLD = 0.34`、`FUZZY_MAX_CANDIDATES = 8`、权重 `0.86 / 0.82`
- `tokenizeModelId` / `tokenJaccard` / `levenshtein` / `editSimilarity` / `scoreCandidate`（`max(tokenJaccard×0.86, editSimilarity×0.82)`）；分词正则保留小数点（`[^a-z0-9.]+`，CPAMP 原为 `[^a-z0-9]+`）：「5.6」「4.6」等版本号须为单 token，否则版本差异会被误算为共享 token
- 未单建 `buildCatalogIndex` 函数：`matchFuzzyModelMetadata` 内联按 `modelId.toLowerCase()` 分组（catalogKey 全集：modelFacts + providerCatalog），同 id 多条目经 `pickRepresentative`（本 provider → 官方条目 → catalogKey 稳定序）选代表后打分
- 归一化探测串：复用现有 `model-id-core.ts` 的 `localCoreCandidates`，probe 取其**首个**候选（只剥前缀、不逐段截断，保留最多区分信息；与 OpenClawUsage 取最短候选不同），**不另引** OpenClawUsage 的 `generateModelKeyCandidates`（noiseSuffixes 概念以 oc-switch 现有常量为准）
- `isOfficialMetadataEntry` 官方条目启发式与 `KNOWN_MODEL_CREATORS` 集合原样移植，仅用于 `pickRepresentative` 消歧排序，不产出独立 reason
- `hasStrictTokenContainment` 守卫原样移植；因模糊层永不自动应用（§5.3），守卫与 `FUZZY_SCORE_THRESHOLD` 仅用于 reason 标注

### 5.3 模糊结果分流（与 CPAMP 的关键差异）

- 模糊层命中（score ≥ `FUZZY_WEAK_THRESHOLD`）**一律入队**，即使 score ≥ `FUZZY_SCORE_THRESHOLD` 且唯一——写入真实运行配置比定价参考表保守，用户确认成本一次点击，误应用成本是运行参数错误
- 候选按 score 降序（同分按 catalogKey 稳定序）取前 `FUZZY_MAX_CANDIDATES` 条，附 `score` 与 `reason`（`"token-containment"` 严格 token 包含 / `"shared-model-tokens"` ≥0.55 / `"weak-recall"` 0.34–0.55）
- 低于 `FUZZY_WEAK_THRESHOLD` → 计入 `unmatched`

## 6. 写入语义（fill-empty）

字段映射（`NormalizedModelMetadata` → `OpenClawModel`），**仅当条目当前字段缺失且候选值合法时**才写入：

| 目录字段 | 目标字段 | 备注 |
|---|---|---|
| `name` | `name` | 条目缺 `name` 时填（`defaultModelName` 的显示补全不算已有值） |
| `reasoning` | `reasoning` | batch-add 硬编码 `true` 的条目不会被改（fill-empty 的既定后果） |
| `contextWindow` | `contextWindow` | 正整数（catalog 侧已校验） |
| `maxTokens` | `maxTokens` | 同上 |
| `input` | `input` | 过滤到已知模态集合 `text/image/audio/video`；过滤后为空则不填 |

- 未知键穿透保留；不改 `id`、不改大小写
- 已禁用 Provider 允许同步参数（纯元数据回填，与「禁用后仍可批量删除」同理），但不触碰启用态
- 写盘：core 读取→修改→保存 `openclaw.json` 一次完成（含现有自动备份）；本轮无自动应用项时不写盘
- accept 队列项走同一 fill-empty 函数，语义一致

## 7. 报告 DTO 与队列存储

### 7.1 `ModelMetadataSyncReport`

```ts
interface ModelMetadataSyncReport {
  providerId: string;
  updated: Array<{ modelId: string; filled: Partial<Pick<OpenClawModel, "name" | "reasoning" | "contextWindow" | "maxTokens" | "input">>; catalogKey: string; matchKind: string }>;
  queued: Array<{ modelId: string; candidateCount: number }>;
  unmatched: string[];   // 两级均落空
  skipped: string[];     // 五项参数齐全
  sources: ModelMetadataSourceStatus[];
  warnings: string[];
}
```

### 7.2 确认队列 `model-metadata-sync-queue.json`

- 位置：`stateDir`（`~/.oc-switch/`），机器产物，不进备份、不进 Git；损坏即丢弃重建并 warning（`json-state-store` 的 `invalidJson: "fallback"` 模式）
- 条目：

```ts
interface ModelMetadataQueueItem {
  providerId: string;
  modelId: string;
  candidates: Array<{ catalogKey: string; score: number; reason: string; metadata: NormalizedModelMetadata }>;
  lastSeenAt: string;
  dismissed: boolean;
}
```

- `score`：模糊层候选为实际打分（0–1）；resolver 来源候选固定为 `1`（确定性命中，仅因非 high 置信入队）

- `metadata` 快照随候选入队：accept 不依赖再次联网/缓存，队列可离线解决
- 重复同步对同 `(providerId, modelId)` upsert：刷新 `candidates` 与 `lastSeenAt`，**保持 `dismissed`**；已 dismissed 的项在 UI 默认折叠
- 模型被删除/改名后对应队列项成为孤儿：accept 时目标条目不存在则报错并移除该项

## 8. API（packages/server）

| 端点 | 说明 |
|---|---|
| `POST /api/providers/:id/models/sync-metadata` | body `{ modelIds?: string[] }`；返回 `ModelMetadataSyncReport`（另附 `ok: true`，有写盘时附 `backupId`） |
| `GET /api/model-metadata/sync-queue?providerId=` | 队列查询（含 dismissed 标记），返回 `{ items }` |
| `POST /api/model-metadata/sync-queue/resolve` | body `{ items: Array<{ providerId, modelId, action: "accept", catalogKey } \| { providerId, modelId, action: "dismiss" }> }`；accept 按 §6 落盘（合并为一次写盘），返回 `{ ok, applied, dismissedCount, failed, backupId? }`；先试算，`configChanged` 才进写事务，纯 dismiss / 无可填字段只更新队列文件 |

## 9. CLI（packages/cli）

- `provider sync-metadata <id> [--models id1,id2] [--refresh]`：跑同步，打印 updated/queued/unmatched/skipped 摘要；`--refresh` 绕过 24h 缓存强制刷新 models.dev 目录
- `provider metadata-queue list [--provider <id>]`
- `provider metadata-queue accept <providerId> <modelId> --catalog <catalogKey>`
- `provider metadata-queue dismiss <providerId> <modelId>`

## 10. Web（packages/web）

- Providers 页 Provider 行操作加「同步参数」→ 完成后 Toast + 报告摘要（更新 n、待确认 n、未匹配 n）
- 「模型」弹窗（本地目录）支持多选 + 「同步参数」（model 级，复用同一 API）
- 确认队列入口：Providers 页 Provider 行操作「参数待确认 (n)」（计数只计未忽略项），打开 `ModelMetadataQueueDialog` 以列表 + radio 展示队列项与候选（catalogKey、匹配度 score、上下文/最大输出），操作「应用 / 忽略」；已忽略项沉底并以 `Pill` 标记；复用 `Button` / `Toast` / `EmptyState` / `Pill` 等共享组件（未使用 `DataTable`）
- `ModelDialog` 现有「查询参考参数」保持不变

## 11. 错误处理

- 目录两源均不可用 → 同步入口报错、零写入；队列查询/accept 不受影响（快照在队列里）
- 单模型匹配异常 → 计入 `unmatched` 并 warning，不中断整批
- 队列文件损坏 → 丢弃重建 + warning
- config 写盘失败 → 现有备份/报错路径，无部分写入（单次事务）
- 网络请求沿用 catalog 既有约束：固定 allowlist URL、不拼接本地信息、超时与大小上限

## 12. 测试计划

- core 单测：
  - `model-metadata-matcher`：打分权重、阈值边界、token 严格包含守卫、官方条目消歧（移植 CPAMP 对应用例）
  - `model-metadata-sync`：fill-empty 逐项语义（已有值不动/空值才填/非法值不填）、high-only 自动应用、medium/low 入队、skipped/unmatched 分流、禁用 Provider 允许同步、allowlist/modelPolicy/fallbacks 不变
  - `model-metadata-queue`：upsert 保 dismissed、孤儿项 accept 报错并移除、损坏重建
  - 回归：`resolveModelMetadata` 与 suggestions API 行为不变
- server 路由测试：三端点 happy path + 错误分支
- CLI 测试：命令参数与输出
- web views 测试：按钮、报告展示、队列对话框 accept/dismiss

## 13. Sync Audit 清单

- [x] `AGENTS.md`「已实现能力（摘要）」Model 节补批量参数同步；「Learned Workspace Facts」补队列文件与阈值常量（另在规格索引补本 spec 行）
- [x] 本 spec 随实现同步偏差（§5.2 probe 取值/分词小数点/索引结构、§5.3 reason 取值、§8 响应形状、§9 `--refresh`、§10 队列入口与对话框形态）
- [x] `2026-09-02-oc-switch-model-metadata-core-id-matching-design.md` 无需修订（resolver 契约不变：本特性各 commit 未触碰 `model-metadata-resolver.ts` / `model-id-core.ts` / `model-metadata-catalog.ts`）
