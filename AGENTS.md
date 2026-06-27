# AGENTS.md

本文件供 AI 助手与贡献者快速了解 oc-switch 的架构约定、业务规则与开发方式。个人工作流偏好请放在本地 Cursor User Rules，不写入此文件。

## 项目概述

oc-switch 是用于本地 **OpenClaw** provider/model 配置管理与清理的 Bun/TypeScript monorepo。核心价值：读写 `openclaw.json` 与 allowlist、切换主模型、备份恢复、清理陈旧 ref（大小写不一致、孤立 allowlist 等）。

- 日常约定以本文件与 `README.md` 为准；深度设计见下方规格索引。
- 代码注释使用中文。
- 新功能从 `main` 拉分支；控制改动范围，不添加计划外功能。
- 在真实 OpenClaw 配置上做 E2E 时优先只读；若必须写操作，测试后须还原。

## 包结构

| 包 | 职责 |
|----|------|
| `packages/core` | 唯一读写 OpenClaw 本地文件；`operations/` 按 model / provider / lifecycle 等域拆分 |
| `packages/cli` | Commander CLI；`commands/` 各领域命令；`index.ts` 仅做 program 装配 |
| `packages/server` | Hono REST；`routes/` 各领域路由；`app.ts` 仅组装 |
| `packages/web` | React + Vite SPA |

### 常见踩坑

- **`repoRoot`**：`packages/cli/src/command-context.ts` 导出，须自 `packages/cli/src` **上溯三级**至 monorepo 根（测试脚本定位等用途）。
- **Web 主题**：双主题用 `styles.css` 的 `@theme inline` + `:root` / `.dark` token。禁止硬编码 `slate-*` / `sky-*` / `red-*`——Tailwind v4 会静默丢弃未声明 token 的工具类且不报错。
- **共享类型**：不新建 shared contracts 包；core 类型由 server/cli/web 各自引用。

## 领域约定

### ModelRef 与 Allowlist

- **ModelRef**：仅在第一个 `/` 处拆分 provider 与 model，**保留大小写**。
- **Allowlist**（已启用模型）：`agents.defaults.models`，key 为完整 ModelRef。
- **Provider 模型目录**：`models.providers`；`listModels` 合并两者。
- **主模型**：`agents.defaults.model`。

### 文件与密钥

- **配置路径**：默认 `OPENCLAW_CONFIG_PATH` 或 `~/.openclaw/openclaw.json`；活动路径持久化于 `~/.oc-switch/settings.json`，可在 Settings 切换（`GET/PUT /api/settings/paths`）。
- **`.env`**：默认 `~/.openclaw/.env`；oc-switch 写入限定在 `# oc-switch:start` … `# oc-switch:end` 托管块内。
- **API Key**：仅存 `.env`；`openclaw.json` 的 `models.providers.*.apiKey` 写 `"${ENV_VAR}"`。OpenClaw 2026.6.8+ 不接受 oc-switch 旧版两字段 `{ "source": "env", "id": "..." }` 作为新写入格式。`authHeader` 是 boolean 开关，不保存密钥。CLI / API / Web **不回显**完整密钥；env preview 不收 value。
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

- 分层 env 管理；运行实例路径 best-effort 发现
- 已知后续：stale allowlist 专用清理 UI、chmod 警告、真实配置写 E2E

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
