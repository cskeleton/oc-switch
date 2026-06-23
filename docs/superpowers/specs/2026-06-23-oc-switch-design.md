# oc-switch 设计规格

> 日期：2026-06-23  
> 状态：已评审  
> 更新：2026-06-23，补充模型引用解析、事务写入、`.env` 管理与验收 fixture  
> 目标：为 OpenClaw 提供专注的 Provider/Model 管理工具（WebGUI + CLI），解决 CC Switch 无法完整读写复杂 `openclaw.json` 的问题。

---

## 1. 背景与动机

### 1.1 问题

用户现有 OpenClaw 配置（`~/.openclaw/openclaw.json`）包含：

- 12 个自定义 provider（elysiver、juya、cherryin、nvidia 等）
- 43 个 `agents.defaults.models` allowlist 条目
- 全部 API Key 以 env 引用形式存储（`apiKey: { source: "env", id: "..." }`）
- `models.mode: "merge"` 与 bundled provider 共存
- 模型 ID 含斜杠（如 `nvidia/deepseek-ai/deepseek-v4-flash`）

对本机当前配置的验证结果：

- `models.providers` 为对象，共 12 个 provider，provider key 大小写敏感（如 `DeepSeek`、`OpenRouter`）
- `agents.defaults.models` 为对象，共 43 个 allowlist 条目，value 常见结构为 `{ alias, agentRuntime? }`
- 多个 provider 的模型 ID 本身包含斜杠，例如 `deepseek-ai/deepseek-v4-flash`、`qwen/qwen3.5-27b`
- 因此完整模型引用必须按“第一个 `/` 前为 provider，其余完整保留为 modelId”解析

CC Switch 作为通用多工具管理器，无法完整导入上述配置，主要局限：

| 用户配置特征 | CC Switch 局限 |
|---|---|
| 大量自定义公益站 provider | 主要识别内置 preset |
| env 引用式 apiKey | 可能只处理内联 key |
| `models.mode: "merge"` | 导入逻辑可能只覆盖 `models.providers` |
| provider 与 allowlist 不完全同步 | 不维护双向同步 |
| 特殊 api 类型（anthropic-messages、google-generative-ai） | 支持不完整 |

### 1.2 目标

构建 **oc-switch**：专注 OpenClaw 的 Provider/Model 管理工具。

- **WebGUI + CLI**，不做独立桌面应用
- 每台机器各自部署，只管本机 `~/.openclaw` 配置
- 远程场景：在 VPS 上运行后，通过浏览器从 Mac/iPad/手机访问 WebGUI
- 内置 preset 库 + 从现有配置反向导入
- 统一将 API Key 写入 `~/.openclaw/.env`
- 写入前自动备份，严格限定可写范围

### 1.3 非目标

- 不管理 Claude Code、Codex 等其他 AI CLI 工具
- 不管理 OpenClaw 的 channels、MCP、Skills、workspace 文件
- 不提供多机配置同步（各机独立部署）
- 不内置 HTTPS 证书管理

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                     oc-switch                            │
│                                                          │
│  ┌─────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │   CLI   │   │  Web Server  │   │   WebGUI (SPA)    │  │
│  │ oc-switch│   │  REST API    │   │  响应式，iPad友好  │  │
│  └────┬────┘   └──────┬───────┘   └─────────┬─────────┘  │
│       └───────────────┴─────────────────────┘            │
│                       │                                  │
│              ┌────────┴────────┐                         │
│              │    Core Engine   │                         │
│              │                  │                         │
│              │ • ConfigAdapter  │ ← 只动 provider/models  │
│              │ • EnvManager     │ ← 统一写 .env           │
│              │ • BackupManager  │ ← 写入前自动备份         │
│              │ • PresetStore    │ ← 内置 + 用户 preset    │
│              └────────┬────────┘                         │
└───────────────────────┼──────────────────────────────────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   ~/.openclaw/   ~/.openclaw/   ~/.oc-switch/
   openclaw.json      .env         presets/
                                  backups/
```

### 2.1 部署方式

```bash
# Mac 本机
oc-switch serve                    # WebGUI → http://localhost:7420
oc-switch use nvidia/nv-kimi       # CLI 快速切换 primary model

# 远程 VPS（SSH 登录后）
oc-switch serve --host 0.0.0.0 --token <secret>
# 从 Mac/iPad 浏览器访问 http://<vps-ip>:7420
```

### 2.2 写入范围（严格限定）

| 文件 | 可写区域 | 禁止修改 |
|------|----------|----------|
| `openclaw.json` | `models.providers.*`、`agents.defaults.models.*`、`agents.defaults.model` | `acp`、`wizard`、`channels`、`auth` 等其余字段 |
| `.env` | oc-switch 管理块内的 API Key 变量，或 manifest 记录的变量 | 其他已有 env 变量（默认保留不覆盖） |

### 2.3 Provider CRUD 规则

以 provider 名称（`models.providers` 的 key）为唯一标识：

- **添加**：preset 不存在于配置 → 写入 `models.providers.{id}` + 批量注册 allowlist
- **更新**：已存在 → 合并 models 列表，同步 allowlist diff
- **删除**：移除 provider + 清除 allowlist 中所有 `parseModelRef(ref).providerId === id` 的条目；若 primary model 命中则警告

### 2.4 备份策略

每次写入前：

1. 创建备份包 `~/.oc-switch/backups/{ISO-timestamp}/`
2. 复制 `openclaw.json` 与 `.env`（若存在）
3. 生成 `metadata.json`，记录来源路径、写入原因、写入前 hash、oc-switch 版本
4. 默认保留最近 20 份，超出自动清理最旧
5. WebGUI / CLI 支持预览 diff 与一键回滚（回滚前再次备份当前状态）

备份与回滚以 `openclaw.json` 和 `.env` 为一个整体，避免 JSON 已回滚但 env key 仍停留在新状态。

### 2.5 ModelRef 与斜杠解析规则

OpenClaw 的完整模型引用统一称为 `ModelRef`：

```
ModelRef = `${providerId}/${modelId}`
```

解析规则：

- `providerId` 不允许包含 `/`，必须与 `models.providers` 的 key 完全一致，大小写敏感，不自动 normalize
- `modelId` 可以包含 `/`、`.`、`:`、`-` 等字符，解析时保留第一个 `/` 后面的完整字符串
- `parseModelRef(ref)` 只按第一个 `/` 拆分：`providerId = beforeFirstSlash(ref)`，`modelId = afterFirstSlash(ref)`
- 无 `/`、provider 为空、modelId 为空均为非法引用
- 删除 provider、过滤 allowlist、判断 primary 是否命中时，都必须使用同一个 `parseModelRef`

示例：

| ModelRef | providerId | modelId |
|----------|------------|---------|
| `nvidia/deepseek-ai/deepseek-v4-flash` | `nvidia` | `deepseek-ai/deepseek-v4-flash` |
| `cherryin/qwen/qwen3.5-27b` | `cherryin` | `qwen/qwen3.5-27b` |
| `minimax-portal/MiniMax-M3` | `minimax-portal` | `MiniMax-M3` |

REST API 不应把完整 `ModelRef` 作为普通 path segment 直接传递。涉及模型引用的写操作优先通过 JSON body 传 `{ ref }`；如必须放在 URL 中，需作为 wildcard route 接收并要求 URL 编码。

---

## 3. Preset 数据模型

### 3.1 结构定义

```typescript
interface ProviderPreset {
  id: string;                    // "elysiver"，对应 models.providers 的 key
  name: string;                  // "Elysiver 公益站"
  description?: string;
  tags?: string[];               // ["公益站", "openai-compatible"]

  provider: {
    api: "openai-completions" | "anthropic-messages" | "google-generative-ai";
    baseUrl: string;
    apiKeyEnv: string;           // "ELYSIVER_API_KEY"
  };

  models: Array<{
    id: string;                  // provider 内裸 ID，如 "deepseek-v4-pro"
    name?: string;
    alias?: string;              // allowlist 别名，缺省自动生成
    reasoning?: boolean;
    contextWindow?: number;
    maxTokens?: number;
    api?: "openai-completions" | "anthropic-messages" | "google-generative-ai";
    input?: string[];
    cost?: Record<string, unknown>;
    [key: string]: unknown;      // 反向导入时保留 OpenClaw 现有模型字段
  }>;
}
```

### 3.2 写入映射

```
preset.id              →  models.providers.{id}
preset.provider.*      →  models.providers.{id}.*
preset.models[]        →  models.providers.{id}.models[]
                         agents.defaults.models["{id}/{modelId}"]

apiKeyEnv              →  .env: ELYSIVER_API_KEY=sk-xxx
                         JSON: apiKey: { source: "env", id: "ELYSIVER_API_KEY" }
```

`agents.defaults.models` 的 value 按 OpenClaw 原始结构保留，oc-switch 首版只主动维护：

```typescript
interface AllowlistEntry {
  alias?: string;
  agentRuntime?: { id: string };
  [key: string]: unknown;
}
```

写入 allowlist 时：

- key 使用完整 `ModelRef`
- alias 来自 preset model 的 `alias`，缺省可由 provider/model 名称生成
- 已存在 entry 时只更新 oc-switch 明确管理的字段，保留未知字段

### 3.3 Preset 来源

| 来源 | 路径 | 说明 |
|------|------|------|
| 内置 | `presets/builtin/*.json` | 随安装包附带，覆盖常见公益站 |
| 用户自定义 | `~/.oc-switch/presets/custom/*.json` | 手动编辑或 WebGUI 导出 |
| 反向导入 | CLI `oc-switch import` | 从现有 `openclaw.json` 生成 preset |

### 3.4 模型同步逻辑

**Provider 添加/更新时：**

- `provider.models` 新增 → 自动添加 `agents.defaults.models["{provider}/{modelId}"]`
- `provider.models` 删除 → 自动移除对应 allowlist 条目
- 若被删模型为当前 primary → 标记警告，不自动修改 primary

**用户手动启用/禁用模型（WebGUI 开关）：**

- 仅影响 allowlist，不删除 `provider.models` 中的定义（便于重新启用）

### 3.5 `.env` 管理规则

oc-switch 不把 API Key 明文写入 `openclaw.json`，只写 env 引用。

`.env` 写入遵循以下规则：

- 首选写入 oc-switch 管理块：

```dotenv
# oc-switch:start
ELYSIVER_API_KEY=...
# oc-switch:end
```

- 若目标变量已存在于管理块外，默认不覆盖；CLI/WebGUI 需提示用户确认后才可接管
- 每次写入同步更新 `~/.oc-switch/manifest.json`，记录 providerId、env var、创建时间、最后更新时间
- 日志、REST 响应、WebGUI 页面均不得显示 API Key 明文，只显示是否已配置、变量名和尾部 4 位掩码
- 删除 provider 时默认不删除 env key，仅标记为 orphan；用户可在设置页清理 orphan keys

---

## 4. WebGUI 页面设计

响应式布局，适配 iPad 与手机浏览器。

### 4.1 仪表盘 `/`

- 当前 Primary Model（大卡片，一键跳转切换）
- Provider 数量、模型数量、最近备份时间
- 快捷操作：添加 Provider、切换模型、查看备份

### 4.2 Provider 管理 `/providers`

列表字段：名称、api 类型、模型数（已注册/已启用）、是否含 primary model、操作（编辑/删除）。

**添加流程：**

1. 从 Preset 库选择（搜索 + 标签筛选）
2. 填写 API Key（写入 `.env`）
3. 勾选要启用的模型（默认全选）
4. 预览 diff → 确认写入

**编辑页面：**

- 修改 baseUrl、API Key
- 模型列表 CRUD（id、名称、alias、启用开关）
- 「从站拉取模型列表」：调用 Core Engine 的 provider sync adapter，合并到列表

### 4.3 模型切换 `/models`

- 按 provider 分组的模型列表/卡片
- 点击设为 primary model，当前 primary 高亮
- 支持 alias 搜索

### 4.4 Preset 库 `/presets`

- 浏览内置与用户自定义 preset
- 一键「添加到 OpenClaw」
- 从当前配置「导出为 Preset」
- 导入/导出 preset JSON 文件

### 4.5 备份 `/backups`

- 时间线列表
- 预览 diff（变更的 provider/model）
- 一键回滚

### 4.6 设置 `/settings`

- 配置路径（默认 `~/.openclaw/openclaw.json`，支持 `OPENCLAW_CONFIG_PATH`）
- WebGUI 端口（默认 7420）、bind 地址、访问 Token
- 备份保留份数
- Gateway 重启命令（可选，写入后执行，如 `openclaw gateway restart`）

---

## 5. CLI 命令集

CLI 与 WebGUI 共用 Core Engine，行为一致。

```bash
# 服务
oc-switch serve [--port 7420] [--host 127.0.0.1] [--token <secret>]
oc-switch token rotate

# 查看
oc-switch status
oc-switch providers list
oc-switch models list [--provider <name>]
oc-switch presets list

# Provider CRUD
oc-switch provider add <preset-id> --key <api-key> [--models model1,model2]
oc-switch provider edit <name> [--base-url <url>] [--key <api-key>]
oc-switch provider delete <name> [--force]

# 模型操作
oc-switch model add <provider>/<model-id...> [--alias <alias>]
oc-switch model remove <provider>/<model-id...>
oc-switch model enable <provider>/<model-id...>
oc-switch model disable <provider>/<model-id...>
oc-switch use <provider>/<model-id...>

# 同步
oc-switch provider sync <name>          # 从 provider models 端点拉取更新
oc-switch import                        # 从 openclaw.json 反向导入 preset
oc-switch diff                          # 预览当前配置 vs 上次备份

# 备份
oc-switch backup list
oc-switch backup restore <timestamp>
```

CLI 中所有 `<provider>/<model-id...>` 都按 `parseModelRef` 规则解析，只拆第一个 `/`。例如：

```bash
oc-switch use nvidia/deepseek-ai/deepseek-v4-flash
```

解析结果为 provider `nvidia`，modelId `deepseek-ai/deepseek-v4-flash`。

---

## 6. REST API 概要

所有端点需 `Authorization: Bearer <token>`。仅绑定 localhost 且 `serve` 未指定 token 时，可生成临时 token 并打印到终端；绑定 `0.0.0.0` 时必须显式配置 token。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/status` | 当前 primary、provider 概览 |
| GET | `/api/providers` | 列出所有 provider |
| POST | `/api/providers` | 从 preset 添加 provider |
| PUT | `/api/providers/:id` | 更新 provider |
| DELETE | `/api/providers/:id` | 删除 provider |
| POST | `/api/providers/:id/sync` | 从远端拉取模型列表 |
| GET | `/api/models` | 列出 allowlist 模型 |
| PUT | `/api/models/primary` | 设置 primary model，body: `{ "ref": "provider/model" }` |
| PATCH | `/api/models` | 启用/禁用 allowlist 条目，body: `{ "ref": "provider/model", "enabled": true }` |
| GET | `/api/presets` | 列出 preset |
| POST | `/api/presets/import` | 从配置反向导入 |
| POST | `/api/presets/export/:id` | 导出 preset |
| GET | `/api/backups` | 列出备份 |
| POST | `/api/backups/:id/restore` | 回滚 |
| GET | `/api/diff` | 预览变更 |

---

## 7. 安全与错误处理

### 7.1 远程访问安全

- 默认 bind `127.0.0.1`；`--host 0.0.0.0` 才对局域网/公网暴露
- Token 认证保护所有 API
- `--host 0.0.0.0` 时必须显式提供 `--token` 或已配置持久 token，否则拒绝启动
- 未指定 token 且仅绑定 localhost 时，可生成临时 token 并只打印一次到终端
- 支持 `oc-switch token rotate` 轮换持久 token
- 日志与 API 响应不得输出 API Key 明文
- 文档推荐 SSH 隧道或反向代理 + TLS，工具不内置证书

### 7.2 写入流程

```
1. 获取文件锁 ~/.oc-switch/write.lock
2. 读取 openclaw.json（JSON5 解析）与 .env
3. 记录写入前 hash / mtime，计算目标变更
4. 校验：语义 diff 不超出允许字段
5. 创建包含 openclaw.json + .env 的备份包
6. 写入临时文件（同目录 .tmp）
7. rename .env 临时文件，再 rename openclaw.json 临时文件
8. 任一步失败则从备份包 best-effort 回滚，并返回备份路径
9. 可选：执行 gateway restart 命令
10. 释放文件锁
```

JSON5 处理约定：

- 首版保证语义不修改非目标字段，但不承诺保留原始注释、空白和字段排版
- 写入前展示语义 diff；若检测到源文件包含注释，CLI/WebGUI 需提示“本次写入可能重格式化配置文件”
- 写入后再次解析并比较，只允许白名单路径发生变化
- 后续版本可引入 lossless patch 写入以保留注释和排版

### 7.3 错误场景

| 场景 | 处理 |
|------|------|
| `openclaw.json` 不存在 | 提示运行 `openclaw onboard` 或手动指定路径 |
| provider 名已存在 | 进入更新模式，WebGUI 弹窗确认覆盖范围 |
| 删除含 primary 的 provider | 警告，要求指定新 primary 或 `--force` |
| `.env` 写入失败 | 回滚整个写入事务，恢复 `openclaw.json` 与 `.env` |
| provider models 端点拉取失败 | 保留现有列表，提示手动编辑 |
| JSON5 解析失败 | 拒绝写入，建议从备份恢复 |
| `.env` 变量已存在但不归 oc-switch 管理 | 默认拒绝覆盖，提示用户确认接管或换变量名 |
| 写入前后 hash 变化 | 拒绝写入，提示配置被其他进程修改，请刷新后重试 |
| 文件锁超时 | 拒绝写入，提示已有 oc-switch 操作正在进行 |
| diff guard 发现非白名单字段变化 | 拒绝写入，并保留临时 diff 用于诊断 |

### 7.4 Provider Sync 兼容性

`provider sync` 首版按 API 类型分层处理：

| API 类型 | 首版行为 |
|----------|----------|
| `openai-completions` | 归一化 baseUrl 后请求 models 端点，避免重复 `/v1`，兼容 OpenAI list models 响应 |
| `anthropic-messages` | 默认不自动拉取，提示手动维护；后续可加 provider-specific adapter |
| `google-generative-ai` | 默认不自动拉取，提示手动维护；后续可加 provider-specific adapter |

sync 合并模型时只新增缺失模型，不删除已有模型；删除需由用户显式确认。

---

## 8. 技术栈

```
oc-switch/
├── packages/
│   ├── core/          # ConfigAdapter, EnvManager, BackupManager, PresetStore
│   ├── cli/           # Commander.js CLI
│   ├── server/        # Hono REST API
│   └── web/           # React + Vite + Tailwind
├── presets/
│   └── builtin/       # 内置 preset JSON
├── package.json       # Bun workspace monorepo
└── README.md
```

| 选型 | 理由 |
|------|------|
| TypeScript | 与 OpenClaw 生态一致，类型可复用 |
| Bun | 运行时 + 包管理 + 可选 compile 为单文件 |
| Hono | 轻量 REST API |
| React + Tailwind | 响应式 WebGUI，iPad 友好 |
| json5 | 读取 OpenClaw JSON5 配置；写入后做语义 diff guard |

---

## 9. 内置 Preset 初始清单

首版内置以下公益站/常用 provider 模板（从用户现有配置反向验证）：

| Preset ID | API 类型 | 说明 |
|-----------|----------|------|
| `elysiver` | openai-completions | Elysiver 公益站 |
| `cherryin` | openai-completions | Cherryin |
| `juya` | openai-completions | Juya Owl |
| `aitoolscfd` | openai-completions | AITools CFD |
| `nvidia` | openai-completions | NVIDIA NIM |
| `openrouter` | openai-completions | OpenRouter |
| `deepseek` | openai-completions | DeepSeek 官方 |
| `minimax-portal` | anthropic-messages | MiniMax |
| `cerebras` | openai-completions | Cerebras |
| `openai-compatible` | openai-completions | 通用 OpenAI 兼容模板 |

用户可通过 `oc-switch import` 从现有配置补充其余 provider。

---

## 10. 验收标准

- [ ] 能完整读取用户现有 12 个 provider 和 43 个 allowlist 模型
- [ ] 从 preset 添加 provider 后，`models.providers` 与 `agents.defaults.models` 同步正确
- [ ] API Key 统一写入 `.env`，JSON 保持 env 引用格式
- [ ] 写入前自动备份，回滚后配置与备份一致
- [ ] 写入不影响 `acp`、`channels` 等非目标字段
- [ ] WebGUI 在 iPad Safari 上可完成 provider 添加与模型切换
- [ ] CLI `oc-switch use` 与 WebGUI 切换 primary model 行为一致
- [ ] `oc-switch provider sync` 能从 OpenAI 兼容端点拉取模型列表
- [ ] 远程 VPS 上 `serve --host 0.0.0.0 --token` 可通过浏览器管理

### 10.1 Fixture 验收用例

首版测试至少包含以下 fixture：

- **slash-model-ref**：`nvidia/deepseek-ai/deepseek-v4-flash` 解析为 provider `nvidia` 与 modelId `deepseek-ai/deepseek-v4-flash`
- **case-sensitive-provider**：`DeepSeek` 与 `deepseek` 不能互相覆盖或 normalize
- **allowlist-value-preserve**：更新 alias 时保留 `agentRuntime` 与未知字段
- **provider-delete-scope**：删除 `nvidia` 只移除 provider 首段等于 `nvidia` 的 allowlist 条目
- **env-conflict**：管理块外已有同名 env var 时默认拒绝覆盖
- **transaction-rollback**：`.env` 或 JSON 写入失败后，`openclaw.json` 与 `.env` 均恢复到备份状态
- **json5-semantic-guard**：写入后只有 `models.providers.*`、`agents.defaults.models.*`、`agents.defaults.model` 发生语义变化
- **primary-delete-warning**：删除包含当前 primary 的 provider 时必须要求新 primary 或 `--force`
- **unauthorized-api**：未携带 token 的 REST 请求返回 401，且不泄漏配置内容
