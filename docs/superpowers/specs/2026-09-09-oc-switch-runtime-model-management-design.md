# oc-switch OpenClaw 运行时 Provider / 模型协调管理设计

日期：2026-09-09（2026-09-11 续审修正）  
状态：续审修复完成；隔离全量验证、本机及claw新CLI只读对账通过，未部署。详细证据与限制见 §17。

本轮发现并修正了策略入口、运行时写入门禁、真实 CLI `available:null`、插件影响面、事务新鲜度、最小写入和测试隔离问题。`available:false` 不再无依据地推断为 Provider 拒绝；缺失占位不再伪装成目录项。手机 Policy 表被挤窄的问题已修复，并通过 ID/状态/操作同屏与实际尺寸验收。

## 1. 背景

oc-switch 当前用三个来源组装 Provider / 模型列表：

1. `openclaw.json` 的 `models.providers`；
2. OpenClaw 插件 manifest 的静态 `modelCatalog`；
3. `agents.defaults.models` 的传统 metadata 引用。

OpenClaw 2026.9.3 的 Telegram `/models` / `/model` 交互与 `openclaw models status` 则基于 Prepared Model Catalog、插件运行时目录、认证/路由可见性、当前 Agent 配置和 `agents.defaults.modelPolicy.allow` 共同计算。两边目录来源不同，导致以下问题：

- 只存在于 OpenClaw 运行时 shard 的插件模型可在 Telegram 中出现，但 oc-switch 不显示；
- `modelPolicy.allow` 中的精确引用即使目录不存在，仍可进入 OpenClaw 的 `allowed` 集合或交互选择入口；
- oc-switch 没有完整展示或管理 policy-only 精确条目、零命中通配条目；
- 插件停用、policy 未允许、目录缺失和认证/路由不可用被混为同一个“禁用”状态；
- 用户选择实际不可用模型后，OpenClaw 才返回“模型已改名、下架或账户不可用，需要更新配置”的运行时错误。

本设计将 OpenClaw 运行时事实与 oc-switch 的安全写入能力合并，让用户在操作前看到同一模型的**来源、策略、插件状态与运行可用性**，并显式决定补全配置、替换模型、删除引用或保留。

## 2. 设计目标

1. oc-switch 能对账当前 Agent 的 OpenClaw 实际 allowed 集合和模型目录。
2. 所有 policy-only 模型引用必须可见，不再因缺少目录而从 UI 消失。
3. “策略允许”和“运行可用”严格分离；策略允许但不可用的模型单独列出。
4. config Provider、插件 Provider、运行时目录贡献和仅引用条目保留来源信息，不互相伪装。
5. Web 与 CLI 使用同一协调结果和同一 Core 写入规则。
6. 支持已安装、且贡献模型 Provider 的插件启停；一个插件可贡献多个 Provider。
7. 所有破坏性操作继续自动备份、受 diff guard 保护，并遵守主模型、fallback 与 wildcard 的 fail-closed 规则。
8. 探测失败必须标为 `unknown`，不得把未知误判为不可用，更不得据此批量清理。

## 3. 非目标

- 不安装、卸载或升级 OpenClaw 插件。
- 不直接读取或写入 Agent SQLite 中的密钥值。
- 不由 oc-switch 自动删除认证 Profile。
- 不把插件或运行时模型伪造为 `models.providers` 条目。
- 不自动修复、展开或删除用户拥有的 wildcard policy。
- 不保证本机与 SSH `claw` 的目录天然一致；两端按各自安装、认证与运行时状态独立计算。
- 不管理 `agents.entries.*.modelPolicy.allow`；本期范围仍为 `agents.defaults`。
- 不让 CLI 强制依赖常驻 Server。

## 4. 架构

### 4.1 调用关系

```text
Web ──HTTP──> Server ──┐
                      ├──> 共享模型协调层 ──> Core 安全写入
CLI ──────────────────┘           │
                                  └──> OpenClaw CLI 只读探测
```

- Web 是浏览器入口，经 Server 完成鉴权、HTTP 输入校验和 DTO 输出。
- CLI 是本地受信入口，直接调用共享模块；`oc-switch serve` 未启动时仍可工作。
- Server 与 CLI 不复制业务判断，必须调用同一协调层与 Core operation。
- Core 仍是 `openclaw.json`、`.env`、`provider-states.json` 的唯一 writer。
- OpenClaw CLI 仅提供运行时事实，不作为 oc-switch 配置写入通道。

### 4.2 新模块边界

建议新增以下 Core 模块：

1. `runtime-model-catalog.ts`
   - 运行只读 OpenClaw 命令；
   - 解析并脱敏成稳定的内部 snapshot；
   - 记录版本、时间和 diagnostics；
   - 支持依赖注入，测试不得调用开发机真实 OpenClaw。

2. `model-inventory.ts`
   - 合并 config、插件、运行时和引用来源；
   - 计算 Provider / model 的策略与可用性；
   - 只做纯计算，不写文件、不 shell-out。

3. `operations/plugin-state.ts`
   - 管理已安装、贡献模型 Provider 的插件 `enabled`；
   - 做主模型、fallback、policy 影响预检；
   - 经既有事务、备份与 diff guard 落盘。

4. `operations/model-reconciliation.ts`
   - 删除 policy-only 精确引用；
   - 可选清理对应 legacy metadata；
   - 为已有 config Provider 补入可验证的模型目录项；
   - Provider 不存在时返回结构化的“需要用户补充字段”，不猜 baseUrl/API。

## 5. 运行时探测

### 5.1 命令与用途

每次 snapshot 至少组合：

- `openclaw --version`：版本与兼容性诊断；
- `openclaw models status --json`：当前 Agent、默认模型、fallback、expanded `allowed`；
- `openclaw models list --json`：当前配置/可见目录及 `available`、`missing`、tags；
- `openclaw models list --all --json`：完整可发现目录，用于判定精确引用是否有已知 catalog entry；
- 既有 `openclaw plugins list --json`：插件 ID、启停状态、Provider 归属和 manifest 路径。

不得将 `models status` 的原始 auth 内容透传、缓存或写日志。只保留本功能需要的非敏感字段。

### 5.2 超时与缓存

- 单次命令默认 8 秒超时，输出上限沿用插件发现的防护模式。
- Server 可缓存 snapshot 30 秒，手动刷新同时重建插件与模型来源；缓存绑定所选 config/env 路径及文件版本，不能跨路径复用。
- CLI 默认每次新建 snapshot；同一命令执行内复用。
- 任一命令失败时保留其余成功来源，diagnostics 指明缺失边界。
- 只有 snapshot 完整覆盖某一判断所需来源时，才能产生 `available` 或 `unavailable`；证据不足必须是 `unknown`。

## 6. 统一数据模型

### 6.1 ModelInventoryEntry

```ts
type ModelCatalogSource = "config" | "plugin-manifest" | "openclaw-runtime";
type ModelReferenceSource = "primary" | "fallback" | "legacy-metadata" | "policy-exact" | "policy-wildcard";
type ModelAvailability = "available" | "unavailable" | "unknown";
type ModelAvailabilityReason =
  | "plugin-disabled"
  | "provider-not-found"
  | "model-not-in-catalog"
  | "missing-auth"
  | "route-incompatible"
  | "provider-rejected"
  | "probe-failed";

interface ModelInventoryEntry {
  ref: string;
  providerId: string;
  modelId: string;
  catalogSources: ModelCatalogSource[];
  referenceSources: ModelReferenceSource[];
  policyMode: "legacy" | "unrestricted" | "restricted";
  selectionSource?: "legacy" | "unrestricted" | "policy-exact" | "policy-wildcard";
  policyAllowed: boolean;
  availability: ModelAvailability;
  availabilityReasons: ModelAvailabilityReason[];
  pluginIds: string[];
  capabilities: {
    canTogglePolicy: boolean;
    canSetPrimary: boolean;
    canEditCatalogEntry: boolean;
    canMaterializeConfigModel: boolean;
    canRemovePolicyExactRef: boolean;
  };
}
```

数组字段必须去重且稳定排序。`policyAllowed` 与 `availability` 不得合并为一个 boolean。

### 6.2 ProviderInventoryEntry

Provider 的 `source` 不再承担所有来源信息，改为 `sources[]`，并增加：

- `pluginIds[]`：支持一个 Provider 多插件来源及一个插件多 Provider；
- `pluginEnabled`：`true | false | null`，`null` 表示非插件或无法确认；
- `availability` 与 reasons；
- `modelCount`、`policyAllowedModelCount`、`availableModelCount`、`unavailableModelCount`；
- capability flags，决定哪些操作可显示或执行。

“policy 里出现 providerId”不自动把它认定为可用 Provider；没有目录的归入“未解析引用”分组。

## 7. 协调规则

### 7.1 候选集合

最终 inventory 是以下集合的并集：

- config Provider 模型；
- 插件 manifest 模型；
- OpenClaw 当前及完整目录模型；
- `modelPolicy.allow` 中的 exact refs；
- `agents.defaults.models` refs；
- 主模型与合法 fallback refs。

wildcard 不是模型行，只作为规则展示；只有它实际覆盖目录模型时才给模型添加 `policy-wildcard` 来源。

### 7.2 可用性

- OpenClaw 当前列表明确给出 `available=true` 且未 missing：`available`；当前列表的显式否定不能被完整目录的正向标记覆盖。
- exact ref 不在当前或完整 catalog，且探测完整：`unavailable/model-not-in-catalog`。
- 插件明确 `enabled=false`：该插件贡献的模型为 `unavailable/plugin-disabled`。
- Provider 明确不存在且 exact policy ref 仍存在：`unavailable/provider-not-found`。
- OpenClaw 返回可安全映射的认证、路由或 Provider 拒绝事实时，追加对应 reason。仅有 `available:false` 时原因可以为空，不猜测“Provider 拒绝”。当前 CLI 未提供足够细分事实时，不通过读取 auth 原文补充原因。
- 当前 OpenClaw 的 `available:null` 是合法的“未确认”：保留目录行、归一为该行 `unknown/probe-failed`，不使整个 snapshot 失效。`missing:true` 是引用占位，不是 catalog membership，不参与 wildcard/unrestricted 目录展开。
- CLI 缺失、超时、JSON 不兼容或目录 snapshot 非 authoritative：`unknown/probe-failed`，不得推断 unavailable。

`openclaw models status.allowed` 仅证明策略层允许，不证明模型可调用。

### 7.3 同名与来源冲突

- 同一逻辑 `provider/model` 合并为一行，保留全部 `catalogSources`。
- config 与插件同名时，不再用 config 遮蔽插件模型成员资格；展示 OpenClaw 实际并集。
- 只有 config 来源的模型定义可直接编辑/删除。
- 插件或 runtime-only 模型可管理 policy 和主模型，但目录定义只读。
- runtime-only 模型只有在 OpenClaw 明确可用时才能直接启用或设主模型。

## 8. 不可用与待处理模型

Models 页新增独立区段“不可用与待处理”，默认按严重性排序：

1. 当前主模型不可用；
2. fallback 不可用；
3. policy 精确允许但不可用；
4. legacy metadata 悬空；
5. 零命中 wildcard；
6. 探测未知。

每行同时显示：ref、引用来源、目录来源、策略、插件状态、可用性和原因。

### 8.1 用户操作

1. **补全配置**
   - Provider 已存在且有可靠 runtime metadata：预览后将模型补入 config Provider；
   - Provider 不存在：打开 Custom Provider 向导，预填 providerId/modelId；baseUrl、API、密钥引用必须由用户提供或确认；
   - 插件模型已下架：不提供“伪造为 config”快捷操作。

2. **换成其他模型**
   - 主模型/fallback 命中时优先提供；
   - 主模型切换走 `primary-model.ts`，保留对象形状、fallback 与未知键。

3. **删除引用**
   - 默认只删除 `modelPolicy.allow` 的 exact ref；
   - 不删除 wildcard；
   - 删除最后一条 restricted policy 会变为 `[]` unrestricted 时 fail closed；
   - 同时存在 metadata 时作为独立复选项，默认不勾选；
   - 认证 Profile 只提示存在，不由本操作删除。

4. **保留**
   - 不修改配置；允许用户等待 Provider 恢复或后续补全。

## 9. 插件启停

### 9.1 范围

只管理“已安装且至少贡献一个模型 Provider”的插件。非模型插件、安装、卸载、升级均不纳入。

截图中的本机真实关系应显示为一个插件组：

```text
插件 @openclaw/xiaomi-provider（pluginId=xiaomi，当前 disabled）
├── Provider xiaomi（2 models）
└── Provider xiaomi-token-plan（2 models）
```

不能把 `xiaomi` 与 `xiaomi-token-plan` 误显示成两个独立插件。

### 9.2 写入语义

- 启用：设置 `plugins.entries.<pluginId>.enabled=true`；
- 停用：设置 `plugins.entries.<pluginId>.enabled=false`；
- 无显式 entry、依赖 `enabledByDefault` 的已安装插件，用户主动停用时允许创建最小 `{ enabled: false }`；
- 不改 entry 的其他字段；
- diff guard 只允许确放行该插件的 `enabled` 键位；
- 每次写入自动备份。

### 9.3 安全预检

停用前必须列出受影响的所有 Provider 和模型，并检查：

- 当前主模型：阻止停用，要求先切换；
- 合法 fallback：阻止停用，要求先处理；
- policy exact/wildcard：默认保留并提示停用后将成为不可用项；
- 插件同时贡献工具、频道或 hooks：确认框显示插件级影响，不能描述为“只关闭模型”。

插件启停不自动改 policy。重新启用后原有 selection 应自然恢复。

### 9.4 生效确认

写入后重新运行插件与模型探测：

- 新状态已被 OpenClaw CLI 观察到：成功；
- 配置已写但运行时未更新：返回“待应用/重启”，提供既有 Gateway apply/restart 操作；
- 探测失败：写入结果与运行确认分开报告，不伪装为完全成功。

## 10. API 与 CLI

### 10.1 Server API

建议新增：

- `GET /api/model-inventory`：统一 Provider / 模型、规则与 diagnostics；
- `POST /api/model-inventory/refresh`：强制刷新运行时 snapshot；
- `PATCH /api/plugins/:pluginId/state`：显式启停模型插件；
- `DELETE /api/model-policy/exact-ref`：只删除一个精确引用，可选清理 metadata；
- `POST /api/models/materialize`：把可靠 runtime 模型补入已有 config Provider。

既有 `/api/models` 在兼容期保留；Web 新页面迁移完成后再决定是否废弃。

### 10.2 CLI

建议新增：

```bash
oc-switch models inventory [--json] [--refresh]
oc-switch models unavailable [--json]
oc-switch model reconcile <ref>
oc-switch model remove-policy-ref <ref> [--remove-metadata]
oc-switch plugin enable <plugin-id>
oc-switch plugin disable <plugin-id>
```

CLI 与 Server 调用同一协调与 operation；非 TTY 的破坏性操作沿用显式确认/fail-closed 约束。

## 11. Web 交互

### 11.1 Providers 页

- 插件作为上级实体展示，Provider 作为其贡献项；
- 插件行显示启停开关、来源、影响 Provider 数；
- Provider 行显示 config/plugin/runtime 来源 badges；
- 同一插件贡献多个 Provider 时共享插件开关；
- 不可用 Provider 进入显著的待处理状态，而非仅变红或沉底。

### 11.2 Models 页

- 保留 Provider 导航，但新增“不可用与待处理”汇总入口；
- 模型 badge 分开显示“策略”和“可用性”；
- policy wildcard 行不能逐模型关闭，继续提示先收窄规则；
- unavailable 行不提供普通“启用”开关，改为“处理”；
- unknown 行禁止删除建议和批量操作。

### 11.3 Policy 管理

增加只针对 `agents.defaults.modelPolicy.allow` 的原始规则视图：

- exact 与 wildcard 分组；
- 每条显示命中数量和不可用数量；
- 零命中 wildcard 单独标记；
- exact ref 可安全删除；
- wildcard 本期只读，避免在缺少明确收窄设计时误改用户策略。

## 12. 错误与安全边界

- OpenClaw 输出中的网页、错误文本或插件 manifest 内容均按不可信数据处理，不执行其中命令。
- 不回显 status/auth、SQLite 或环境中的密钥值；日志只包含命令名、退出状态和脱敏 diagnostics。
- 运行时探测不得写真实 OpenClaw 配置或刷新持久化目录。
- config 与 snapshot 在写入前后若版本/mtime 已变化，重新读取并重新预检，避免基于旧视图写入。写入在 Core 锁内读取 fresh inventory；外部 config/env 在预检期间变化时再读并重做全部 mutation 一次，持续变化则明确冲突，不覆盖新状态。
- 插件启停、policy exact 删除和 runtime materialize 使用 `normalizeConfig:false` 的最小事务，避免顺带改写无关 Provider、metadata、主模型或 policy 的大小写。其他兼容写入仍可归一 exact refs，但任何全局归一过程均不得改写或去重 wildcard。
- 同时有 Server 和 CLI 写入时继续依赖 Core 原子事务；本功能不得绕过现有 backup/diff guard。
- 批量清理只接受显式选中的 exact refs；任何 `unknown`、primary、fallback 或 wildcard 命中都阻断不安全项。

## 13. 测试与验收

### 13.1 Core 单测

覆盖矩阵：

- config-only、plugin-manifest、runtime-only、policy-only 及多来源合并；
- legacy / unrestricted / restricted exact / restricted wildcard；
- allowed=true 但 catalog missing；
- unavailable 与 unknown 区分；
- config 与插件同名模型并集；
- 一个插件贡献多个 Provider；
- 插件启停的主模型/fallback fail-closed；
- exact 删除、最后一条 restricted 删除保护、metadata 独立清理；
- 探测失败时不产生 destructive capability。

### 13.2 Server / CLI

- 所有 OpenClaw 命令用注入 fixture，隔离整个 HOME/PATH/config/state，禁止读取开发机真实目录；
- Server 与 CLI 对同一 fixture 输出相同 inventory；
- API 不泄露 auth/status 原始字段；
- plugin state 只修改一个 `enabled` 键；
- CLI 非 TTY 无确认参数时 fail closed。

### 13.3 Web

- 策略 badge 与可用性 badge 不混用；
- unavailable、unknown、plugin-disabled 操作能力正确；
- 多 Provider 共用一个插件开关；
- 主模型/fallback 阻断文案；
- 表格在桌面与移动端无 body 横向溢出；Policy 表另测自身 `scrollWidth <= clientWidth`，手机必须同时可读规则 ID/命中状态/操作，不能仅用 body 不溢出掩盖列被挤窄。

### 13.4 Acceptance

使用 `mkdtemp` 隔离 HOME、config、state、备份、`.env` 和 fake `openclaw`：

1. 构造 Telegram/`status.allowed` 中存在但静态目录缺失的 exact ref；
2. oc-switch 必须将其显示为 policy-only + unavailable；
3. 删除 exact ref 后重新探测，条目从 allowed 与待处理集合消失；
4. 构造 `xiaomi` 插件贡献 `xiaomi`、`xiaomi-token-plan` 两个 Provider；
5. 启停一次插件，验证两个 Provider 同步变化且 policy 原样保留；
6. 让运行时探测超时，验证状态为 unknown，所有清理操作被禁用；
7. 全程检查输出与备份不含密钥值。

真机最终只读对账：

- 本机与 `ssh claw` 分别比较 oc-switch inventory、`openclaw models status --json` 的 allowed 和模型列表；
- 对每个差异都能解释为明确来源/状态，不允许模型无声消失；
- 真实写入验证只在用户明确授权后执行，并在测试后核对备份与 Gateway 状态。

## 14. 迁移与兼容

- 保留现有 `/api/models`、`ProviderSummary.source` 和 Web 入口作为兼容层；
- 新 inventory DTO 先供新页面使用，稳定后再移除旧的 config-adapter 聚合职责；
- 既有 plugin provider v1 的 config 优先遮蔽规则由新 inventory 并集取代，但写权限仍按来源限制；
- `StatusSummary.effectiveModelCount` 的旧语义在迁移期保留，同时新增 inventory 的 available/allowed 计数，避免静默改坏现有消费者；
- OpenClaw CLI schema 不兼容时自动降级到静态视图 + unknown diagnostics，不阻断既有 Provider 编辑能力。

## 15. 实施顺序

1. 运行时探测与纯协调模型；
2. Core 单测和 fixture；
3. Server/CLI 统一 inventory 读取；
4. 不可用模型与 policy exact 安全处理；
5. 插件分组和启停 operation；
6. Web Provider/Models/Policy UI；
7. acceptance 与本机/`claw` 只读 Sync Audit；
8. 更新插件 Provider 旧 spec 的 v2 状态与 README/AGENTS 摘要。

## 16. 已确认决策

- 采用“OpenClaw 运行时只读事实 + oc-switch Core 唯一写入”的混合权威源。
- Web 经 Server、CLI 直接调用共享模块，不强制 CLI 依赖 Server。
- 不可用模型必须单独标记，由用户决定补全、替换、删除引用或保留。
- 删除引用默认只删 policy exact；metadata 与认证 Profile 独立处理，默认不连带删除。
- 模型插件启停纳入范围；插件状态、模型策略与运行可用性是三个独立维度。
- 一个插件贡献多个 Provider 时只提供一个插件级开关，并完整提示非模型能力影响。

## 17. Sync Audit（2026-09-11，续审后重新核验）

此前实现与首次绿测没有覆盖真实 CLI nullable 字段、写入旁路、最小写入和手机列挤压。本节以本轮当前代码、失败复现、全量测试及真机只读结果替换旧的通过声明。

### 17.1 规格与实际证据

| 章节 / review gate | 结果 | 当前证据 |
|---|---|---|
| §1–3 背景、目标、非目标 | 完成 | Core 是唯一 writer；不安装插件、不读 SQLite/认证原文、不管理 per-agent policy，不要求 CLI 连接 Server |
| §4 架构 / Gate 1 | 完成 | `runtime-model-catalog.ts` 只读探测，`model-inventory.ts` 纯计算；Server 与 CLI 共用 inventory 和 Core operations |
| §5 探测与缓存 / Gate 1 | 完成 | 固定四命令、8s 超时、1MiB 输出上限、逐命令脱敏错误；接受合法 `available:null`，坏行使来源不完整；30s 缓存绑定 config/env 文件版本和所选路径，refresh 重建两种目录 |
| §6 DTO / Gate 1 | 完成 | policy / plugin / availability 分维；summary/来源/规则/能力来自统一计算；acceptance 比较整个 Server/CLI inventory，而非只比较 ref 列表 |
| §7 协调 / Gate 1 | 完成 | 多来源并集、运行时独有模型、大小写归一身份；`missing:true` 占位不算目录，不参与 wildcard/unrestricted 展开；当前列表否定优先，不虚构拒绝原因 |
| §8 引用协调 / Gate 2 | 完成 | exact-only 默认保留 metadata；独立复选清理；最后 exact、wildcard、primary/fallback、unknown 阻断；available runtime 仅补入已存在 config Provider，100模型限制仍生效 |
| §9 插件 / Gate 2 | 完成 | 一插件多 Provider；当前发现的 descriptor 与完整诊断门禁；只改指定 `enabled`，不顺带归一配置；真实 `toolNames`/`hookCount`/各类 `*ProviderIds` 的非模型影响完整归类；写后核对实际 enabled |
| §10 API/CLI / Gate 3 | 完成 | 五个新端点与 inventory/unavailable/reconcile/remove-policy-ref/plugin 命令；新旧写入口共用 fresh inventory，非 TTY 确认；错误结构化、JSON错误不泄露输入；旧 `/api/models` DTO 保留 |
| §11 Web / Gate 4 | 完成 | Provider 导航大小写匹配、available未允许可开启、runtime-only可设主；处理向导补全/删除/保留、metadata默认不勾选、primary实际替换、fallback只读指引；插件一组一开关并展示同名config贡献与非模型能力 |
| §11.3 手机规则表 / Gate 4 | 完成 | 发现并修复精确表432px挤入356px容器；手机两列且规则下显示计数、桌面四列；新E2E断言Policy表自身不横滚，删除对象与按钮同时可见 |
| §12 写入与错误 / Gate 2–3 | 完成 | fresh预检在Core写锁内；外部config/env变化时再读再预检一次，持续变化拒绝；指定协调事务跳过全局归一，wildcard从不改写/去重；备份、diff guard、失败回滚回归通过 |
| §13.1–3 / Gate 5 | 完成 | `bun run check`：1014个Core/Server/CLI测试 + 203个Web测试，0失败；monorepo typecheck和Web生产build通过 |
| §13.4 隔离验收 / Gate 5 | 完成 | `bun run acceptance`通过；fake CLI自行回读临时配置，严格断言exact删除后allowed/待处理消失、两个Provider同步启停且policy原样、unknown直接CLI删除被拒绝、失败无写无备份、输出无auth泄漏 |
| §13.4 浏览器 / Gate 5 | 完成 | `bun run test:e2e`：desktop/mobile共36项通过（含真实fixture写入及还原）；默认17420/15173隔离端口；另以真实`oc-switch serve`+fake OpenClaw在17430验证全链路，390px body=390、Policy表=356/356、无pageerror，失败模式7/7 unknown且全部capability=false |
| §13.4 真机只读 / Gate 5 | 完成 | 本机及claw都实际运行本轮新CLI；claw将临时bundle通过SSH stdin交给Bun，不部署、不改远端源码/服务；完整目录、allowed及差异逐条对账，见§17.2 |
| §14–16 兼容、实施与决策 | 完成 | 保留config-adapter旧consumer口径和config-only计数；新inventory不依赖其遮蔽规则；README/AGENTS/旧插件spec同步；没有执行可选commit或真实写入验证 |

额外静态验证：两个验收脚本按项目 strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes 参数独立 typecheck 通过；`git diff --check`通过。变更扫描仅出现明确测试占位密钥；没有新增真实凭据。

### 17.2 真机只读对账（2026-09-11 06:51 北京时间）

两机版本均为 OpenClaw `2026.9.3 (1391f7c)`；三项 completeness 均为 true，diagnostics 均为0。对账脚本只输出经过白名单提取的ref/状态/来源，不保存原始status/auth。config、源 `.env`、settings、provider-state 在探测前后指纹均不变。

| 环境 | inventory模型 | 策略允许 | available | unavailable | unknown | status.allowed | 未解释缺失 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 本机 | 230 | 48 | 142 | 54 | 34 | 48 | 0 |
| claw | 220 | 72 | 146 | 72 | 2 | 64 | 0 |

- 本机 `status.allowed` 与 inventory policyAllowed 双向差集为空。34个unknown来自合法nullable可用性（ollama-cloud 24、google 10），并非探测失败；54个unavailable为42个插件停用模型和12个目录缺失模型。
- claw `status.allowed - inventory` 为空；`inventory.policyAllowed - status.allowed` 有8条，全部由当前 `models list` 明确报告 available、被 `cpa/*` 覆盖，但不在 `--all` / prepared status 目录中。逐项对应如下，不通过隐藏模型“修平”数量：

| ref | 当前列表tag | 完整目录 | 解释 |
|---|---|---|---|
| `cpa/g/Gemini 3.5 Flash Lite` | `image` | 无 | 当前配置图像模型，current list来源 |
| `cpa/g/Gemini 3.1 Flash Lite` | `img-fallback#1` | 无 | 图像fallback第1项 |
| `cpa/g/Gemini 3.1 Flash Lite Preview` | `img-fallback#2` | 无 | 图像fallback第2项 |
| `cpa/g/Gemini 3.6 Flash` | `img-fallback#3` | 无 | 图像fallback第3项 |
| `cpa/g/Gemini 3.5 Flash` | `img-fallback#4` | 无 | 图像fallback第4项 |
| `cpa/g/Gemini 3 Flash Preview` | `img-fallback#5` | 无 | 图像fallback第5项 |
| `cpa/g/Gemini 2.5 Flash` | `img-fallback#6` | 无 | 图像fallback第6项 |
| `cpa/g/Gemini 2.5 Flash-Lite` | `img-fallback#7` | 无 | 图像fallback第7项 |

OpenClaw已安装源码中的 `models status` 从prepared catalog投影allowed，而 `models list` 还组装当前配置行，解释了上述差异。claw两个已知anyrouter悬空exact仍为provider-not-found；2个unknown为xiaomi-token-plan无明确可用标记。两机主模型 `cpa/agy-gf` 都有available事实。

### 17.3 本轮问题与限制

- 修复了此前“只在UI藏按钮”的写入缺口：unknown/受保护ref在直接API/CLI调用时同样阻断；runtime-only available 的开启/设主模型不会再被旧静态目录拒绝。
- 插件启停、精确引用删除和materialize不再因事务归一化而改写无关policy/Provider大小写；全局wildcard的大小写及重复规则始终保留。
- `available`只是OpenClaw的当前报告，不等于已完成真实推理请求。细分认证/路由/Provider拒绝原因没有可信事实时不猜测，nullable保持unknown。
- 图像模型/图像fallback不在本期编辑范围；从current list进入inventory作为运行时来源保留，本期仅管理`agents.defaults.model`的primary及合法fallback保护。
- 本轮未部署、未重启常驻实例、未执行真实配置写入；可选commit保持未执行。构建有约503kB单JS chunk的Vite提示，不影响构建通过，未为本任务引入额外拆包重构。
- 测试前期发现并纠正旧入口的只读插件探测与E2E路径报告隔离缺口；最终测试使用隔离HOME/fake OpenClaw。真实配置指纹检查未发现修改。

本机临时日志和脱敏对账：`/tmp/oc-switch-runtime-review.V4Jiik/`；截图与续审记录在忽略目录 `.superpowers/sdd/2026-09-09-runtime-model-management/`。这些是本次执行证据，不是运行依赖或需提交的个人配置。
