# AGENTS.md

本文件供 AI 助手与贡献者快速了解 oc-switch 的架构约定、业务规则与开发方式。个人工作流偏好请放在本地 Cursor User Rules，不写入此文件。

## 项目概述

oc-switch 是用于本地 **OpenClaw** provider/model 配置管理与清理的 Bun/TypeScript monorepo。核心价值：读写 `openclaw.json` 与 allowlist、切换主模型、备份恢复、清理陈旧 ref（大小写不一致、孤立 allowlist 等）。

- 日常约定以本文件与 `README.md` 为准；深度设计见下方规格索引。
- 代码注释使用中文。
- 新功能从 `main` 拉分支；控制改动范围，不添加计划外功能。
- 在真实 OpenClaw 配置上做 E2E 时优先只读；若必须写操作，测试后须还原。

## 本地私有补充

如果仓库根目录存在 `AGENTS.local.md`，AI 助手在读取本文件后必须继续读取该文件，并将其中内容作为本机私有补充约束。`AGENTS.local.md` 用于个人工作流、部署路径、私有环境事实等不应进入公开仓库的信息，必须保持在 Git 跟踪之外。

## 包结构

| 包 | 职责 |
|----|------|
| `packages/core` | 唯一读写 OpenClaw 本地文件；`operations/` 按 model / provider / lifecycle 等域拆分 |
| `packages/cli` | Commander CLI；`commands/` 各领域命令；`index.ts` 仅做 program 装配 |
| `packages/server` | Hono REST；`routes/` 各领域路由；`app.ts` 仅组装 |
| `packages/web` | React + Vite SPA |

### 常见踩坑

- **`repoRoot`**：`packages/cli/src/command-context.ts` 导出，须自 `packages/cli/src` **上溯三级**至 monorepo 根（测试脚本定位等用途）。
- **Web 主题**：双主题用 `styles.css` 的 `@theme inline` + `:root` / `.dark` token。禁止硬编码 `slate-*` / `sky-*` / `red-*`——Tailwind v4 会静默丢弃未声明 token 的工具类且不报错。`brand` / `success` / `warning` / `danger` 等语义色 token 已在 `styles.css` 声明，同样禁止硬编码 `amber-*` / `emerald-*`。
- **Web 表格换行与宽度**：`DataTable` 的单元格默认 `wrap: "normal"`（按词边界断行）。历史上 `<td>` 是无条件 `break-all`，会把 `openai-completions`、`qwen-token-plan` 这类短标识拦腰截断——列一被挤窄就大面积折行。只有长 URL / 长 ModelRef 才声明 `wrap: "anywhere"`，状态与操作列声明 `wrap: "nowrap"`。`Pill` / `Badge` 自带 `whitespace-nowrap shrink-0`，徽章永不折行。列数多的表必须显式传 `minWidthClass`（可带断点，如 `min-w-[22rem] lg:min-w-[62rem]`）：宽度不足时应横向滚动，而不是继续挤压列宽；同时用 `className: "hidden md:table-cell"` 在窄屏隐藏低价值列，保证 ID / 状态 / 操作 在手机上不横滚即可达。改动后须实测「表格 scrollWidth ≤ 容器 clientWidth」与「页面 body 不横向溢出」，别凭感觉估宽度。**实测别手搓 mock**：自造 API fixture 极易漏掉必填数组（如 `/api/settings` 的 `orphanEnvKeys`），页面会白屏并抛 `Cannot read properties of undefined`，看着像产品 bug 其实是 fixture bug。正确做法是另起一个隔离的 `oc-switch serve`：`HOME` 指向 mkdtemp fixture（stateDir / 备份 / .env 全部隔离），PATH 前置一个假 `openclaw` 脚本回放事先只读捕获的 `plugins list --json`，这样能拿到真实 DTO 与真实插件行（含同名遮蔽、已停用），且不碰用户常驻实例和真实 `openclaw.json`。注意 `overflow-x-auto` 容器 scrollWidth 超出属设计（App.tsx 的移动端 nav tab 条、对话框内表格），`truncate` 元素同理，不要当成回归。
- **Web 共享组件**：`Button` / `Pill` / `Toast`（`ToastProvider` + `useToast`）/ `EmptyState` / `Skeleton` / `DataTable`（支持列排序）/ `PageHeader`（统一页头：标题 + 描述 + 右侧操作区）位于 `packages/web/src/components(/ui)`，新代码应直接使用，不得再内联拼 class。
- **Web 单测 DOM 全局**：`packages/web/src/test-setup.ts` 逐项挑选 happy-dom 全局注入 `globalThis`，缺项不会在启动时报错，只在渲染时抛 `X is not defined` 且堆栈指向组件库内部。已知项：Radix `Switch` 位于 `<form>` 内会额外渲染依赖 `ResizeObserver` 的隐藏 bubble input（表单外不会），故该全局必须注入。引入新 Radix 组件后若测试炸在这类报错上，补 test-setup 而非改组件；单个用例的崩溃会经 `cleanup()` 连带打挂同文件其它用例，别被表象误导。另外 `@testing-library` 的 `screen` 在模块加载期一次性绑定 `document.body`，bun test 下它先于 test-setup 的注入完成求值，导致单文件独立运行时 `screen.*` 抛「global document has to be available」（全量套件因跨文件模块缓存被掩盖）；test-setup 末尾已在注入 `document` 后用 `getQueriesForElement` 重建 screen 绑定，新增测试文件务必第一行 `import "./test-setup"`。
- **共享类型**：不新建 shared contracts 包；core 类型由 server/cli/web 各自引用。

## 领域约定

### ModelRef 与 Allowlist

- **ModelRef**：仅在第一个 `/` 处拆分 provider 与 model，**保留大小写**。
- **Model policy 三态**：`agents.defaults.modelPolicy.allow` 缺失=`legacy`，effective enabled 由 `agents.defaults.models` exact ref 决定；存在且为 `[]`=`unrestricted`，本地 Provider 目录模型在 Provider 未 disabled 时有效；存在且非空=`restricted`，仅 exact ref 或尾部 wildcard（`provider/*`、`provider/namespace/*`）命中时有效。restricted 模式下 `agents.defaults.models` 仍是 alias/per-model metadata，不是 authoritative selection allowlist；Provider disabled state 独立且优先阻止有效启用。缺失与空数组必须保持可区分。
- **Model policy DTO**：固定使用 `ModelPolicyMode = "legacy" | "unrestricted" | "restricted"` 与 `ModelSelectionSource = "legacy" | "unrestricted" | "policy-exact" | "policy-wildcard"`；`ModelSummary.selectionSource`、`StatusSummary.modelPolicyMode`、`StatusSummary.effectiveModelCount` 为新增字段，`allowlistModelCount` 在兼容期保留并继续表示 `agents.defaults.models` 条目数。
- **modelPolicy.allow 写入安全**：Core 是唯一 writer；仅在 policy 已存在且非空时同步 exact entries，绝不创建、清空、隐式展开、删除或改写用户 wildcard。单模型/Provider disable、rename、batch cleanup 若无法不改 wildcard 地表达，必须 fail closed，`force` 也不可绕过。per-agent `agents.entries.*.modelPolicy.allow` 不在范围内。`config-status` 对 legacy `agents.defaults.models` metadata ref 未被非空 policy 覆盖，必须产生 `health:model-policy-not-covered:modelPolicy.allow`（source=`health`、severity=`warning`）全局 issue，并在 detail/action 中说明 metadata 不参与 restricted selection 及修复方向。
- **malformed modelPolicy.allow**：`allow` 非数组按 `legacy` 兼容解释，`ConfigStatusReport.modelPolicy.policyEntryCount` 固定为 `0`，但产生 blocking `health:invalid-model-policy-allow:modelPolicy.allow`；数组中的非字符串条目保留、忽略匹配，并逐项产生 blocking `health:invalid-model-policy-entry:modelPolicy.allow[<zero-based-index>]`。`ConfigStatusReport.modelPolicy` 固定包含 `mode`、`policyEntryCount`、`effectiveCatalogCount`、`unknownProviderRefs`、`policyOnlyExactRefs`、`knownProviderUnknownModelRefs`；unknown refs 只返回 Provider 不存在的字符串 exact refs，policy-only refs 只返回不在 `agents.defaults.models` 的字符串 exact refs，known-provider/unknown-model refs 是其子集；三者均排除 wildcard 和非字符串条目，不返回 secrets。
- **Provider 模型目录**：`models.providers`；`listModels` 合并两者。
- **主模型**：`agents.defaults.model`，双形态（见下节）。

### 三层写模型与删除分级（2026-09-13 起）

规格见 `docs/superpowers/specs/2026-09-13-oc-switch-three-layer-write-model-design.md`（已实施）。

- 模型配置分三层：① 目录 `models.providers`（不是隐式 allowlist）、② 使用配置 `agents.defaults.models`、③ 策略 `modelPolicy.allow`；精确与通配放行混用合法，wildcard 永不隐式改写（唯一例外仍是 Provider/插件停用）。
- **删除不再被 wildcard 阻断**：`removeProviderModel` / `batchRemoveProviderModels` / `removeProvider` 的 wildcard guard 降级为 `OperationResult.warnings` 提示；保留不动的 fail-closed：disable / rename / `removeModelPolicyExactRef` 的 wildcard guard、primary/fallback 命中、删除最后一条 restricted exact、unknown 可用性门禁。
- **删除分级**：Core options/input 新增 `layers: { metadata?: boolean; policyExact?: boolean }`，缺省三层全删（CLI 与既有调用方语义不变）；Web 删除对话框显式传层级，默认「临时移除」只删目录条目，wildcard 覆盖行「连同精确放行」置灰。API Key 永不在删除范围内。
- **Provider 删除**：`removeProvider` 新增 `removePolicyWildcard?: boolean`（默认 false）；残留的悬空 wildcard 不自动删（warning 提示），显式勾选才移除，且不得把 restricted policy 清空（fail closed）。
- **discover 鉴权回退**：`ProviderDiscoverOptions.pluginProviders` 由 server/CLI 注入当前插件目录；config 条目缺 Key 时回退同名（大小写折叠）插件 manifest 的 `apiKeyEnvVars` 从 `.env` 取值，声明了变量但 `.env` 缺失时发请求前报错；无鉴权 401/403 报错带 `(missing or invalid API key)`。

### OpenClaw 2026.9 选择器与停用（2026-09-11 修正）

以下修正规则优先于后文的 2026-09-09/v1 历史描述；规格见 `docs/superpowers/specs/2026-09-11-model-picker-and-disable-design.md`。

- 日常 Web Provider/模型选项使用 Gateway `models.list` 的 default 视图；`config.get` 仅校验所选配置路径及已应用版本，原始配置/认证内容不返回、不缓存。CLI `models list` 和 `--all` 是目录证据，不能冒充 IM 选择器。`pickerSource="inferred"` 必须明确提示未确认在线 IM 一致性。
- `models.providers` 是目录，`agents.defaults.models` 是别名/参数，`modelPolicy.allow` 是策略。`meta.migrations.modelPolicyAllowlist=true` 或已有空 policy 对象时，不再把 metadata 当 legacy 限制；尚未迁移且有旧 model map 时保留 legacy 行为。
- `pickerVisible`、`inactive`、`needsAttention` 由 Core 计算。只有正在选择/保护的模型出现可用性问题才进入待处理。未启用插件不展开未引用的模型；未被 policy 覆盖的 metadata、主动停用状态、保留备用 Key 不产生全局待办。真正的配置语法/结构错误仍须报告。
- **明确 Provider/插件级停用是 wildcard 写入纪律的限定例外**：通过 `suspendModelProviders` 移出该目标的 exact/wildcard 规则，不改其他规则的大小写、顺序和重复次数；恢复只补保存的目标规则。开放策略必须取得可靠当前选择器后收窄为其他可见模型，禁止清成 `[]`。单模型 disable/rename/batch 仍拒绝 wildcard。
- `.env` 原样保留；目录默认保留，`cleanupMetadata` / CLI `--cleanup-metadata` 可选清理别名与模型参数。完整 Provider 目录清理走已有删除入口，密钥仍不自动删除。插件停用同时写 `plugins.entries.<id>.enabled=false`；低层 `setModelPluginEnabled` 只写开关，CLI/API 必须组合 selection suspension。旧 Provider 快照可重复应用真实停用并保留恢复资料；插件恢复不能越过另一个独立 Provider 停用。
- 精确引用主动移除只收窄选择范围，不依赖 availability；unknown 仍不得启用、设主模型或物化目录。primary/fallback/wildcard/最后一条规则保护仍生效。Provider/插件停用还检查其他 Agent 显式模型/策略及 image/pdf/utility 依赖；不静默改其他 Agent。
- Server/CLI 使用异步有界探测：并行命令、30 秒缓存、同 scope 并发去重；config/env 路径和文件版本变化、写后均失效。事务 `mutate` 支持 Promise，保留文件变化重读/重做一次的保护。`provider-states.json` 只对同路径、仍存在的 config Provider 生效，旧孤立记录不能锁死插件。
- 正常视图/配置管理视图分开；未启用插件折叠，残留选项可整组移出。配置写入成功与 Gateway 确认分开，未确认不得声称 IM 已生效。

### 问题处理与用户决定（2026-09-12 起）

方案见 `docs/superpowers/specs/2026-09-11-provider-attention-workflow-proposal.md`（已实施）。

- **统一问题列表**：`packages/core/src/model-attention.ts` 的 `buildModelAttention(config, inventory)` 是唯一来源，同一根因只产生一条 issue（如停用 anthropic 的 7 个目录模型 ≠ 7 个待办）；config blocking 问题并入且不可忽略。Dashboard / Models / Providers 三页消费同一列表，按 `issueId` 去重，前端不得自行把 `unavailable` 重新分类成待办。
- **持久化忽略**：`~/.oc-switch/attention-decisions.json`，按 scope（`openclawPath\0envPath\0agent`）+ issue revision 指纹记录；问题事实变化自动失效，重新启用 / 新增实际依赖 / 升级为加载阻断会恢复提醒。primary/fallback/实际依赖与 blocking 问题 `canIgnore=false`，禁止用忽略伪装恢复健康。
- **动作语义**：「本问题不再提醒」只改 oc-switch 提醒、不改 OpenClaw 配置与 IM（文案必须明确）；「不再使用」走真实停用并默认保留配置与 API Key；清理是独立可选后续，绝不自动删 Key；「暂不处理」只关面板。
- **API**：`GET /api/model-attention`（`schemaVersion: 2`）；`PATCH /api/model-attention/decision` 要求携带当前 revision，不匹配返回 409，写入经 decisionLock 串行 + 文件锁。
- **前后端版本一致**：`GET /api/meta` 返回 `protocolVersion: 2` 与 capabilities；inventory 响应必须 `schemaVersion: 2` 且 `needsAttention`/`inactive`/`pickerVisible` 为 boolean，前端遇旧协议只报「前后端版本不兼容」，**禁止**用 `?? availability` 回退成旧告警逻辑；`static-web.ts` 启动时对 dist 取指纹，运行中 dist 被更新则静态页返回 503 提示重启。

### 运行时模型协调（2026-09-09 起）

- **三维状态**：策略允许（`policyAllowed` / `selectionSource`）、插件启停（`pluginEnabled`）与运行可用性（`availability: "available" | "unavailable" | "unknown"`）是**三个独立维度**，绝不合并成一个 boolean；「策略允许」不代表「可调用」。必要探测证据不足（CLI 缺失 / 超时 / 非法 JSON / 目录 snapshot 不完整）时标为 `unknown/probe-failed`，绝不误判 `unavailable`；已取得的明确可用事实可保留。OpenClaw 合法的 `available:null` 仅使该行 unknown，不污染整份目录；unknown 行禁用一切清理/编排 capability。
- **统一 inventory 读路径**：`packages/core/src/model-inventory.ts` 的 `buildModelInventory` 合并 config ∪ 插件 manifest ∪ OpenClaw 运行时目录（`runtime-model-catalog.ts` 经四条白名单命令 `--version` / `models status --json` / `models list --json` / `models list --all --json` 探测，任一失败逐命令降级 + diagnostics，不抛错）∪ 引用来源（policy exact、legacy metadata、primary/fallback）。Server `GET /api/model-inventory`（30s 缓存 + `POST …/refresh` 强制重探测）与 CLI `models inventory / unavailable` 共用同一计算，acceptance 锁定两端口径一致。wildcard 不是模型行，只作为规则展示（`policyRules`），实际覆盖目录模型时才补 `policy-wildcard` 引用来源。
- **兼容层边界**：`createConfigAdapter`（`GET /api/models`、`ProviderSummary.source`）保留给旧 consumers；其「config 同名遮蔽插件成员」是 v1 简化，**新代码不得依赖它判断运行时可用性**——一律走 `buildModelInventory`。形状由 `config-adapter.test.ts` 的兼容层回归测试锁死。
- **运行时写入门禁**：模型启停 / 设主模型 / 编辑删除 / 批量清理 / 引用协调使用事务内 fresh inventory，不能以静态目录绕过 unknown；缓存绑定所选 config/env 路径与文件版本。预检期间外部 config/env 变化时，Core 重新读取并重做 mutation 一次，持续变化则明确拒绝。插件启停与精确协调事务设 `normalizeConfig:false`，不顺带归一无关配置；全局归一也不允许改写或去重 wildcard。
- **插件级启停**：`packages/core/src/plugin-state.ts` 只写 `plugins.entries.<pluginId>.enabled` 一个键（diff-guard 白名单已含）；主模型 / fallback 命中贡献 Provider 时 fail closed；policy / legacy metadata 原样保留（停用后成为不可用项是预期，重新启用即恢复）。一个插件可贡献多个 Provider（如 xiaomi → xiaomi + xiaomi-token-plan），UI/CLI 只提供插件级开关并完整提示非模型能力（speech/tools/hooks…）影响；写后重探测并确认目标插件的实际 enabled 与请求值一致，`runtimeConfirmed: false` 是警告不是失败。非模型能力从真实 `toolNames` / `hookNames` / `hookCount` / 各类 `*ProviderIds` 等公开字段归类，不只识别旧 `toolIds` 等别名。未知 pluginId 在 server 404 / CLI 非零退出（descriptor 只来自当前发现的插件列表，杜绝凭空注入）。
- **模型引用协调**：`packages/core/src/model-reconciliation.ts`——`removeModelPolicyExactRef`（默认只删 policy exact、metadata 为独立复选项；删成 `[]` unrestricted 时 fail closed；wildcard 输入拒绝）与 `materializeRuntimeModel`（仅 runtime `available` 且 config Provider 已存在才补入；Provider 缺配置返回结构化「需用户补充字段」，绝不猜 baseUrl/API）。primary/fallback 命中时 fail closed，`force` 不可绕过。
- **测试隔离（运行时探测，必读）**：server 的 `createApp` 与 CLI 默认真实 shell-out `openclaw`。server 测试经 `AppOptions.runtimeModelCatalogProvider` 注入；CLI 测试经 `OC_SWITCH_MOCK_RUNTIME_MODELS` 环境变量指向 `{ version, status, list, listAll }` fixture 文件；acceptance 在 PATH 前置假 `openclaw` 脚本按 argv 回放，并经 `OC_FAKE_OPENCLAW_MODE=timeout|invalid-json` 切换失败模式。任何测试都不得读开发机真实 `~/.openclaw`。完整浏览器 E2E 默认隔离 API `17420` / Web `15173`，可用 `E2E_API_PORT` / `E2E_WEB_PORT` 覆盖；不能停掉或复用常驻 `7420`。
- 详见 `docs/superpowers/specs/2026-09-09-oc-switch-runtime-model-management-design.md`（§17 为实现后 Sync Audit）。

### 插件 Provider（OpenClaw 2026.4+）

- **来源**：Provider 可来自 OpenClaw **插件 manifest** 的 `modelCatalog`（bundled 或 npm global），**从不写入** `models.providers`。`packages/core/src/plugin-catalog.ts` 的 `discoverPluginCatalog()` 经 `openclaw plugins list --json` + 读 `<rootDir>/openclaw.plugin.json` 得到只读目录；任何失败（CLI 缺失/8s 超时/JSON 或 manifest 解析失败）**降级为空结果 + diagnostics，绝不抛错**，行为回落到 config-only。
- **DTO**：`ProviderSummary.source: "config" | "plugin"`（必填）。插件条目的 `disabled = !plugin.enabled`，语义是 OpenClaw 的 `plugins.entries.<id>.enabled=false`，**与 oc-switch 的可逆关闭（`provider-states.json`）无关**，UI/CLI 不得混用同一文案。
- **冲突规则**：providerId 与 `models.providers` 同名（大小写折叠）时 **config 优先**，插件条目不列出，且该 provider 的**模型级**校验/编排只看本地目录。这是 v1 简化——OpenClaw 实际是并集；统一 inventory（2026-09-09 spec）已按并集合并模型行，此遮蔽语义只保留在兼容层 `createConfigAdapter`。
- **可写范围**：只有「单模型启停 / 设主模型 / 设 API Key」。`enableModel` / `setPrimaryModel` 用 `hasKnownModel`（本地目录 ∪ **启用中**插件 catalog）校验；插件 `enabled=false` 的 ref 拒绝并在报错中指向 `plugins.entries.<pluginId>.enabled=false`。编辑连接信息、增删改模型、`disableProvider`/`restoreDisabledProvider`、`removeProvider`/`deleteProvider` 对插件 provider 一律**显式拒绝**（不得静默 no-op）。v1 不写 `plugins.entries`；唯一例外是 `sync push --enable-plugins`（spec §6.3 的刻意收窄：仅 `plugins.entries.<id>.enabled` 一个键位、仅 false→true、仅显式列出的 pluginId，收窄逻辑在 `config-sync.ts` 的 `applySyncPayload`，diff-guard 白名单相应只加该一条）。
- **API Key**：只写 `.env` 托管块中 manifest `setup.providers[].envVars` 声明的变量（`providerAuthChoices` 不含变量名）。`apiKeyEnvVars` 把含 `API_KEY` 的变量排到前面并只取首个——否则会把 API Key 写进 `ANTHROPIC_OAUTH_TOKEN` 这类 OAuth 变量。**不写** `models.providers.<id>.apiKey`。
- **计数语义**：`StatusSummary.providerCount` / `providerModelCount` 保持 config-only；`effectiveModelCount` 必须计入启用中插件 provider 并与 `ConfigStatusReport.modelPolicy.effectiveCatalogCount` **相等**（server 测试锁定该不变量）。
- **测试隔离（必读）**：server 的 `createApp` 与 CLI 默认使用真实 `discoverPluginCatalog`。测试若不隔离会 shell-out 到开发机真实 `openclaw`，provider/model 列表随本机装了哪些插件漂移（且每次调用最多 8s）。server/acceptance 经 `AppOptions.pluginCatalogProvider` 注入；CLI 测试在 `runCli` 里 PATH 前置一个假 `openclaw` 脚本输出确定性 `plugins list --json`。
- 详见 `docs/superpowers/specs/2026-09-07-oc-switch-plugin-provider-design.md`。

### 主模型双形态（agents.defaults.model）

- 合法形态：字符串 ModelRef，或对象 `{ primary?, fallbacks? }`（OpenClaw 运行时回退链）。
- **core 禁止直接读写该字段**，必须经 `packages/core/src/primary-model.ts` 归一层（`readPrimaryModelRef` / `readFallbackModelRefs` / `writePrimaryModelRef` / `isPrimaryModelRef`）；读取 trim + 校验、永不抛错，写入形状守恒、绝不丢 `fallbacks` 与未知键。
- `fallbacks` 不可编辑、不展示，但破坏性操作（删除/关闭 Provider、删除/rename/批量清理模型、case-duplicate merge）命中合法 fallback ref 时必须 fail closed（`force` 也不可绕过），不自动改写 `fallbacks`。
- 详见 `docs/superpowers/specs/2026-06-25-oc-switch-model-editing-design.md` §13。

### 文件与密钥

- **配置路径**：默认 `OPENCLAW_CONFIG_PATH` 或 `~/.openclaw/openclaw.json`；活动路径持久化于 `~/.oc-switch/settings.json`，可在 Settings 切换（`GET/PUT /api/settings/paths`）。
- **`.env`**：默认 `~/.openclaw/.env`；oc-switch 写入限定在 `# oc-switch:start` … `# oc-switch:end` 托管块内。
- **API Key**：仅存 `.env`；新写入的 `models.providers.*.apiKey` 使用 canonical SecretRef `{ source: "env", provider: "default", id: "ENV_VAR" }`。旧 `${ENV_VAR}`、`$ENV_VAR` 与两字段 EnvRef 只在 Providers 页提示并由用户确认迁移；源 `.env` 缺失、空值、重复或复杂表达式时 fail closed。已关联 Gateway service env 缺 Key 可迁移；同名值与 `.env` 不一致时因进程环境覆盖而 fail closed。`health repair` 不得静默迁移或降级 Provider `apiKey`。`authHeader` 是 boolean 开关，不保存密钥。CLI / API / Web **不回显**完整密钥；env preview 不收 value。
- **Web 登录 Token**：指 oc-switch 自身的 API token（`~/.oc-switch/token.json`），与 Provider API Key 是两回事。浏览器侧默认只落 `sessionStorage`（同 tab 刷新恢复）；仅在用户勾选「记住密码」时才明文写入 `localStorage`，登录页对此有提示。「自动登录」以「记住密码」为前提，不变量在 `packages/web/src/auth-storage.ts` 的读、写两侧强制。
- **`baseUrl`**：遵循 OpenClaw——`openai-completions` 含 `/v1`；`anthropic-messages` 通常不带末尾 `/v1`。

### 写入与安全

- 每次写入自动备份至 `~/.oc-switch/backups/`（含 `openclaw.json` 与 `.env`）；备份 metadata 含路径，恢复时路径不一致或缺 metadata 则拒绝。
- 读取支持 JSON5，保存写为标准 JSON（注释将在下次写入丢失）；语义变更限于 provider / model 相关字段。
- OpenClaw 配置可能含 JSON5；可用 `diff` 查看即将变更的范围。

## 已实现能力（摘要）

### Provider

- CRUD、从 preset / 自定义添加（`provider add-custom`、`POST /api/providers/custom*`）
- 可逆关闭（`provider disable/enable`、`PATCH /api/providers/:id/state`）：快照 `agents.defaults.models` metadata 至 `provider-states.json`，保留 `models.providers`、不改 `modelPolicy.allow` / `.env`；含主模型时不可关闭
- 删除级联：移除 `models.providers[<id>]` 与 `agents.defaults.models` 中第一段等于该 ID 的 metadata；restricted exact policy 在可安全表达时同步；残留 wildcard 不阻断（warning 提示），仅显式 `removePolicyWildcard` 才移除且不得清空 restricted policy；`.env` Key 不自动删，标为 orphan；含当前主模型须先切换
- 大小写重复：`inspectConfigHealth` / `mergeProviderCaseDuplicates`；`GET /api/health`（legacy，仅大小写检查）；CLI `health` / `providers merge-duplicates`；`addCustomProvider` 含大小写防重复
- 插件 Provider 只读接入：`providers list` 标注 `plugin`、`GET /api/providers` 返回 `source`、Providers 页「插件」徽章 + 编辑/删除/发现模型/同步参数/关闭恢复禁用 + 「设置 Key」走 `.env` upsert；`ProviderModelsDialog` 对插件 provider 全只读

### Model

- 增删、按 model policy 三态启用/禁用、切换主模型（`use`）
- 插件 Provider 的模型可启停与设为主模型（CLI `model enable/disable`、`use`；`PATCH /api/models`、`PUT /api/models/primary`；Models 页 Switch/Star），编辑与删除入口隐藏
- 模型编辑（Web + API）
- 模型参数批量同步（`provider sync-metadata`、`POST /api/providers/:id/models/sync-metadata`、Providers 页「同步参数」）：从 models.dev 为本地目录条目回填 `name`/`reasoning`/`contextWindow`/`maxTokens`/`input`；确定性 resolver 唯一 high 置信自动回填，其余（非 high、多候选、模糊命中）进确认队列 `~/.oc-switch/model-metadata-sync-queue.json`，Web/CLI/API 三端 accept/dismiss；只填空缺字段，绝不覆盖已有值

### 运行时模型协调（2026-09-09）

- 统一 inventory：`GET /api/model-inventory`（+ `POST …/refresh`）与 CLI `models inventory [--json]` / `models unavailable [--json]`；合并 config / 插件 manifest / OpenClaw 运行时目录三来源 + 引用来源；模型行三维状态（策略 / 插件 / 可用性）与 capability 从事实推导
- 不可用与待处理：Models 页汇总区段（严重性排序：主模型 > fallback > 悬空精确引用 > 其余 > unknown）；处理向导按行事实分发——补全到已有目录（`POST /api/models/materialize`、CLI `model reconcile <ref> --yes`）、删除 policy 精确引用（`DELETE /api/model-policy/exact-ref`、CLI `model remove-policy-ref`，metadata 独立复选）、Provider 缺配置时打开 Custom Provider 向导预填 providerId/modelId、或保留；primary/fallback fail closed
- Policy 规则视图（Models 页折叠区段）：exact 可删、wildcard 按 Core 投影的 `removable` 显式删除（显示命中/不可用计数）、非字符串条目只显示下标不回显值；restricted 模式下可添加规则（`POST /api/model-policy/rules`，CLI `model add-policy-rule`），删除 wildcard 走 `DELETE /api/model-policy/wildcard` / `model remove-policy-wildcard`；守卫（模式门禁、防清空、primary/fallback 覆盖保护）fail closed
- 插件级启停：`PATCH /api/plugins/:pluginId/state`（confirm 必填）与 CLI `plugin enable/disable`；一组一个开关（一个插件多 Provider）、只写 `enabled` 一个键、主模型/fallback 阻断、非模型能力影响完整提示、写后重探测 `runtimeConfirmed` 分离报告

### 配置健康

- `GET /api/config-status` 返回 `ConfigStatusReport` v1；`issues[]` 为去重行动列表（key：`source:kind:subject`）
- 插件 Provider 的 policy ref 不再误报 `unknownProviderRefs`；`effectiveCatalogCount` 计入启用中插件的有效模型（v1 仍看不到运行时 shard 里的 live 模型，相关 ref 会被判为 model drift）

### 跨机同步

- `sync push <host>` / `sync diff <host>`（dry-run）：经 SSH 调对端隐藏 plumbing `sync-agent read-config|check|write|env-upsert`（stdout 纯 JSON 协议），把 `models.providers` / `agents.defaults.models` / `agents.defaults.modelPolicy.allow` / `agents.defaults.model` 四个子树**整体覆盖**到对端（单向 push，不 merge）；写入仍走 core 唯一事务（自动备份 + diff-guard），`--enable-plugins` 可显式开启已安装但 `enabled=false` 的插件（仅 false→true），`--fill-keys` 交互逐项补对端缺失 env 变量（值不回显）；非 TTY 无 `--yes` fail closed；报告只含变量名/ref，绝不出现密钥值。详见 `docs/superpowers/specs/2026-09-09-oc-switch-config-sync-design.md`

### 路径与环境

- 分层 env 管理；跨平台运行实例探测（Linux systemd / macOS LaunchAgent），返回 `RuntimeDiscoveryResult` 与候选组（`candidateId`）；管理源 `.env` 与 Gateway service env 分离，后者只读展示且不得成为 active `envPath`
- **运行时 env 来源**：`openclaw.json` 使用 canonical SecretRef 引用；`openclaw` CLI 与 Gateway 可加载 state 目录全局 `.env`。OpenClaw 同时为服务生成 env 快照（Linux：unit 实际 `EnvironmentFile=`，常见为 `gateway.systemd.env`；macOS：`service-env/*.env`）；服务进程环境优先于 dotenv，因此快照同名旧值会覆盖 `.env`，而快照缺项可由 `.env` 补足。改 API Key 后仍应同步服务 env 并 restart/apply，使运行中进程加载新值（日常切模型/allowlist 通常无需重启）。
- Gateway 服务环境：`.env` 托管块在写入校验通过且能唯一关联候选组时自动同步到该组 service env（Linux：PID/unit 关联的 `EnvironmentFile=`，禁止仅按 `dirname(envPath)/gateway.systemd.env` 猜测；macOS：共享 LaunchAgent 解析器识别的 `service-env/*.env`，兼容 `/bin/sh + wrapper` 与旧 wrapper 布局）；无法唯一关联时主写入仍成功但 `gatewayEnvSync.ok=false`；目标文件块外内容原样保留，块外同名 Key 只告警不自动改写；Web/CLI/API 提供 `sync-env`、`restart`、`apply`（均可带 `--candidate` / `candidateId`），多实例时必须指定候选，不自动静默重启 Gateway
- 已知后续：stale allowlist 专用清理 UI、chmod 警告、真实配置写 E2E、`GET /api/gateway/env-drift`

## 产品与使用定位

### 主路径（日常）

- 本机已有 OpenClaw：读/改 `openclaw.json` 的 Provider、模型目录与有效选择策略是主流程。
- 新开荒：直接添加 provider 与模型，不依赖 preset。

### 迁移与共享

- 优先 **backup/restore**、**`presets export <provider-id>`**、**`import`**，或拷贝 `openclaw.json` + 相关 `.env` Key。
- export/import **不含** API Key 明文。

### Preset（已弱化，不推荐主流程）

- 仓库**不包含**任何 builtin 预设 JSON；请勿将个人 Provider 配置提交进 Git。
- **custom**（`~/.oc-switch/presets/custom/`）：仅作本机 `import` / `presets export` 迁移快照。
- 主流程用 **Providers 页 / `provider add-custom`**；Web「预设」页为遗留入口，后续可移除。
- Web「预设」页展示 JSON 文件，**不是**实时读 `openclaw.json`。
- 后续优先整配置或 provider 级 import/export，而非扩充 builtin。

## 工具链

```bash
bun install
bun test                              # core / cli / server / web 单元测试
bun run typecheck
bun run build                         # 构建 Web（E2E 依赖 packages/web/dist）
bun run check                         # test + typecheck + build
bun run acceptance                    # 验收冒烟（临时 fixture）
bun run test:e2e                      # Playwright（需先 build）
bun run packages/cli/src/index.ts     # 直接调用 CLI
```

本机快速启动：先 `bun run build`，再 `./scripts/install-local-launcher.sh` 安装 `~/bin/oc-switch` 薄包装；任意目录 `oc-switch start` / `restart` / `stop`（日志 `~/.oc-switch/serve.log`）。

本地开发 Web：`bun run cli -- serve`（API，默认 `127.0.0.1:7420`）+ `bun run --cwd packages/web dev`（默认 `127.0.0.1:5173`）。API token 可持久化于 `~/.oc-switch/token.json`（`oc-switch token rotate`）。

## 设计与实现

- 各功能设计规格在 `docs/superpowers/specs/`（**已纳入 Git**，公开仓库可访问）。
- 实现新功能前：若有对应 spec，先读 spec 再编码；完成后对照 spec 做 Sync Audit。
- `docs/superpowers/plans/` 为本地 Superpowers 实现计划（agent 任务分解），**不纳入 Git**；路径已写入 `.gitignore`。

### 规格索引

| 主题 | 规格路径 |
|------|----------|
| 总体设计 | `docs/superpowers/specs/2026-06-23-oc-switch-design.md` |
| Custom Provider | `docs/superpowers/specs/2026-06-24-oc-switch-custom-provider-design.md` |
| Path & Env | `docs/superpowers/specs/2026-06-24-oc-switch-path-env-management-design.md` |
| Model Editing | `docs/superpowers/specs/2026-06-25-oc-switch-model-editing-design.md` |
| Provider Case Duplicate | `docs/superpowers/specs/2026-06-25-oc-switch-provider-case-duplicate-design.md` |
| Provider Disable | `docs/superpowers/specs/2026-06-25-oc-switch-provider-disable-design.md` |
| Web UI UX Revamp | `docs/superpowers/specs/2026-06-25-web-ui-ux-revamp-design.md` |
| 架构优化（草案） | `docs/superpowers/specs/2026-06-26-oc-switch-architecture-optimization-draft.md` |
| Config Status | `docs/superpowers/specs/2026-06-26-oc-switch-config-status-design.md` |
| Local Launcher | `docs/superpowers/specs/2026-07-09-oc-switch-local-launcher-design.md` |
| Provider Model Discover | `docs/superpowers/specs/2026-07-09-oc-switch-provider-model-discover-design.md` |
| Backup Diff Changelog | `docs/superpowers/specs/2026-07-09-oc-switch-backup-diff-changelog-design.md` |
| Model Metadata Core-ID Matching | `docs/superpowers/specs/2026-09-02-oc-switch-model-metadata-core-id-matching-design.md` |
| Model Metadata Batch Sync | `docs/superpowers/specs/2026-09-05-oc-switch-model-metadata-batch-sync-design.md` |
| Plugin Provider | `docs/superpowers/specs/2026-09-07-oc-switch-plugin-provider-design.md` |
| Runtime Model Management | `docs/superpowers/specs/2026-09-09-oc-switch-runtime-model-management-design.md` |
| Config Sync（跨机同步） | `docs/superpowers/specs/2026-09-09-oc-switch-config-sync-design.md` |
| Model Picker & Disable（2026.9 选择器与停用） | `docs/superpowers/specs/2026-09-11-model-picker-and-disable-design.md` |
| Provider Attention Workflow（问题处理与用户决定） | `docs/superpowers/specs/2026-09-11-provider-attention-workflow-proposal.md` |
| 三层写模型与删除分级 | `docs/superpowers/specs/2026-09-13-oc-switch-three-layer-write-model-design.md` |

## Learned User Preferences

- 巨型 Provider（如 OpenRouter）优先「发现 + 按需勾选添加」，不要把远端全量模型目录持久化进 `openclaw.json`。
- 每 Provider 本地已添加模型硬上限按 **100** 设计；主要顾虑 OpenClaw 侧维护成本，而非 oc-switch UI 渲染；存量可超过但禁止再增，需批量清理。
- `anthropic-messages` 应支持模型发现；`google-generative-ai` 保持 unsupported（官方 API 仍在演进、第三方少用）。
- 本地目录膨胀时需要批量删除 /「只保留已启用」，避免逐条删。
- 本机日常启动优先 `oc-switch start` / `restart` / `stop`（`~/bin` 薄包装），不优先 `bun compile` 独立二进制；无需为 macOS 单独拆包或仓库。
- Dashboard 备份差异 Changelog：P0 为 Provider 增删与 Key/Credentials 变更；P1 为停用/启用、模型增删、非密钥参数与主模型切换。
- 关注 OpenClaw `doctor`/`secrets audit` 对 `apiKey` 格式的告警；新写入宜优先 canonical SecretRef 以减少被判 plaintext 的噪音。

## Learned Workspace Facts

- Providers「发现模型」/ CLI `provider sync`：**默认只 discover、不写盘**；显式勾选或 `sync --add` 才 batch-add 进 `models.providers[<id>].models[]`。默认不进 allowlist；`--enable` / 勾选「同时启用」才写入。旧无参全量 sync 已移除。常量 `MAX_PROVIDER_MODELS = 100`，须在 **core 所有会增加 `provider.models` 条数的写入路径**统一强制。详见 `2026-07-09-oc-switch-provider-model-discover-design.md`。
- 「模型」弹窗读的是本地已写入的 Provider 目录，不是实时远端全量列表；列表膨胀通常来自历史全量同步，可用多选删除 /「只保留已启用」清理。
- 已禁用 Provider：禁止 batch-add / 启用类写入；批量删除与「只保留已启用」仍应可用，以便把超限目录降到上限以下。
- 本机 launcher：`./scripts/install-local-launcher.sh` 只安装 `~/bin/oc-switch` 包装；需自行保证 `~/bin` 在 PATH；Web 登录用 API token（`~/.oc-switch/token.json` / `token rotate`），不是 macOS 系统登录密码。
- OpenClaw 2026.6.11+ 的 `doctor`/`secrets audit` 将 `${ENV_VAR}` 字符串视为 plaintext residue；`{ source: "env", provider: "default", id: "..." }` 才算合规 SecretRef。勿用 `health repair` 把对象格式迁成 `${VAR}` 来消除 doctor 告警。
- 模型参数批量同步的模糊匹配常量（`FUZZY_SCORE_THRESHOLD = 0.55` / `FUZZY_WEAK_THRESHOLD = 0.34` / `FUZZY_MAX_CANDIDATES = 8`、权重 0.86/0.82）移植自 CPAMP，集中定义于 `packages/core/src/model-metadata-matcher.ts`；模糊命中**永不自动应用**（即使 ≥0.55 且唯一），一律进确认队列；CLI 测试缝 `OC_SWITCH_MOCK_METADATA` 指向 `{ models, api }` JSON 文件，离线应答 models.dev 请求。
