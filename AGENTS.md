## Learned User Preferences

- 使用中文沟通；代码注释使用中文。
- 实现前遵循 Superpowers 流程：先读设计规格与实现计划，再动手编码。
- 实现完成后对照设计规格做 Sync Audit，报告偏差。
- 仅在用户明确要求时创建 git commit；不主动 push。
- 已完成且可独立使用的阶段切片应尽早合并到 `main`，避免多功能 big-bang 合并。
- 控制改动范围，严格按计划实现，不添加计划外功能。

## Learned Workspace Facts

- oc-switch 是用于本地 OpenClaw provider/model 配置管理的 Bun/TypeScript monorepo。
- 包结构：`packages/core`（`@oc-switch/core`）与 `packages/cli`（CLI 入口 `oc-switch`）。
- 设计规格在 `docs/superpowers/specs/`；实现计划在 `docs/superpowers/plans/`。
- 分阶段交付：Phase 1 为 Core+CLI MVP，后续 REST API、WebGUI、packaging 从 `main` 拉分支。
- 默认路径：`OPENCLAW_CONFIG_PATH` 或 `~/.openclaw/openclaw.json`；`.env` 在 `~/.openclaw/.env`；状态与备份在 `~/.oc-switch/`。
- ModelRef 仅在第一个 `/` 处拆分 provider 与 model，保留大小写。
- `.env` 写入限定在 `# oc-switch:start` / `# oc-switch:end` 托管块内。
- 工具链：`bun install`、`bun test`、`bun run typecheck`、`bun run packages/cli/src/index.ts`。
