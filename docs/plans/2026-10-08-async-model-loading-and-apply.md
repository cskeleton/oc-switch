# oc-switch 异步模型信息加载与显式运行时确认执行计划

状态：已实施；验证与测量记录见文末。

## Goal

让模型、Provider 和仪表盘页面先展示能够从本地配置直接得到的内容，再异步补充插件目录、OpenClaw 运行时目录和 Gateway 状态。用户执行保存或确认后，立即知道本地配置是否已经写入；普通保存完成后不自动重新触发完整探测，用户点击「检查并确认」时才为这次变更等待完整运行时核验。

耗时操作必须在界面上显示明确的阶段和进行中状态。失败时要区分「本地配置已保存」与「运行时未确认」，不能把写入成功显示成失败，也不能把未完成的运行时检查显示成成功。

## Context

- 本地 JSON/JSON5 与 `.env` 读取很快；当前冷 inventory 的关键路径会启动插件目录、OpenClaw 模型目录和 Gateway 查询。`openclaw models status --json` 是当前实测的主要耗时来源。
- `packages/server/src/context.ts` 已有插件目录和运行时目录的独立缓存与在途请求复用。
- `GET /api/model-inventory` 与 `POST /api/model-inventory/refresh` 已能返回完整 inventory；`refresh` 将作为显式「检查并确认」的后端入口，不新增第二套探测算法。
- `GET /api/models`、`GET /api/providers` 当前为了合并插件 Provider 会等待插件目录；`Dashboard`、`ModelsView`、`ProvidersView` 的首轮加载仍把静态数据和完整 inventory 放在同一个等待批次。
- 写响应已经有 `runtimeConfirmed`、`diagnostics` 和可选 `inventory` 语义，前端也有 `inventoryFromWriteResponse`、`LoadingNotice`、Toast 和代次防乱序逻辑，可在此基础上扩展。

## Constraints

- Core 仍是唯一配置 writer；JSON5 读取、备份、回滚、写前外部变化检查、主模型/fallback 保护和 policy revision 冲突继续保留。对于 `models.providers` 中已明确存在的配置模型，普通保存不以在线 availability 为前提；运行时-only 模型、materialize、插件/Provider 选择协调仍使用现有必要的 unknown/fresh 门禁。
- 不用“静态目录”伪装成“运行时可用”。静态视图与完整 inventory 使用不同请求/状态，不把尚未加载误标为 `available` 或把加载中误标为 `unknown`。
- 不新增后台轮询、WebSocket、数据库、worker 池、全局工作流引擎或通用缓存框架。异步加载只使用现有 HTTP 请求、缓存和页面状态。
- 不默认改变旧 API 的响应语义；现有调用方不带参数时保持兼容。Web 使用新的显式静态读取接口。
- 不为了“更安全”扩大阻断范围。仅保留已有的 primary/fallback、unknown 目录条目、policy 防清空和 revision 冲突保护；运行时完整核验从普通展示/静态保存关键路径移到显式确认动作。
- 本计划只涉及代码和测试，不包含 commit、push、部署、重启常驻服务或修改真实 OpenClaw 配置。

## Implementation

### Task 1: 定义静态读取与运行时读取的接口边界

**Objective**

让页面可以只读取本地配置而不触发插件目录和运行时探测，同时保留旧端点默认行为。

**Relevant files**

- `packages/server/src/routes/models.ts`
- `packages/server/src/routes/providers.ts`
- `packages/server/src/routes/health.ts`
- `packages/server/src/routes/model-inventory.ts`
- `packages/core/src/model-operations.ts`
- `packages/core/src/provider-operations.ts`
- `packages/core/src/model-config-snapshot.ts`（新增）
- 对应运行时管理 spec 与 `AGENTS.md` 领域约定
- `packages/server/src/context.ts`
- `packages/web/src/api.ts`
- 相关 server/web API 测试

**Implementation**

1. 新增 `GET /api/model-config`，返回独立的 `StaticModelConfigSnapshot` DTO：`schemaVersion`、`capturedAt`、配置 Provider、配置模型、主模型、policy mode/rules/revision，以及脱敏的 API Key 状态。fallback 只在 Core 计算静态保护权限，不返回或显示回退链。该 DTO 不包含 `availability`、`pickerVisible`、`needsAttention` 或插件模型字段。
2. 新增 `GET /api/model-extensions`，只返回插件 descriptors、插件 Provider 目录和插件诊断。它只调用 `currentPluginCatalog()`，不启动 runtime model probes；与完整 inventory 并发时必须复用 context 已有的 plugin in-flight/30 秒缓存。
3. 静态 config snapshot 只读取 `openclaw.json`、`.env` 和现有 state 文件；不得调用 `currentPluginProviders()`、`buildCurrentInventory()` 或 OpenClaw 子进程。Core 可新增 `packages/core/src/model-config-snapshot.ts`，复用现有 config adapter、primary-model 和 policy 解析。
4. 保留 `GET /api/models`、`GET /api/providers` 的旧默认语义，避免破坏 CLI、旧 Web 或外部消费者；新 Web 首屏只使用 `/api/model-config`。Dashboard 的快速统计从 snapshot 派生，不等待插件目录；完整插件计数随 extensions/runtime 阶段单独补充。
5. `packages/web/src/api.ts` 增加 `StaticModelConfigSnapshot`、`PluginExtensionsSnapshot`、`getModelConfig()`、`getModelExtensions()`；完整 inventory v2 校验继续保留。
6. 在 server 测试中注入会抛错或计数的 plugin/runtime provider，证明 config-only 请求不触发任何探测、extensions 请求只触发插件探测；同时证明旧默认请求仍能取得插件数据。

**Depends on**

无。

**Verification**

```sh
bun test packages/server/test packages/web/src/api.test.ts
```

额外断言静态 API 的响应在延迟插件 provider 存在时仍先返回，且调用计数为零。

**Done when**

静态 snapshot 只做本地读取，extensions 只做插件读取，旧请求兼容，接口测试覆盖静态、插件和完整三种数据来源。

### Task 2: 将三个页面改成“静态首屏 + 运行时后台阶段”

**Objective**

页面先显示 CPA 和其他本地配置模型，再独立加载插件/运行时信息；运行时加载期间不遮挡已经可用的静态内容。

**Relevant files**

- `packages/web/src/views/Dashboard.tsx`
- `packages/web/src/views/ModelsView.tsx`
- `packages/web/src/views/ProvidersView.tsx`
- `packages/web/src/components/LoadingNotice.tsx`
- `packages/web/src/components/PluginProviderGroup.tsx`
- `packages/web/src/api.ts`

**Implementation**

1. 每个页面拆成三个请求阶段，静态先显示，后两者独立更新：
   - `loadStatic`：`getModelConfig()`、健康/差异等本地数据，完成后立即渲染主体。
   - `loadExtensions`：`getModelExtensions()`，完成后只更新插件区域。
   - `loadRuntime`：`getModelInventory()`、attention 和依赖它们的 config-status，完成后覆盖/补充运行时字段；与 `loadExtensions` 并发时依赖 server cache 复用同一次插件探测。
2. `ModelsView` 先用 snapshot 中的配置模型展示本地模型；完整 inventory 未到达时，运行时能力按钮显示为加载中或暂不可用，不自行推断 `pickerVisible`、`needsAttention` 和 `availability`。
3. `ProvidersView` 先显示 snapshot 中的配置 Provider；插件分组独立显示加载占位，extensions 到达后先显示插件 Provider/非模型能力，inventory 到达后再补充插件模型和运行时状态。
4. `Dashboard` 先显示状态、健康和差异；模型 attention 区域单独显示运行时加载状态，不让整个仪表盘保持全屏 spinner。
5. 页面切换或手动刷新时保留现有 request sequence/代次检查，旧 runtime 响应不得覆盖新静态视图。静态阶段失败与 runtime 阶段失败分开显示。
6. 页面不重复请求 `/api/meta`；连接握手仍由 `App.tsx` 管理。

**Depends on**

Task 1 的静态 API。

**Verification**

- Web 组件测试：延迟 runtime 请求时，静态 Provider/模型先出现。
- Web 组件测试：runtime 成功后插件和 availability 字段出现；runtime 失败时保留静态内容并显示明确提示。
- 乱序测试：旧 runtime 响应不能恢复旧列表或旧错误。

**Done when**

冷加载时用户先看到自己的本地配置；插件/运行时延迟不会让页面看起来完全卡死。

### Task 3: 建立统一的异步操作进度提示

**Objective**

用户点击保存、刷新或检查并确认后，能够知道操作正在执行、当前阶段和最终结果。

**Relevant files**

- `packages/web/src/components/LoadingNotice.tsx`
- 新增 `packages/web/src/components/OperationProgress.tsx`（或等价小组件）
- `packages/web/src/views/ModelsView.tsx`
- `packages/web/src/views/ProvidersView.tsx`
- `packages/web/src/views/Dashboard.tsx`
- `packages/web/src/components/PluginProviderGroup.tsx`
- 现有 Toast 组件与测试

**Implementation**

1. 统一操作状态至少包含：`idle`、`saving`、`loading-plugin`、`checking-runtime`、`success`、`partial`、`error`。
2. 进度提示使用真实阶段，不显示没有依据的百分比：
   - `正在保存本地配置…`
   - `正在读取插件目录…`
   - `正在检查 OpenClaw / Gateway…`
   - `配置已保存，在线状态待确认`
3. 提示同时满足 `role="status"` 和 `aria-live="polite"`；按钮在对应操作进行中变成“保存中…”、“检查中…”，防止重复提交。
4. 成功结果显示“本地配置已保存”；若没有运行时确认，显示“已保存，在线状态待确认”，并提供「检查并确认」或「刷新探测」入口。OpenClaw 可能热加载配置，不得绝对声称“尚未应用”。
5. 错误结果保留已经成功写入的状态，不把后续探测失败包装成写入失败；Toast 与页面内提示使用一致文案。
6. 不做假进度条、不做无限重试、不把后台加载错误静默成空列表。

**Depends on**

Task 2 的分阶段加载状态。

**Verification**

- Web 测试覆盖延迟 promise、失败 promise 和写入成功但 runtime 未确认三种状态。
- 键盘/辅助技术检查 `role=status`、`aria-live` 和按钮禁用状态。

**Done when**

每个可能持续数秒的用户触发操作都有可见且可读的进行中反馈，结束后能区分成功、部分成功和失败。

### Task 4: 增加显式“检查并确认”流程

**Objective**

把悬空引用、Gateway 是否已读取新配置和完整运行时状态检查从普通读取/静态保存中移出，放到用户主动确认的动作中。

**Relevant files**

- `packages/server/src/routes/model-inventory.ts`
- `packages/server/src/routes/models.ts`
- `packages/server/src/routes/providers.ts`
- `packages/server/src/routes/plugins.ts`
- `packages/server/src/context.ts`
- `packages/core/src/model-operations.ts`
- `packages/core/src/provider-operations.ts`
- `packages/core/src/model-policy-edit.ts`
- `AGENTS.md` 与对应运行时管理 spec
- `packages/web/src/api.ts`
- `packages/web/src/views/ModelsView.tsx`
- `packages/web/src/views/ProvidersView.tsx`
- `packages/web/src/views/Dashboard.tsx`

**Implementation**

1. 复用 `POST /api/model-inventory/refresh` 作为完整运行时检查入口；UI 将其呈现为「检查并确认」，不新增名义上的第二个 apply 探测接口，也不在该动作中自动重启 Gateway。
2. 按页面提供一个明确入口：有本地变更、在线状态待确认或用户手动要求检查时显示；点击后显示 Task 3 的阶段提示。
3. 检查完成后统一更新 inventory、attention 和必要的 config-status；不再由多个子组件各自发起完整探测。
4. 若 Gateway 未确认，显示原因和下一步（例如到设置中使用现有「同步并重启 Gateway」），但不自动重试、不自动重启 Gateway。
5. 对普通静态保存，响应可以立即结束并标记 `onlineStatusPending`/`runtimeConfirmed:false`；保留现有 API 默认确认语义，Web 通过明确参数选择不等待写后完整确认。该选项只跳过写后完整确认，不跳过事务、备份、外部变化检查和必要的静态校验。
6. 对 `models.providers` 中已明确存在的配置模型，主模型切换、启用/禁用、metadata/参数编辑和目录删除采用配置层校验后快速保存：检查 Provider 是否存在/被 oc-switch 停用、primary/fallback、wildcard、防清空和 revision 等配置事实；在线 availability 留给显式「检查并确认」。这项语义调整必须先写入新的运行时管理 spec 与 `AGENTS.md`，不能作为隐式性能绕过。
7. 运行时-only 模型、materialize、插件/Provider 停用与选择器收窄、需要 Gateway visibleRefs 的操作继续取得 fresh inventory；policy 规则编辑对 config Provider 用静态 knownProviderIds，涉及插件 Provider 时用 extensions 已确认的 knownProviderIds，写后完整确认移到显式「检查并确认」。
8. 为当前支持写后确认的写接口增加 `confirmRuntime:false` 选项；新 Web 快速保存传入此选项，省略时保持原确认行为。不要只改 Web `await load()` 而让 server 写路由继续隐式等待完整探测。

**Depends on**

Tasks 1–3。

**Verification**

- server 测试：静态保存选项不等待写后 runtime confirmation；显式 refresh 仍执行完整探测并返回 diagnostics/inventory。
- server 测试：primary/fallback/revision 保护不变；配置目录保存不以在线 availability 为前提，runtime-only/插件协调的 unknown/fresh 门禁保持。
- Web 测试：保存成功后出现在线状态待确认；点击检查并确认后更新完整 inventory。

**Done when**

普通本地保存不再隐式等待完整运行时探测；用户主动检查并确认后仍能得到完整悬空引用和 Gateway 状态结果。

### Task 5: 收窄无用的重复探测和刷新

**Objective**

在分阶段加载生效后，删除仍会触发重复完整探测的调用，保持一次用户动作只刷新一次必要数据。

**Relevant files**

- `packages/server/src/routes/model-inventory.ts`
- `packages/server/src/routes/models.ts`
- `packages/server/src/routes/providers.ts`
- `packages/server/src/routes/model-attention.ts`
- `packages/web/src/views/ModelsView.tsx`
- `packages/web/src/views/ProvidersView.tsx`
- `packages/web/src/views/Dashboard.tsx`

**Implementation**

1. 写响应携带有效 inventory 时，页面直接消费该 inventory；无有效 inventory 时只标记在线状态待确认，不立即自动再 GET。
2. 删除只用于守卫但没有消费结果的 inventory 读取；若操作确实需要 fresh inventory，保留并在代码注释中说明保护对象。
3. attention/config-status 在同一刷新责任方内各读一次；子面板只消费父页面结果。
4. 普通静态刷新不清空仍可用的本地视图；runtime 更新到达后局部替换状态。

**Depends on**

Tasks 2–4。

**Verification**

使用带调用计数的 server fixture 和 Web request mock，验证一次保存/确认的端点次数；运行现有刷新乱序回归。

**Done when**

一次用户动作不会再触发重复 inventory/attention 请求，且没有为了减少请求而跳过已有安全保护。

### Task 6: 端到端验证与基线对比

**Objective**

证明用户感知的首屏速度和操作反馈得到改善，并确认运行时功能仍可用。

**Relevant files**

- `packages/server/test/**`
- `packages/web/src/**/*.test.tsx`
- `packages/web/src/api.test.ts`
- `packages/web/test/e2e/**`
- `scripts/acceptance-smoke.ts`

**Implementation**

1. 使用隔离的 fake `openclaw`：静态请求禁止调用它；runtime 请求按命令回放并可人为延迟。
2. 覆盖桌面和窄屏：静态内容先显示、插件区加载提示不撑坏布局、运行时失败提示可见。
3. 对冷启动静态 API、完整 inventory、显式确认分别测量，不把暖缓存结果当作冷启动结果。

**Verification**

```sh
bun test packages/core packages/cli packages/server scripts
bun test --preload ./packages/web/src/test-setup.ts packages/web/src
bun run typecheck
bun run build
bun run acceptance
bun run test:e2e
```

另做一次本地隔离 API 测量，记录：静态请求的外部命令数、完整 runtime refresh 的命令数、保存按钮到“本地已保存”的耗时、确认按钮到最终状态的耗时。

**Done when**

首屏静态内容不等待 OpenClaw 子进程；所有耗时阶段可见；完整运行时确认仍能报告悬空引用、Gateway 未确认和探测诊断；现有核心测试、类型检查、构建和隔离 E2E 通过。

## Integration / Final Verification

1. 首次打开 Models/Providers/Dashboard：先出现本地配置，随后出现“正在加载插件/运行时状态”，最终合并完整信息。
2. 编辑 CPA Provider 或本地模型：保存响应先完成，页面显示“已保存，在线状态待确认”；点击「检查并确认」后才等待完整探测。
3. 运行时探测失败：本地配置仍保留，页面显示“配置已保存，运行时未确认”，不会显示空模型列表或假成功。
4. 配置目录模型的删除/停用/主模型切换：执行配置层保护；运行时-only、插件/Provider 选择协调仍执行现有 fresh inventory 门禁，不得通过静态阶段绕过保护。
5. 快速连续刷新和页面切换：旧异步响应不能覆盖新状态，不能在新请求运行时提前隐藏提示。

## Acceptance Criteria

- 本地静态配置页面不再等待插件或 OpenClaw 子进程。
- 插件、运行时目录和 Gateway 状态作为独立区域/阶段异步加载。
- 用户点击保存、刷新或检查并确认后，界面立即显示正在执行的阶段；按钮不会无反馈地停住。
- 保存成功与运行时确认成功明确分开；探测失败不会伪装成写入失败或空配置。
- 悬空引用和在线状态通过显式「检查并确认」处理，普通静态保存后不重复触发完整探测；初次页面打开的运行时检查在后台进行。
- 现有模型策略、主模型/fallback、revision 冲突和备份回滚约束保持不变；配置目录模型的在线 availability 检查明确延后到运行时确认，runtime-only/插件协调的 unknown 保护保持不变。
- 没有引入后台轮询、无限重试、自动 Gateway 重启或未经用户请求的外部副作用；真正的同步/重启继续使用现有 Gateway Apply 入口。

## Handoff Notes

- 先做 Task 1–3，再做 Task 4–5；Task 6 最后执行。
- 静态首屏固定使用独立的 `/api/model-config`，不要把运行时字段填成 unknown 来复用完整 inventory DTO；旧 `/api/models`、`/api/providers` 默认行为保持不变。
- 不要把 `availability: "unknown"` 兼作“尚未加载”；加载中应由独立页面状态表示。
- 不要为了让首屏看起来完整而等待插件目录；CPA 和无插件 Provider 的本地信息是首屏主内容。
- 不要为了追求一次请求返回所有信息而新增聚合状态层；当前 inventory/attention 的职责划分继续保留。

## 实施与验证记录（2026-10-08）

### 已实施行为

- Core 新增静态配置 DTO、配置操作权限和插件公开字段投影；Server 新增 `/api/model-config` 和 `/api/model-extensions`，旧读接口保持兼容。
- Dashboard、Models、Providers 先显示静态配置，插件与完整运行时信息各自异步更新。同名插件贡献不会移走本地 Provider。插件定位 Key 表单等待 manifest 声明，避免错误打开新建向导。
- 配置目录模型的主模型/启停/编辑/删除及批量目录清理使用配置层保护；Web 写后只刷新静态配置。policy 写后确认由 `confirmRuntime:false` 分离；涉及运行时目录、真正悬空 metadata 与插件/Provider 选择协调的必要 fresh 检查保留。
- 保存、插件加载、在线检查、成功和未确认状态持续显示；对话框及按钮有 busy 状态。attention 决定直接消费报告，配置写回调只刷新静态配置，消除整轮重复探测。
- 复审补齐编辑表单 `enabled:false` 的 primary/fallback 保护，和过期响应、插件写后状态、诊断确认、插件 Key 定位等实际回归。

### 延迟夹具测量

全部使用临时配置与注入探测；插件固定延迟 600 ms、运行时固定延迟 1200 ms。数据用于确认关键路径与调用数量，不代表真机或远端提速倍数。

| 动作 | 耗时 | 插件探测 | 运行时探测 | 实例发现 |
| --- | ---: | ---: | ---: | ---: |
| 静态读取 | 7.5 ms | 0 | 0 | 0 |
| 配置模型设主模型 | 4.3 ms | 0 | 0 | 1 |
| 配置模型参数保存 | 2.4 ms | 0 | 0 | 1 |
| 显式刷新核验 | 1206.3 ms | 1 | 1 | 0 |

保存仍会执行事务的实例发现，以关联备份/环境目标；本轮保留此既有行为。必要时它仍可能有额外延迟，但普通保存已不等待完整模型/插件探测。

### 验证入口与隔离

执行项目 Core/CLI/Server/scripts 测试、全部 Web 测试、typecheck、build、acceptance 和桌面/手机 E2E。E2E 使用临时配置、注入探测与隔离端口；延迟测试拦截真实 fixture DTO 的响应，不手造 API 数据。

构建输出为 `/tmp/oc-switch-async-web-8kGQTO`，通过 `OC_SWITCH_WEB_DIST` 指定，preview 与 Playwright 复用该配置。未替换常驻 serve 正在使用的 dist，未修改真实 OpenClaw 配置、重启服务、提交或部署。

核验日志：`/tmp/oc-switch-async-core-tests.log`、`/tmp/oc-switch-async-web-tests.log`、`/tmp/oc-switch-async-typecheck.log`、`/tmp/oc-switch-async-build.log`、`/tmp/oc-switch-async-acceptance.log`、`/tmp/oc-switch-async-e2e.log`。

最终结果：Core/CLI/Server/scripts **1320 pass / 0 fail**，Web **269 pass / 0 fail**，合计 **1589**；typecheck、隔离构建、acceptance 均通过；桌面/手机 E2E **52 passed / 0 failed**；`git diff --check` 通过。

初轮浏览器验证发现测试定位器将菜单项误写为 button，已修正；旧用例仍期待自动确认或旧按钮，已迁移为保存后显式确认并保留原计数/布局/保护断言。旧用例超时导致其 finally 还原未完成而影响后续 fixture，重新启动独立 fixture 后验证，未将污染结果当作产品故障。最后整套 52 项在新 fixture 与最终构建上全部通过。
