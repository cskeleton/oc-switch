# OpenClaw 2026.9 模型选择器与停用修正

## 依据与问题

2026-09-11 核对本机 OpenClaw 2026.9.3（1391f7c）的随包文档及 dist 代码：

- https://docs.openclaw.ai/concepts/models ：`models.providers` 是配置目录，`agents.defaults.models` 是别名/参数，`agents.defaults.modelPolicy.allow` 是选择策略。迁移前旧 models 映射仍可限制；`meta.migrations.modelPolicyAllowlist=true` 或已存在 policy 对象后不再恢复旧限制。
- https://docs.openclaw.ai/tools/plugin ：`plugins.entries.<id>.enabled=false` 保留配置并阻止插件激活；环境变量留有凭据不代表用户希望使用该插件。
- `src/auto-reply/reply/commands-models.ts`：IM 默认浏览使用 prepared catalog 与 visibility policy，并补入 exact policy、primary/fallback；停插件却保留 exact 规则会继续显示悬空选项。
- `src/gateway/server-methods/models-list-result.ts`：`models.list` 默认视图是运行中 Gateway 的选择器投影。CLI `models list` 与 `--all` 不是该投影，不能用完整目录冒充 IM 列表。
- `src/config/model-policy-allowlist-migration.ts`：迁移标记与空 policy 对象必须参与 legacy 判定。

旧实现把完整目录、停用插件、未选择的配置全部归入待处理；Provider 关闭仅删除 metadata、不改 authoritative policy；同步 shell-out 串行阻塞 HTTP。只读基线：插件探测约 1519ms，四条模型探测约 5904ms；CLI 配置列表 134 行，Gateway 选择器 46 行（数量会随用户配置变化）。

## 行为

1. 日常模型视图展示 Gateway 默认选择器结果。管理视图允许查看配置目录及待启用项；完整目录仅作诊断证据，不自动制造待处理任务。Gateway 不可达时明确标注推算/未确认，不宣称与在线 IM 一致。
2. 策略允许、运行可用性、选择器可见性、主动停用独立。仅当前选用/主模型/fallback 的不可用项算待处理；未选择的 metadata 和已停用项不持续警告。
3. 停用保留 `.env` 全部内容。插件写 `enabled=false`，并移出该插件所贡献 Provider 的选择规则；Provider 关闭同样移出选择规则。恢复保存的规则。用户可选择保留或清理相关目录/metadata，清理必须可通过自动备份恢复。
4. Provider/插件级明确停用允许移除属于该目标的完整 wildcard 规则（这是旧规格只读 wildcard 的限定例外）；不得展开 wildcard、修改其他 Provider 规则。单模型操作仍拒绝 wildcard。不得把 restricted 清成 `[]`；可保留其他有效规则或主模型，无法安全表达时拒绝。开放策略下明确停用需建立保留当前其他可见模型的策略，缺少可靠目录时拒绝。
5. primary/fallback 与其他 Agent 显式依赖阻止停用；凭据不会被删除。未知插件不能凭空创建。已停用内置插件仅在折叠管理入口显示插件名，不展开全部模型。

## 性能与一致性

- 同步解析保留供纯测试/旧消费者使用；生产 HTTP 使用异步、有超时与输出上限的子进程，独立探测并行。
- 缓存绑定 config/env 路径及文件版本；同一 scope 合并并发请求，写后失效，旧请求不能覆盖新 scope。
- 事务支持异步 fresh preflight，外部变更继续重新读/重试一次；未知可用性不能被缓存误报成可运行；主动移除精确规则只减少选择范围，仍受主模型/fallback/wildcard/最后一条规则保护。
- Providers 主列表不等待不相关的参数队列、迁移诊断；隐藏插件详情按需渲染。

## 验证

纯逻辑覆盖 migrated/legacy/empty policy、picker 与完整目录区别、停用/恢复/可选清理、wildcard 与 primary/fallback/Agent 保护、密钥原样保留。HTTP 覆盖并发去重、失效期间旧请求完成、异步探测不阻塞其他路由、失败明确降级。Web 验证默认视图、停用组折叠、待处理消退和清理选项。最后运行项目 check、acceptance 与隔离浏览器 E2E；真实用户配置仅只读核对，不擅自停用具体 Provider。


## 实现后 Sync Audit（2026-09-11）

- Server 与 CLI 均改为异步探测并复用解析器；新增 Gateway `models.list` / `config.get` 白名单调用，后者只比较路径/应用版本，不缓存认证原文。
- 默认视图、目录管理和折叠插件入口已分开；已停用但仍在 IM 留有选项时可整组移出。纯低层插件开关保留兼容性，用户入口均组合 selection suspension。
- Provider 快照增加 `policyEntries`，插件规则保存于受权限保护的 `plugin-selection-states.json`；支持重复停用与旧快照补应用，保留重复 wildcard。恢复不覆盖新 metadata，不越过独立 Provider 停用。
- Core 对主动停用与探测未知分开处理：不会推断缺失；精确引用可安全收窄，其他编排能力仍由可用性门禁控制。尚未提供修改其他 Agent 独立策略的界面，依赖冲突明确拒绝。
- 只读实测（当前配置）：并发读取 inventory/providers/config-status 首次约 3097ms，缓存命中约 6ms；Gateway 模型选项 46 条，待处理 0、配置 issue 0，未启用 anthropic 模型行 0。配置及 `.env` 哈希前后相同。旧串行基线约 7423ms。
- 用 OpenClaw 2026.9.3 自身的 `createModelVisibilityPolicyWithFallbacks` 对隔离配置验证：停用目标 Provider 后只剩另一个主模型，恢复后原选项回归，metadata 保持。
- 最终验证通过：`bun run check`（1032 项 Core/CLI/Server + 205 项 Web 测试，typecheck、build）、`bun run acceptance`、`bun run test:e2e`（36 个桌面/手机用例）；未修改真实用户配置、未提交或发布。
