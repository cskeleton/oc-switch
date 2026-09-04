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
- **Web 共享组件**：`Button` / `Pill` / `Toast`（`ToastProvider` + `useToast`）/ `EmptyState` / `Skeleton` / `DataTable`（支持列排序）位于 `packages/web/src/components(/ui)`，新代码应直接使用，不得再内联拼 class。
- **Web 单测 DOM 全局**：`packages/web/src/test-setup.ts` 逐项挑选 happy-dom 全局注入 `globalThis`，缺项不会在启动时报错，只在渲染时抛 `X is not defined` 且堆栈指向组件库内部。已知项：Radix `Switch` 位于 `<form>` 内会额外渲染依赖 `ResizeObserver` 的隐藏 bubble input（表单外不会），故该全局必须注入。引入新 Radix 组件后若测试炸在这类报错上，补 test-setup 而非改组件；单个用例的崩溃会经 `cleanup()` 连带打挂同文件其它用例，别被表象误导。
- **共享类型**：不新建 shared contracts 包；core 类型由 server/cli/web 各自引用。

## 领域约定

### ModelRef 与 Allowlist

- **ModelRef**：仅在第一个 `/` 处拆分 provider 与 model，**保留大小写**。
- **Model policy 三态**：`agents.defaults.modelPolicy.allow` 缺失=`legacy`，effective enabled 由 `agents.defaults.models` exact ref 决定；存在且为 `[]`=`unrestricted`，本地 Provider 目录模型在 Provider 未 disabled 时有效；存在且非空=`restricted`，仅 exact ref 或尾部 wildcard（`provider/*`、`provider/namespace/*`）命中时有效。restricted 模式下 `agents.defaults.models` 仍是 alias/per-model metadata，不是 authoritative selection allowlist；Provider disabled state 独立且优先阻止有效启用。缺失与空数组必须保持可区分。
- **Model policy DTO**：固定使用 `ModelPolicyMode = "legacy" | "unrestricted" | "restricted"` 与 `ModelSelectionSource = "legacy" | "unrestricted" | "policy-exact" | "policy-wildcard"`；`ModelSummary.selectionSource`、`StatusSummary.modelPolicyMode`、`StatusSummary.effectiveModelCount` 为新增字段，`allowlistModelCount` 在兼容期保留并继续表示 `agents.defaults.models` 条目数。
- **modelPolicy.allow 写入安全**：Core 是唯一 writer；仅在 policy 已存在且非空时同步 exact entries，绝不创建、清空、隐式展开、删除或改写用户 wildcard。单模型/Provider disable、rename、batch cleanup 若无法不改 wildcard 地表达，必须 fail closed，`force` 也不可绕过。per-agent `agents.entries.*.modelPolicy.allow` 不在范围内。`config-status` 对已启用但 policy 未覆盖仍报 `model-policy-not-covered` warning。
- **Provider 模型目录**：`models.providers`；`listModels` 合并两者。
- **主模型**：`agents.defaults.model`，双形态（见下节）。

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
- 可逆关闭（`provider disable/enable`、`PATCH /api/providers/:id/state`）：快照 allowlist 至 `provider-states.json`，保留 `models.providers`、不改 `.env`；含主模型时不可关闭
- 删除级联：移除 `models.providers[<id>]` 与 allowlist 中第一段等于该 ID 的条目；`.env` Key 不自动删，标为 orphan；含当前主模型须先切换
- 大小写重复：`inspectConfigHealth` / `mergeProviderCaseDuplicates`；`GET /api/health`（legacy，仅大小写检查）；CLI `health` / `providers merge-duplicates`；`addCustomProvider` 含大小写防重复

### Model

- 增删、allowlist 启用/禁用、切换主模型（`use`）
- 模型编辑（Web + API）

### 配置健康

- `GET /api/config-status` 返回 `ConfigStatusReport` v1；`issues[]` 为去重行动列表（key：`source:kind:subject`）

### 路径与环境

- 分层 env 管理；跨平台运行实例探测（Linux systemd / macOS LaunchAgent），返回 `RuntimeDiscoveryResult` 与候选组（`candidateId`）；管理源 `.env` 与 Gateway service env 分离，后者只读展示且不得成为 active `envPath`
- **运行时 env 来源**：`openclaw.json` 使用 canonical SecretRef 引用；`openclaw` CLI 与 Gateway 可加载 state 目录全局 `.env`。OpenClaw 同时为服务生成 env 快照（Linux：unit 实际 `EnvironmentFile=`，常见为 `gateway.systemd.env`；macOS：`service-env/*.env`）；服务进程环境优先于 dotenv，因此快照同名旧值会覆盖 `.env`，而快照缺项可由 `.env` 补足。改 API Key 后仍应同步服务 env 并 restart/apply，使运行中进程加载新值（日常切模型/allowlist 通常无需重启）。
- Gateway 服务环境：`.env` 托管块在写入校验通过且能唯一关联候选组时自动同步到该组 service env（Linux：PID/unit 关联的 `EnvironmentFile=`，禁止仅按 `dirname(envPath)/gateway.systemd.env` 猜测；macOS：共享 LaunchAgent 解析器识别的 `service-env/*.env`，兼容 `/bin/sh + wrapper` 与旧 wrapper 布局）；无法唯一关联时主写入仍成功但 `gatewayEnvSync.ok=false`；目标文件块外内容原样保留，块外同名 Key 只告警不自动改写；Web/CLI/API 提供 `sync-env`、`restart`、`apply`（均可带 `--candidate` / `candidateId`），多实例时必须指定候选，不自动静默重启 Gateway
- 已知后续：stale allowlist 专用清理 UI、chmod 警告、真实配置写 E2E、`GET /api/gateway/env-drift`

## 产品与使用定位

### 主路径（日常）

- 本机已有 OpenClaw：读/改 `openclaw.json` 与 allowlist 是主流程。
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
