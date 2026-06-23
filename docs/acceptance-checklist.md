# oc-switch 验收清单

> 映射 `docs/superpowers/specs/2026-06-23-oc-switch-design.md` §10 验收标准与 §10.1 Fixture 用例。  
> 自动化入口：`bun run check`、`bun run acceptance`、`bun run test:e2e`。

---

## §10 功能验收

| # | 验收项 | 验证方式 | 命令 / 测试 |
|---|--------|----------|-------------|
| 1 | 完整读取现有 12 个 provider 与 43 个 allowlist 模型 | 只读真实配置 smoke | `OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" bun run packages/cli/src/index.ts status` |
| 2 | 从 preset 添加 provider 后 `models.providers` 与 `agents.defaults.models` 同步 | 单元 + REST | `packages/core/test/operations.test.ts`（adds provider…）；`packages/server/test/app.test.ts`（POST /api/providers） |
| 3 | API Key 写入 `.env`，JSON 保持 env 引用 | 单元 | `packages/core/test/env-manager.test.ts`；`packages/core/test/transaction-writer.test.ts` |
| 4 | 写入前自动备份，回滚后与备份一致 | 单元 + CLI + REST | `packages/core/test/backup-manager.test.ts`；`packages/cli/test/cli.test.ts`（restores backup）；`packages/server/test/app.test.ts`（POST restore） |
| 5 | 写入不影响 `acp`、`channels` 等非目标字段 | 单元 | `packages/core/test/diff-guard.test.ts`；`packages/core/test/diff.test.ts` |
| 6 | WebGUI 在 iPad Safari 尺寸可添加 provider 与切换模型 | Playwright e2e | `bun run test:e2e`（mobile 390×844 viewport） |
| 7 | CLI `use` 与 WebGUI 切换 primary 行为一致 | 单元 + e2e | `packages/cli/test/cli.test.ts`（uses slash-containing model ref）；`packages/web/test/e2e/webgui.e2e.ts` |
| 8 | `provider sync` 从 OpenAI 兼容端点拉取模型 | 单元 + CLI | `packages/core/test/provider-sync.test.ts`；`packages/cli/test/cli.test.ts`（provider sync） |
| 9 | VPS `serve --host 0.0.0.0 --token` 可通过浏览器管理 | 单元 + 文档 | `packages/core/test/token-manager.test.ts`；`packages/cli/test/cli.test.ts`（serve rejects 0.0.0.0）；README VPS 章节 |
| 10 | 无 API Key 泄漏 | 全套件 + smoke | `bun run acceptance`；各测试文件 `not.toContain("sk-")` 断言 |

---

## §10.1 Fixture 验收用例

| Fixture | 说明 | 验证方式 | 命令 / 测试 |
|---------|------|----------|-------------|
| slash-model-ref | `nvidia/deepseek-ai/deepseek-v4-flash` → provider `nvidia`，modelId `deepseek-ai/deepseek-v4-flash` | 单元 + CLI + smoke | `packages/core/test/model-ref.test.ts`；`packages/cli/test/cli.test.ts`；`bun run acceptance` |
| case-sensitive-provider | `DeepSeek` 与 `deepseek` 不互相覆盖 | 单元 | `packages/core/test/model-ref.test.ts`（preserves provider casing）；`packages/core/test/config-adapter.test.ts` |
| allowlist-value-preserve | 更新 alias 时保留 `agentRuntime` 与未知字段 | 单元 | `packages/core/test/operations.test.ts`；`packages/core/test/config-adapter.test.ts` |
| provider-delete-scope | 删除 `nvidia` 只移除首段为 `nvidia` 的 allowlist | 单元 | `packages/core/test/operations.test.ts` |
| env-conflict | 管理块外同名 env var 默认拒绝覆盖 | 单元 | `packages/core/test/env-manager.test.ts` |
| transaction-rollback | JSON 或 `.env` 写入失败后两者均恢复 | 单元 | `packages/core/test/transaction-writer.test.ts` |
| json5-semantic-guard | 仅目标语义字段变化 | 单元 | `packages/core/test/diff-guard.test.ts`；`packages/core/test/diff.test.ts` |
| primary-delete-warning | 删除含当前 primary 的 provider 需新 primary 或 `--force` | 单元 | `packages/core/test/operations.test.ts` |
| unauthorized-api | 无 token 返回 401 且不泄漏配置 | 单元 + smoke | `packages/server/test/app.test.ts`；`bun run acceptance` |

---

## Phase 5.2–5.3 一键验证

```bash
bun run check
bun run acceptance
OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" bun run packages/cli/src/index.ts status
```

预期：

- `check`：全部单元测试通过、typecheck 通过、WebGUI 构建成功
- `acceptance`：临时 fixture 烟雾脚本通过，输出不含 API Key
- 真实配置 `status`（只读）：本机应显示 12 providers、43 allowlist models（以实际环境为准）
