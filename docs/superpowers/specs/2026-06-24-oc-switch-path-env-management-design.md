# oc-switch Path and Env Management Design

> 日期：2026-06-24  
> 状态：2026-07-14 路径探测增补待评审
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

- 设置页能展示并切换 `openclaw.json` 与当前 OpenClaw **管理源 `.env`** 路径，并将 Gateway 实际加载的 service env 作为只读运行时信息展示。
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

- `active` 表示当前实际读写路径，`recommended` 只表示建议切换的候选；已有 settings 时运行实例候选不得静默覆盖 active。
- 首次没有 settings 时，可按上述优先级把唯一且无冲突的 `confirmed` / `strong` 运行实例作为 active；`inferred` 只作为推荐候选，必须由用户确认。
- `OPENCLAW_CONFIG_PATH` 只覆盖 `openclaw.json`，不自动决定 `.env`。
- 管理源 `.env` 必须从运行实例的 state dir 推导；不得仅因 `openclaw.json` 位于某目录，就把同目录 `.env` 当作管理源。
- Gateway service env（Linux 的 `gateway.systemd.env`、macOS 的 `service-env/*.env`）是运行时快照，不得成为 active `envPath`。
- 若用户切换路径，Server 进程内的 active paths 立即更新；CLI 后续命令读取持久化 settings。

### 4.2 路径候选

设置页展示候选列表，每个候选带来源标签、存在状态、读写状态和推荐状态。

候选来源：

| 来源 | openclaw.json | .env | 说明 |
| --- | --- | --- | --- |
| 运行中 OpenClaw 实例 | 进程参数、进程环境、service metadata 或状态探测 | 运行实例 state dir 推导 | 能确定时默认选中；附带置信度与证据 |
| OpenClaw 默认路径 | `~/.openclaw/openclaw.json` | `~/.openclaw/.env` | 标注为默认路径 |
| `OPENCLAW_STATE_DIR` | `$OPENCLAW_STATE_DIR/openclaw.json` | `$OPENCLAW_STATE_DIR/.env` | 仅当可发现该环境时出现 |
| oc-switch 当前设置 | `settings.json.openclawPath` | `settings.json.envPath` | 标注为当前配置 |
| 用户手动指定 | 用户输入 | 用户输入 | 标注为手动 |

候选展示示例：

- `/Users/gc/.openclaw/.env`（OpenClaw 默认路径）
- `/data/openclaw/.env`（运行中 OpenClaw 实例，推荐）
- `/custom/.env`（oc-switch 当前配置）
- `/other/.env`（手动指定）

运行实例探测结果按置信度和失败阶段映射为以下 UI 状态：

| 状态 | UI 行为 |
| --- | --- |
| `confirmed` / `strong` | 显示“已确认管理源”，不显示警告 |
| `inferred` | 中性提示“由运行中 Gateway 与默认 state dir 推断”，不显示误导性警告 |
| `gateway-detected-path-unresolved` | 显示琥珀警告：检测到 Gateway，但无法确认其管理源 `.env` |
| `gateway-not-detected` | 显示中性提示“未检测到运行中的 Gateway”；不得暗示当前路径配置错误 |
| `probe-failed` | 显示“运行实例探测失败，当前路径未改变”；不得把失败等同于未运行 |

Gateway service env 路径若可发现，应作为只读信息展示：

> Gateway 进程加载：`gateway.systemd.env` / `service-env/*.env`。该文件由 oc-switch sync 维护，不作为 active `envPath` 直接编辑。

### 4.3 运行实例探测与置信度

运行实例探测采用跨平台证据流水线。各 probe 独立 best-effort；单个 probe 失败不得清空其他有效结果。

证据优先级从强到弱：

1. 显式 `OPENCLAW_CONFIG_PATH` / `OPENCLAW_STATE_DIR`。
2. macOS LaunchAgent 或 Linux systemd service metadata，并与运行 PID 关联。
3. 经过严格过滤的 Gateway 进程命令行与进程环境。
4. `openclaw gateway status --json`，仅在路径仍有歧义时作限时补充确认，不作为唯一依赖。
5. 已确认 Gateway 进程存在后，从默认 state dir 推断。

探测结果至少包含：

```ts
type RuntimeDiscoveryConfidence = "confirmed" | "strong" | "inferred";
type RuntimeDiscoveryStatus =
  | "resolved"
  | "gateway-detected-path-unresolved"
  | "gateway-not-detected"
  | "probe-failed";
type RuntimeDiscoveryEvidence =
  | "process-cmdline"
  | "process-environ"
  | "systemd-unit"
  | "launchd-plist"
  | "cli-status"
  | "default-state-dir";

interface RunningOpenClawInstance {
  instanceId: string;
  pid: number;
  openclawPath?: string;
  envPath?: string;
  stateDir?: string;
  serviceEnvPath?: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  confidence?: RuntimeDiscoveryConfidence;
  evidence: RuntimeDiscoveryEvidence[];
}

interface RuntimePathCandidateGroup {
  candidateId: string;
  instanceId: string;
  stateDir: string;
  openclawPath: string;
  envPath: string;
  serviceEnvPath?: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  pid: number;
  confidence?: RuntimeDiscoveryConfidence;
  evidence: RuntimeDiscoveryEvidence[];
}

interface RuntimeDiscoveryResult {
  status: RuntimeDiscoveryStatus;
  instances: RunningOpenClawInstance[];
  candidateGroups: RuntimePathCandidateGroup[];
  diagnostics: RuntimeDiscoveryDiagnosticCode[];
}
```

`status === "resolved"` 时 `instances` 至少包含一个路径已解析实例，且至少一个可推荐候选组必须携带符合下表最低证据的 `confidence`；其他状态的 unresolved / conflict metadata 不得携带 `confidence`。`instanceId` 优先由 `serviceManager + serviceId` 构成；无 service manager 的手动进程才退化为 `pid:<pid>`。

运行实例路径必须作为候选组返回（见上 `candidateGroups`），禁止只靠两个独立列表表达关联。

现有 `openclawPaths` / `envPaths` 与 `source: "running-instance"` 继续保留以兼容 API，但每项增加可选 `candidateId`。Web 选择运行实例候选时必须按组同时设置 config 与管理源 `.env`；手动模式仍可提交完整路径对，但不获得运行实例推荐标记。新增 runtime discovery 摘要用于 UI 展示置信度、证据与 service env。API 不返回 service env 内容、进程环境值或完整原始命令行。

置信度计算规则：

| 置信度 | 最低证据 |
| --- | --- |
| `confirmed` | `cli-status` 返回 daemon config 与 runtime PID，且与 PID 关联的 service metadata 一致；或 Gateway 进程环境中的显式 state/config 与 service ID、PID 一致 |
| `strong` | PID 关联的 systemd/launchd metadata 能确定 service env，并由显式路径变量或受支持的生成目录布局推导 state dir |
| `inferred` | 严格确认 Gateway command 后，仅由该用户默认 state dir 且可读的 `openclaw.json` 推导 |

任意同级或更强证据发生路径冲突时，不提升置信度；该实例进入 `gateway-detected-path-unresolved`，冲突路径只作非推荐候选展示。oc-switch 进程自身的 `OPENCLAW_*` 只属于 active path 覆盖，不得冒充 Gateway 进程证据。

#### 4.3.1 进程过滤

`pgrep -fl openclaw` 只负责提供候选 PID，不足以证明进程是 Gateway。仅接受命令参数 token 同时满足：

- 可执行入口指向 OpenClaw CLI（例如 `openclaw/dist/index.js`）；并且
- 子命令 token 为 `gateway`。

Codex app-server、embedding worker、路径中偶然包含 `openclaw` 的进程，以及探测命令自身必须排除。不得仅用命令行字符串包含关系触发默认路径推荐。

#### 4.3.2 Linux / systemd

Linux probe 按以下顺序合并证据：

1. 从 `/proc/<pid>/environ` 只提取路径与服务标识白名单：`HOME`、`OPENCLAW_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_PROFILE`、`OPENCLAW_SERVICE_MARKER`、`OPENCLAW_SERVICE_KIND`、`OPENCLAW_SYSTEMD_UNIT`。
2. 关联 systemd user unit 与 `MainPID`，解析 unit / service metadata 中的 `EnvironmentFile=`。
3. 若 service env 为 `<stateDir>/gateway.systemd.env`，可由其父目录推导 state dir。
4. `/proc` 无权限或 unit metadata 不完整时，保留其他 probe 结果；已严格确认 Gateway 且默认配置存在时，允许以 `inferred` 使用默认 state dir。

由 state dir 推导管理源 `<stateDir>/.env`；service env 仅记录为 `serviceEnvPath`。

#### 4.3.3 macOS / LaunchAgent

macOS probe 扫描当前用户 `~/Library/LaunchAgents/ai.openclaw.*.plist`，并通过 launchd runtime PID 与 Gateway 进程关联。默认 label 为 `ai.openclaw.gateway`，profile 可使用 `ai.openclaw.<profile>`。

LaunchAgent `ProgramArguments` 必须兼容 OpenClaw 已出现的两种生成布局：

```text
# 当前布局
/bin/sh, <stateDir>/service-env/*-env-wrapper.sh, <stateDir>/service-env/*.env, node, .../openclaw/dist/index.js, gateway, ...

# 旧布局
<stateDir>/service-env/*-env-wrapper.sh, <stateDir>/service-env/*.env, node, .../openclaw/dist/index.js, gateway, ...
```

解析器返回 wrapper、service env 与解包后的 Gateway command，并正确处理 plist XML entity。探测与 Gateway service env 同步必须复用同一解析器，禁止维护两套参数位置假设。

解析器必须拒绝：

- 参数不足；
- wrapper 不位于 `service-env` 或文件名不以 `-env-wrapper.sh` 结尾；
- env 不位于同一 `service-env` 目录或不以 `.env` 结尾；
- 解包后 command 不是 OpenClaw `gateway`；
- 同一 label 出现多个互相冲突的 wrapper/env 配对。

未加载或没有 runtime PID 的 plist 可生成普通非推荐路径候选，但不得标记为 `running-instance`。多个已加载 plist 必须分别形成候选组。

路径推导规则：

1. 只从 service env 内提取与 Linux 相同的路径/服务标识白名单，不向 API 暴露值。
2. 显式 `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` 优先。
3. 若 service env 位于 `<stateDir>/service-env/*.env`，由 `dirname(dirname(serviceEnvPath))` 推导 state dir。
4. 由 state dir 推导管理源 `<stateDir>/.env`；配置默认为 `<stateDir>/openclaw.json`。
5. `openclaw gateway status --json` 可补充验证 daemon config、PID 与 plist source path，但必须设置超时、输出上限并允许旧版本不支持。

#### 4.3.4 路径解析不变量

- `openclawPath` 与 state dir 独立解析；`dirname(openclawPath)/.env` 不是通用规则。
- `envPath` 始终表示 oc-switch 管理源，不表示 Gateway 直接加载的快照。
- `serviceEnvPath` 只读展示并用于 sync / drift；不得自动写入 settings 的 `envPath`。
- 多条证据指向同一路径时合并去重并提升置信度；证据冲突时保留多个候选，不静默覆盖用户 settings。
- 外部命令设置短超时与输出上限；返回结构化诊断枚举，不返回原始 stderr。
- 稳定诊断码至少包括：`process-probe-failed`、`process-environ-denied`、`service-metadata-missing`、`service-pid-mismatch`、`service-args-invalid`、`cli-status-timeout`、`cli-status-invalid`、`path-evidence-conflict`。

### 4.4 切换校验

切换前校验：

- `openclaw.json` 必须存在、是普通文件、可读取、可 JSON5 解析。
- `.env` 可不存在；若不存在，父目录必须存在且可写，或明确提示写入时无法创建。
- `.env` 存在时必须是普通文件，可读取；写入操作前还要确认可写。
- symlink 候选可只读展示，但拒绝切换为 active 和拒绝写入；权限异常显示明确错误。
- 若用户提交的 `envPath` 等于当前 discovery 中任一 `serviceEnvPath`，拒绝切换并说明应选择对应候选组的管理源 `.env`。

切换动作只更新 `~/.oc-switch/settings.json` 和 Server active paths，不改 OpenClaw 文件。

## 5. `.env` 管理范围

`.env` 页面只管理当前 active `envPath` 文件。页面顶部明确说明：

> 这里管理的是当前 OpenClaw 实例关联的管理源 `.env` 文件。想由 oc-switch 管理的 OpenClaw 相关 Key 可以放入这里；不想被 oc-switch 索引或管理的 Key 不应放入这个文件。Gateway 运行时使用的 service env 快照由 sync 维护，不在这里直接编辑。

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

### 6.2 Provider 写入路径统一迁移（2026-06-27 增补）

**问题**：Settings 环境变量页已支持非托管变量迁移确认，但 Provider 相关写入（`PUT /api/providers/:id`、`POST /api/providers`、`POST /api/providers/custom` 及 CLI `provider edit` / `provider add` / `provider add-custom`）仍直接调用 `writeOpenClawTransaction` + `updateManagedEnv`，遇到块外同名变量时抛出 `Refusing to overwrite unmanaged env var`，用户只能在 Settings 页绕行。

**原则**：凡是通过 oc-switch 写入 Provider API Key（即向 `.env` 写入 provider 引用的 env var），与 `POST /api/env` 遵循**同一套**迁移与确认规则；不得因入口不同而行为分裂。

#### Core

新增共享函数 `applyEnvUpdates(content, updates, options)`（或等价命名），供 `writeOpenClawTransaction` 与 `applyEnvOperation` 复用：

| 变量状态 | 无确认 | `confirmMigration: true` | `confirmComplex: true` |
| --- | --- | --- | --- |
| 不存在 / 已在托管块 | `updateManagedEnv` | 同左 | 同左 |
| 非托管（块外已存在） | 拒绝，错误：`env var migration requires confirmation` | `migrateEnvVarToManagedBlock` | 需同时满足 complex 规则 |
| 重复或 complex | 拒绝，错误：`complex env var requires confirmation` | 不单独解决 complex | `migrateEnvVarToManagedBlock`（标准化写入） |

`writeOpenClawTransaction` 的 `TransactionInput` 扩展：

```ts
envUpdates?: Record<string, string>;
envUpdateOptions?: {
  confirmMigration?: boolean;
  confirmComplex?: boolean;
};
```

`updateManagedEnv` 对非托管变量的硬拒绝保留，作为无确认时的最后一道防线；正常业务路径应在上层先校验并传入确认标记。

新增 `previewEnvUpdates(content, refs, manifest, updates)`（或基于现有 `inspectEnvFile` + `previewEnvOperation` 组合），返回与 `POST /api/env/preview` 一致的结构，供 Provider preview 端点复用。

#### Server API

以下写入端点接受可选确认字段（与 env API 对齐）：

- `PUT /api/providers/:id` — body 增加 `confirmMigration?`、`confirmComplex?`（当 `apiKey` 存在时生效）
- `POST /api/providers` — 同上（`apiKey` 必填场景）
- `POST /api/providers/custom` — 同上

新增或扩展 preview，在提交前让前端获知是否需要确认（**preview 不接收 apiKey 明文**）：

- `POST /api/providers/:id/preview` — body：`{ baseUrl? }`；若请求带 `includeApiKeyEnv: true`，仅根据 env var **名**检查迁移/complex 状态，返回 `envPreview`
- `POST /api/providers/custom/preview` — 在现有 config diff 上附加 `envPreview`（由 `apiKeyEnv` 推导）
- `POST /api/providers/preview`（preset add）— 同上，由 preset 的 `apiKeyEnv` 推导

`envPreview` 形状与 `POST /api/env/preview` 一致：

```json
{
  "affectedKeys": ["ELYSIVER_API_KEY"],
  "requiresConfirmation": true,
  "warnings": ["ELYSIVER_API_KEY will be migrated into the oc-switch managed block"],
  "backupWillIncludeSecrets": true
}
```

`GET /api/providers` 响应中每个 provider 增加只读元数据（不含 value）：

- `apiKeyEnv: string | null` — 从 `openclaw.json` 解析的 env 变量名
- `apiKeyEnvManaged: boolean` — 是否位于托管块
- `apiKeyEnvStatus: "managed" | "unmanaged" | "missing" | "complex" | "duplicate"` — 供列表与编辑弹窗展示

#### CLI

`provider add`、`provider add-custom`、`provider edit --key` 增加：

- `--confirm-migration` — 确认将非托管变量迁入托管块
- `--confirm-complex` — 确认标准化 complex/duplicate 行

未传确认且需要时，CLI 以明确错误退出并提示上述 flag，而非暴露 `Refusing to overwrite unmanaged env var` 内部措辞。

#### Web

**Providers 列表 / 编辑**

- 若 `apiKeyEnvStatus === "unmanaged"`，编辑弹窗内 API Key 输入区上方显示持久提示（琥珀色）：
  > `{apiKeyEnv}` 当前在 `.env` 托管块外。保存新 Key 时会迁入 `# oc-switch:start/end`；旧值不会显示。
- `complex` / `duplicate` 时追加风险提示（与 Settings 一致）。
- 用户填写 API Key 并点保存时：先 `preview`（`includeApiKeyEnv: true`），若 `requiresConfirmation` 则弹确认框，确认后带 `confirmMigration` / `confirmComplex` 提交 `PUT`。
- 仅改 `baseUrl`、不改 Key 时，不触发 env preview。

**添加 Provider（CustomProviderDialog）**

- 高级区展示 `apiKeyEnv` 时，根据 `getEnvIndex` 或 custom preview 的 `envPreview` 显示同样提示。
- 提交前 preview → 确认 → `POST /api/providers/custom` 带确认标记。

**预设添加（PresetsView，遗留入口）**

- 与 custom add 相同流程；保持行为一致直至该页移除。

**组件复用**

- 从 Settings 环境变量确认弹窗抽取共享 `EnvMigrationConfirmDialog`（或等价），文案与 6.1 节一致，避免三处复制。

#### 错误处理（增补）

| 场景 | 行为 |
| --- | --- |
| Provider 写入非托管 env，未传 `confirmMigration` | 400，`env var migration requires confirmation` |
| Provider 写入 complex env，未传 `confirmComplex` | 400，`complex env var requires confirmation` |
| 仅改 baseUrl | 不检查 env 迁移 |

## 7. 明文密钥安全边界

首版安全约束：

- `GET /api/env` 不返回 value。
- `POST /api/env/preview` 不接收或返回 value。
- `POST /api/env` 可接收新值，但响应不回显明文 value；成功时返回 `envWrite` 摘要（见 §7.1）。
- manifest 不保存 value。
- 日志不记录 value。
- Web DOM 不渲染 value。
- 提交成功后前端清空输入框。
- 代码层面不提供读取具体值的函数给 API 层使用；读取函数仅限 provider sync 等现有后端内部调用，不暴露到 Web API。

说明：

- `.env` 文件本身和备份内 `.env` 必须包含明文，否则 OpenClaw 无法使用。
- 本设计不承诺密钥在本机文件系统中加密保存。

### 7.1 写后校验反馈（2026-06-27 增补）

Provider and Settings env writes perform server-side write-after-read verification before returning success feedback. The server compares the managed-block value with the submitted value in memory and returns only `verified`, `envVar`, `managed`, and optional `maskedValue`; it never returns the plaintext key or the mismatched disk value.

- 校验仅读取 `# oc-switch:start/end` 托管块内的最终值。
- `maskedValue` 为可选短指纹（长度不足 16 时不返回），用于 Web 成功提示。
- 校验失败时事务回滚并返回错误响应；响应不含明文、不含磁盘上的错误值，也不把失败写入成功反馈。
- Web 成功文案必须基于 `envWrite.verified === true`，不得仅凭前端输入乐观展示「已写入」。

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
  "runtimeInstanceId": "launchd:ai.openclaw.gateway",
  "serviceEnvPath": "/Users/gc/.openclaw/service-env/ai.openclaw.gateway.env",
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
- `runtimeInstanceId` / `serviceEnvPath` 只记录路径关联，不保证恢复时目标仍有效；恢复同步前必须按当前 discovery 重新验证 PID、service ID 与候选组。
- Web API 不提供下载或预览备份 `.env` 内容。

## 9. Core 设计

新增或扩展模块建议：

- `paths.ts`
  - `resolveOpenClawPathCandidates()`
  - `getActivePaths()`
  - `readOcSwitchSettings()`
  - `writeOcSwitchSettings()`
- `path-discovery.ts`
  - 仅负责跨平台 probe 编排、证据合并、去重与置信度计算
- `path-discovery-linux.ts`
  - 严格 Gateway 进程识别、`/proc` 白名单环境读取、systemd unit/PID/EnvironmentFile 关联
- `path-discovery-macos.ts`
  - LaunchAgent 枚举、launchd PID 关联、state dir 与 service env 推导
- `gateway-launchd-metadata.ts`
  - 统一解析新旧 `ProgramArguments` wrapper 布局，供路径探测与 service env sync 复用
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
  - 接受可选 `runtimeDiscoveryProvider`；未传入时回退默认 `discoverOpenClawRuntime()`（仅供测试缺省与极端兜底，产品入口不得依赖此回退）
- `env-operations.ts` / `backup-manager.ts`
  - `applyEnvOperation`、`restoreBackupSafely` 同样接受并向下透传 `runtimeDiscoveryProvider`

Core 是唯一文件读写层。Server/Web 不直接读写本地文件。

**Discovery provider 透传（产品入口必须）**：`AppRuntime.runtimeDiscoveryProvider`（Server）与 `CommandContext.runtimeDiscovery` / 等价字段（CLI）须注入**所有**会触发自动 gateway sync 的写入路径，包括但不限于：

- `writeOpenClawTransaction`：providers / models / health repair 等路由与 CLI 命令
- `writeEnvTransaction` / `applyEnvOperation`：Settings env upsert/delete/rename
- `restoreBackupSafely`：备份恢复

禁止产品入口省略该参数、每次写入静默 fork 真实探测。测试可通过注入固定 `RuntimeDiscoveryResult` 快照验证 sync 关联，而不依赖本机 Gateway。

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
- 写后校验托管块内值与提交值一致（§7.1）
- 返回 `{ ok: true, backupId, envWrite? }`；`envWrite` 不含明文 value

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
| 检测到 Gateway 但无法推导 state dir | 保留当前 active paths；显示 `gateway-detected-path-unresolved`，不得把 service env 当作管理源 |
| 未检测到 Gateway | 展示默认/settings 候选与中性说明，不显示“路径错误”式警告 |
| 所有必要 probe 均执行失败 | 保留当前 active paths；显示 `probe-failed` 与稳定诊断码 |
| `/proc`、launchctl 或 systemd probe 无权限/失败 | 继续其他 probe；记录结构化 best-effort 诊断，不返回原始环境或 stderr |
| 多条证据路径冲突 | 展示多个候选及各自证据，不静默切换 active paths |
| config 与 env 来自不同运行实例候选组 | 禁止作为推荐切换；要求选择同一候选组或进入明确的手动路径模式 |
| `envPath` 指向已发现的 service env | 拒绝切换；提示该文件是运行时快照 |
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
- `OPENCLAW_CONFIG_PATH` 位于 state dir 外时，管理源仍为 `<stateDir>/.env`。
- 严格 Gateway token 过滤排除 Codex app-server、embedding worker、探测命令自身和普通路径命中。
- Linux 覆盖：无 `--config` 的 systemd Gateway、显式 state/config、`EnvironmentFile=`、profile unit、`/proc` 不可读与 PID 不匹配。
- Linux 自定义 `EnvironmentFile` 与 `<stateDir>/gateway.systemd.env` 不同时，只允许写 unit 实际关联目标。
- macOS 覆盖：`/bin/sh + wrapper + service-env` 当前布局、旧 wrapper 布局、默认/profile label、自定义 state dir、XML entity、service 未加载与 PID 不匹配。
- service env 与管理源 `.env` 分离；service env 不会进入 active `envPath`。
- 多证据合并、冲突候选、`confirmed` / `strong` / `inferred` 置信度正确。
- `resolved`、`gateway-detected-path-unresolved`、`gateway-not-detected`、`probe-failed` 判别状态及必填字段正确。
- 多实例候选保持 config/env/service-env 配对；不得跨实例组合或自动同步。
- 外部 CLI 补充 probe 超时、输出过大、无效 JSON、旧版本不支持时安全降级。
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
- `GET /api/settings/paths` 可返回不含密钥的 runtime discovery 摘要，并区分 `resolved`、`gateway-detected-path-unresolved`、`gateway-not-detected`、`probe-failed`；resolved 实例再携带 confidence。
- `GET /api/settings/paths` 覆盖 `strong` 与 `probe-failed`，运行实例候选项带同一 `candidateId`。
- `PUT /api/settings/paths` 对运行实例候选按组校验；拒绝把已发现的 service env 设为 active `envPath`。
- 响应不包含 service env 内容、进程环境值、完整原始命令行或 probe stderr。
- `PUT /api/settings/paths` 切换后立即影响后续 `GET /api/providers`。
- `GET /api/env` 不返回明文。
- `POST /api/env/preview` 不接收明文。
- `POST /api/env` 不回显明文。
- 未确认复杂迁移返回 400。
- 备份路径不一致时 restore 需要显式目标。
- gateway sync/apply/restart 在多实例时缺少或传入过期 `candidateId` 会拒绝执行，并按当前 discovery 重新验证目标。

### Web

- 候选路径展示来源标签和推荐项。
- 已确认与推断成功时不显示“未能确认 runtime env”警告。
- 推断路径显示中性证据文案；仅 unresolved 显示琥珀警告。
- service env 作为只读运行时快照展示，明确提示不得将其选作 active `envPath`。
- 选择运行实例时按候选组同时填充 config/env；手动模式明确标记为未验证配对。
- 用户确认后切换路径。
- Provider 密钥常规区显示引用状态。
- 高级区默认折叠。
- 提交成功后密钥输入清空。
- 页面 DOM 不包含旧值或测试密钥。
- 复杂变量迁移弹出风险确认。
- Providers 编辑/添加：非托管 `apiKeyEnv` 显示内联提示；保存 Key 前 preview 并弹迁移确认；确认后请求带 `confirmMigration`。
- `GET /api/providers` 返回 `apiKeyEnv` 与托管状态，列表或编辑入口可展示「块外」标记。

### E2E

- 路径切换后，Provider/Model 操作写入新 `openclaw.json`。
- 更新非托管 env 后，变量迁移到 managed block。
- 恢复备份时路径不一致会拦截。
- 两个运行实例并存时，选择 A 只会同步 A 的 service env，不修改 B。
- active 手动路径或恢复目标无法与当前候选组关联时，主写入/恢复成功但自动 sync 明确跳过。
- 已发现的 service env 不能被设置为 active `envPath`。
- 响应 JSON、页面文本、测试日志不包含测试密钥值。

## 14. 验收标准

- 用户能看到当前 `openclaw.json` 与 `.env` 路径。
- 用户能从候选路径中选择并即时切换。
- 运行中实例路径与默认路径不一致时，页面能标注来源。
- Linux systemd 与 macOS LaunchAgent 在没有 `--config` 参数时仍可正确发现管理源 `.env`。
- macOS 新旧 LaunchAgent wrapper 布局均可用于路径发现和 service env 同步。
- 自定义 `OPENCLAW_CONFIG_PATH` 不会错误改变管理源 `.env`。
- UI 能区分“已确认”“由默认 state dir 推断”“检测到 Gateway 但路径未解析”“未检测到 Gateway”。
- 多实例场景不会把一个实例的管理源同步到另一个实例的 service env。
- 自定义 systemd `EnvironmentFile` 不会被 canonical 路径猜测覆盖。
- 用户能更新 Provider API Key，但不能查看旧值。
- 从 Providers 页更新 API Key 时，非托管变量与 Settings 环境变量页行为一致（提示 + 确认 + 迁移），不再出现未解释的 `Refusing to overwrite unmanaged env var`。
- 用户能在高级区新增、重填、删除 OpenClaw `.env` 文件内的额外托管变量。
- 非托管变量只有被修改时才迁移进 managed block。
- 复杂变量迁移前有明确风险提示。
- 备份与恢复路径感知，不会把 `.env` 静默还原到错误位置。
- API 响应、manifest、日志、Web DOM 不暴露 `.env` 明文。
- 相关 `bun test`、`bun run typecheck`、Web 测试通过。

## 15. Gateway 服务环境同步

OpenClaw Gateway 作为系统服务运行时，**不会**直接读取 `.env` 全文，而是读取 OpenClaw 为当前平台生成的服务环境快照。oc-switch 写入的 Provider / 托管变量位于 `.env` 的 `# oc-switch:start` … `# oc-switch:end` 块内；Gateway 要生效须将这个托管块同步到当前平台对应的服务环境文件，再重启 Gateway。

oc-switch 必须自动识别运行平台并选择同步目标：

- Linux / systemd user service：同步到与 active 候选组、运行 PID 和 unit 明确关联的 `EnvironmentFile=`；不得仅按 `dirname(envPath)/gateway.systemd.env` 猜测目标。
- macOS / LaunchAgent：解析已发现并与运行实例关联的 `~/Library/LaunchAgents/ai.openclaw.*.plist`，同步到 OpenClaw wrapper 实际加载的 `service-env/*.env` 文件。
- 其他平台或无法发现服务环境文件：不创建猜测路径；手动 sync / apply 返回明确失败；自动 sync / restore 不阻断主写入，返回 `gatewayEnvSync.ok=false` 与 warning，引导用户检查 `openclaw gateway status` / `openclaw gateway install --force`。

自动 sync 前必须证明 active `envPath` 与目标 `serviceEnvPath` 属于同一 `RuntimePathCandidateGroup`。settings/手动路径、备份恢复目标或多实例候选无法建立唯一关联时，不执行自动 sync，不创建推测文件，并返回 `gatewayEnvSync.ok=false`。手动 sync/apply 必须要求用户选择或确认具体候选组。

**automatic 关联（事务 / 恢复后自动 sync）**：`resolveGatewayRuntimeTarget({ mode: "automatic" })` 按 active `openclawPath` + `envPath` 过滤候选组后，在**带非空 `serviceEnvPath` 的子集**中要求恰好一组：

- 0 个可同步组 → 不 sync（`no-matching-group` / `no-service-env`），主写入仍成功；
- 恰好 1 个可同步组 → 使用该组（即使另有仅路径匹配、无 `serviceEnvPath` 的组，也不视为歧义）；
- ≥2 个可同步组 → `ambiguous-match`，不 sync。

「唯一关联」指**唯一可同步目标**，不是「路径匹配组数必须为 1」。explicit 模式（手动 sync/restart/apply）仍按 `candidateId` 选定，多实例缺 id 时拒绝。

### 15.1 同步源与目标

| 项目 | 规则 |
| --- | --- |
| 同步源 | **仅** `.env` 中 oc-switch 托管块内的 `KEY=VALUE` |
| Linux 同步目标 | PID 关联 systemd unit 实际声明的 `EnvironmentFile=` |
| macOS 同步目标 | 由共享 LaunchAgent metadata 解析器识别的 `service-env/*.env`；当前布局为 `ProgramArguments[2]`，旧布局为 `[1]` |
| 合并策略 | 只替换目标服务 env 文件中的 oc-switch 托管块；目标文件块外内容（如 `HTTP_PROXY`、OpenClaw 生成的服务元变量）**原样保留** |
| 块外同名 Key | 不自动删除或改写；返回 warning，提示用户手动清理或迁移 |
| 删除/重命名 | 通过整体替换目标托管块移除旧 Key；块外同名 Key 仍保留并告警 |
| 块外 `.env` | **不读取、不同步** |
| 服务定义文件 | **不修改** systemd unit、LaunchAgent plist、`EnvironmentFile=` 或 `ProgramArguments` |

### 15.2 写入与安全

- 原子写：`gateway.systemd.env.tmp` → `rename`，mode `0600`。
- macOS 原子写：`service-env/<label>.env.tmp` → `rename`，mode `0600`；托管块使用 `export KEY='value'` 形式，value 按 POSIX 单引号规则转义，保证 wrapper 可 `source`。
- macOS 同步目标解析必须兼容 `/bin/sh + wrapper + service-env` 与旧 `wrapper + service-env` 两种布局，并与路径探测复用同一解析器。
- 每个 value 不得含 `\r`/`\n`；空值拒绝同步并报错。
- 若托管块 Key 不在 unit 内 `OPENCLAW_SERVICE_MANAGED_ENV_KEYS` 列表中，返回 **warning**（不阻断）；提示用户日后可 `openclaw gateway install` 更新列表。
- 若目标文件块外存在同名 Key，返回 **warning**（不阻断）；oc-switch 不越权改写块外内容。
- API / CLI / Web **不回显**密钥明文；sync 响应仅含 `syncedKeys`、`removedKeys`、`warnings`。

### 15.3 触发时机

1. **自动 sync（无重启）**：`transaction-writer` 在 `envWrite.verified === true` 且其他写入钩子成功之后，使用调用方注入的 `runtimeDiscoveryProvider`（写后重新 discovery，避免陈旧候选）解析唯一可同步目标，再调用 `syncManagedBlockToGatewayServiceEnv`（含 Provider Key 保存、Settings env upsert/delete/rename）；目标不可发现、关联不唯一或平台不支持时，主事务仍成功，响应附带 `gatewayEnvSync.ok=false` 与 warning。
2. **手动补救**：CLI `oc-switch gateway sync-env`、Web 设置页「同步并重启 Gateway」、REST `POST /api/gateway/*`；多实例时必须提供 `candidateId`，目标不可发现或平台不支持必须返回失败。
3. **备份恢复**：恢复 `openclaw.json` / `.env` 后，经注入的 `runtimeDiscoveryProvider` 重新验证；仅当恢复路径能与唯一可同步候选组关联时同步该组 service env，并返回 `gatewayRestartRequired: true`；无法关联时恢复结果仍成功，但不执行 sync，附带 `gatewayEnvSync.ok=false` 与 warning。
4. **重启**：`openclaw gateway restart`；**不默认静默自动重启**（会打断会话），由用户点「同步并重启」或单独「重启」。

### 15.4 API / CLI

| 方法 | 路径 / 命令 | 行为 |
| --- | --- | --- |
| `POST` | `/api/gateway/sync-env` | 手动 merge 托管块 → `candidateId` 关联的 service env |
| `POST` | `/api/gateway/restart` | 重启 `candidateId` 关联的 Gateway；单实例时可省略 |
| `POST` | `/api/gateway/apply` | 对同一 `candidateId` 执行 sync-env + restart |
| CLI | `oc-switch gateway sync-env` | 同 sync-env |
| CLI | `oc-switch gateway restart` | 同 restart |
| CLI | `oc-switch gateway apply` | 同 apply |

写入类 API 在 `envWrite` 之后可附带 `gatewayEnvSync`（自动 sync 结果，不含 value）。结果可包含 `targetKind`（`systemd` / `launchd`）与 `targetPath` 便于 UI 展示同步目标，但不得包含密钥值。备份恢复 API 成功时可附带 `gatewayEnvSync` 与 `gatewayRestartRequired: true`。

### 15.5 Web UI

- `envWrite.verified` 成功后展示 `GatewayApplyBanner`：说明 Gateway 使用平台服务环境文件；若已自动 sync 则提示「已同步，待重启」，主按钮为「重启 Gateway」或「同步并重启 Gateway」。
- `formatEnvWriteSuccess` 按结果分支：自动 sync 成功时只提示“下一步：重启 Gateway”；sync 未执行或失败时提示“下一步：确认目标并同步/重启 Gateway”。
- 设置 / 通用 Tab 提供手动 `apply` 入口。

### 15.6 明确不做（本阶段）

- 不将 `EnvironmentFile=` 改指向 `.env`。
- 不修改 LaunchAgent plist 的 `ProgramArguments`。
- 不同步 `.env` 块外内容；不整文件覆盖 systemd / launchd 服务 env。
- 不调用 `openclaw secrets configure --apply`。
- 不在用户未确认时静默重启 Gateway。

## 16. 后续可选增强

- 备份加密。
- 更完整地识别 OpenClaw config `env` block 与非 Provider SecretRef。
- 增加 `GET /api/gateway/env-drift`，比较管理源托管块与已发现的 service env；路径深度探测已纳入 §4.3。
- 支持旧备份批量清理和敏感备份风险审计。
