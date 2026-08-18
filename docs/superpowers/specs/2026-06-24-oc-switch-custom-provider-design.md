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
| Provider ID | 是 | `models.providers.{id}` | 不允许 `/`，写入时统一转换为小写；默认由供应商名称生成，可手改 |
| 供应商名称 | 是 | manifest metadata | UI 展示名，不影响 OpenClaw provider key |
| 备注 | 否 | manifest metadata | 用户备注 |
| 官网链接 | 否 | manifest metadata | 仅展示和后续编辑使用 |
| API 类型 | 是 | `provider.api` | 支持 `openai-completions`、`anthropic-messages`、`google-generative-ai` |
| 请求地址 | 是 | `provider.baseUrl` | 写入 OpenClaw provider 的 `baseUrl` |
| 完整 URL | 否 | manifest metadata | 控制表单输入辅助行为，不改变 OpenClaw schema |
| API Key env 名 | 是 | `provider.apiKey`，写入 canonical SecretRef `{ source: "env", provider: "default", id: "ENV_VAR" }`；`authHeader` 仅作为 boolean 兼容开关，不保存密钥引用 | 默认由 Provider ID 生成 |
| API Key | 是 | `.env` managed block | 只写入 `.env`，不回显 |
| 模型列表 | 是 | `provider.models[]` | 表格式输入：每行 `id`、可选 `name`、可选 `alias` |

高级字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 默认启用全部模型 | 开 | 开启时写入 `agents.defaults.models["{providerId}/{modelId}"]` |
| baseUrl 自动补 `/v1` | 由 API 类型决定 | `openai-completions` 在“完整 URL”关闭时补 `/v1`，其他 API 类型原样 |

### 4.3 模型列表输入格式

模型列表使用表格式输入。每行包含 `id`、可选 `name`、可选 `alias`。默认展示 3 行空输入，点击加号追加更多行。

交互约束：

- 每行均提供删除操作，可删除空行或任意已填写行
- 允许删到 0 行；提交时仍按“至少 1 个有效 `id`”校验

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
        "apiKey": { "source": "env", "provider": "default", "id": "MY_PROVIDER_API_KEY" },
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

当前规则：

- 所有 API 类型统一写 `apiKey: { source: "env", provider: "default", id: "ENV_VAR" }`
- 不在新写入中使用 `authHeader` 保存密钥；`authHeader` 仅作为 boolean 兼容开关（修复旧配置时可为 `true`）

旧 `${ENV_VAR}`、`$ENV_VAR` 与两字段 `{ source: "env", id: "ENV_VAR" }` 不在普通写入或 `health repair` 中静默改写。Providers 页通过 `GET /api/providers/secret-ref-migrations` 展示候选；源 `.env` 存在唯一、非空且语法简单的值时才可能为 `ready`。唯一关联的 Gateway service env 缺少该变量不构成 blocker，因为 OpenClaw 可从全局 `.env` 补足；若 service env 存在同名但不同值（含空值），则进程环境会覆盖 dotenv，返回 `gateway-env-drift` 并 fail closed；无法唯一关联目标时仍返回 `gateway-target-unavailable`。用户确认后，`POST /api/providers/secret-ref-migrations` 仅迁移明确提交的 Provider，事务写入前创建备份并返回 `gatewayRestartRequired: true`；任一候选状态变化或存在 blocker 时 fail closed。比较过程和响应均不得暴露值。

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
2. 在模型列表区可点击“发现模型”（ephemeral discover，见 §9.4），按勾选结果回填到表单行
3. 点击“预览并添加”
4. 前端调用 `/api/providers/custom/preview`
5. 页面显示 `DiffSummary`
6. 用户确认
7. 前端调用 `/api/providers/custom`
8. 成功后清空 API Key、关闭表单、刷新 Providers 和 Dashboard；成功提示基于响应 `envWrite.verified` 与可选 `maskedValue`（见 Path & Env 规格 §7.1），不得仅凭前端输入展示「已写入」

### 9.3 弹窗关闭守卫

- 添加 Provider 弹窗禁止遮罩点击关闭与 `Esc` 关闭
- 仅允许通过底部「取消」按钮触发关闭流程
- 取消时若表单无脏数据：直接关闭并重置表单
- 取消时若存在脏数据：必须弹二次确认；用户确认后才关闭并清空
- 脏数据判定应覆盖基础字段、API Key、高级选项与模型行变更；仅初始空白行不算脏
- 脏数据判定基准为“初始快照”而非“字段是否非空”：空表单初始态点击取消必须直接关闭，不得因自动派生值（如 `apiKeyEnv` 默认值）被误判为脏

### 9.4 添加前发现模型（ephemeral discover）

用途：在 Provider 尚未写入配置前，基于当前表单 `api` / `baseUrl` / `apiKey` 临时拉取远端模型，勾选后仅回填表单模型行。

约束：

- discover 请求为只读行为，不写 `openclaw.json`、不写 `.env`、不创建备份
- discover 结果仅存在会话内；关闭弹窗即丢弃
- 勾选回填时按模型 `id` 去重；已存在 `id` 跳过
- 勾选回填时优先填充现有空白模型行，再追加新行，避免无意义扩容表单行数
- 勾选回填需遵守 `MAX_PROVIDER_MODELS = 50`（最终提交前后均由 core 再次校验）
- 该流程遵守「discover 默认不写盘」规则；真正写盘仅发生在用户确认提交 custom provider 后
- `isFullUrl=true` 时 discover 请求地址按用户输入原样使用；`isFullUrl=false` 时才按 API 类型应用补 `/v1` 等归一化规则（与最终 custom 提交语义一致）

### 9.5 表单默认值

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
- 所有 API 类型写入 canonical env SecretRef 且填充 model `name`
- 旧 env shorthand/两字段 EnvRef 迁移只接受明确确认的 ready 候选；不改 `.env`，响应不含 Key 值
- `openai-completions` 在 `isFullUrl=false` 时补 `/v1`
- providerId/env/baseUrl/models 校验失败

### 11.2 Server

- preview 返回 diff 且不写文件
- commit 写入 `openclaw.json`、`.env`、manifest
- commit 响应不泄漏 API Key；含 API Key 写入时返回 `envWrite` 校验摘要（`verified`、`envVar`、`managed`、可选 `maskedValue`），不含明文或磁盘不匹配值
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
- 遮罩点击与 `Esc` 不会关闭弹窗；仅“取消”可触发关闭
- 空表单点击“取消”直接关闭，不出现二次确认
- 脏表单点击“取消”会出现二次确认
- 模型行支持删除空行与任意行
- 添加前 discover 仅回填表单，不触发任何配置写入或备份

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
- Provider and Settings env writes perform server-side write-after-read verification before returning success feedback. The server compares the managed-block value with the submitted value in memory and returns only `verified`, `envVar`, `managed`, and optional `maskedValue`; it never returns the plaintext key or the mismatched disk value.
- 添加前可以看到 diff preview
- 添加后 provider 出现在 Providers 页面，模型出现在 Models 页面
- 默认启用时 allowlist 包含所有输入模型
- `bun run check`、`bun run acceptance`、`bun run test:e2e` 通过
