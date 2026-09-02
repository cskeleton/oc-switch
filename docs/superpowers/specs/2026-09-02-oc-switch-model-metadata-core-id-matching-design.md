# oc-switch 模型参数建议核心 ID 匹配与 Modalities 应用设计

> 日期：2026-09-02
> 状态：草案，待用户评审
> 目标：模型参数建议在 5 级精确匹配全部落空后，新增确定性的「核心 ID」回退层级（忽略前缀 `/` 与思考等级/路由后缀/检查点日期等尾段）；同时把 Models.dev 的输入/输出 modalities 纳入建议——input 可应用写入，output 仅展示。

## 1. 背景

现有建议解析器（`packages/core/src/model-metadata-resolver.ts`）只做 5 级精确匹配，并显式禁止自动删日期后缀等任何归一化。实际使用中大量本地模型 id 与 Models.dev 目录条目存在系统性差异，导致查不到建议：

- **前缀差异**：`zai-org/GLM-4.6`（本地）vs `zai/glm-4.6`（目录），`openai/gpt-4o`（OpenRouter 风格本地 id）。
- **思考等级后缀**：`gpt-5-high`、`o3-low` 等。
- **路由/供应商后缀**：`-fireworks`、`-groq` 等推理路由商标记。
- **检查点日期**：本地 `deepseek-v3.1-0731`，或目录侧 `claude-sonnet-4-5-20250929`、`gpt-4o-2024-08-06`。

同时，Models.dev 提供 `modalities.input` 与 `modalities.output`，但 catalog 只采集了 `input`，建议卡也不展示、不应用 modalities。

## 2. 目标

### 2.1 用户目标

- 本地模型 id 带供应商前缀、思考等级、路由后缀或检查点日期时，仍能查到 Models.dev 参数建议
- 建议卡展示候选模型的输入/输出类型；「应用」时一并填入 input modalities
- 所有归一化只影响**匹配**，写回 `openclaw.json` 的模型 id 与字段保持用户原值，大小写语义不变

### 2.2 工程目标

- 归一化是**确定性规则**，不引入编辑距离/相似度等模糊匹配
- 新匹配层级仅在现有 5 级精确匹配全部落空后启用，不改变精确路径的任何行为与优先级
- `resolveModelMetadata` 保持纯函数；不联网、不读文件、不改 config

## 3. 非目标

- 不改 discover / batch-add / batch-remove 契约（provider-model-discover 规格 §3.1 边界不变）
- 不把 output modalities 写入 `openclaw.json`（OpenClaw 模型条目目前只有 `input` 字段，output 仅作展示参考）
- 不应用 `reasoning` 标志位（沿用现状，另行评估）
- 不从目录推导 `contextTokens`；建议仍须用户显式点击应用，绝不自动改表单
- 不做 CLI 侧建议查询命令
- 不改动 allowlist、主模型双形态等任何其他领域语义

## 4. 与既有规格的关系

本规格**修订** `2026-06-25-oc-switch-model-editing-design.md` §10.3：

- 原文匹配规则为 5 级精确匹配，且实现注释禁止「自动删日期后缀」。现改为：5 级精确匹配保持不变；仅在其全部落空后，允许经本规格 §5 定义的**确定性归一化回退**（第 6 层 `core-model-id`）。
- 实现时需同步修订该 spec 相应段落与 `model-metadata-resolver.ts` 顶部注释（Sync Audit 项）。

## 5. 核心 ID 归一化与匹配（方案 A：双向归一化 + 渐进剥离）

### 5.1 基础归一化函数（core 新增，纯函数，集中定义常量）

- `stripModelIdPrefix(id)`：取**最后一个** `/` 之后的子串；无 `/` 则原样返回。
- 日期尾段模式（按序判定，循环剥离直到不再匹配）：
  - 单段 `\d{8}`（如 `20241022`）
  - 单段 `\d{4}`（如 `0731`）
  - 三段组合 `\d{4}-\d{2}-\d{2}`（如 `2024-08-06`，一次剥三段）
- 已知类别枚举（集中常量，便于扩充）：
  - `THINKING_LEVEL_SUFFIXES`：`high`、`medium`、`low`、`minimal`
  - `ROUTING_SUFFIXES`：`fireworks`、`groq`、`together`、`deepinfra`、`openrouter`、`azure`、`cerebras`、`sambanova`、`novita`、`baseten`、`nebius`、`hyperbolic`
- 比较一律大小写折叠（`toLowerCase()`）；折叠只用于匹配，不写回。

### 5.2 目录侧 coreId

对每条 `NormalizedModelMetadata`（modelFacts 与 providerCatalog 都算）在 resolver 内即时计算：

```
catalogCoreId = stripModelIdPrefix(modelId) 再循环剥日期尾段（仅日期，不剥枚举后缀）
```

目录侧只剥日期：Models.dev 目录 id 基本不带思考等级/路由后缀，剥多了反而制造歧义。

### 5.3 本地侧渐进候选

对本地 raw model id：

```
core0 = stripModelIdPrefix(modelId)           // 深度 0
coreN = core(N-1) 剥掉最后一个 "-segment"     // 深度 N
```

- 最长优先：从深度 0 开始逐深度测试。
- 下限：候选最少保留 1 段（该单段候选仍参与匹配），不再继续剥；永不产生空串候选；重复候选去重。

### 5.4 匹配流程

第 6 层级 `core-model-id` 仅在层级 1–5 未产生任何候选时执行：

1. 从深度 0 起，对每个本地候选 `core`（大小写折叠后）收集全部命中：
   - 目录条目 `lower(modelId) === lower(core)`（raw 命中），或
   - `lower(catalogCoreId) === lower(core)`（core 命中）
2. **首个有命中的深度胜出**，更深层不再测试（最小剥离原则）。
3. 命中条目去重（沿用现有 `dedupKey`），作为 `core-model-id` 候选返回；仍受 `MAX_MODEL_METADATA_SUGGESTIONS = 5` 限制。
4. 候选排序：raw 命中优先于 core 命中，再按现有 source 优先级与 `catalogKey` 字典序。

### 5.5 置信度

`core-model-id` 的置信度按候选逐个计算（不再静态映射）：

- `medium`：本次匹配中两侧剥掉的**所有**尾段都属于已知类别（日期模式 / `THINKING_LEVEL_SUFFIXES` / `ROUTING_SUFFIXES`）；仅前缀剥离与大小写折叠不影响置信度。
- `low`：任一剥掉的段不属于已知类别（宽松剥离命中的未知段，如 `gpt-5-pro` → `gpt-5`）。

### 5.6 示例

| 本地 id | 目录条目 | 结果 |
|---------|----------|------|
| `zai-org/GLM-4.6` | `zai/glm-4.6` | 深度 0 raw 命中（前缀+大小写差异），medium |
| `gpt-5-high` | `openai/gpt-5` | 深度 1，剥 `high`（已知思考等级），medium |
| `deepseek-v3.1-0731` | `deepseek/deepseek-v3.1` | 深度 1，剥日期 `0731`，medium |
| `claude-sonnet-4-5` | `anthropic/claude-sonnet-4-5-20250929` | 深度 0，目录侧剥日期命中，medium |
| `kimi-k2-0711-preview` | `moonshotai/kimi-k2` | 深度 2，`preview` 未归类 → low |
| `gpt-5-pro`（目录无此 id） | `openai/gpt-5` | 深度 1，`pro` 未归类 → low，UI 警告人工核对 |

歧义核心（多 Provider 同名）返回多候选，沿用现有「先选择再应用」交互。

## 6. Catalog 采集 output modalities

- `NormalizedModelMetadata` 新增 `output?: string[]`，`normalizeModelEntry` 从 `modalities.output` 采集（与 `input` 同款字符串数组过滤），`rebuildEntry` 同步处理。
- 缓存版本 `MODEL_METADATA_CACHE_VERSION` 1 → 2：旧缓存视为不可用并重新获取，避免旧快照长期缺 `output` 字段。

## 7. Server 与 Web 变更

### 7.1 Server

- `GET /api/model-metadata/suggestions` 路由与校验不变；`output` 随 `NormalizedModelMetadata` 类型自然透传进响应。

### 7.2 Web

- `ModelMetadataSuggestionCard`：
  - 新增「输入类型」「输出类型」展示行；输出类型仅参考，**无应用按钮**。
  - 新增「应用输入类型」按钮（候选有 `input` 时可用）。
  - 「全部应用」= 原生上下文 + 最大输出 + 输入类型（各自有值才应用）；底部说明文案同步更新，明确不写入输出类型。
  - `matchKind === "core-model-id"` 时标注「核心 ID 匹配（已忽略前缀与后缀差异）」；`low` 置信沿用现有警告样式。
  - 建议 input 与当前勾选不一致时显示差异提示（与数值字段同款）。
- `ModelDialog`：
  - 新增 `onApplyInputModes` 回调：写入 `inputModes` 并置 `inputModesTouched = true`，确保随保存写入。
  - `INPUT_MODE_OPTIONS` 为 `text` / `image` / `audio` / `video`（对齐 OpenClaw 支持的输入类型；Models.dev 词表中的 `pdf` 等其余模态不入选项）；应用时对建议值按该集合过滤并保持选项顺序。

## 8. 错误与边界

| 场景 | 行为 |
|------|------|
| 精确层级已有候选 | 不执行核心 ID 匹配，行为与现状完全一致 |
| 本地 id 剥到只剩 1 段仍无命中 | 返回空建议，允许留空手动填写 |
| 核心命中多候选 | 全部返回（≤5），用户显式选择后才可应用 |
| 剥离段含未归类段 | 候选置信度 `low`，UI 警告需人工核对 |
| 目录条目缺失 `modalities.output` | 仅不展示/不返回该字段，不产生 warning |
| 旧版本缓存（version 1） | 视为不可用，重新获取 |
| 建议 input 含未知模态值 | 按 `INPUT_MODE_OPTIONS` 过滤后应用，未知值静默丢弃 |

已知风险（用户已确认接受宽松剥离）：目录侧剥日期可能误吞版本号式四位尾段（如假设的 `internlm-2025`）；宽松剥离可能把不同型号关联到同一核心（如 `gpt-5-pro` → `gpt-5`）。均由「回退层级 + 多候选 + 显式应用 + 低置信警告」兜底。

## 9. 测试计划

- **core 归一化**：前缀剥离（含多段 `/`）；三类日期模式与循环剥离；渐进深度顺序与最小深度胜出；1 段下限与空串保护；大小写折叠；已知类别 → medium / 未归类 → low；歧义核心多候选。
- **resolver**：精确层级命中时不执行核心匹配（含优先级回归）；核心匹配的 raw 命中优先于 core 命中排序；5 条上限。
- **catalog**：`modalities.output` 采集与过滤；缓存重建含 output；缓存版本 1 → 2 旧缓存废弃重取。
- **server**：建议响应携带 `output`（存在时）。
- **web**：建议卡 input/output 展示与「应用输入类型」「全部应用」写入链路；core-model-id 标注与低置信警告；`INPUT_MODE_OPTIONS` 扩展后应用过滤与排序。

## 10. 验收标准

- [ ] `zai-org/GLM-4.6`、`gpt-5-high`、`deepseek-v3.1-0731` 等形态在精确匹配落空后能命中核心 ID 候选，且置信度标注正确
- [ ] 5 级精确匹配的行为与优先级完全不变（回归测试通过）
- [ ] 建议卡展示输入/输出类型；「应用输入类型」与「全部应用」把 input modalities 填入表单并随保存写入 `openclaw.json`；output 永不写入
- [ ] 匹配归一化不修改任何写回值（模型 id、大小写保持用户原值）
- [ ] 旧版本元数据缓存被废弃并重新获取
- [ ] model-editing spec §10.3 与 resolver 注释完成同步修订；`AGENTS.md` 规格索引更新
