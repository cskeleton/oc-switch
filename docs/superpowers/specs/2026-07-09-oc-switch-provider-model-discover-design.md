# oc-switch Provider Model Discover & Local Cap Design

> 日期：2026-07-09  
> 状态：已通过  
> 目标：将 Providers「全量同步入库」改为「发现 + 按需添加」；为每 Provider 本地模型目录设硬上限；补齐批量清理与本地列表排序；并为 `anthropic-messages` 增加发现 adapter。

## 1. 背景

当前 Providers 页「同步」会请求远端 models 端点，并把**所有本地尚不存在的远端模型**合并进 `models.providers[<id>].models[]`。同步**不会**自动写入 allowlist（`agents.defaults.models`），但未启用模型仍会进入 `openclaw.json` 目录。

对 OpenRouter、部分 NVIDIA 代理等巨型目录，这会导致：

- `openclaw.json` 体积膨胀
- Providers「模型」弹窗展示本地全量目录，列表极长
- OpenClaw 侧维护过多模型条目，体验变差

「模型」弹窗本身不拉远端，只读本地已写入目录；列表爆炸通常来自先前全量同步。

首版 sync 仅支持 `openai-completions` 形状；`anthropic-messages` / `google-generative-ai` 返回 unsupported。不少兼容 Anthropic Messages 的 Provider 也提供 list models，值得接入发现流。Google 官方 API 仍在演进且第三方少用，本次保持 unsupported。

## 2. 目标

### 2.1 用户目标

- 在 Providers 页用「发现模型」浏览远端列表（分组 + 搜索），勾选后再写入本地
- 添加时可选择是否「同时启用」（默认仅添加、不进 allowlist）
- 在「模型」弹窗管理本地已添加模型：已启用置顶；支持多选删除与「只保留已启用」
- 每 Provider 本地目录硬上限 20；存量超过 20 仍可用，但禁止再添加，直到删到少于 20
- CLI 与 Web 语义一致：默认发现不写盘，显式 `--add` 才写入

### 2.2 工程目标

- Core 仍为唯一 OpenClaw 配置写入层
- 发现与写入分离：discover 永不写配置、不建备份
- 硬上限在 **core 层所有会增加 `provider.models` 条数的写入路径**统一强制，避免仅 `batch-add` 或前端校验（见 §5.1）
- OpenAI 与 Anthropic 分 adapter；Google 明确 unsupported
- 从 `main` 拉独立功能分支实现，完成后合并

## 3. 非目标

- 不把「目录超过 20」做成 `config-status` 强制 issue（存量只拦新增）
- 不做 `google-generative-ai` list adapter
- 不把远端全量模型持久化到 oc-switch 本地缓存文件（见 §3.1：Models.dev 公开目录快照是独立能力，不属于本条所指的 Provider 远端目录）
- 不自动静默删除用户已同步进目录的模型
- 不改变 Gateway 重启 / env sync 语义
- 不做跨 Provider 的全局模型数上限

### 3.1 与模型参数建议（Models.dev）的边界

第一版「模型参数建议」是独立只读能力（见 model editing 规格 §10），不改变本规格的 discover 写入契约：

- discover 默认不写盘；本规格所有 discover/batch-add/batch-remove 语义保持不变。
- batch-add 仍只写用户明确选择的模型；建议查询不替用户勾选。
- 每 Provider 20 条上限（`MAX_PROVIDER_MODELS`）不变，且建议查询不影响该上限。
- disabled Provider 的 add/enable 禁止、cleanup（batch-remove / 只保留已启用）允许的规则不变；disabled Provider 下仍可查询参数建议（只读）。
- 建议来源是固定的 Models.dev 公开 JSON 快照（缓存于 `<stateDir>/model-metadata-cache.json`），不是 Provider 远端 `/v1/models`；两者不得混用。
- 不改远端 discover 契约：discover 仍以 `id/name` 为主；OpenRouter 等富响应透传留作后续增量。

## 4. 核心概念

| 概念 | 含义 | 存储 |
|------|------|------|
| 发现（Discover） | 临时拉取远端模型目录供浏览 | 仅内存 / API 响应 |
| 已添加 | 写入 Provider 模型目录 | `models.providers[id].models[]` |
| 已启用 | 进入 allowlist | `agents.defaults.models[ref]` |
| 硬上限 | 每 Provider 已添加条数上限 | 常量 `MAX_PROVIDER_MODELS = 20` |

已添加 ≠ 已启用。发现默认不改变任一者。

## 5. 数据流

```
[远端 /v1/models] --discover--> [Web/CLI 会话内列表]
                                      |
                                      | 用户勾选 + 可选 enable
                                      v
                              batch-add（校验 ≤20）
                                      |
                                      +--> provider.models[]
                                      +-->（可选）allowlist

[本地 provider.models] --模型弹窗--> 排序展示 / 启停 / batch-remove
```

1. **Discover**：按 API 类型选 adapter 拉远端；返回 id（及可选 name）与 `alreadyAddedIds`；不写盘。
2. **Batch add**：客户端提交勾选模型的 `{ id, name? }`；写入目录；`enable=true` 时同步写 allowlist；超限整单拒绝。
3. **本地管理**：只操作已添加集合；排序与批量删除不触发远端请求。

### 5.1 硬上限强制点（core 统一）

常量：`MAX_PROVIDER_MODELS = 20`，含义为单个 Provider 的 `models.providers[id].models.length`。

**必须在 core 增加模型目录条数的路径上统一校验**（推荐抽 `assertProviderModelCapacity(provider, addingCount)`，在 mutate 前调用）。至少覆盖：

| 写入入口 | 现状参考 | 要求 |
|----------|----------|------|
| `batch-add` / CLI `provider sync --add` | 本规格新增 | `current + newlyAdded ≤ 20` |
| `addProviderModel` / `POST /api/models` / CLI `model add` | `model-operations.ts` | 单次 +1 时若已达 20 则拒绝 |
| `addCustomProvider` / custom 创建 | `provider-operations.ts` | 初始 `models.length` 不得超过 20 |
| preset / import 等会写入或扩张 `provider.models` 的路径 | 现有 import/preset 流程 | 扩张后总数不得超过 20；失败整单拒绝 |

规则细节：

- **存量已超过 20**：不自动删；允许删除、启停、编辑已有条目；**任何净增加条数的操作拒绝**，错误信息提示先删除或「只保留已启用」
- **替换/编辑**（改 id、改字段但不增加条数）：不受「再 +N」限制；若编辑把 id 改成新 id 且旧 id 移除，条数不变则允许
- **前端/CLI 预检**可有，但**不能替代** core 校验
- 不把「目录超过 20」做成 `config-status` 强制 issue（与 §3 一致）

## 6. API 契约

### 6.0 ID 语义（写死）

本项目 ModelRef 仅在**第一个** `/` 处拆成 `providerId` / `modelId`，且 `modelId` 自身常含 `/`（如 `openai/gpt-4o`）。

因此：

- 路径参数 `:id` = **provider id**
- `discover` / `batch-add` / `batch-remove` body 中的模型标识一律为 **provider-local raw model id**（即 `provider.models[].id` / 远端返回的 `id`），**不是**完整 ModelRef
- 禁止在这些 body 里传 `providerId/modelId` 形式的 ref 并再按第一个 `/` 拆分（会把 `openai/gpt-4o` 误拆）
- CLI：`--add` / `--ids` 同样接受 **raw model id**（可含 `/`）。若用户传入看起来像 `providerId/...` 的字符串，**不**自动剥掉 provider 前缀；需要完整 ref 的命令仍走现有 `model` 子命令

### 6.1 发现

`POST /api/providers/:id/discover`

- 只读；成功也不创建备份
- 响应示例：

```json
{
  "ok": true,
  "providerId": "openrouter",
  "remoteModels": [{ "id": "openai/gpt-4o", "name": "GPT-4o" }],
  "alreadyAddedIds": ["openai/gpt-4o"],
  "truncated": false,
  "unsupportedReason": null
}
```

- `remoteModels[].id`：provider-local raw id
- `remoteModels[].name`：可选显示名（来自 OpenAI 兼容字段或 Anthropic `display_name`）
- `truncated: true` 时必须带简短 `truncationReason`（如达到安全页数/条数上限），UI 须提示「列表可能不完整」
- `google-generative-ai`：`ok: false`，带 `unsupportedReason`，`remoteModels: []`（与现有 sync unsupported 响应风格一致）
- 旧 `POST /api/providers/:id/sync`：**移除全量写入语义**。实现时改为 `discover` 的别名（相同响应），并在帮助/文档标明 breaking change；不得再无参全量 `applySyncedModels`。

### 6.1A 添加前临时发现（ephemeral discover）

`POST /api/providers/discover-preview`

请求体（用于「添加 Provider」弹窗）：

```json
{
  "api": "openai-completions",
  "baseUrl": "https://api.example.com",
  "apiKey": "sk-...",
  "isFullUrl": false,
  "alreadyAddedIds": ["model-a"]
}
```

规则：

- 仅用于尚未入库 Provider 的临时发现；凭表单 `api` / `baseUrl` / `apiKey` 发起只读拉取
- `isFullUrl=true` 时按输入 `baseUrl` 原样拼接 discover endpoint；`isFullUrl=false` 时沿用对应 API 的 baseUrl 归一化（如 OpenAI 兼容补 `/v1`）
- 响应形状与 §6.1 对齐（`remoteModels`、`alreadyAddedIds`、`truncated`、`unsupportedReason`）
- `google-generative-ai` 保持 unsupported（与 §8.3 一致）
- **不读取、不写入** `openclaw.json` / `.env`，**不创建备份**
- 结果仅用于会话内勾选，不持久化缓存；关闭弹窗即丢弃
- 本接口自身不做 batch-add；真正写盘仍走 custom 提交或 §6.2 batch-add

后端实现契约（用于本规格对应实现）：

- core 提供只读能力：`discoverProviderModelsFromCredentials({ api, baseUrl, apiKey, isFullUrl?, alreadyAddedIds? }, options?)`
- server `POST /api/providers/discover-preview` 必须校验 `api` / `baseUrl` / 非空 `apiKey`，允许可选 `alreadyAddedIds`
- 响应语义与 §6.1 保持一致：`remoteModels`、`alreadyAddedIds`、`truncated`、`unsupportedReason`、`truncationReason`
- 该路径复用现有 OpenAI / Anthropic discover adapter 与 `unsupported/truncated` 语义，不新增独立远端解析分支；但 endpoint 构造需显式尊重 `isFullUrl`

### 6.2 按需添加

`POST /api/providers/:id/models/batch-add`

```json
{
  "models": [
    { "id": "openai/gpt-4o", "name": "GPT-4o" },
    { "id": "anthropic/claude-sonnet-4" }
  ],
  "enable": false
}
```

- `models[].id`：必填，provider-local raw model id
- `models[].name`：可选；来自 discover 会话内勾选结果。**服务端不重新 discover**；关闭弹窗后客户端必须把勾选时的 `name` 一并提交，否则仅有 id 时走 `ensureModelName` 默认命名
- `enable` 默认 `false`
- 已存在 id：跳过（计入 skipped，不报错）；跳过项不覆盖已有 name
- 校验：`currentCount + newlyAddedCount ≤ 20`（及 §5.1）；失败整单拒绝，不部分写入
- 若 Provider 已 disable：无论 `enable` 为 `true` 或 `false`，batch-add 都整单拒绝并提示先恢复 Provider；disable 状态下仅允许 discover 只读浏览
- 走现有事务写入 + 备份
- 响应：`addedModelIds`、`skippedModelIds`、`enabled`、`backupId?`

### 6.3 批量删除

`POST /api/providers/:id/models/batch-remove`

二选一 body：

```json
{ "modelIds": ["openai/gpt-4o", "vendor/model-b"] }
```

```json
{ "keepEnabledOnly": true }
```

规则：

- `modelIds`：provider-local raw model id 数组（见 §6.0）
- 多选删除：从 `provider.models` 移除；若在 allowlist 则同步移除；**若任一 id 为当前主模型的 modelId 则整单拒绝**
- `keepEnabledOnly`：
  - **主模型目录项永远保留**
  - 其余目录项：仅保留当前在 allowlist 中的模型；未启用项从目录删除
  - 本操作不向 allowlist 新增条目
  - 若配置已损坏（主模型 ref 指向本 Provider，但主模型 **不在** `provider.models`）→ **整单拒绝**，提示先修复配置（例如手动添加主模型目录项或切换主模型），不进行部分清理
- 空 `modelIds`（且非 `keepEnabledOnly`）：返回 400
- 走事务 + 备份

## 7. CLI 契约

| 命令 | 行为 |
|------|------|
| `oc-switch provider sync <id>` | 仅发现并打印远端列表（标注已添加；若 `truncated` 则警告）；**默认不写** |
| `oc-switch provider sync <id> --add id1,id2` | 等价 batch-add（仅 id，无 name 则默认命名）；id 为 raw model id，可含 `/`；尊重上限 20 |
| `... --add ... --enable` | 添加并写入 allowlist |
| `oc-switch provider models remove <id> --ids id1,id2` | 多选删除（raw model id） |
| `oc-switch provider models remove <id> --keep-enabled-only` | 只保留已启用（主模型规则见 §6.3） |

命令名可在实现计划中微调，但语义必须与上表一致。帮助文案须标明 breaking：旧「无参 sync = 全量入库」已移除。

## 8. Discover adapters

### 8.1 `openai-completions`

- 归一化 baseUrl（避免重复 `/v1`），请求 `GET {base}/models`
- 鉴权：现有 Bearer / 解析自 `.env` 的逻辑
- 解析：`{ data: [{ id, ... }] }`，取 `id`；若有可用显示名字段可映射为 `name`
- 分页：若响应提供可跟随的分页约定则耗尽之；多数兼容站一次返回全量。若达到实现安全上限仍未结束 → `truncated: true`

### 8.2 `anthropic-messages`

- 端点：`GET {baseUrl}/v1/models`（baseUrl 遵循 OpenClaw 约定：Anthropic 通常**不**带末尾 `/v1`，由 adapter 拼接 `/v1/models`，避免与 OpenAI 归一化逻辑混用导致双 `/v1`）
- 鉴权头：`x-api-key: <key>`；`anthropic-version: 2023-06-01`（版本常量集中定义，便于后续调整）
- 解析官方 List Models 形状：`data[]` 每项取 `id`，`display_name` → `name`；使用 `has_more` + `last_id` 作为下一页 `after_id`（见 [Anthropic List Models](https://platform.claude.com/docs/en/api/models/list)）
- **分页策略（写死）**：默认**循环拉取直到 `has_more === false`**，以便搜索/浏览看到完整目录。实现须设安全上限（建议：单次 discover 最多 50 页或累计 5000 条，常量集中定义）。触顶仍 `has_more` → 返回已拉到的列表且 `truncated: true`，UI/CLI 必须提示列表可能不完整；**不**在首版做交互式「加载更多」API（避免与「关闭即丢弃」会话模型纠缠）
- 兼容站若实现相近形状即可用；解析失败则报错，**不**回退成 OpenAI 解析以免误填

### 8.3 `google-generative-ai`

- 返回 unsupported；UI/CLI 引导手动「添加模型」
- 不在本规格范围实现 ListModels

## 9. Web UX

### 9.1 Providers 行

- 「同步」按钮文案与行为改为「发现模型」
- 保留「模型」：本地已添加管理

### 9.2 发现模型弹窗

- 打开时调用 discover；展示 loading / unsupported / 错误
- 若 `truncated === true`：顶部警告「远端列表可能不完整（已达拉取上限）」
- 搜索：过滤 id 与 name（基于本次已返回的 `remoteModels`，非服务端再搜）
- 分组：按 model id 第一个 `/` 前的前缀；无 `/` 归入「其他」；组可折叠
- 行：勾选 + id（+ name）；已添加禁用勾选并标注「已添加」
- 底部：已选数量；「同时启用」默认关；「添加到配置」
- 提交时 body 使用 §6.2 的 `models: [{ id, name? }]`，把会话内勾选行的 `name` 一并带上
- 若 `已添加数 + 新选中 > 20`：禁用提交并提示剩余可添加名额
- 远端列表仅会话内持有，关闭弹窗丢弃；因此**不能**依赖服务端在 batch-add 时重新 discover
- 添加 Provider 弹窗内的 ephemeral discover 复用同一展示语义，但确认后仅回填本地表单行，不直接写盘
- 添加 Provider 弹窗内的 ephemeral discover 在回填时按 `id` 去重，优先填现有空行，再追加新行

### 9.3 模型弹窗（本地）

- 排序：主模型 → 已启用 → 未启用；同组内按 id 稳定排序
- 多选 +「删除所选」（提交 raw model id）
- 「只保留已启用」：确认对话框说明将从目录移除未启用模型、**主模型始终保留**；不删除 Provider、不改 Key；若主模型已不在目录则操作失败并提示先修复
- 启停：避免整页暴力刷新；优先本地 state 更新或仅重拉该 Provider 模型（已添加规模按上限 20 设计）

### 9.4 存量超过 20

- 不自动清理、不做健康检查强制项
- 发现/添加在已达 20 时禁止新增
- 用户用批量删除或「只保留已启用」清到不超过 20

## 10. 错误与边界

| 场景 | 行为 |
|------|------|
| discover HTTP/鉴权失败 | 明确错误；不写配置 |
| discover-preview（ephemeral）缺少必填字段或 key 为空 | 400；不写配置、不建备份 |
| Google / 未知 unsupported API | `unsupportedReason`；引导手动添加 |
| Anthropic 响应无法解析 | 报错；不回退 OpenAI 解析 |
| batch-add 超限 | 400；整单拒绝 |
| 其他写入入口使目录超过 20 | core 拒绝（§5.1） |
| batch-remove 含主模型 | 拒绝 |
| keepEnabledOnly 且主模型已不在目录 | 拒绝，提示先修复配置 |
| Provider 已 disable | 允许只读 discover；batch-add 无论是否 `enable` 都拒绝；其他启用写入仍按现有 disable 规则拒绝，提示先恢复 Provider；**batch-remove /「只保留已启用」仍允许**（便于关闭后清理超限目录） |

## 11. 测试计划

- **core**：OpenAI / Anthropic discover 解析与鉴权头；Anthropic 多页耗尽与 truncated；Google unsupported；batch-add 携带 name、上限与 enable；`addProviderModel` / `addCustomProvider` 同样受上限约束；batch-remove 多选与 keepEnabledOnly；主模型保护与「主模型已不在目录」拒绝
- **server**：discover 不写盘、无备份；batch-add/remove 事务与 backupId；body 使用 raw model id（含 `/`）；disabled provider 下 batch-add（含 `enable=false`）被拒绝
- **cli**：默认 sync 不写；`--add` raw id（含 `/`）/ `--enable`；超限；disabled provider 下 `--add` 被拒绝；remove 子命令
- **web**：发现弹窗分组/搜索/truncated 提示/提交带 name；模型弹窗排序与批量删（组件/视图测）

## 12. 迁移与兼容

- **Breaking**：无参 `provider sync` / `POST .../sync` 不再全量写入
- 已灌库的巨型目录：不自动删；用户用「只保留已启用」或多选删除清理
- 文档：`AGENTS.md` 规格索引、验收清单、总体设计中 sync 小节需在实现时同步修订

## 13. 实现分支

- 分支名建议：`feat/provider-model-discover`
- 自 `main` 拉取；本规格合并进 Git 后按实现计划开发；完成后 PR 合并回 `main`

## 14. 验收标准

- [ ] 发现 OpenRouter 类巨型列表时，未勾选模型不会出现在 `openclaw.json`
- [ ] 添加 Provider 弹窗可基于表单凭证执行 ephemeral discover；该流程不写盘、不备份
- [ ] 勾选添加后仅选中项进入 `provider.models`；discover 带来的 `name` 经 batch-add 保留；默认不进 allowlist；勾选「同时启用」则进入
- [ ] 每 Provider 目录总数不可超过 20；`batch-add`、单条 `model add`、`add-custom`、import 等写入入口均不可绕过；存量超过 20 可删不可增
- [ ] 「只保留已启用」与多选删除可用；主模型永远保留；主模型已不在目录时拒绝并提示修复
- [ ] API/CLI 批量接口使用 provider-local raw model id（可含 `/`），不按完整 ModelRef 误拆
- [ ] 本地模型列表：已启用在未启用之前
- [ ] `anthropic-messages` 可 discover 并耗尽分页（或明确 truncated）；`google-generative-ai` 仍为 unsupported
- [ ] CLI 默认 sync 不写盘；`--add` 与 Web 规则一致
