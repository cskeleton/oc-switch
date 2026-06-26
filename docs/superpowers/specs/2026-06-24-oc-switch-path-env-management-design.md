# oc-switch Path and Env Management Design

> 日期：2026-06-24  
> 状态：待评审  
> 目标：为 oc-switch 增加 OpenClaw 配置路径管理与分层 `.env` 管理，支持即时切换目标文件，同时保持密钥明文不经 API/UI 暴露。

## 1. 背景

oc-switch 当前默认读取：

- `OPENCLAW_CONFIG_PATH` 或 `~/.openclaw/openclaw.json`
- `~/.openclaw/.env`
- `~/.oc-switch/` 作为状态、manifest 与备份目录

这对默认安装足够，但有两个缺口：

1. 用户可能有多个 OpenClaw 实例，或通过 `OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR` / system service 使用非默认路径。
2. 用户需要在 WebGUI 中管理 OpenClaw 强相关 `.env` 文件里的密钥，例如 Provider API Key、MCP EPID、工具 API Key 等，但不希望 oc-switch 暴露旧值明文或变成通用 `.env` 编辑器。

本设计补齐这两个能力。

## 2. 目标

- 设置页能展示并切换 `openclaw.json` 与当前 OpenClaw runtime `.env` 路径。
- 路径候选需要标注来源，默认选中运行中 OpenClaw 实例对应路径，但切换必须由用户确认。
- 用户确认切换后，当前 Web/CLI 后续操作立即使用新路径，并持久化到 `~/.oc-switch/settings.json`。
- `.env` 页面管理当前选中 OpenClaw 实例关联的 `.env` 文件。
- Provider 密钥作为常规区；其他 OpenClaw 强相关变量作为高级区。
- 不提供读取旧密钥明文的 API、UI、manifest 或日志能力。
- 非托管变量只有在用户通过 oc-switch 修改时才迁移进 `# oc-switch:start/end` 托管块。
- 备份与恢复必须记录并校验 `openclawPath` / `envPath`，避免路径切换后恢复到错误文件。

## 3. 非目标

- 不管理系统环境变量。
- 不管理工作目录 `.env`。OpenClaw 会读取工作目录 `.env`，但该来源是低信任来源，Provider credential 不应只放在那里。
- 不管理任意项目或 MCP 自己单独指定的 `.env` 文件。
- 不编辑 OpenClaw config `env` block；首版最多把它作为“非文件来源”提示，不纳入 `.env` 页面写入。
- 不在 WebGUI 显示、复制、下载旧密钥明文。
- 不提供完整 `.env` 明文编辑器。
- 首版不加密备份；先通过权限、不可下载、不可预览和清理能力降低风险。

## 4. 路径模型

### 4.1 当前路径

新增 oc-switch 自身设置文件：

```json
{
  "openclawPath": "/Users/gc/.openclaw/openclaw.json",
  "envPath": "/Users/gc/.openclaw/.env"
}
```

位置：`~/.oc-switch/settings.json`。

优先级：

1. 单次命令显式参数或环境变量，例如 `OPENCLAW_CONFIG_PATH`，用于脚本与测试覆盖。
2. oc-switch settings 中保存的 `openclawPath` / `envPath`。
3. OpenClaw 运行中实例发现结果。
4. OpenClaw 默认路径。

说明：

- `OPENCLAW_CONFIG_PATH` 只覆盖 `openclaw.json`，不自动决定 `.env`。
- `.env` 优先从运行实例或 state/config dir 推导。
- 若用户切换路径，Server 进程内的 active paths 立即更新；CLI 后续命令读取持久化 settings。

### 4.2 路径候选

设置页展示候选列表，每个候选带来源标签、存在状态、读写状态和推荐状态。

候选来源：

| 来源 | openclaw.json | .env | 说明 |
| --- | --- | --- | --- |
| 运行中 OpenClaw 实例 | 进程参数、进程环境、service metadata 或状态探测 | 运行实例 state/config dir 推导 | 能确定时默认选中 |
| OpenClaw 默认路径 | `~/.openclaw/openclaw.json` | `~/.openclaw/.env` | 标注为默认路径 |
| `OPENCLAW_STATE_DIR` | `$OPENCLAW_STATE_DIR/openclaw.json` | `$OPENCLAW_STATE_DIR/.env` | 仅当可发现该环境时出现 |
| oc-switch 当前设置 | `settings.json.openclawPath` | `settings.json.envPath` | 标注为当前配置 |
| 用户手动指定 | 用户输入 | 用户输入 | 标注为手动 |

候选展示示例：

- `/Users/gc/.openclaw/.env`（OpenClaw 默认路径）
- `/data/openclaw/.env`（运行中 OpenClaw 实例，推荐）
- `/custom/.env`（oc-switch 当前配置）
- `/other/.env`（手动指定）

如果候选无法确定运行中实例，设置页显示：

> 未能确认运行中 OpenClaw 使用的 env 文件。请选择候选路径，或向当前 OpenClaw 实例确认实际 runtime env 文件。

### 4.3 切换校验

切换前校验：

- `openclaw.json` 必须存在、是普通文件、可读取、可 JSON5 解析。
- `.env` 可不存在；若不存在，父目录必须存在且可写，或明确提示写入时无法创建。
- `.env` 存在时必须是普通文件，可读取；写入操作前还要确认可写。
- symlink 或权限异常需显示警告，首版可拒绝写入。

切换动作只更新 `~/.oc-switch/settings.json` 和 Server active paths，不改 OpenClaw 文件。

## 5. `.env` 管理范围

`.env` 页面只管理当前 active `envPath` 文件。页面顶部明确说明：

> 这里管理的是当前 OpenClaw 实例关联的 runtime `.env` 文件。想由 oc-switch 管理的 OpenClaw 相关 Key 可以放入这里；不想被 oc-switch 索引或管理的 Key 不应放入这个文件。

### 5.1 常规区：Provider 密钥

从 `openclaw.json` 收集：

- `models.providers.*.apiKey.id`
- `models.providers.*.authHeader.id`

每行展示：

- Provider ID
- env var 名
- 是否存在于当前 `.env`
- 是否在 oc-switch 托管块内
- 是否 orphan
- 最后更新时间
- 风险状态

允许操作：

- 重填/更新 Key
- 迁移到托管块
- 清理 orphan key

不允许操作：

- 查看旧值
- 复制旧值
- 从 API 获取旧值

### 5.2 高级区：额外托管变量

默认折叠。用于 MCP EPID、工具 API Key、搜索服务 Key 等 OpenClaw 强相关但非 Provider 的变量。

允许操作：

- 新增变量
- 重填变量
- 重命名托管变量
- 删除托管变量
- 将非托管变量迁移进 oc-switch 托管块

展示字段：

- 变量名
- 来源状态
- 是否托管
- 是否被 provider 引用
- 是否重复
- 是否复杂行
- 最后更新时间
- 用户备注或用途标签

不展示旧值明文。

## 6. `.env` 解析与状态

Core 需要解析当前 `.env` 文件，但返回给 Server/Web 的结果不包含 value。

变量状态：

| 状态 | 含义 |
| --- | --- |
| `managed` | 位于 `# oc-switch:start/end` 托管块内 |
| `unmanaged` | 位于当前 `.env` 文件中，但不在托管块内 |
| `providerRef` | 被 Provider `apiKey` 或 `authHeader` 引用 |
| `extraManaged` | 非 Provider 引用，但由 oc-switch 托管 |
| `missing` | 配置引用了变量，但 `.env` 中不存在 |
| `duplicate` | 同名变量在文件内出现多次 |
| `complex` | 行使用 `export`、行尾注释、复杂引号、变量引用或其他非标准形态 |
| `orphan` | manifest 记录为已删除 provider 的遗留变量 |

### 6.1 非托管变量迁移

规则：

- 只读取变量名和结构状态，不返回旧值。
- 如果用户不操作非托管变量，oc-switch 不移动、不重排、不写入。
- 如果用户通过 oc-switch 更新非托管变量，必须确认迁移到托管块。
- 迁移后，该变量写入为标准 `KEY=<新值>`。
- 原位置的旧行会被移除或按确定的迁移策略处理，避免同名变量继续冲突。

普通唯一变量确认文案：

> 该变量当前不在 oc-switch 托管区。更新后会迁移到 `# oc-switch:start/end`，以后由 oc-switch 管理；旧值不会显示。

复杂或重复变量确认文案：

> 该变量存在重复或复杂 `.env` 语法。迁移会写成标准 `KEY=<新值>`，可能改变 OpenClaw 对该变量的解析结果。如果不确定，请先确认当前 OpenClaw 实际读取规则后再继续。

## 7. 明文密钥安全边界

首版安全约束：

- `GET /api/env` 不返回 value。
- `POST /api/env/preview` 不接收或返回 value。
- `POST /api/env` 可接收新值，但响应不回显。
- manifest 不保存 value。
- 日志不记录 value。
- Web DOM 不渲染 value。
- 提交成功后前端清空输入框。
- 代码层面不提供读取具体值的函数给 API 层使用；读取函数仅限 provider sync 等现有后端内部调用，不暴露到 Web API。

说明：

- `.env` 文件本身和备份内 `.env` 必须包含明文，否则 OpenClaw 无法使用。
- 本设计不承诺密钥在本机文件系统中加密保存。

## 8. 备份与恢复

每次写入前继续创建备份。备份 metadata 必须路径感知：

```json
{
  "createdAt": "2026-06-24T00:00:00.000Z",
  "reason": "update env var SOME_MCP_EPID",
  "openclawPath": "/Users/gc/.openclaw/openclaw.json",
  "envPath": "/Users/gc/.openclaw/.env",
  "stateDir": "/Users/gc/.oc-switch",
  "pathSources": {
    "openclawPath": "running-instance",
    "envPath": "openclaw-default"
  },
  "beforeHash": "...",
  "sourceFiles": ["openclaw.json", ".env"]
}
```

权限要求：

- `~/.oc-switch` 目录尽量为 `0700`。
- `backups` 目录尽量为 `0700`。
- 备份内 `.env`、manifest、settings、token 文件尽量为 `0600`。
- 如果 chmod 失败，操作继续，但在设置页显示权限警告。

恢复规则：

- 默认恢复到备份 metadata 记录的原 `openclawPath` / `envPath`。
- 恢复前显示备份路径、当前 active 路径和是否一致。
- 如果当前路径与备份路径不一致，阻止一键恢复，要求用户选择：
  - 恢复到备份原路径
  - 明确恢复到当前选中路径
- 恢复前仍创建 safety backup，且记录当前路径。
- Web API 不提供下载或预览备份 `.env` 内容。

## 9. Core 设计

新增或扩展模块建议：

- `paths.ts`
  - `resolveOpenClawPathCandidates()`
  - `getActivePaths()`
  - `readOcSwitchSettings()`
  - `writeOcSwitchSettings()`
- `env-inspector.ts`
  - `inspectEnvFile(content, refs, manifest)`
  - 返回不含 value 的索引
- `env-manager.ts`
  - 保留现有 `updateManagedEnv`
  - 新增迁移非托管变量到 managed block 的操作
  - 新增删除、重命名、复杂状态识别
- `backup-manager.ts`
  - metadata 扩展路径来源与权限收紧
- `transaction-writer.ts`
  - 使用 active paths
  - env-only 写入也走事务与备份

Core 是唯一文件读写层。Server/Web 不直接读写本地文件。

## 10. Server API

新增端点：

### `GET /api/settings/paths`

返回：

- 当前 active paths
- 候选 openclaw paths
- 候选 env paths
- 推荐项
- 校验状态

不返回任何文件内容。

### `PUT /api/settings/paths`

请求：

```json
{
  "openclawPath": "/path/to/openclaw.json",
  "envPath": "/path/to/.env"
}
```

行为：

- 校验路径
- 写入 `~/.oc-switch/settings.json`
- 更新 Server active paths
- 后续请求立即使用新路径

### `GET /api/env`

返回 `.env` 索引：

- providerRefs
- managed variables
- unmanaged variables
- missing refs
- orphan variables
- duplicate/complex warnings

不返回 value。

### `POST /api/env/preview`

预览写入操作，不接收 value。

可预览：

- 新增
- 重填
- 重命名
- 删除
- 迁移

返回：

- affectedKeys
- requiresConfirmation
- warnings
- backupWillIncludeSecrets

### `POST /api/env`

提交写入。请求 body 可包含新 value，响应不得包含 value。

行为：

- 校验确认标记
- 创建备份
- 更新 `.env`
- 更新 manifest metadata
- 返回 `{ ok: true, backupId }`

## 11. Web 设计

### 11.1 设置页路径区域

显示：

- 当前 `openclaw.json`
- 当前 `.env`
- 候选列表
- 来源标签
- 推荐项
- 校验状态
- 切换按钮

用户确认后立即切换。

### 11.2 环境变量页或设置 Tab

首版可放在设置页 Tab，避免增加导航复杂度；若内容过多，再升级为独立导航页。

结构：

- 当前 envPath 和范围说明
- 安全提示：不显示旧值，备份包含密钥
- 常规区：Provider 密钥
- 高级区：额外托管变量，默认折叠
- orphan 清理入口
- 旧备份清理入口

所有涉及写入的操作都使用确认弹窗。

## 12. 错误处理

| 场景 | 行为 |
| --- | --- |
| 找不到 `openclaw.json` | 候选可展示，但不可切换为 active；提示初始化或手动指定 |
| JSON5 解析失败 | 禁止切换和写入 |
| `.env` 不存在 | 允许选择；写入前确认创建 |
| `.env` 父目录不可写 | 禁止写入 |
| 多个候选 `.env` | 展示全部，默认选中运行中实例，不静默切换 |
| 非托管变量同名冲突 | 默认不覆盖；修改时迁移进托管块 |
| 重复变量 | 强确认；建议不确定时先确认 OpenClaw 读取规则 |
| 复杂行 | 强确认；说明会标准化 |
| 备份路径与当前路径不同 | 恢复前阻止一键恢复，要求选择目标 |
| chmod 失败 | 操作继续，显示权限警告 |

## 13. 测试策略

### Core

- 路径候选发现覆盖默认、settings、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR`。
- active paths 优先级正确。
- settings 持久化为 `0600`。
- `inspectEnvFile` 不返回 value。
- managed/unmanaged/providerRef/missing/orphan/duplicate/complex 状态识别。
- 更新非托管变量时迁移到 managed block。
- 复杂变量需要确认。
- env-only 写入创建备份。
- backup metadata 记录 `openclawPath` 和 `envPath`。

### Server

- `GET /api/settings/paths` 不返回文件内容。
- `PUT /api/settings/paths` 切换后立即影响后续 `GET /api/providers`。
- `GET /api/env` 不返回明文。
- `POST /api/env/preview` 不接收明文。
- `POST /api/env` 不回显明文。
- 未确认复杂迁移返回 400。
- 备份路径不一致时 restore 需要显式目标。

### Web

- 候选路径展示来源标签和推荐项。
- 用户确认后切换路径。
- Provider 密钥常规区显示引用状态。
- 高级区默认折叠。
- 提交成功后密钥输入清空。
- 页面 DOM 不包含旧值或测试密钥。
- 复杂变量迁移弹出风险确认。

### E2E

- 路径切换后，Provider/Model 操作写入新 `openclaw.json`。
- 更新非托管 env 后，变量迁移到 managed block。
- 恢复备份时路径不一致会拦截。
- 响应 JSON、页面文本、测试日志不包含测试密钥值。

## 14. 验收标准

- 用户能看到当前 `openclaw.json` 与 `.env` 路径。
- 用户能从候选路径中选择并即时切换。
- 运行中实例路径与默认路径不一致时，页面能标注来源。
- 用户能更新 Provider API Key，但不能查看旧值。
- 用户能在高级区新增、重填、删除 OpenClaw `.env` 文件内的额外托管变量。
- 非托管变量只有被修改时才迁移进 managed block。
- 复杂变量迁移前有明确风险提示。
- 备份与恢复路径感知，不会把 `.env` 静默还原到错误位置。
- API 响应、manifest、日志、Web DOM 不暴露 `.env` 明文。
- 相关 `bun test`、`bun run typecheck`、Web 测试通过。

## 15. 后续可选增强

- 备份加密。
- 更完整地识别 OpenClaw config `env` block 与非 Provider SecretRef。
- 支持 service manager 深度探测 launchd/systemd 环境。
- 支持旧备份批量清理和敏感备份风险审计。
