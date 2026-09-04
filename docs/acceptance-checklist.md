# oc-switch 验收清单

> 映射 `docs/superpowers/specs/2026-06-23-oc-switch-design.md` §10 验收标准与 §10.1 Fixture 用例。  
> 自动化入口：`bun run check`、`bun run acceptance`、`bun run test:e2e`。

---

## §10 功能验收

> 兼容说明：本节及下方旧 fixture 中凡只写“allowlist”而未明确 `modelPolicy.allow` 的验收，均指 legacy mode 下的 `agents.defaults.models` 行为；不得用这些行推导 restricted mode 的 effective selection。Model policy 兼容性以本页 P1–P9 为准。

| # | 验收项 | 验证方式 | 命令 / 测试 |
|---|--------|----------|-------------|
| 1 | legacy mode 下完整读取现有 12 个 provider 与 43 个 `agents.defaults.models` allowlist 模型 | 只读真实配置 smoke | `OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" bun run packages/cli/src/index.ts status` |
| 2 | legacy mode 下从 preset 添加 provider 后 `models.providers` 与 `agents.defaults.models` 同步 | 单元 + REST | `packages/core/test/operations.test.ts`（adds provider…）；`packages/server/test/app.test.ts`（POST /api/providers） |
| 3 | API Key 写入 `.env`，JSON 保持 env 引用 | 单元 | `packages/core/test/env-manager.test.ts`；`packages/core/test/transaction-writer.test.ts` |
| 4 | 写入前自动备份，回滚后与备份一致 | 单元 + CLI + REST | `packages/core/test/backup-manager.test.ts`；`packages/cli/test/cli.test.ts`（restores backup）；`packages/server/test/app.test.ts`（POST restore） |
| 5 | 写入不影响 `acp`、`channels` 等非目标字段 | 单元 | `packages/core/test/diff-guard.test.ts`；`packages/core/test/diff.test.ts` |
| 6 | WebGUI 在 iPad Safari 尺寸可添加 provider 与切换模型 | Playwright e2e | `bun run test:e2e`（mobile 390×844 viewport） |
| 7 | CLI `use` 与 WebGUI 切换 primary 行为一致 | 单元 + e2e | `packages/cli/test/cli.test.ts`（uses slash-containing model ref）；`packages/web/test/e2e/webgui.e2e.ts` |
| 8 | `provider sync` 从远端发现模型（默认不写盘）；`--add` 按需 batch-add | 单元 + CLI | `packages/core/test/provider-sync.test.ts`；`packages/cli/test/cli.test.ts`（provider sync / sync --add）；详见 `2026-07-09-oc-switch-provider-model-discover-design.md` |
| 9 | VPS `serve --host 0.0.0.0 --token` 可通过浏览器管理 | 单元 + 文档 | `packages/core/test/token-manager.test.ts`；`packages/cli/test/cli.test.ts`（serve rejects 0.0.0.0）；README VPS 章节 |
| 10 | 无 API Key 泄漏 | 全套件 + smoke | `bun run acceptance`；各测试文件 `not.toContain("sk-")` 断言 |

## Model policy 兼容性验收

| # | 验收项 | 验证方式 | 命令 / 测试 |
|---|--------|----------|-------------|
| P1 | claw-like restricted 配置中 `cpa/*` 与 `grok2api/*` 按 provider-wide wildcard 生效，不展开或删除用户 wildcard | Core + REST fixture | `packages/core/test/model-policy.test.ts`；`packages/server/test/app.test.ts` |
| P2 | policy-only exact refs 识别为 `restricted` / `policy-exact`；不在本地目录的 ref 不虚构模型 | Core + status DTO | `packages/core/test/config-status.test.ts` |
| P3 | `modelPolicy.allow` 缺失=`legacy`，存在空数组=`unrestricted`，两者不可混淆；restricted 下 `agents.defaults.models` 仅为 metadata | Core + REST | `packages/core/test/model-policy.test.ts`；`packages/server/test/app.test.ts` |
| P4 | `ModelSummary.selectionSource`、`StatusSummary.modelPolicyMode`、`effectiveModelCount` 正确，兼容保留 `allowlistModelCount` | Core + Web API contract | `packages/core/test/config-adapter.test.ts`；`packages/web/src/api.test.ts` |
| P5 | exact policy entry 可切换；provider-wide/namespace wildcard 无法安全表达单模型或 Provider disable 时拒绝，`force` 也拒绝 | Core mutation tests | `packages/core/test/model-operations.test.ts`；`packages/core/test/operations.test.ts` |
| P6 | Provider disabled state 与 policy availability 独立：disabled Provider 不可有效启用，恢复不改 policy；rename、batch cleanup 遵守 wildcard/fallback fail-closed 规则 | Core + acceptance fixture | `packages/core/test/operations.test.ts`；`bun run acceptance` |
| P7 | `health:model-policy-not-covered:modelPolicy.allow` 使用 `health` source、warning severity 和固定全局 ID；detail/action 说明 legacy metadata 未被非空 policy 覆盖及修复方向 | Config-status contract | `packages/core/test/config-status.test.ts` |
| P8 | `ConfigStatusReport.modelPolicy` 返回固定 `mode`、`policyEntryCount`、`effectiveCatalogCount`、`unknownProviderRefs`；unknown refs 仅 exact ref、仅 refs、info raw fact，不虚构本地目录 | Config-status contract | `packages/core/test/config-status.test.ts` |
| P9 | 非数组 `allow` 按 legacy 处理并产生 blocking `health:invalid-model-policy-allow:modelPolicy.allow`；非字符串数组项保留但忽略匹配，并按 zero-based index 产生 blocking `health:invalid-model-policy-entry:modelPolicy.allow[<index>]` | Config-status contract | `packages/core/test/config-status.test.ts` |

---

## 模型参数建议与运行上下文（Models.dev）

> 映射 `docs/superpowers/specs/2026-06-25-oc-switch-model-editing-design.md` §4.4 与 §10。

| # | 验收项 | 验证方式 | 命令 / 测试 |
|---|--------|----------|-------------|
| S1 | 在线建议：固定两个 Models.dev URL 下载、归一化并按 6 级规则本地匹配（含核心 ID 归一化回退） | 单元 | `packages/core/test/model-metadata-catalog.test.ts`；`packages/core/test/model-metadata-resolver.test.ts` |
| S2 | 缓存建议：24h fresh TTL、ETag/304、30 天内 stale 回退并标注「缓存数据」 | 单元 | `packages/core/test/model-metadata-catalog.test.ts` |
| S3 | 无匹配：返回空建议与提示，不猜测（latest/模糊相似度不命中；日期/思考等级/路由后缀差异经确定性核心 ID 回退匹配并标注置信度） | 单元 | `packages/core/test/model-metadata-resolver.test.ts` |
| S4 | 离线回退：目录失败时空建议 + warning，不阻止保存；前端 error 状态可手工填写 | Server + UI + e2e | `packages/server/test/app.test.ts`（目录错误）；`packages/web/src/views.test.tsx`（not-found/error/stale）；`bun run test:e2e`（500 手工保存） |
| S5 | 手动覆盖：三字段可选、可留空；快捷按钮写入完整整数；建议仅在显式点击后应用 | UI + e2e | `packages/web/src/views.test.tsx`（快捷按钮/应用/全部应用）；`bun run test:e2e` |
| S6 | 三字段 round-trip：`contextWindow` / `contextTokens` / `maxTokens` 写入、读取、清空；`contextTokens > contextWindow` 双层拦截 | 单元 + REST + UI | `packages/core/test/model-operations.test.ts`；`packages/server/test/app.test.ts`；`packages/web/src/views.test.tsx` |
| S7 | 无 secret 外发：请求 URL/body/header 不含 API Key、baseUrl、Provider ID、Model ID | 单元 + REST | `packages/core/test/model-metadata-catalog.test.ts`（allowlist URL）；`packages/server/test/app.test.ts`（fetch mock 断言） |
| S8 | 查询不改配置：建议查询前后 `openclaw.json`/`.env` 完全相同、不创建 backup；缓存只落 `stateDir` | REST + e2e | `packages/server/test/app.test.ts`；`bun run test:e2e`（fixture server） |
| S9 | 核心 ID 回退与 modalities：精确落空后核心 ID 匹配（medium/low 标注）；建议卡展示输入/输出类型，应用仅写入 input | 单元 + UI | `packages/core/test/model-id-core.test.ts`；`packages/core/test/model-metadata-resolver.test.ts`；`packages/web/src/views.test.tsx` |

---

## §10.1 Fixture 验收用例

| Fixture | 说明 | 验证方式 | 命令 / 测试 |
|---------|------|----------|-------------|
| slash-model-ref | `nvidia/deepseek-ai/deepseek-v4-flash` → provider `nvidia`，modelId `deepseek-ai/deepseek-v4-flash` | 单元 + CLI + smoke | `packages/core/test/model-ref.test.ts`；`packages/cli/test/cli.test.ts`；`bun run acceptance` |
| provider-id-storage-normalization | `DeepSeek/Model-X` 写入为 `deepseek/Model-X`，model ID 保持原样；同名 Provider 块冲突时拒绝静默覆盖 | 单元 | `packages/core/test/config-normalization.test.ts`；`packages/core/test/transaction-writer.test.ts` |
| allowlist-value-preserve | legacy mode 下更新 alias 时保留 `agentRuntime` 与未知字段 | 单元 | `packages/core/test/operations.test.ts`；`packages/core/test/config-adapter.test.ts` |
| provider-delete-scope | legacy mode 下删除 `nvidia` 只移除首段为 `nvidia` 的 `agents.defaults.models` allowlist | 单元 | `packages/core/test/operations.test.ts` |
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
- 真实配置 `status`（只读，legacy-mode compatibility baseline）：本机应显示 12 providers、43 `agents.defaults.models` allowlist models（以实际环境为准）
