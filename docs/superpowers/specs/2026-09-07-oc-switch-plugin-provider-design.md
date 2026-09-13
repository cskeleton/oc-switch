# oc-switch 插件 Provider 支持设计（OpenClaw 2026.9.2 兼容）

> 2026-09-11 修正：选择器、主动停用、metadata 告警和异步探测行为以 [最新规格](2026-09-11-model-picker-and-disable-design.md) 为准；本文保留历史设计背景。

日期：2026-09-07（2026-09-08 真机验证后同步修订）
状态：已实现（v1），已通过 `bun run check` + `bun run acceptance` + 真机只读验证

## 1. 背景

OpenClaw 自约 v2026.4.24 引入 manifest `modelCatalog` 契约后，provider 可以来自**插件**而非 `openclaw.json` 的 `models.providers`：

- **bundled 插件**：随 OpenClaw 包发行，manifest 在 `<install>/dist/extensions/<id>/openclaw.plugin.json`（如 `opencode-go`，`enabledByDefault: true`）。
- **npm global 插件**：自动安装到 `~/.openclaw/npm/projects/<...>/node_modules/@openclaw/<id>/`（如 `opencode`）。

这类 provider 的 baseUrl、api 类型、静态模型目录全部内嵌在插件 manifest 中，**从不写入** `models.providers`。oc-switch 此前只读 `models.providers`，因此对插件 provider 完全不可见，且 `config-status` 会把指向插件 provider 的 `modelPolicy.allow` exact ref 误报为 `unknownProviderRefs`。

## 2. OpenClaw 侧语义（调研结论，均有代码/文档证据）

- **合并**：`resolveImplicitProviders` → `mergeProviders({implicit, explicit})`。Provider 级字段用户配置覆盖内置。`models.mode: "replace"` 全局丢弃插件 catalog（oc-switch 不写此字段）。
  - **模型成员资格是并集，不是用户接管**（2026-09-08 真机实测修正了本节早前的判断）：本机 `models.providers.opencode` 写了非空 `models` 数组（4 条，policy 无 `opencode/*` 通配），而 `openclaw models list --provider opencode` 返回 **5** 条——4 条用户条目（带 `configured` 标记）+ `opencode/mimo-v2.5`。`mimo-v2.5` 既不在用户数组里，也不在插件静态 manifest 的 7 条 catalog 里，因此来自运行时 shard（§2.1）。即 policy 过滤操作的是「config ∪ 插件 catalog（运行时）」。
- **policy**：`modelPolicy.allow` 的 exact ref 与尾部通配对插件 provider 照常生效（policy 过滤只操作合并后的 catalog，不区分来源）。legacy `agents.defaults.models` 同理。
- **主模型**：`agents.defaults.model.primary` 可指向插件 ref（官方文档示例：`opencode-go/kimi-k3`）。
- **认证**：插件 provider 的 key 走环境变量（如 `OPENCODE_API_KEY` / `OPENCODE_ZEN_API_KEY`），变量名只由 manifest `setup.providers[].envVars` 声明（`providerAuthChoices` 只描述 auth 方式，不含变量名，见 §2.1）；运行时 shard 中只存 env var 名标记。正确操作面是 `.env`，**不是** `models.providers.<id>.apiKey`。
- **整 provider 禁用**：`plugins.entries.<id>.enabled = false` 在发现/注册层生效（v1 不写此字段，见 §7）。

### 2.1 已知 OpenClaw 侧坑（不影响本设计，记录在案）

- `plugins.entries.<id>.enabled=false` 后，`openclaw models list`（无过滤）仍平铺插件静态 manifest 行（列表规划器不过滤 enabled）；`--all` 路径才尊重。即「列表仍显示」≠「未被禁用」。
- `openclaw models list --provider <id>` 对 disabled 插件返回 0 条，与无过滤列表不一致（CLI 列表层语义不一致）。
- 插件 catalog 的运行时 shard 存于 agent SQLite（`cache_entries`，scope=`plugin-model-catalog-v1`）；oc-switch 不读 SQLite，只用 manifest 静态目录。运行时 catalog 是 manifest 的超集（实测 `opencode` manifest 7 条，运行时含 `mimo-v2.5` 等更多条目），故 oc-switch 会把「只存在于运行时」的 policy ref 判为 drift（§7 v2）。
- `openclaw models list` 输出的 `configured` 标记可区分来源：带标记 = 来自 `models.providers` 用户条目，不带 = 来自插件 catalog。
- `providerAuthChoices` **不含环境变量名**（实测 anthropic / openai / opencode manifest 只给 `optionKey` / `cliFlag` / `cliOption`）；env 变量名只在 `setup.providers[].envVars` 里。

## 3. 发现协议（`packages/core/src/plugin-catalog.ts`）

`discoverPluginCatalog(deps?)`：

1. `spawnSync("openclaw", ["plugins", "list", "--json"], { timeout: 8s, maxBuffer: 1MB })`。
2. 取 `providerIds.length > 0` 的插件；每条目含 `rootDir`、`origin`、`enabled`、`status`。
3. 读 `<rootDir>/openclaw.plugin.json`，解析 `modelCatalog.providers[<providerId>]`（`baseUrl`/`api`/`models[]`）与 auth env 变量名（**仅** `setup.providers[].envVars`，见 §2.1）。`apiKeyEnvVars` 把名字含 `API_KEY` 的变量排到前面：manifest 声明顺序未必以 API Key 开头（`anthropic` 是 `["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]`），而写入只取首个，否则会把 API Key 写进 OAuth token 变量。
4. **绝不抛错**：CLI 缺失/超时/JSON 解析失败/manifest 缺失 → 返回空或部分结果 + `diagnostics[]`。

依赖注入（`runCommand`/`readTextFile`）照抄 `path-discovery.ts` 模式，测试可注入 fake。

产出类型：

```ts
interface PluginProviderModel { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] }
interface PluginProvider { pluginId: string; providerId: string; origin: string; enabled: boolean; baseUrl?: string; api?: string; models: PluginProviderModel[]; apiKeyEnvVars: string[] }
interface PluginCatalogResult { providers: PluginProvider[]; diagnostics: string[] }
```

**冲突规则**：providerId 已存在于 `models.providers`（大小写折叠）时，config 条目优先，插件条目不重复列出；该 provider 的**模型级**校验/编排（`hasKnownModel`、`config-status` 的 model drift 判定、`listModels`）也只看本地目录。

这是 **v1 的简化取舍，不是 OpenClaw 语义**：OpenClaw 实际是并集（§2）。两个方向的误差：
- 只存在于插件 catalog 的模型（如 `opencode/big-pickle`）在 oc-switch 里不可见、不可 enable/use，且若已在 policy 里会被报为 model drift；
- 用户可经既有「添加模型」把该模型写进 `models.providers` 后正常编排。

选它而非做并集的理由：即便实现 manifest 并集，也无法消除运行时-only 模型（`mimo-v2.5`）的同类误报（§2.1），而并集需要新增 `ModelSummary.source` 与 Web 侧分支（同一 provider 下混排只读/可写行）。留作 v2（§7）。

## 4. DTO 与读取合并

- `ProviderSummary.source: "config" | "plugin"`（必填，config 条目恒为 `"config"`）。
- `createConfigAdapter(config, { disabledProviderIds, pluginProviders })`：
  - `listProviders()`：追加插件条目；`disabled = !plugin.enabled`（插件启停状态来自插件系统，**不**进 `provider-states.json`）；`enabledModelCount` 按 policy 三态对插件 ref 计算。
  - `listModels()`：追加插件模型条目；`enabled`/`selectionSource` 复用现有 `getModelSelectionSource`（对任意 ref 可计算）；`isPrimary` 走 `primary-model.ts` 归一层。
  - `getStatus()`：`providerCount`/`providerModelCount` 维持 config-only（插件 provider **不计入**，避免与既有语义混淆）；`effectiveModelCount` **计入**启用中插件 provider 的有效模型，必须与 `config-status` 的 `effectiveCatalogCount` 相等——两者都表示「OpenClaw 实际会提供多少个可选模型」，不一致会让 Dashboard 的「有效可选」与 Models 页对不上。该不变量由 server 测试锁定。

## 5. 编排写入（v1 范围：单模型启停 + 主模型 + API Key）

- **enable/use 放宽**：`enableModel` 与 `setPrimaryModel` 的目录校验从 `hasProviderModel`（仅 `models.providers`）扩展为 `hasKnownModel`（本地目录 ∪ **启用中**插件 catalog，同名 provider 按 §3 由 config 接管）。插件 provider `enabled=false` 的 ref 仍拒绝，报错指向 `plugins.entries.<pluginId>.enabled=false` 而非含糊的 `not defined in provider models`。
- **disable 不变**：`disableModel` 本就不校验目录存在，对插件 ref 天然可用；通配/清空断言照常。
- **fail-closed 收紧**：`removeProvider` 修复「`resolveProviderId` 失败静默 no-op」为显式 throw `Provider not found`。`updateProviderModel`/`addProviderModel`/`removeProviderModel`/batch 系列/`disableProvider`/`restoreDisabledProvider` 对插件 provider 保持显式拒绝（现状即如此，固化为测试）。
- **fallback 保护**：`readFallbackModelRefs` 纯字符串匹配，对插件 ref 天然生效，无需改。
- **API Key**：经现有 `.env` 托管块（`POST /api/env` upsert）写 manifest 声明的 env 变量；server 在 `GET /api/providers` 对插件条目用 `apiKeyEnvVars[0]`（已按 §3 排序）计算 `apiKeyEnv`/`apiKeyEnvStatus`。manifest 未声明任何 env 变量时 `apiKeyEnv` 为 `null`，Web 的「设置 Key」禁用。写后仍走既有 gateway sync-env/apply 流程。
- **diff-guard**：v1 不写 `plugins.entries`，白名单不变。

## 6. config-status 修正

`inspectConfigStatus(input)` 的 input 增加可选 `pluginProviders`：

- `unknownProviderRefs`：排除已知插件 providerId（大小写折叠）。
- `knownProviderUnknownModelRefs`：**不与 `models.providers` 同名**的插件 provider 的 ref 改查插件 catalog 模型 id，命中则不计入；同名 provider 仍只查本地目录（§3）。
- `effectiveCatalogCount`：计入启用中插件 provider 的有效模型数。
- v1 不新增 issue 类型。

## 7. 明确不做（v2 候选）

> **2026-09-09 更新**：本节下列条目已由《oc-switch OpenClaw 运行时 Provider / 模型协调管理设计》（`2026-09-09-oc-switch-runtime-model-management-design.md`）接管实现，本 spec 的相应表述由该 spec 取代：
>
> - **整 provider 启停（写 `plugins.entries.<id>.enabled`）**：已实现为插件级启停 operation（新 spec §9；CLI `plugin enable/disable`、`PATCH /api/plugins/:pluginId/state`），diff guard 白名单已含 `plugins.entries.<id>.enabled`。
> - **运行时目录 / 同名 provider 的模型并集**：统一 inventory（新 spec §6/§7）按 config ∪ 插件 manifest ∪ OpenClaw 运行时目录合并模型行；本 spec §3 的「config 优先遮蔽插件成员」简化只保留在兼容层 `createConfigAdapter`（`/api/models` 旧 consumers），新代码不得依赖该简化判断运行时可用性。
> - **运行时-only 模型的 drift 误报**：统一 inventory 以运行时探测（`openclaw models list --json` / `--all`）给出三态可用性（available/unavailable/unknown），只存在于运行时 shard 的模型不再被误报；`config-status` 的 drift 判定不变（它仍是 config-only 视角）。
>
> 未被接管、维持不做的条目：读取 agent SQLite 密钥表、`models.mode: "replace"` 管理、Web 侧 config-status issues 展示组件。

- 整 provider 启停（写 `plugins.entries.<id>.enabled`，需扩 `diff-guard.ts` 白名单）。
- `models.providers.<同名>` 覆盖/接管成员资格的写入 UI。
- 读取 agent SQLite 的运行时刷新 catalog（live 模型）；`models.mode: "replace"` 管理。运行时-only 模型（本机 `opencode/mimo-v2.5`）在 v1 会被 `knownProviderUnknownModelRefs` 误报为 drift。
- 同名 provider 的模型并集：把插件 manifest 模型合并进同名 config provider 的模型列表，需新增 `ModelSummary.source` 并让 Web 在同一 provider 下区分只读/可写行（§3）。
- Web 侧 config-status issues 展示组件（插件误报消除后仍无 UI 消费）。

## 8. 各端接入点

- **server**：`context.ts` 缓存插件 catalog（30s TTL，失败降级空+diagnostic），发现源经 `AppOptions.pluginCatalogProvider` 可注入（测试必须注入，否则会 shell-out 到开发机真实 `openclaw`，列表随本机插件漂移）；`routes/providers.ts` / `routes/models.ts` / `routes/health.ts`（`/api/status` 与 `/api/config-status` 均注入）。
- **CLI**：`providers list` 标注 `plugin`；`models list` / `use` / `model enable` 注入插件 catalog（`model disable` 无需目录校验）；`status` 只印 config-only 计数，不变。CLI 测试经 PATH 前置的假 `openclaw` 脚本注入确定性 `plugins list --json` 输出。
- **Web**：Providers 页合并展示 + 「插件」徽章；编辑/删除/发现模型/同步参数/关闭恢复按钮对插件行禁用；「设置 Key」走 `.env` upsert；Models 页插件模型可启停/设主模型，隐藏编辑/删除；ProviderModelsDialog 对插件 provider 只读。

## 9. 风险与降级

| 风险 | 对策 |
|---|---|
| `openclaw` CLI 缺失/慢/挂起 | 8s 超时，降级为空 catalog + diagnostic；行为等同现状，不回归 |
| manifest 结构演进 | 解析容错（逐字段可选），失败记 diagnostic 跳过该插件 |
| 插件 disabled 但 OpenClaw 列表仍显示 | oc-switch 以 `enabled` 为准标记 disabled 并禁止 enable 其模型 |
| providerId 大小写冲突 | config 优先，大小写折叠判定 |

## 10. Sync Audit（2026-09-08）

实现与本 spec 已对齐；实现过程中修订了以下 spec 判断，均有真机证据：

| 修订处 | 原判断 | 实测结论 |
|---|---|---|
| §2 merge | 用户写非空 `models` 数组时接管成员资格 | 成员资格是并集；`--provider opencode` 返回 4 条 config + `mimo-v2.5` |
| §2.1 / §3 | auth env 变量来自 `providerAuthChoices` 或 `setup.providers[].envVars` | `providerAuthChoices` 无 env 变量名，只有 `setup.providers[].envVars` |
| §3 冲突规则 | 理由是「与 OpenClaw merge 语义一致」 | 是 v1 简化取舍，并集留作 v2 |
| §4 `getStatus()` | 「维持 config-only 计数」（未区分字段） | `effectiveModelCount` 必须计入插件，与 `effectiveCatalogCount` 一致 |

### 真机只读验证（2026-09-08，本机 OpenClaw 2026.9.2）

- `providers list`：12 条 config + 14 条 `plugin` 标注条目；同名的插件 `nvidia` / `openai` 中 `nvidia` 被 config 遮蔽、`openai` 因 config 无该条目而以插件身份列出。
- `config-status`：`unknownProviderRefs` 由 5 条（`openai/*` ×3、`deepseek/*` ×2）降为 **0**；`effectiveCatalogCount` **+3**（= `openai` 插件启用中的 3 条有效模型；`deepseek` 插件 `enabled=false` 故不计入）。绝对值随本机配置变动（两次测量分别为 39→42 与 40→43），delta 稳定。
- 残留 3 条 `opencode/*` 在 `knownProviderUnknownModelRefs`：`hy3`、`muse-spark-1.2-contributor` 在 `openclaw models list` 里也不存在，属真实 drift，报得对；`mimo-v2.5` 是运行时-only 模型，属 §7 记录的 v1 局限。
- 验证过程全程只读，未对真实 `openclaw.json` 发起任何写操作（测试与 acceptance 全部走 mkdtemp fixture）。注意验证期间 `~/.oc-switch/backups/` 出现了 3 条新备份（reason 为 `batch-add models for provider cpa` / `set primary model cpa/agy-gf` / `edit model cpa/agy-gf`）——来自本机常驻 `oc-switch serve`（PID 11995，127.0.0.1:7420）收到的客户端请求（最可能是 Web UI 操作），与本次实现无关：这三次写入涉及的 `cpa/agy-gf` 是本次验证从未触及的 ref，且本次所有写路径均走 mkdtemp fixture。
