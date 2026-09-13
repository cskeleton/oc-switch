# oc-switch 三层写模型与删除分级设计

- 日期：2026-09-13
- 状态：已实施（2026-09-13）
- 上游依据：OpenClaw 官方 Models 文档（"The catalog supplies browse choices and model metadata. **It is not an implicit allowlist.**" / "`openclaw models set`… never change `modelPolicy.allow`"）+ OpenClaw 2026.9.3 随包源码实测
- 关联规格：`2026-09-11-model-picker-and-disable-design.md`（选择器与停用）、`2026-09-09-oc-switch-runtime-model-management-design.md`（统一 inventory）

## 1. 背景与问题

用户心智模型（经官方文档与源码实测验证成立）：OpenClaw 的模型配置是**三个独立层**：

| 层 | 字段 | 语义 |
|----|------|------|
| ① 目录层 | `models.providers` | 浏览选项与模型 metadata；**不是隐式 allowlist** |
| ② 使用配置层 | `agents.defaults.models` | alias / per-model 参数；官方明确与策略解耦 |
| ③ 选择/策略层 | `agents.defaults.modelPolicy.allow` + `agents.defaults.model` | picker 显示「目录行 ∩ policy 可见性」；wildcard 自身不产生选项行 |

补充事实：精确放行与通配放行**混用合法**（`cpa/*` + 别家 exact），oc-switch 不强制二选一，只坚持「永不隐式改写用户的 wildcard」。

当前实现与三层模型的差距：

1. **删除模型被 wildcard 误伤**：`assertNoPolicyWildcardForRef` 是 2026-09-04 为 **disable** 设计的（禁用 wildcard 选中的模型只能把通配改写成枚举挖洞，违反纪律，fail closed 正确），但被无差别套到了 **remove** 上。按三层语义，删目录条目后模型自然从 IM picker 消失，policy 一个字节不用动。
2. **删除无分级**：`removeProviderModel` 总是同时删 ① 目录、② metadata、③ policy exact，用户无法只做「临时移除」。
3. **discover 401 无前置检查**：config 条目缺 `apiKey` 时（如本机 deepseek），`discoverProviderModels` 静默发无认证请求吃服务端 401，且不回退使用同名插件 manifest 声明的 `apiKeyEnvVars`（尽管变量就在 `.env` 里）。
4. **UI gating 不一致**：ModelsView 对 wildcard 覆盖行隐藏删除按钮，Providers 页 `ProviderModelsDialog` 的行删除只看 readOnly 不看 wildcard——用户从未设防入口撞到服务端 fail closed。

## 2. 设计决策

### 2.1 删除路径放宽（wildcard guard 降级为 warning）

- `removeProviderModel` / `batchRemoveProviderModels` / `removeProvider` **不再**调用 `assertNoPolicyWildcardForRef` / `assertNoPolicyWildcardForProvider`。
- 删除成功但被删 ref 仍被 wildcard 覆盖时，在 `OperationResult.warnings` 携带提示：「仍被 `<wildcard>` 覆盖——重新加入目录将自动恢复可选，且精确输入仍可显式选中」。这是 wildcard 的忠实含义，降级为提示而非硬阻断。
- **保留不动的 fail-closed**：disable / rename / 删 policy exact 引用（`removeModelPolicyExactRef`）的 wildcard guard；primary/fallback 命中保护（`force` 不可绕过）；删除最后一条 restricted exact 的防清空；unknown 可用性门禁。

### 2.2 删除分级：临时移除 vs 彻底清理

删除对话框显式列出层级选择，默认安全：

- **默认「临时移除」**：只删 ① 目录条目 → IM 立即看不到，随时可加回。
- 可选「连同使用配置」：删 ② 的 alias / params / agentRuntime metadata。
- 可选「连同精确放行」：删 ③ 的 exact 条目；有 wildcard 覆盖时此项置灰并说明「已被通配覆盖，无需操作」。
- **API Key 永不在删除范围内**；primary/fallback 命中的删除仍 fail closed。

Core API 形态：`removeProviderModel` / `batchRemoveProviderModels` 的 options/input 增加可选 `layers: { metadata?: boolean; policyExact?: boolean }`；**缺省保持旧行为（三层全删）**，以免 CLI 与既有调用方语义漂移；Web 删除对话框显式传层级（默认只传目录层）。只有实际删除 policy exact 时才套用防清空 guard。

Provider 级删除同理放宽：残留的 `cpa/*` 规则成为「悬空 wildcard」，**不自动删**；删除对话框提供显式勾选项「同时删除 policy 中该 Provider 的通配规则」（用户显式删规则 ≠ 我们隐式改写），对应 `removeProvider` 新增 `removePolicyWildcard?: boolean`（默认 false，仅在显式 true 时移除该 Provider 的 wildcard 条目）。

### 2.3 写入联动矩阵（oc-switch 的职责边界）

每个写操作在 diff 预览 / 确认文案里显式列出触碰了哪几层：

| 操作 | ① 目录 | ② 配置 | ③ 策略 |
|------|--------|--------|--------|
| 发现 + 添加模型 | 加 | — | —（restricted 下勾选「同时启用」才加 exact） |
| 启用模型 | — | — | wildcard 已覆盖 → 不写；否则加 exact |
| 删除模型 | 删 | 可选 | 可选（exact） |
| 设主模型 | — | — | 只写 `model.primary` |
| Provider/插件停用 | — | — | 唯一例外：移出该目标 exact+wildcard 规则（2026-09-11 spec 已批准） |
| Provider 删除 | 删 | 删 metadata | exact 同步删除；wildcard 仅显式勾选才删 |

### 2.4 discover 未配置 Key 前置检查 + 插件 manifest 回退

- `ProviderDiscoverOptions` 新增 `pluginProviders?: PluginProvider[]`（由 server/CLI 注入当前插件目录，保持测试隔离注入缝）。
- config 条目经 `providerEnvVar` 解析不到 Key 时，回退查找**同名（大小写折叠）插件 Provider** 的 `apiKeyEnvVars`（已按含 `API_KEY` 优先排序，取首个），从 `.env` 内容读取。
- 若插件 manifest 声明了 env 变量但 `.env` 中全部缺失/为空：**发请求前**抛出清晰错误（「Provider X 未配置 API Key；请在 .env 设置 YYY 或在 Providers 页设置 Key」），不再静默发无认证请求吃 401。
- 纯 config Provider 且无插件 manifest 信息（如本地 ollama 无认证场景）：维持现状发无认证请求；但 HTTP 401/403 的报错文案补充「未配置 API Key 或 Key 无效」提示。

### 2.5 UI 一致性

- `ProviderModelsDialog` 行删除与 ModelsView 对齐：同一删除对话框、同一层级选项、同一 warning 展示（删除成功后 toast 展示 warnings）。
- 删除入口不再对 wildcard 覆盖行隐藏（服务端已放宽）；插件 Provider（readOnly）仍无删除入口。

## 3. 明确不做

- wildcard 永不隐式改写 / 挖洞 / 去重 / 改大小写；唯一例外仍是 Provider/插件停用（2026-09-11 spec）。
- CLI 删除命令不加层级 flag（保持三层全删旧默认）；层级选择是 Web 对话框能力，API 层以 `layers` 参数支持。
- API Key 不进入任何删除范围；不自动清理 `.env`。
- `meta.migrations` / legacy 三态语义不变。

## 4. 验收

- `bun run check`（单测 + typecheck + build）、`bun run acceptance`、`bun run test:e2e` 全绿。
- 真机只读核对：restricted + `cpa/*` wildcard 下删除 `cpa/ag/deepseek-v4-flash` 全程（删前被阻断 → 现在成功且带 warning；policy 字节不变）；deepseek discover 走 `DEEPSEEK_API_KEY` 回退返回 200。
- 测试更新：`model-policy-sync.test.ts` 中「remove 被 wildcard 阻断」断言改为「成功 + warning」；新增层级选项与 discover 回退用例。
