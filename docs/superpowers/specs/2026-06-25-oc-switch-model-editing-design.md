# oc-switch Model Editing Design

> 日期：2026-06-25  
> 状态：待评审  
> 目标：补齐模型新增与编辑能力，让用户能从 Provider 上下文或全局模型列表中便捷维护 `models.providers.*.models[]` 与 `agents.defaults.models`。

## 1. 背景

当前 oc-switch 已支持：

- Providers 页编辑 Provider 本身的 `baseUrl` 与 API Key
- Providers 页同步远端模型、删除 Provider
- Models 页设置 primary model、启用/禁用 allowlist
- CLI `model add/remove/enable/disable`
- Core 层已有 `addProviderModel` 与 `removeProviderModel`

缺口是 WebGUI 不能便捷地给某个特定 Provider 添加模型，也不能编辑已有模型字段。用户只能删除或启停 allowlist，无法维护模型运行所需的基础字段。

## 2. 目标

### 2.1 用户目标

用户可以完成以下操作：

- 在 Providers 页进入某个 Provider 的模型管理，新增、编辑、删除该 Provider 下的模型
- 在 Models 页从全局列表中新增或编辑模型
- 编辑模型常用字段，包括 OpenClaw 运行相关字段
- 修改模型 ID 时自动迁移相关 ref，避免留下陈旧 allowlist 或 primary 引用

### 2.2 工程目标

- Core 继续作为唯一 OpenClaw 配置写入层
- Server/Web 不直接拼接 OpenClaw 写入逻辑
- ModelRef 继续只按第一个 `/` 拆分，保留 model id 内部斜杠
- 写入前自动备份，写入后由 diff guard 限制语义变更范围
- 编辑时保留未知字段，避免破坏用户现有 OpenClaw 扩展配置

## 3. 非目标

首版不做以下能力：

- 批量编辑多个模型
- 直接编辑完整 model JSON 对象
- 管理模型测速、成本统计或健康检查
- 自动从任意非 OpenAI-compatible Provider 拉取模型
- 改造 Presets 页的模型编辑体验

## 4. 用户体验

### 4.1 Providers 页入口

Providers 表格每行增加“模型”操作。

点击后打开该 Provider 专属模型管理弹窗：

- 顶部显示 Provider ID
- 列出该 Provider 的模型
- 支持搜索模型 ID、名称、alias
- 支持新增模型
- 支持编辑模型
- 支持删除模型
- 支持启用/禁用 allowlist

这个入口用于“我正在维护某个 Provider”的场景，新增模型时 Provider 已固定，不要求用户再选择。

### 4.2 Models 页入口

Models 页保留全局模型列表与筛选能力，并增加：

- 页面顶部“添加模型”按钮
- 每行“编辑”按钮

全局添加模型时需要先选择 Provider。编辑现有模型时 Provider 默认来自当前行，不允许在编辑时跨 Provider 移动模型；如需移动，用户应在目标 Provider 下新建，再删除旧模型。

这个入口用于“我已经搜索到某个模型并想快速修正字段”的场景。

### 4.3 共用模型表单

Providers 页和 Models 页共用同一个模型表单组件，避免两边字段、校验和写入行为不一致。

表单字段：

| 字段 | 写入目标 | 说明 |
| --- | --- | --- |
| Provider | `models.providers.{providerId}` | Providers 页固定；Models 页新增时选择 |
| Model ID | `provider.models[].id` | 必填；可包含 `/`；编辑时允许修改并触发 ref 迁移 |
| Name | `provider.models[].name` | OpenClaw 2026.6.8 必填；读取旧配置时允许缺失 |

`models.providers.*.models[].name` 对 OpenClaw 2026.6.8 为必填。读取旧配置时允许缺失并由 config-status 报告；任何 oc-switch 写入路径必须保留已有 name，或从 id 自动生成 fallback name。
| Alias | `agents.defaults.models[ref].alias` | 可选；仅在 enabled 为 true 时写入 |
| Enabled | `agents.defaults.models[ref]` | 开启时写入 allowlist，关闭时删除 allowlist entry |
| API | `provider.models[].api` | 可选；支持 `openai-completions`、`anthropic-messages`、`google-generative-ai` |
| Reasoning | `provider.models[].reasoning` | Checkbox；新增模型默认开启，编辑旧模型时保留“未设置”语义 |
| 原生上下文窗口（可选） | `provider.models[].contextWindow` | 模型/路由原生能力，可选正整数 |
| 运行上下文预算（可选） | `provider.models[].contextTokens` | OpenClaw 实际使用上限，可选正整数，不得大于已填写的 `contextWindow` |
| 最大输出长度（可选） | `provider.models[].maxTokens` | 单次输出上限，可选正整数 |
| Input | `provider.models[].input` | 可选字符串数组；UI 用逗号或多行文本输入 |

`cost` 与其他未知字段首版不提供结构化编辑，但编辑已有模型时必须原样保留。

#### 4.3.1 Reasoning 默认值与编辑交互

- 所有通过创建流程新加入 provider 本地模型目录的模型默认写入 `reasoning: true`，覆盖 Web 手动新增、Server API、CLI、创建自定义 Provider 时随附的模型，以及发现模型后的批量新增。
- 单条新增若调用方明确传入 `reasoning: false`，必须保留 `false`，不得被默认值覆盖。
- Reasoning 在共用模型表单中使用 checkbox。新增模式初始勾选；保存后写入 `true`。
- 编辑模式按现有值显示：`true` 为勾选，`false` 与字段缺失均为未勾选。
- 表单必须额外记录 checkbox 是否被用户操作。旧模型缺少 `reasoning` 时，若用户未操作 checkbox，提交不得增加该字段；首次点击后开始按当前勾选状态明确提交 `true` 或 `false`。
- 不对已存在的 provider 模型做批量迁移或回填；preset/import 与 backup restore 属于数据还原，必须保留来源数据，不应用新增默认值。只有创建流程新增模型，或用户在编辑时明确操作 Reasoning checkbox，才改变该属性。

### 4.4 数值字段语义

三个数值字段语义不同，必须明确区分，不得混用术语：

| 字段 | 写入目标 | 语义 |
|---|---|---|
| 原生上下文窗口 | `provider.models[].contextWindow` | 模型/路由原生能力，可选正整数 |
| 运行上下文预算 | `provider.models[].contextTokens` | OpenClaw 实际使用上限，可选正整数，不得大于已填写的 `contextWindow` |
| 最大输出长度 | `provider.models[].maxTokens` | 单次输出上限，可选正整数 |

规则：

- 三个字段均为可选正整数；不确定时允许留空。
- 同时填写时 `contextTokens` 不得大于 `contextWindow`；Core/Server 校验拒绝，Web 前端在提交前也须阻止。
- `contextWindow` 未填写时允许单独设置 `contextTokens`。
- `contextTokens` 是用户运行偏好，不从外部目录（Models.dev）自动推导，也不从 `contextWindow` 自动复制。
- 三个字段都使用精确整数输入；UI 快捷值（如 `1M`）只是输入便利，点击后输入框必须显示完整整数（如 `1048576`），不使用滑杆表示模型事实。

## 5. 数据规则

### 5.1 ModelRef

完整模型引用仍为：

```text
ModelRef = `${providerId}/${modelId}`
```

解析规则不变：

- `providerId` 不允许包含 `/`
- `modelId` 可以包含 `/`
- 拆分时只按第一个 `/`
- 大小写敏感，不自动 normalize

### 5.2 新增模型

新增模型时：

1. 校验 Provider 存在
2. 校验 model ID 非空
3. 校验同 Provider 下不存在相同 model ID
4. 写入 `models.providers.{providerId}.models[]`
5. 如果 enabled 为 true，写入 `agents.defaults.models[ref]`
6. 如果 alias 为空，allowlist entry 仍可写 `{}`，表示启用但无 alias

### 5.3 编辑模型

编辑模型时：

1. 根据旧 ref 找到 Provider 与旧 model ID
2. 校验 Provider 存在且旧模型存在
3. 如果新 model ID 与旧 model ID 不同：
   - 校验新 model ID 在同 Provider 下不存在
   - 将 `provider.models[].id` 从旧值改为新值
   - 将 `agents.defaults.models[oldRef]` 迁移到 `agents.defaults.models[newRef]`
   - 如果当前 primary model 等于旧 ref，则改为新 ref
4. 更新表单覆盖的结构化字段
5. 未出现在表单里的未知字段保持不变
6. 根据 enabled 状态写入或删除 allowlist entry
7. 更新 alias 时保留 allowlist entry 的 `agentRuntime` 与未知字段

### 5.4 删除模型

删除模型沿用现有语义：

- 从 `provider.models[]` 删除模型
- 删除对应 allowlist entry
- 如果该 ref 是 primary model，必须提供新 primary 或显式 force

WebGUI 首选让用户选择新 primary，不默认留下坏引用。

## 6. Core 设计

新增共享输入类型：

```ts
export interface ProviderModelInput {
  id: string;
  name?: string;
  alias?: string;
  enabled: boolean;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  input?: string[];
}
```

`contextTokens` 与 `contextWindow`、`maxTokens` 同为可选正整数，校验规则见 §4.4。

Core 层新增或扩展操作：

- `addProviderModel(config, providerId, input)`
- `updateProviderModel(config, ref, input)`
- `removeProviderModel(config, ref, options)`

现有 CLI `model add` 可继续调用新增后的 `addProviderModel`，保持命令行为兼容。若为了兼容现有调用签名需要保留旧函数，可新增包装函数，但实际写入逻辑应收敛到同一处。

### 6.1 字段写入约定

模型对象只写入用户设置的字段，但新增模型的 Reasoning 采用领域默认值：

- 空字符串按未设置处理
- 可选数字为空时删除该字段
- 单条新增时 `reasoning` 缺省按 `true` 写入，明确 `false` 时写入 `false`
- 创建自定义 Provider 时，其随附模型统一写入 `reasoning: true`
- 批量新增 provider 模型目录项时统一写入 `reasoning: true`
- 编辑时可选布尔为空按未设置处理；明确 true/false 时写入
- `input` 为空数组时删除该字段

编辑已有模型时，先从旧模型复制一份，再覆盖表单字段，因此未知字段不会丢失。

### 6.2 allowlist 保留规则

启用模型时：

- 旧 allowlist entry 存在：保留未知字段，只更新 alias
- 旧 allowlist entry 不存在：创建新 entry
- alias 为空：不写 alias 字段，但保留其他字段

禁用模型时：

- 删除对应 allowlist entry
- 不删除 provider model 定义

## 7. Server API

新增端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/models` | 新增模型 |
| PUT | `/api/models` | 编辑模型 |
| DELETE | `/api/models` | 删除模型 |

请求体全部使用 JSON body，避免将含斜杠的 ModelRef 放入 path segment。

新增模型请求：

```json
{
  "providerId": "nvidia",
  "model": {
    "id": "deepseek-ai/deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "alias": "ds-v4-pro",
    "enabled": true,
    "api": "openai-completions",
    "reasoning": true,
    "contextWindow": 128000,
    "maxTokens": 8192,
    "input": ["text"]
  }
}
```

编辑模型请求：

```json
{
  "ref": "nvidia/deepseek-ai/deepseek-v4-flash",
  "model": {
    "id": "deepseek-ai/deepseek-v4-pro",
    "name": "DeepSeek V4 Pro",
    "alias": "ds-v4-pro",
    "enabled": true
  }
}
```

删除模型请求：

```json
{
  "ref": "nvidia/deepseek-ai/deepseek-v4-pro",
  "newPrimary": "minimax-portal/MiniMax-M3"
}
```

所有写端点都通过 `writeOpenClawTransaction`，并返回 `backupId`。

## 8. Web 设计

### 8.1 组件

新增共用组件：

- `ModelDialog`
  - 负责新增/编辑模型表单
  - 支持 Provider 固定或 Provider 可选两种模式
  - 解析 `input` 文本为字符串数组
  - 提交后调用 API 并刷新父视图

- `ProviderModelsDialog`
  - Provider 专属模型管理弹窗
  - 展示该 Provider 的模型列表
  - 调用 `ModelDialog` 新增或编辑模型
  - 删除 primary 模型时加载候选新 primary

### 8.2 Models 页

Models 页新增：

- 顶部“添加模型”按钮
- 行内“编辑”按钮

现有“设为主模型”“启用/禁用”保留。

### 8.3 Providers 页

Providers 页新增：

- 行内“模型”按钮

现有 Provider 编辑、同步、删除保留。

## 9. 错误处理

| 场景 | 处理 |
| --- | --- |
| Provider 不存在 | 拒绝写入并提示 |
| 旧模型不存在 | 拒绝写入并提示 |
| 新模型 ID 为空 | 拒绝写入并提示 |
| 新模型 ID 与同 Provider 其他模型重复 | 拒绝写入并提示 |
| 数字字段不是正整数 | 拒绝写入并提示 |
| `contextTokens` 大于已填写的 `contextWindow` | 拒绝写入并说明二者语义 |
| API 类型不支持 | 拒绝写入并提示 |
| 删除 primary 模型但没有新 primary 或 force | 拒绝写入并提示选择新主模型 |

## 10. 模型参数建议（Models.dev）

在添加/编辑模型的弹窗中，提供有来源、可选择应用的上下文窗口与最大输出建议值，并补齐 `contextTokens` 运行预算字段。外部目录不可用时仍可安全手动配置。

### 10.1 架构边界

- `packages/core` 负责 Models.dev 下载、校验、版本化缓存与本地匹配。
- Server 仅暴露只读建议查询；不把 Provider/密钥数据发给第三方。
- Web 在 `ModelDialog` 中把模型事实（`contextWindow` / `maxTokens`）与运行偏好（`contextTokens`）分开显示；任何建议值都必须由用户显式应用后，才随正常模型保存事务写入 `openclaw.json`。

### 10.2 锁定产品决策

1. **不使用滑杆表示模型事实。** `contextWindow` / `maxTokens` 保留精确整数输入；常用值仅作为快捷按钮。
2. **模型事实与运行预算分开。** `contextTokens` 不从 Models.dev 的 `limit.input` 自动推导，也不从 `contextWindow` 自动复制。
3. **建议值不是默认值。** 查询成功只展示建议卡；必须点击「应用上下文」「应用最大输出」或「全部应用」才修改表单。
4. **不覆盖用户输入。** 非空字段与建议值不同必须显示当前值和建议值；只有用户主动应用才替换。
5. **查不到或离线时允许留空。** 三个数字字段仍是可选字段；外部目录失败不得阻止保存模型。
6. **不向目录服务发送本机配置。** 只下载固定、公开的 Models.dev JSON；Provider ID、Model ID、baseUrl、API Key 均只在本地匹配。
7. **不把目录快照写入 OpenClaw 配置。** `openclaw.json` 只保存用户最终接受的字段；目录缓存放在 `~/.oc-switch/`（`OcSwitchPaths.stateDir`）。
8. **第一版不引入 LiteLLM 双源合并。**
9. **第一版不改远端 discover 契约。** Provider discover 仍以 `id/name` 为主。
10. **保持旧配置兼容。** `contextTokens` 是可选字段；只有用户明确填写或修改时才写入，已有模型不会因为打开弹窗或查询建议而新增该字段。

### 10.3 来源优先级与匹配规则

第一版下载两份固定源并在本地归一化：

1. `models.json`（`https://models.dev/models.json`）：provider-agnostic 模型事实，作为主要来源。
2. `api.json`（`https://models.dev/api.json`）：当选中 Provider 可以**明确**映射到 Models.dev Provider 时，提供 provider-specific 覆盖。

匹配顺序：

1. `provider-exact`：oc-switch Provider ID（大小写折叠后）等于 Models.dev Provider ID，且 raw Model ID 精确命中该 Provider 的模型表。
2. `endpoint-exact`：Models.dev Provider 声明了 `api`，其标准化 origin/path 与当前 baseUrl 精确匹配，且 raw Model ID 精确命中。
3. `model-key-exact`：用户输入本身是完整模型 key（如 `openai/gpt-5.2`），精确命中 `models.json`。
4. `provider-model-exact`：`${normalizedProviderId}/${rawModelId}` 精确命中 `models.json`。
5. `unique-model-id`：raw Model ID 在模型事实表中只有一个候选；仅返回低置信候选，不自动应用。

禁止：模糊字符串相似度、自动删日期后缀、自动把 `latest` 映射到某个版本、按名称猜厂商、从任意 baseUrl 域名关键词猜 Provider。

Provider-specific 与 model-only 数值冲突时：

- Provider-specific 值排在前面并标注路由来源。
- 不静默合并不同候选；响应保留候选及其来源，由用户选择。
- `limit.context` → `contextWindow`；`limit.output` → `maxTokens`；`limit.input` 仅作为参考信息返回，不映射到 `contextTokens`。

### 10.4 缓存与失败契约

- Cache path：`<stateDir>/model-metadata-cache.json`。
- Cache schema version：`1`；未知版本视为不可用并重新获取。
- Fresh TTL：24 小时；Stale fallback：最后成功快照最多使用 30 天，并标注「缓存数据」。
- 使用 ETag：刷新请求带 `If-None-Match`；`304` 仅更新 `checkedAt`。
- 单次请求超时 5 秒（测试可注入更短值）；响应大小上限 `models.json` 2 MiB、`api.json` 8 MiB；超限或 schema 异常拒绝替换 last-known-good。
- 两个源分别记录 `fetchedAt`、`checkedAt`、ETag 与 stale 状态；任一源失败不得把另一失败源误标为 fresh。
- 缓存写入使用现有原子 JSON state store；损坏缓存不可影响模型手工编辑。
- 不在应用启动时联网；仅在用户查询建议或显式刷新时加载。
- CI 单元测试只使用 fixture/mock fetch，不依赖公网。

### 10.5 用户可见契约

- `Context Window` 改名为「原生上下文窗口（可选）」；新增「运行上下文预算（可选）」写入 `contextTokens`；`Max Tokens` 改名为「最大输出长度（可选）」。
- 三个字段下方显示简短说明；不确定时明确提示「可以留空」。
- Model ID 与 Provider 已确定后，显示「查询参考参数」次要按钮。
- 查询状态覆盖：idle、loading、matched、multiple、not-found、stale、error。
- 建议卡至少显示：模型名称、原生上下文、最大输出、匹配方式、来源、数据更新时间/缓存检查时间。
- 多候选时最多显示 5 项，用户先选候选再应用；不得自动采用低置信候选。
- 快捷值：原生上下文 `32K/64K/128K/200K/256K/1M`；运行预算 `32K/64K/128K/200K/256K`；最大输出 `4K/8K/16K/32K/64K/128K`。点击快捷值后输入框显示完整整数。
- `contextTokens > contextWindow` 时阻止保存并说明二者语义；其余可疑组合只告警，不擅自修正。

### 10.6 Server 只读端点

```text
GET /api/model-metadata/suggestions?providerId=<id>&modelId=<raw-id>&refresh=0|1
```

- provider/model 必填；Provider 不存在返回 4xx 且不访问 Models.dev。
- 成功响应只包含归一化建议、逐源时间/stale 状态与 warnings。
- `refresh=1` 绕过 fresh TTL，但仍使用 ETag。
- 目录错误时返回 `suggestions: []` + warning 或明确可恢复错误，不阻止其他模型 API。
- 查询前后 `openclaw.json`、`.env` 内容完全相同，且不创建 backup。
- 外发请求 URL/body/header 中不包含 API Key、baseUrl、Provider ID、Model ID。

## 11. 测试计划

### 11.1 Core

覆盖：

- 新增模型写入 provider model 与 allowlist
- 新增模型支持 model ID 内部斜杠
- 编辑模型字段保留未知字段
- 修改 model ID 迁移 allowlist 与 primary ref
- alias 更新保留 `agentRuntime` 与未知字段
- 禁用时只删除 allowlist，不删除 provider model
- 删除 primary 模型要求新 primary 或 force
- 重复模型 ID 被拒绝
- create/edit 写入、修改与清空 `contextTokens`；未知字段不丢失
- 单条新增省略 `reasoning` 时写入 `true`，明确传入 `false` 时保留 `false`
- 创建自定义 Provider 时随附模型统一写入 `reasoning: true`
- 批量新增模型统一写入 `reasoning: true`，跳过的既有模型保持不变
- `contextTokens` 为 0、负数、非整数时报错；大于 `contextWindow` 时报错
- config adapter summary 透传 `contextTokens`
- Models.dev 目录下载/ETag/TTL/stale/大小限制/失败降级
- 建议 resolver 确定性匹配与禁止猜测

### 11.2 Server

覆盖：

- `POST /api/models` 新增模型
- `PUT /api/models` 编辑模型并迁移 ref
- `DELETE /api/models` 删除模型
- 写入响应不泄漏密钥
- 含斜杠 model ID 通过 JSON body 正确处理
- 参数校验错误返回 400
- `contextTokens` round-trip；`contextTokens > contextWindow` 被拒绝
- `GET /api/model-metadata/suggestions` 建议查询、缓存与配置不变性、无 secret 外发

### 11.3 Web

覆盖：

- Providers 页可打开 Provider 模型管理入口
- Provider 固定模式新增模型
- Models 页全局新增模型时可选择 Provider
- Models 页行内编辑模型
- 编辑 ID 后列表显示新 ref
- primary 模型删除时要求选择新 primary
- 三字段可选标注与帮助文本；快捷按钮填入完整整数
- 查询建议状态（loading/matched/multiple/not-found/stale/error）与不自动覆盖输入
- 分别应用上下文/最大输出；「全部应用」不修改 `contextTokens`
- `contextTokens > contextWindow` 前端阻止提交
- Reasoning 使用 checkbox；新增模式默认勾选并提交 `true`
- 编辑既有 `true` / `false` 可通过 checkbox 修改
- 编辑缺少 `reasoning` 的旧模型时，未操作 checkbox 不提交该字段；操作后明确提交当前布尔值

### 11.4 验证命令

实现完成后至少运行：

```bash
bun test
bun run typecheck
```

如 Web 表单交互变更较大，补跑：

```bash
bun run test:e2e
```

## 12. Sync Audit 检查点

实现完成后对照本规格检查：

- Providers 页与 Models 页是否都有入口
- 两个入口是否共用同一套模型表单与 API
- 高级字段是否覆盖 `api`、`reasoning`、`contextWindow`、`contextTokens`、`maxTokens`、`input`
- 所有创建入口是否默认持久化 `reasoning: true`，且显式 `false` 不被覆盖；preset/import 与 backup restore 是否保持来源数据
- Reasoning checkbox 是否在无操作时保留旧模型的字段缺失状态，且未发生存量批量回填
- `contextWindow` / `contextTokens` / `maxTokens` 术语是否未混用；「自动填充」文案是否均改为「建议/显式应用」
- 修改模型 ID 是否迁移 allowlist 与 primary
- 未知字段是否保留
- 写入是否仍经过备份与 diff guard
- 建议值是否只修改表单状态、最终保存仍走现有 transaction writer
- 建议查询是否不发送本地标识/secret、不修改配置、不创建备份
- `agents.defaults.model` 双形态是否全部经归一层访问，`fallbacks` 是否原样保留且仅用于依赖保护
- 是否没有引入计划外功能

## 13. agents.defaults.model 双形态兼容

OpenClaw 允许 `agents.defaults.model` 取两种合法形态：

- 字符串 ModelRef：`"provider/model-id"`（无 fallback 语义）
- 对象：`{ "primary"?: string, "fallbacks"?: string[] }`（primary 与运行时回退链）

oc-switch 必须同时兼容两种形态，并遵循以下契约：

### 13.1 归一层（唯一访问入口）

core 内禁止直接读写 `config.agents.defaults.model`，必须经 `packages/core/src/primary-model.ts`：

- `readPrimaryModelRef(config): string | undefined`：字符串与对象 `primary` 均先 trim，再按 oc-switch ModelRef 规则校验（第一个 `/` 前后均非空）；保留大小写与 model ID 内部斜杠。缺失、空白、非法 ref、对象缺 primary、数组、数字、null 一律返回 `undefined`。**读取路径永不抛错。**
- `readFallbackModelRefs(config): string[]`：按相同规则归一 `fallbacks` 数组中的合法 ref，保持顺序；非法项不参与保护。非数组/缺失返回空数组。
- `writePrimaryModelRef(config, ref)`：形状守恒写入。当前值为非 null、非数组 record → 仅更新其 `primary` 键，保留 `fallbacks` 与未知键；当前值为字符串、缺失或非 record 畸形值 → 写纯字符串。string↔object 永不互转。
- `isPrimaryModelRef(config, ref)`：按归一 ref 等价比较。

### 13.2 fallbacks 语义

- `fallbacks` 是 OpenClaw 运行时回退链，**preserve-only**：oc-switch 不编辑、不展示、不在任何 UI/API 暗示可管理。
- 但 preserve 不等于 ignore：`fallbacks` 中的合法 ref 参与破坏性操作的依赖保护（见 13.3）。
- 原始数组与对象中的未知键始终原样穿透（round-trip / 前向兼容承诺）；未知键不被描述为当前 OpenClaw 的合法字段。

### 13.3 破坏性操作 fail-closed 矩阵

若操作会使任一合法 fallback ref 失去对应 Provider 或本地目录项，必须拒绝（**即使调用方传 `force`**），提示用户先在 OpenClaw 配置中移除或迁移 fallback；oc-switch 不自动改写 `fallbacks` 数组。

| 操作 | 保护条件 |
|---|---|
| 删除 Provider 模型 / rename 模型 ID | 命中任一 fallback ref |
| 批量删除模型 / 只保留已启用 | 会移除任一 fallback 目录项 |
| 删除 Provider / 关闭 Provider | 任一 fallback ref 属于该 Provider |
| case-duplicate merge | 需迁移或丢弃 fallback 所引用的 Provider/模型 |

primary 的既有保护语义不变（删除主模型需新 primary 或 force；主模型所属 Provider 不可删除/关闭）。

### 13.4 diff 与 diff-guard

- `primaryChanged` 以归一 primary ref 比较；仅 `fallbacks` 变化不报主模型变更（backup diff 摘要同样适用；原始备份与恢复仍完整保留）。
- diff-guard 已按前缀放行 `agents.defaults.model.*` 任意深度，无需变更。

### 13.5 畸形配置策略

- 只读路径对畸形值降级为「未设置主模型」，不崩溃。
- 不后台自动修复畸形配置；非 primary 写入不得顺手改写 `agents.defaults.model`。仅显式切换/迁移 primary 时按 13.1 写入。
