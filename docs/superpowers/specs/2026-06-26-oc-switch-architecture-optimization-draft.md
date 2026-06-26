# oc-switch 整体结构优化草案

> 日期：2026-06-26  
> 状态：初稿  
> 目标：从全局视角整理 oc-switch 在多轮功能迭代后的结构风险，给出可分阶段实施的优化方向，避免后续每个小功能都持续放大重复成本。

---

## 1. 背景

oc-switch 目前已经从最初的 Core + CLI MVP 演进到完整的本地配置管理工具，包含：

- `packages/core`：唯一读写 OpenClaw 本地文件的核心层。
- `packages/server`：Hono REST API，供 WebGUI 调用。
- `packages/cli`：Commander CLI，供终端和 smoke 流程使用。
- `packages/web`：React/Vite WebGUI。

现有分层仍然成立：**Core 是唯一写 OpenClaw 配置和 `.env` 的层**。真正开始显现的问题是，每个新增功能都需要横向修改 Core、Server、CLI、Web 和测试 fixture；功能之间独立设计后，局部重复和单文件增长开始累积。

Provider Disable 当前任务只做一个小 Task 0：新增通用 JSON state store 和 `writeOpenClawTransaction.afterWrite`。本文档记录其余结构优化，不阻塞 Provider Disable。

## 2. 当前结构判断

### 2.1 仍然合理的边界

- `packages/core` 继续作为唯一文件写入层，避免 Server/Web/CLI 直接操作 `openclaw.json`、`.env` 或 `~/.oc-switch`。
- `agents.defaults.models` 继续作为 OpenClaw 菜单可见性的唯一真实来源。
- `models.providers` 继续作为 Provider 与模型目录来源。
- Server 和 CLI 作为 Core 的薄包装，这个方向正确。
- Web 不直接读写本地文件，只通过 REST API 操作。

### 2.2 已经出现的结构压力

- `packages/core/src/operations.ts` 聚合了模型启用、Provider 删除、Provider 编辑、模型 CRUD、Preset 添加、Custom Provider 等操作，职责开始变宽。
- `packages/server/src/app.ts` 集中放置所有路由、认证、读取 active paths、事务调用、错误响应与 response shape。
- `packages/cli/src/index.ts` 集中放置所有命令、参数解析、输出格式、事务调用。
- `packages/web/src/api.ts` 复制了一套 API response 类型，和 Core/Server 类型需要手动同步。
- Web 测试中 Provider/Model fixture 较多，`ProviderSummary` 或 `ModelSummary` 增字段时需要多处补字段。
- `settings.json`、`manifest.json`、`token.json`、计划中的 `provider-states.json` 都是 oc-switch 自己的状态文件，但读写、权限、容错逻辑分散。

## 3. 优化原则

- 不做 big-bang 重写，每个优化切片必须能独立合并。
- 不改变 OpenClaw 配置语义，不向 `openclaw.json` 写入 oc-switch 私有字段。
- 优先降低后续功能成本，而不是为了美观拆文件。
- 先抽通用基础设施，再逐步迁移调用方。
- 保留现有对外 API 和 CLI 行为，除非另有产品规格。
- 测试覆盖以行为不变为目标，结构拆分不应引入产品语义变化。

## 4. 建议分阶段

### Slice 0：Provider Disable 的最小基础整理

状态：已纳入 `docs/superpowers/plans/2026-06-25-oc-switch-provider-disable.md`。

范围：

- 新增 `packages/core/src/json-state-store.ts`。
- 给 `writeOpenClawTransaction` 增加 `afterWrite`。
- Provider Disable 的 `provider-states.json` 使用该 state store。

明确不做：

- 不迁移已有 `settings.json`、`manifest.json`、`token.json`。
- 不拆 Server/CLI/Core 大文件。

### Slice 1：统一 oc-switch 状态文件读写

目标：让所有 `~/.oc-switch/*.json` 使用同一套权限、格式化、原子写入和容错策略。

候选文件：

- `packages/core/src/paths.ts` 中的 `settings.json`。
- `packages/core/src/manifest-manager.ts` 中的 `manifest.json`。
- `packages/core/src/token-manager.ts` 中的 `token.json`。
- Provider Disable 引入的 `provider-states.json`。

验收标准：

- 行为不变。
- 文件权限仍为目录 `0700`、状态文件 `0600`。
- JSON 保持 pretty print 和 trailing newline。
- 坏 JSON 的 fallback 语义与现有实现一致。
- `bun test packages/core` 通过。

### Slice 2：拆分 Core operations

目标：降低 `operations.ts` 的职责密度，让后续 Provider/Model 生命周期能力有明确归属。

建议拆分：

- `model-operations.ts`：`setPrimaryModel`、`enableModel`、`disableModel`、模型 CRUD。
- `provider-operations.ts`：Provider 删除、编辑、Custom Provider、Preset Provider 添加。
- `provider-disable-operations.ts` 或 `provider-lifecycle.ts`：关闭/恢复 Provider 及相关纯函数。
- `operations.ts` 可暂时作为 re-export 兼容层，减少一次性迁移成本。

验收标准：

- `@oc-switch/core` public exports 不破坏现有调用。
- 原有 operations 测试通过，必要时按领域拆测试文件。
- 不修改业务行为。

### Slice 3：拆分 Server routes

目标：让 `app.ts` 负责创建 Hono app、认证、中间件和上下文，具体业务路由按领域拆分。

建议结构：

- `packages/server/src/context.ts`：active paths、read config、common helpers。
- `packages/server/src/errors.ts`：`jsonError`、validation error 分类。
- `packages/server/src/routes/providers.ts`
- `packages/server/src/routes/models.ts`
- `packages/server/src/routes/settings.ts`
- `packages/server/src/routes/backups.ts`
- `packages/server/src/routes/presets.ts`
- `packages/server/src/routes/health.ts`

验收标准：

- REST endpoint 路径、response shape、状态码保持不变。
- `packages/server/test/app.test.ts` 通过。
- Provider/Model 新功能不再需要直接编辑一个超长 `app.ts`。

### Slice 4：拆分 CLI commands

目标：让 `packages/cli/src/index.ts` 负责 program 创建和全局参数，具体命令按领域注册。

建议结构：

- `packages/cli/src/command-context.ts`：active paths、read config、write transaction helper。
- `packages/cli/src/commands/providers.ts`
- `packages/cli/src/commands/models.ts`
- `packages/cli/src/commands/settings.ts`
- `packages/cli/src/commands/backups.ts`
- `packages/cli/src/commands/presets.ts`
- `packages/cli/src/commands/serve.ts`

验收标准：

- CLI 命令名、参数、输出保持不变。
- `packages/cli/test/cli.test.ts` 通过。
- 新增 Provider 命令时只改 providers command 文件。

### Slice 5：降低 Web API 类型和测试 fixture 抖动

目标：减少 `ProviderSummary`、`ModelSummary` 等类型变动带来的 Web 测试连锁改动。

短期方案：

- 在 Web 测试中新增 fixture builder，例如 `providerSummary(overrides)`、`modelSummary(overrides)`。
- 页面测试使用 builder，而不是每处手写完整对象。

中期方案：

- 评估是否新增轻量 contracts 层，集中声明 Server response DTO。
- 避免 Web 直接依赖会引入 Node/Bun 文件系统代码的 Core runtime。

验收标准：

- `ProviderSummary` 新增字段时，主要修改 builder 默认值，而不是全量测试 fixture。
- `packages/web/src/views.test.tsx` 可读性提升。
- `bun test --preload ./packages/web/src/test-setup.ts packages/web/src` 通过。

### Slice 6：整理健康状态与结构状态入口

目标：将 case duplicate、orphan env、path warning、disabled Provider 等“配置状态”能力逐步统一成清晰的读取入口。

候选方向：

- 保留现有 `/api/health`，扩展为结构健康问题聚合。
- 或新增 `/api/config-status`，把 health、path、orphan、disabled provider summary 分层返回。

注意：

- 该切片涉及产品展示方式，应单独写规格，不和低风险重构混在一起。
- 不应在 Provider Disable 首版中做。

## 5. 推荐执行顺序

1. 先完成 Provider Disable，包含 Slice 0。
2. Provider Disable 合并后，做 Slice 1：统一状态文件读写。
3. 之后优先做 Slice 5 的 Web fixture builder，降低前端测试维护成本。
4. 再按实际痛点选择 Slice 2、Slice 3、Slice 4；这三者可以独立推进，不需要一次性完成。
5. Slice 6 等到配置健康/状态类功能继续增加时再启动。

## 6. 风险与约束

- 状态文件迁移必须保持现有容错语义。比如 `settings.json` 读坏文件时当前返回空设置，这个行为不能意外变成启动失败。
- Server/CLI 拆分不应改变错误文案和退出码，否则会影响测试和用户脚本。
- Web contracts 如果设计过重，会引入新的包和构建复杂度；短期优先 test builder。
- `operations.ts` 拆分时要保护 `packages/core/src/index.ts` 的导出兼容性。
- 结构优化期间仍需遵守：默认不提交 `docs/` 与 `.cursor/`，仅在用户明确要求时纳入 commit。

## 7. 当前结论

项目结构没有到需要推翻重来的程度。当前最有价值的优化是**小步抽取重复基础设施**，尤其是 oc-switch 状态文件读写和 transaction side-effect hook。

Provider Disable 可以继续推进，但应把新增状态文件建立在 `json-state-store` 上。其余优化应作为后续独立切片处理，避免把一个产品功能变成大范围结构重写。
