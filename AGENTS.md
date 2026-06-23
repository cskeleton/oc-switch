## Learned User Preferences

- 使用中文沟通；代码注释使用中文。
- 实现前遵循 Superpowers 流程：先读设计规格与实现计划，再动手编码。
- 实现完成后对照设计规格做 Sync Audit，报告偏差。
- 仅在用户明确要求时创建 git commit；不主动 push。
- 已完成且可独立使用的阶段切片应尽早合并到 `main`，避免多功能 big-bang 合并。
- 控制改动范围，严格按计划实现，不添加计划外功能。
- Git 合并、推送等操作前先说明执行计划，待用户确认后再执行。
- 默认不提交 `docs/` 与 `.cursor/`；仅在用户明确要求时纳入 commit。

## Learned Workspace Facts

- oc-switch 是用于本地 OpenClaw provider/model 配置管理的 Bun/TypeScript monorepo。
- 包结构：`packages/core`（唯一读写 OpenClaw 本地文件）、`packages/cli`、`packages/server`（Hono REST）、`packages/web`（React/Vite SPA）。
- 设计规格在 `docs/superpowers/specs/`；实现计划在 `docs/superpowers/plans/`。
- 分阶段交付：Phase 1–5 已完成（Core+CLI、REST Server、WebGUI、内置 preset、验收）；后续功能从 `main` 拉分支。
- 默认路径：`OPENCLAW_CONFIG_PATH` 或 `~/.openclaw/openclaw.json`；`.env` 在 `~/.openclaw/.env`；状态与备份在 `~/.oc-switch/`。
- ModelRef 仅在第一个 `/` 处拆分 provider 与 model，保留大小写。
- `.env` 写入限定在 `# oc-switch:start` / `# oc-switch:end` 托管块内。
- Provider `baseUrl` 遵循 OpenClaw：`openai-completions` 含 `/v1`；`anthropic-messages` 通常不带末尾 `/v1`。
- 内置 preset 在 `presets/builtin/`，为当前快照而非永久承诺。
- 工具链：`bun install`、`bun test`、`bun run typecheck`、`bun run packages/cli/src/index.ts`。
