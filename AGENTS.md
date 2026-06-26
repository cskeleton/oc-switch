## Learned User Preferences

- 使用中文沟通；代码注释使用中文。
- 实现前遵循 Superpowers 流程：先读设计规格与实现计划，再动手编码。
- 实现完成后对照设计规格做 Sync Audit，报告偏差。
- 仅在用户明确要求时创建 git commit；不主动 push。
- 已完成且可独立使用的阶段切片应尽早合并到 `main`，避免多功能 big-bang 合并。
- 控制改动范围，严格按计划实现，不添加计划外功能。
- Git 合并、推送等操作前先说明执行计划，待用户确认后再执行。
- 默认不提交 `docs/` 与 `.cursor/`；仅在用户明确要求时纳入 commit。
- 持续开发时按计划推进至任务完成，仅遇重大问题再暂停向用户确认。
- 在真实 OpenClaw 配置上做浏览器/E2E 测试时优先只读；若必须写操作，测试后须还原。

## Learned Workspace Facts

- oc-switch 是用于本地 OpenClaw provider/model 配置管理与清理（陈旧 ref、allowlist 与 provider 不一致等）的 Bun/TypeScript monorepo。
- 包结构：`packages/core`（唯一读写 OpenClaw 本地文件）、`packages/cli`、`packages/server`（Hono REST）、`packages/web`（React/Vite SPA；双主题用 `styles.css` 的 `@theme inline` + `:root`/`.dark` token，禁止硬编码 `slate-*`/`sky-*`/`red-*`，否则 Tailwind v4 会静默丢弃未声明 token 的工具类且不报错）。
- 设计规格在 `docs/superpowers/specs/`；实现计划在 `docs/superpowers/plans/`。
- 分阶段交付：Phase 1–5 已完成；Path & Env Management（2026-06-25）、E2E Browser Review 改进（2026-06-25）、Model Editing、Provider Case Duplicate（2026-06-25）已合并到 `main`；后续功能从 `main` 拉分支。
- Custom Provider（手工添加 Provider）已实现：Web Providers 页 / `provider add-custom` / `POST /api/providers/custom*`；规格见 `docs/superpowers/specs/2026-06-24-oc-switch-custom-provider-design.md`。
- Provider Case Duplicate（大小写重复检测/合并）已合并到 `main`：core `inspectConfigHealth`/`mergeProviderCaseDuplicates`、`GET /api/health`、CLI `health`/`providers merge-duplicates`、Web 仪表盘/Providers/Models 标注与 `MergeCaseDuplicateDialog`；`addCustomProvider` 含大小写防重复。规格见 `docs/superpowers/specs/2026-06-25-oc-switch-provider-case-duplicate-design.md`。
- 删除 Provider 级联：同时移除 `models.providers[<id>]` 目录与 allowlist 中第一段等于该 Provider ID 的所有条目；`.env` API Key 不自动删，仅标为 orphan 供设置页清理；若其下含当前主模型须先选新主模型，操作前自动备份。
- Path & Env Management：默认与活动路径 `OPENCLAW_CONFIG_PATH` 或 `~/.openclaw/openclaw.json`、`.env` 在 `~/.openclaw/.env`、active 路径持久化于 `~/.oc-switch/settings.json` 并可在 Settings 切换；`GET/PUT /api/settings/paths`、分层 env 管理（preview 不收 value、API/UI 不回显密钥）；备份 metadata 含路径，恢复时路径不一致或缺 metadata 拒绝；运行实例路径 best-effort 发现。规格见 `docs/superpowers/specs/2026-06-24-oc-switch-path-env-management-design.md`。已知后续：stale allowlist 专用清理 UI、chmod 警告、真实配置写 E2E。
- ModelRef 与 Allowlist 约定：ModelRef 仅在第一个 `/` 处拆分 provider 与 model 且保留大小写；Allowlist（已启用模型）在 `agents.defaults.models`（key 为完整 ModelRef），`models.providers` 为 provider 模型目录，`listModels` 合并两者；`.env` 写入限定在 `# oc-switch:start` / `# oc-switch:end` 托管块内；Provider `baseUrl` 遵循 OpenClaw（`openai-completions` 含 `/v1`、`anthropic-messages` 通常不带末尾 `/v1`）。
- 工具链：`bun install`、`bun test`、`bun run typecheck`、`bun run test:e2e`（需先 `bun run build` 生成 `packages/web/dist`，因 E2E 用 vite preview）、`bun run check`（test+typecheck+build）、`bun run acceptance`、`bun run packages/cli/src/index.ts`。

## 产品与使用定位

### 主路径（日常）

- 用户在本机已有 OpenClaw 时，核心价值是**读/改 `openclaw.json` 与 allowlist**：Providers、模型、主模型切换、备份/恢复、diff，以及清理陈旧 ref（大小写不一致、孤立 allowlist 等）。
- **新开荒**：按需直接添加 provider 与模型即可，不依赖 preset 流程。

### 迁移与共享

- 优先用 **backup/restore**、**`presets export <provider-id>`**、**`import`（全量导出到 `~/.oc-switch/presets/custom/`）**，或直接拷贝 `openclaw.json` + 相关 `.env` Key。
- 这类「配置快照」比维护 builtin 模板更贴近真实需求；export/import 不含 API Key 明文。

### Preset 的定位（次要、可选，**待改进**）

- **状态：待改进**——当前 preset 流程价值有限，后续优先强化 provider/整配置 import·export，并考虑将本页弱化为「高级：从模板添加」。
- **builtin**（`presets/builtin/`）：仓库内静态模板，供「从模板添加 provider」时少打字；会过时，不等于用户本机配置。
- **custom**（`~/.oc-switch/presets/custom/`）：由 `import` / `presets export` 从当前配置生成，才反映本机或共享用的真实形态。
- WebGUI「预设」页展示的是上述 JSON 文件，**不是**实时读取 `openclaw.json`。
- 对已配满机器的用户 preset 价值有限；UI 上可弱化为「高级：从模板添加」，不必与 Providers/模型页抢主流程。
- 后续增强迁移能力时，优先 **整配置或 provider 级 import/export**，而非扩充易过时的 builtin 目录。
