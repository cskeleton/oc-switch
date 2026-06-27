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
| Reasoning | `provider.models[].reasoning` | 可选布尔字段；未设置时不写入 |
| Context Window | `provider.models[].contextWindow` | 可选正整数 |
| Max Tokens | `provider.models[].maxTokens` | 可选正整数 |
| Input | `provider.models[].input` | 可选字符串数组；UI 用逗号或多行文本输入 |

`cost` 与其他未知字段首版不提供结构化编辑，但编辑已有模型时必须原样保留。

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
  maxTokens?: number;
  input?: string[];
}
```

Core 层新增或扩展操作：

- `addProviderModel(config, providerId, input)`
- `updateProviderModel(config, ref, input)`
- `removeProviderModel(config, ref, options)`

现有 CLI `model add` 可继续调用新增后的 `addProviderModel`，保持命令行为兼容。若为了兼容现有调用签名需要保留旧函数，可新增包装函数，但实际写入逻辑应收敛到同一处。

### 6.1 字段写入约定

模型对象只写入用户设置的字段：

- 空字符串按未设置处理
- 可选数字为空时删除该字段
- 可选布尔为空时删除该字段；明确 true/false 时写入
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
| API 类型不支持 | 拒绝写入并提示 |
| 删除 primary 模型但没有新 primary 或 force | 拒绝写入并提示选择新主模型 |

## 10. 测试计划

### 10.1 Core

覆盖：

- 新增模型写入 provider model 与 allowlist
- 新增模型支持 model ID 内部斜杠
- 编辑模型字段保留未知字段
- 修改 model ID 迁移 allowlist 与 primary ref
- alias 更新保留 `agentRuntime` 与未知字段
- 禁用时只删除 allowlist，不删除 provider model
- 删除 primary 模型要求新 primary 或 force
- 重复模型 ID 被拒绝

### 10.2 Server

覆盖：

- `POST /api/models` 新增模型
- `PUT /api/models` 编辑模型并迁移 ref
- `DELETE /api/models` 删除模型
- 写入响应不泄漏密钥
- 含斜杠 model ID 通过 JSON body 正确处理
- 参数校验错误返回 400

### 10.3 Web

覆盖：

- Providers 页可打开 Provider 模型管理入口
- Provider 固定模式新增模型
- Models 页全局新增模型时可选择 Provider
- Models 页行内编辑模型
- 编辑 ID 后列表显示新 ref
- primary 模型删除时要求选择新 primary

### 10.4 验证命令

实现完成后至少运行：

```bash
bun test
bun run typecheck
```

如 Web 表单交互变更较大，补跑：

```bash
bun run test:e2e
```

## 11. Sync Audit 检查点

实现完成后对照本规格检查：

- Providers 页与 Models 页是否都有入口
- 两个入口是否共用同一套模型表单与 API
- 高级字段是否覆盖 `api`、`reasoning`、`contextWindow`、`maxTokens`、`input`
- 修改模型 ID 是否迁移 allowlist 与 primary
- 未知字段是否保留
- 写入是否仍经过备份与 diff guard
- 是否没有引入计划外功能
