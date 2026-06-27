# oc-switch Custom Provider Add Design

## 1. 背景

当前 oc-switch 已支持从 preset 添加 Provider：

- CLI：`oc-switch provider add <preset-id> --key <api-key> [--models ...]`
- WebGUI：`/presets` 页面从内置或自定义 preset 添加
- 写入链路：`writeOpenClawTransaction`、`.env` managed block、manifest、备份、diff guard

缺口是：用户在 WebGUI 的 Provider 管理页无法像 CC Switch 那样直接填写供应商信息、API Key、请求地址和模型列表来添加自定义 Provider。

本功能目标是补齐 **手工添加 Provider**，并复用现有 oc-switch 的安全写入机制。

## 2. 目标

### 2.1 用户目标

用户可以在 Providers 页面点击“添加 Provider”，打开一个类似 CC Switch 的表单，填写：

- 供应商名称
- 备注
- 官网链接
- API Key
- 请求地址
- API 类型
- 模型列表
- 高级选项

确认前可以预览 diff；确认后写入 `openclaw.json`、`~/.openclaw/.env` 和 `~/.oc-switch/manifest.json`。

### 2.2 工程目标

- Core 继续作为唯一 OpenClaw 本地文件写入层
- Server/Web/CLI 不直接拼接 OpenClaw 写入逻辑
- API Key 永远不返回给前端，不写入 JSON 配置
- 写入前自动备份，写入后通过 diff guard 限制语义变更范围
- Provider ID 与 model ref 继续遵守“只按第一个 `/` 拆分”的规则

## 3. 非目标

首版不实现以下 CC Switch 功能：

- 代理请求日志、成本统计、健康检查、失败转移
- “管理与测速”自动测速流程
- “隐藏 AI 署名”“Teammates 模式”“启用 Tool Search”“最大强度思考”等 Claude/Codex 代理专属配置
- 多 endpoint 自动选择
- Provider 图标上传或图标颜色管理
- 完整 JSON 编辑器直接覆盖 OpenClaw provider 原始结构
- 创建后自动同步远端模型

这些能力不属于 oc-switch 当前的 OpenClaw Provider/Model 管理边界。

## 4. 用户体验

### 4.1 入口

Providers 页面顶部新增“添加 Provider”按钮。

点击后打开表单区域或模态窗口。首版建议使用模态窗口，因为 Providers 页面已有列表和删除确认，新增表单会比列表复杂，模态可以降低页面噪声。

### 4.2 表单字段

基础字段：

| 字段 | 必填 | 写入目标 | 说明 |
| --- | --- | --- | --- |
| Provider ID | 是 | `models.providers.{id}` | 大小写敏感，不允许 `/`，默认由供应商名称生成，可手改 |
| 供应商名称 | 是 | manifest metadata | UI 展示名，不影响 OpenClaw provider key |
| 备注 | 否 | manifest metadata | 用户备注 |
| 官网链接 | 否 | manifest metadata | 仅展示和后续编辑使用 |
| API 类型 | 是 | `provider.api` | 支持 `openai-completions`、`anthropic-messages`、`google-generative-ai` |
| 请求地址 | 是 | `provider.baseUrl` | 写入 OpenClaw provider 的 `baseUrl` |
| 完整 URL | 否 | manifest metadata | 控制表单输入辅助行为，不改变 OpenClaw schema |
| API Key env 名 | 是 | `provider.apiKey`，写入 OpenClaw 2026.6.8 兼容的 `"${ENV_VAR}"` 字符串；`authHeader` 仅作为 boolean 兼容开关，不保存密钥引用 | 默认由 Provider ID 生成 |
| API Key | 是 | `.env` managed block | 只写入 `.env`，不回显 |
| 模型列表 | 是 | `provider.models[]` | 表格式输入：每行 `id`、可选 `name`、可选 `alias` |

高级字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 默认启用全部模型 | 开 | 开启时写入 `agents.defaults.models["{providerId}/{modelId}"]` |
| baseUrl 自动补 `/v1` | 由 API 类型决定 | `openai-completions` 在“完整 URL”关闭时补 `/v1`，其他 API 类型原样 |

### 4.3 模型列表输入格式

模型列表使用表格式输入。每行包含 `id`、可选 `name`、可选 `alias`。默认展示 3 行空输入，点击加号追加更多行。

解析规则：

- 仅提交 `id` 非空的行
- `name` 与 `alias` 可选；省略 `name` 时由 core 从 `id` 生成 fallback
- `model.id` 可以包含 `/`，不做路径拆分
- 重复 model id 报错，不静默覆盖

### 4.4 完整 URL 开关

参考 CC Switch 的“完整 URL”交互，但映射到 oc-switch 更窄：

- 开启：请求地址去除首尾空白后原样写入 `provider.baseUrl`
- 关闭且 API 类型为 `openai-completions`：如果 URL 不以 `/v1` 结尾，写入时追加 `/v1`
- 关闭且 API 类型为 `anthropic-messages` 或 `google-generative-ai`：原样写入

表单下方提示：

> OpenAI-compatible 通常使用 `/v1` 结尾；Anthropic/Gemini 兼容端点按服务商说明填写。

## 5. 数据模型

### 5.1 新增输入类型

在 core 中新增 `CustomProviderInput`：

```ts
export interface CustomProviderInput {
  providerId: string;
  displayName: string;
  notes?: string;
  websiteUrl?: string;
  api: ApiType;
  baseUrl: string;
  isFullUrl: boolean;
  apiKeyEnv: string;
  models: Array<{
    id: string;
    name?: string;
    alias?: string;
  }>;
  enableAllModels: boolean;
}
```

### 5.2 OpenClaw 写入结果

示例输入：

```json
{
  "providerId": "my-provider",
  "displayName": "My Provider",
  "api": "openai-completions",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyEnv": "MY_PROVIDER_API_KEY",
  "models": [
    { "id": "model-a", "name": "Model A", "alias": "a" },
    { "id": "vendor/model-b", "name": "Vendor Model B", "alias": "b" }
  ],
  "enableAllModels": true
}
```

写入 `openclaw.json`：

```json
{
  "models": {
    "providers": {
      "my-provider": {
        "baseUrl": "https://api.example.com/v1",
        "api": "openai-completions",
        "apiKey": "${MY_PROVIDER_API_KEY}",
        "models": [
          { "id": "model-a", "name": "Model A" },
          { "id": "vendor/model-b", "name": "Vendor Model B" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "models": {
        "my-provider/model-a": { "alias": "a" },
        "my-provider/vendor/model-b": { "alias": "b" }
      }
    }
  }
}
```

写入 `.env` managed block：

```dotenv
# oc-switch:start
MY_PROVIDER_API_KEY=sk-...
# oc-switch:end
```

更新 `manifest.json`：

```json
{
  "providers": {
    "my-provider": {
      "providerId": "my-provider",
      "envVar": "MY_PROVIDER_API_KEY",
      "displayName": "My Provider",
      "notes": "Company account",
      "websiteUrl": "https://example.com",
      "isFullUrl": false,
      "createdAt": "2026-06-24T00:00:00.000Z",
      "updatedAt": "2026-06-24T00:00:00.000Z",
      "orphan": false
    }
  }
}
```

## 6. Core 设计

### 6.1 新增操作

新增 `addCustomProvider(config, input)`：

- 校验 `providerId` 非空、不包含 `/`
- 校验 `providerId` 不与现有 provider 冲突
- 校验 `apiKeyEnv` 符合 env var 命名规则
- 校验 `baseUrl` 为 http/https URL
- 校验 `models` 非空且 id 去重
- 根据 `api` 与 `isFullUrl` 规范化 `baseUrl`
- 写入 `models.providers[providerId]`
- 当 `enableAllModels` 为 true 时写入 allowlist

### 6.2 auth 字段选择

首版规则（OpenClaw 2026.6.8 兼容）：

- 所有 API 类型统一写 `apiKey: "${ENV_VAR}"` 字符串
- 不在新写入中使用 `authHeader` 保存密钥；`authHeader` 仅作为 boolean 兼容开关（修复旧配置时可为 `true`）

### 6.3 manifest metadata

现有 manifest entry 需要扩展可选字段：

```ts
export interface ManifestProviderEntry {
  providerId: string;
  envVar: string;
  displayName?: string;
  notes?: string;
  websiteUrl?: string;
  isFullUrl?: boolean;
  createdAt: string;
  updatedAt: string;
  orphan: boolean;
}
```

扩展现有 `upsertProviderEnvManifest`，允许传入可选 metadata，并在保持 `createdAt` 不变的前提下更新 `updatedAt`。

## 7. Server API

### 7.1 Preview

`POST /api/providers/custom/preview`

请求体：

```json
{
  "providerId": "my-provider",
  "displayName": "My Provider",
  "notes": "Company account",
  "websiteUrl": "https://example.com",
  "api": "openai-completions",
  "baseUrl": "https://api.example.com",
  "isFullUrl": false,
  "apiKeyEnv": "MY_PROVIDER_API_KEY",
  "models": [
    { "id": "model-a", "alias": "a" }
  ],
  "enableAllModels": true
}
```

响应体：`ConfigDiffSummary`

行为：

- 读取当前配置
- 调用 `addCustomProvider(structuredClone(config), input)`
- 返回 `summarizeConfigDiff(before, after)`
- 不写文件，不接收 API Key

### 7.2 Commit

`POST /api/providers/custom`

请求体同 preview，额外包含：

```json
{
  "apiKey": "sk-..."
}
```

行为：

- 校验 body
- 通过 `writeOpenClawTransaction` 写入
- `envUpdates` 写入 `{ [apiKeyEnv]: apiKey }`
- `manifestUpdates` 写入 provider env 与 metadata
- 返回 `{ ok: true, backupId }`
- 响应体不得包含 API Key

## 8. CLI 设计

新增命令：

```bash
oc-switch provider add-custom \
  --id my-provider \
  --name "My Provider" \
  --api openai-completions \
  --base-url https://api.example.com \
  --key sk-... \
  --models model-a,model-b \
  --aliases model-a:a,model-b:b
```

可选参数：

- `--env MY_PROVIDER_API_KEY`
- `--notes "..."`
- `--website https://example.com`
- `--full-url`
- `--disable-by-default`

CLI 采用同一 core 操作与事务写入路径。

## 9. Web 设计

### 9.1 Providers 页面

顶部按钮：

- 刷新
- 添加 Provider

添加 Provider 表单结构参考 CC Switch：

- 顶部：Provider 图标占位符，显示 providerId 首字母或 `P`
- 第一行：供应商名称、备注
- 第二行：官网链接
- 第三行：API Key
- 第四行：请求地址、完整 URL 开关
- 第五行：模型列表
- 高级选项折叠区：API 类型、API Key env 名、默认启用全部模型
- 底部：预览并添加、取消

### 9.2 交互流程

1. 用户填写基础信息
2. 点击“预览并添加”
3. 前端调用 `/api/providers/custom/preview`
4. 页面显示 `DiffSummary`
5. 用户确认
6. 前端调用 `/api/providers/custom`
7. 成功后清空 API Key、关闭表单、刷新 Providers 和 Dashboard

### 9.3 表单默认值

- `API 类型` 默认 `openai-completions`
- `完整 URL` 默认关闭
- `默认启用全部模型` 默认开启
- `API Key env 名` 根据 Provider ID 自动生成，但用户修改后不再自动覆盖
- `Provider ID` 根据供应商名称生成小写 kebab-case，但用户修改后不再自动覆盖

## 10. 错误处理

| 场景 | 行为 |
| --- | --- |
| Provider ID 已存在 | preview 和 commit 均返回 400 |
| Provider ID 包含 `/` | 返回 400 |
| API Key env 名非法 | 返回 400 |
| 请求地址不是 http/https | 返回 400 |
| 模型列表为空 | 返回 400 |
| 模型 ID 重复 | 返回 400 |
| `.env` 非托管变量冲突 | 与 Path & Env 规格 §6.2 一致：preview 返回 `requiresConfirmation`；commit 须 `confirmMigration`（complex 须 `confirmComplex`），确认后 `migrateEnvVarToManagedBlock` |
| diff guard 拦截 | 拒绝写入并返回错误 |

## 11. 测试策略

### 11.1 Core

- `addCustomProvider` 写入 provider、models、allowlist
- `model.id` 包含 `/` 时 ref 正确
- 所有 API 类型写入 `apiKey: "${ENV_VAR}"` 且填充 model `name`
- `openai-completions` 在 `isFullUrl=false` 时补 `/v1`
- providerId/env/baseUrl/models 校验失败

### 11.2 Server

- preview 返回 diff 且不写文件
- commit 写入 `openclaw.json`、`.env`、manifest
- commit 响应不泄漏 API Key
- 错误输入返回 400

### 11.3 CLI

- `provider add-custom` 写入 provider 与 env
- `--models` 支持 slash-containing model id
- `--disable-by-default` 不写 allowlist

### 11.4 Web

- Providers 页面可以打开添加表单
- 填写表单后调用 preview endpoint
- 确认后调用 commit endpoint，API Key 不渲染
- Provider ID 与 env 名自动生成逻辑可被用户覆盖

### 11.5 E2E

- 桌面和移动视口下，添加表单可打开、可取消
- 表单长 model id 不造成布局溢出

## 12. 兼容性与迁移

- 不改变现有 preset 添加路径
- 不改变现有 `POST /api/providers` 语义
- 新增 `/api/providers/custom*` 避免与 preset 添加冲突
- 现有 manifest 缺少 metadata 字段时继续兼容
- 旧 custom preset 不需要迁移

## 13. 验收标准

- 用户无需创建 preset 文件即可添加自定义 Provider
- API Key 不出现在 `openclaw.json`、API 响应、Web DOM 文本中
- 添加前可以看到 diff preview
- 添加后 provider 出现在 Providers 页面，模型出现在 Models 页面
- 默认启用时 allowlist 包含所有输入模型
- `bun run check`、`bun run acceptance`、`bun run test:e2e` 通过
