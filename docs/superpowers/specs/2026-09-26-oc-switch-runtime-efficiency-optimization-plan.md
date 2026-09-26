# oc-switch 运行效率评估与优化方案

日期：2026-09-26。评估基线：`main`，`354ec4916bb3d599c7a033996c6a4eaddb67580a`。状态：**方案，尚未实施**。

## 1. 决策摘要

当前分层适合这个产品，不需要重写。最值得做的是：**减少一次用户操作触发的工作量，让已取得的事实只计算一次，让与当前操作无关的探测不进入关键路径。**

建议按以下顺序实施：

| 顺序 | 优化 | 判断依据 | 主要收益 |
| --- | --- | --- | --- |
| 1 | 分离连接校验与业务刷新，消除页面重复加载 | Provider 写后先 `load()`，再重建 client、重新验证服务、卸载并重挂页面 | 减少整组请求、重复投影和界面状态丢失 |
| 2 | 一次编译 policy 匹配信息，按 Provider 聚合模型 | 合成测量：1,000 模型/规则构建 inventory 约 276 ms；2,000 个约 1.12 s | 降低直接阻塞 Server/CLI 的 CPU 开销 |
| 3 | 使用写响应中的 inventory，统一页面刷新责任 | Server 已返回写后 inventory，Web 仍重新 GET；attention 面板也独立重复刷新 | 减少往返、解析和重复计算 |
| 4 | 按需发现运行环境；固定路径与 stateDir 操作走短路径 | CLI 路径已固定也会发现 Gateway；HTTP 部分读请求仍同步发现 | 改善 CLI 启动和服务响应尾延迟 |
| 5 | 完善刷新合并、并行元数据源、跳过未改变的 `.env` 写入 | 三项均通过隔离实验确认存在额外工作 | 降低外部进程、网络与磁盘工作量 |
| 6 | 删除确定不可达的兼容分支，收窄吞错范围 | v2 API 已检查布尔字段，视图仍回退猜测；若干读取失败被当作空数据 | 缩短决策链，减少假成功和后续补救 |

先做 1–3，再处理 4–6。不要先引入全局缓存框架、数据库、后台轮询、worker 池、通用工作流引擎或大规模组件重构。

**证据边界：**本文确认了代码路径、合成输入成本及部分现有安全契约；没有测量用户真实配置、常驻服务、浏览器端到端耗时或远端部署。不能据此承诺“页面提速 N 倍”。

## 2. 场景、目标与第一性原理

### 2.1 产品实际要完成的事

oc-switch 是低并发的本地配置管理器。常见动作是查看当前选用模型、切换主模型、修改 Provider、编辑策略、查看问题、发现远端模型与恢复备份。持久数据量通常小，外部 OpenClaw 命令、运行目录和网络请求的成本可能远高于配置文件读取。

本地 Provider 新增模型上限为 100；该限制不等于统一 inventory 上限。存量超限目录、插件目录和运行时全量目录仍可能贡献大量模型。本文用 100、500、1,000、2,000 个模型构造量级梯度，**不声称这些是用户当前数据规模**。

优化目标依次为：

1. 降低用户一次操作到可继续使用界面的时间。
2. 降低同一操作的外部命令数、重复请求数、CPU 扫描和无效写入。
3. 故障时尽快给出明确状态，避免无限等待或把错误当空结果继续运行。
4. 保留配置语义、写入安全和已有功能，不以减少检查数量代替正确设计。

### 2.2 成本模型

一次交互的耗时由**关键路径上的等待 + CPU 投影 + 本地 I/O + 浏览器渲染**组成。并行命令的等待不能简单相加；多个请求共享了外部探测，也不意味着共享了 inventory 的纯计算。

资源成本另算：一次冷 inventory 当前会启动 1 次插件探测和 6 次运行时/Gateway 命令。它们可以并行，但每轮仍有 7 个进程启动。减少探测轮数，通常比把一个 `filter` 改成循环更有价值；另一方面，已测到秒级的同步投影也必须处理。

设计判断标准：

- **操作需要什么事实，就取得什么事实。**读取备份列表不需要知道 Gateway 在哪里。
- **同一层只保留一个事实来源。**Web 不再次解释 `availability` 来猜选择器或待办。
- **外部输入在边界检查，内部消费已验证结构。**消除散落的旧协议猜测，不移除边界校验。
- **安全保护对齐其保护对象。**配置冲突、受保护模型、真实可用性和运行时关联各有独立用途。
- **先减少工作，再考虑缓存。**缓存增加版本、失效、错误和竞态成本，应有测量收益支撑。

### 2.3 明确保留的约束

- Core 是唯一配置 writer；继续支持 JSON5 读取、主模型双形态、policy 三态和现有兼容配置。
- Provider 身份、模型 ID 大小写和现有特殊别名的匹配语义以当前匹配器为准。不得顺便规范化用户 wildcard 的大小写、顺序或重复条目。
- 配置与 `.env` 的写前变化检查、最多重做一次预检、revision 409、备份、回滚与作用路径固定必须保留。
- unknown 不得被静态目录替换成 available。启用、设主模型、物化及相应目录操作继续遵守各自当前 capability。
- 纯规则编辑、引用清理、目录删除、Provider/插件停用的守卫并不相同，不抽成一条笼统的“模型可写”规则。
- 凭据不进入响应、缓存新增字段、计时日志或测量产物；写入成功与 Gateway 确认成功继续分开。
- 优化开发沿用当前检出分支；本方案不授权 commit、push、部署或操作真实配置。

## 3. 当前证据与覆盖范围

### 3.1 已核实的运行路径

| 范围 | 核实内容 | 结论 |
| --- | --- | --- |
| Web | App 连接门禁、Dashboard/Models/Providers 加载、attention、API 校验、表格与打包 | 最大机会在刷新责任和请求生命周期；路由懒加载、vendor 分包已经存在 |
| Server | context 缓存、inventory/attention/health/settings/gateway 路由、写后确认、静态服务 | 外部探测有缓存，纯投影仍逐次执行；强制刷新合并和同步 discovery 有空间 |
| Core 读路径 | inventory、policy、attention、config adapter/status | 多处重复匹配和聚合；应复用索引，不能合并状态维度 |
| Core 写路径 | transaction writer、备份、policy 编辑 | 未变 `.env` 仍替换；写前安全检查不是过度兜底 |
| CLI | command context、token/backup/lifecycle、模型命令与同步入口 | `activePaths()` 不区分实际信息需求；命令内已有探测复用，不能误报为完全无缓存 |
| 外部 I/O | runtime/plugin 命令、系统发现、Models.dev、Provider discover、SSH executor | 已有部分超时、大小、ETag/TTL 约束；两份元数据源串行，Provider discover 缺应用级网络时限 |

这是覆盖主要架构与运行成本的评估，不是逐行安全审计，也不是对所有功能的完整验收。

### 3.2 合成测量

环境：Bun 1.3.5，macOS arm64；直接调用当前源码；无真实 OpenClaw、Gateway、网络或用户配置。纯函数每组预热 3 次、采样 9 次，下表为中位数。相同进程依次测量，结果用于定位和后续同环境比较，不能外推到其他主机。

| 场景 | 模型数 | policy 条数 | 中位耗时 |
| --- | ---: | ---: | ---: |
| inventory：全部可用、精确规则 | 100 | 100 | 3.261 ms |
| 同上 | 500 | 500 | 70.015 ms |
| 同上 | 1,000 | 1,000 | 275.941 ms |
| 同上 | 2,000 | 2,000 | 1,117.624 ms |
| inventory：全部可用、每 Provider 一条 wildcard | 2,000 | 20 | 27.449 ms |
| attention：全部不可用、每 Provider 一条 wildcard | 100 | 1 | 0.568 ms |
| 同上 | 500 | 5 | 7.499 ms |
| 同上 | 1,000 | 10 | 27.052 ms |
| 同上 | 2,000 | 20 | 102.855 ms |

inventory 输入包含 config 与 runtime 相同的模型集合；每个 Provider 不超过 100 个模型；attention 的 inventory 在计时外构建。**wildcard 对照只用于分辨成本来源，不建议把用户 exact 规则转换成 wildcard。**没有做函数级 CPU profile，不能把全部耗时归因于某一个函数。

交付前已从本文提取附录 A 并重新执行，脚本成功退出；复跑的 1,000/2,000 exact 中位数约为 239/958 ms，仍呈相同增长趋势。两轮差异说明绝对毫秒数受进程和机器状态影响，实施比较应重新取得同批次基线，不只挑选较慢一轮计算收益。

另有六项计数/行为实验：

| 隔离实验 | 当前结果 | 说明 |
| --- | --- | --- |
| 同 scope 同时两次普通 inventory 读取 | 插件 provider 1 次、runtime provider 1 次 | 已有 Promise 缓存有效 |
| 同 scope 同时两次 `refresh:true` | 两种 provider 各 2 次 | 刷新没有合并，不能把普通读去重推广到 refresh |
| 暖缓存后空 `batch-remove` | 200、removedCount=0、backupId=null；两种 provider 各新增 1 次 | 没有写入仍走强制写后确认 |
| 固定 settings 路径后两次 CLI `activePaths()` | 路径正确，discovery 仍执行 1 次 | 命令内缓存有效，但首次探测多余 |
| 两份元数据源各模拟等待 60 ms | 单 load 2 请求、峰值并发 1，约 129 ms；两个并发 load 共 4 请求 | 确认串行与缺少进行中请求合并；不是真实网络测速 |
| 纯配置事务、既有 `.env` | `.env` 字节相同，inode 改变；discovery 1 次 | 确认不必要的文件替换 |

### 3.3 当前契约检查

已运行：

```sh
bun test packages/server/test/runtime-review.test.ts \
  packages/core/test/runtime-model-catalog.test.ts \
  packages/core/test/model-inventory.test.ts \
  packages/core/test/model-policy-edit.test.ts
```

结果：**174 pass / 0 fail，642 次断言**。覆盖现有模型投影、policy 编辑、探测失败、scope/缓存和部分事务门禁。它证明评估基线的这些行为，不证明优化已实施，也不代表全量测试、浏览器 E2E 或部署通过。

## 4. 分项设计与实施任务

优先级 P0 表示先实施的性能工作，P1 表示随后实施；不是安全漏洞等级。各任务均以最终行为和最小必要改变为边界。

### O1 · P0：业务刷新不再重新建立连接

**证据。**[App.tsx](../../../packages/web/src/App.tsx) 133–148 行把 `tick` 放在 client 的 memo 依赖里；刷新重建 client，重跑 `/api/meta` 并令 `service.ready=false`。313 行随后卸载页面。以 [ProvidersView.tsx](../../../packages/web/src/views/ProvidersView.tsx) 261–272 行为例，写后先 `await load()`，再 `onRefresh()`；129–164 行的一次 load 包含五个主要 GET。由调用链可确定会重复加载，具体请求总量还受 React effect 调度影响，未做浏览器计数。

登录也有可消除的串行工作：App 175/199 行用 `/api/status` 验证连接，进入页面后再校验 `/api/meta`，Dashboard 40–45 行再次读取 status。`/api/meta` 已受 Bearer middleware 保护，并返回服务协议和 instanceId。

**实施。**

1. client 身份只依赖连接地址与 token。把连接验证重试与业务数据刷新分成两个明确入口。
2. 手动/自动连接共用一次 `/api/meta` 握手，同时完成认证和协议校验；把成功结果交给连接状态，避免 effect 再发相同握手。配置读取错误由页面明确展示。
3. Provider 写操作只由页面刷新一次，删除“页面 load + App 全局重建”的组合。Presets、Backups 的同类调用一并审查。
4. 地址/token 变化、断线重连、显式版本重试仍重新校验；每个 inventory 响应仍执行现有 v2 校验。

**依赖：**无。**验收：**一次 Provider 写后，每个必要读端点至多请求一次，业务刷新不发 `/api/meta`；查询、筛选、选中项及非关闭目标弹窗不因服务门禁重挂载而消失。401、旧协议及重连仍阻断相应操作。使用真实 App 组合测试或隔离浏览器计数，不能只测 ProvidersView 的 mock 回调。

### O2 · P0：将规则匹配和模型聚合改为一次构建、重复查询

**证据。**[model-inventory.ts](../../../packages/core/src/model-inventory.ts) 423–432、468–474、537–538、582–638、743–780 行分别存在规则/模型交叉扫描、逐 Provider 扫全模型、逐规则过滤全模型及删除守卫重算。[model-policy-edit.ts](../../../packages/core/src/model-policy-edit.ts) 616–625 行每次可删性判断重新过滤 allow、校验最终覆盖。[model-attention.ts](../../../packages/core/src/model-attention.ts) 60–78 行逐模型查 Provider/plugin，再扫描整个模型集合判断同组是否有健康选项。

令 M=模型数、P=Provider 数、R=规则数、W=wildcard 数、F=受保护 ref 数。现有路径包含 `P×M`、`R×M`、逐规则最终覆盖重复工作；attention 在全部相关模型失效时包含近似 `M²` 扫描。上节测量支持这些成本值得优先处理。

**实施。**

1. 在 Core 的 policy 归一层建立**一次投影调用内**使用的匹配上下文：模式、原始条目、字符串条目、exact 身份索引、按 Provider 分组的 wildcard 前缀、原始字符串副本计数。保留原数组作为写入权威，不把索引写回配置。
2. 从现有 matcher 抽出可复用的已解析匹配逻辑；输入 ref/规则解析一次。保留 model ID 大小写和 OpenRouter free 别名等现有语义。不能另写一个“更快但近似”的 matcher。
3. exact 规则计数用身份索引查询；wildcard 只扫描相关 Provider 模型。Provider 的各状态计数在构建模型行时一次累加。
4. 将规则删除的纯判断抽为 Core 内部共享判定：预计算原始字符串副本数，以及 primary/fallback 被哪些原始规则值覆盖；判断“删除该字符串的全部副本”后是否还有覆盖。防清空使用包含 invalid 条目的原始数组长度；编辑前本就未覆盖的引用不新增全局阻断。mutation 和投影使用同一个判定，mutation 仍在事务内针对最新 config 检查。
5. attention 预建 Provider/plugin 查询表、受保护 ref 集合和各 Provider 的健康选项集合；同一组健康性不逐模型重算。多插件贡献的选择顺序要保持当前行为，不能用 Map 覆盖改变归属。
6. 仅在同一纯计算调用中复用索引；不引入长期配置缓存。随后按需要让 config adapter/status 复用同一匹配上下文，保留其兼容层 DTO 口径。

**目标复杂度。**exact 主导时消除 `R×M` 和逐条 `R²` 工作；主要成本接近模型/规则索引构建、受保护引用覆盖计算与稳定排序。wildcard 的成本仍与实际覆盖和前缀数量有关，不承诺所有输入严格线性，不先引入 trie。

**依赖：**无，可独立于 O1。**验收：**完整 DTO 与旧实现逐字段一致；尤其是 invalid 条目索引、同值副本、重叠 wildcard、primary/fallback、available:null、missing、config/plugin 同名并集和稳定排序。用现有测试加有意义的组合输入比较；性能目标为同机 1,000/2,000 exact 场景中位耗时至少下降 80%，100 模型场景无明显回退。该百分比是验收目标，尚未实现。

### O3 · P1：每个页面只有一个刷新责任方，优先消费已有响应

**证据。**[model-inventory 路由](../../../packages/server/src/routes/model-inventory.ts) 63–78 行已返回写后 inventory；[api.ts](../../../packages/web/src/api.ts) 763–819 行相关返回类型没有表达该字段，ModelsView 规则写后继续 load。[ModelAttentionPanel.tsx](../../../packages/web/src/components/ModelAttentionPanel.tsx) 26–34 行依赖 inventory 对象触发 attention 请求，50–59 行先自己读取，再通知父页面刷新；父页面的新 inventory 又能触发一次 attention 读取。Server 的 [model-attention.ts](../../../packages/server/src/routes/model-attention.ts) 17–21 行则再次构建 inventory、再次读 config，再完整执行 config-status 只取 blocking issues。

**实施。**

- 定义准确的规则/协调 mutation 响应类型；只为实际返回 inventory 的端点声明它，不能假定所有 mutation 都有。
- 把现有 inventory 校验提成 API 层一个函数，GET 和写响应复用。确认失败时当前后端可能返回 `{}`，必须识别为“写入已保存、未取得有效新视图”，不强转成 inventory，不自动重试 mutation。
- 父页面负责一轮 inventory、attention 和必要 config-status 读取，面板只消费 report 和事件回调。首屏独立读取可并行；写后已有有效 inventory 时，使用该响应，只读受影响的其他资源。
- attention route 先读取一份 config，传入 inventory，再用同一对象计算 attention/config-status，消除本请求内两次 JSON5 解析及不同配置对象混用。blocking 检查继续存在。
- 明确承认：保留独立 API 后，inventory 与 attention 仍可能各做一次投影；先用 O2 降低该成本。只有暖读投影仍超过交互预算时才评估服务端派生 DTO 缓存或聚合 API，本轮不增加通用状态层。

**依赖：**O1 的稳定 client；O2 降低剩余重复投影。**验收：**正常规则写后不再 GET inventory；attention 每轮只读一次；显式重探测只发一个 refresh；延迟乱序响应不能覆盖更新的页面结果。确认失败仍展示保存成功与未确认状态，后续读取可由用户重试。409 保持冻结 revision，不能自动换 revision 写入。

### O4 · P1：路径解析与运行实例发现按需求分开

**证据。**[command-context.ts](../../../packages/cli/src/command-context.ts) 161–170 行每次首次 activePaths 都先 discovery；[paths.ts](../../../packages/core/src/paths.ts) 143–165 行实际上优先使用显式环境变量/settings。backup list、token rotate、lifecycle stop 只消费 stateDir，也走此路径。Server [settings.ts](../../../packages/server/src/routes/settings.ts) 15–25 行与 [gateway.ts](../../../packages/server/src/routes/gateway.ts) 57–60 行直接调用同步 discovery；[path-discovery.ts](../../../packages/core/src/path-discovery.ts) 的默认 runner 使用 `spawnSync`，声明为 async 的路由并不能消除该阻塞。

**实施。**

1. CommandContext 暴露只解析 oc-switch stateDir 的入口，state-only 命令不调用 activePaths。复用已有 stateDir/envHome 规则，不另创路径约定。
2. config 与 env 两个路径都已由显式设置确定时跳过 discovery；只有尚缺的路径确实需要运行实例推断时才执行。不能因为 config 已指定就擅自推断 envPath，改变现有优先级。
3. path/settings 候选发现和 Gateway 操作保持完整 discovery。Server 读路径改为真正异步的有界进程 runner；复用现有解析器和候选归并规则，不能用 `Promise.resolve(syncDiscovery())` 伪装异步。
4. 同 scope 同时发生的只读 discovery 可共享一次进行中 Promise；本轮不增加跨请求长期 TTL。env-drift 仍读当前文件，显式 Gateway 写操作和写后关联检查仍取得新证据。

**依赖：**无。**验收：**固定两路径的纯读命令 discovery=0；state-only 命令 discovery=0；路径不完整、多实例/歧义、设置优先级结果与现有契约一致。注入延迟进程 runner 时，discovery 未完成期间 `/api/meta` 仍能响应。服务 target/PID/路径校验不得以缓存代替。

### O5 · P1：让“强制刷新”合并本轮工作，而非重复清缓存

**证据。**[context.ts](../../../packages/server/src/context.ts) 148–185 行已有普通读 Promise 缓存和 30 秒 TTL；`refresh:true` 每次先清缓存。隔离实验两次并发 refresh 各启动一套 provider。空批量操作在 [model-inventory.ts](../../../packages/server/src/routes/model-inventory.ts) 288–290 行仍调用 postWriteConfirmation。多处写后又执行 `invalidateCatalogCaches()` 加 `buildCurrentInventory({refresh:true})`，重复表达失效责任。

**实施。**

- 在现有 context 内区分 scope/version、失效代次、已完成缓存、当前刷新 Promise。并发手动 refresh 在同一代次共享一次新探测，不复用刷新前已完成的值。
- 写成功、路径/文件版本变化、事务重做预检必须推进代次；写后不能加入写前启动的 Promise。旧代次完成后不得覆盖当前缓存。
- 把重复的失效调用集中在一个明确入口，避免“每个调用者各清一次”破坏合并。
- 空批量删除保持 no-op、无备份；响应需要 inventory 时读取正常缓存，不为不存在的写入强制确认。没有缓存时仍可能正常探测，不能承诺所有空请求零进程。
- 30 秒 TTL 仍按现有采集开始时间计算；不借优化延长证据有效期。失败返回脱敏 diagnostic/unknown，不能改为成功空目录。

**依赖：**无。**验收：**普通读和同代次双 refresh 分别最多一套探测；在途探测跨写入、路径切换、外部 config/env 替换时必须重新取得对应代次事实；旧结果不能污染新缓存。空操作在暖缓存下不新增探测，且不落盘。

### O6 · P1：两份 Models.dev 目录并行取得，合并相同的在途读取

**证据。**[model-metadata-catalog.ts](../../../packages/core/src/model-metadata-catalog.ts) 446–447 行顺序 await 两个独立固定源。单源时限为 5 秒，当前总等待可接近两者之和。现有 24 小时 TTL、ETag/304、最长 30 天 stale 和字节限制均已存在，不需要重建缓存系统。隔离两个并发冷 load 得到 4 次请求，说明磁盘缓存没有合并尚未完成的加载。

**实施。**两源用 Promise.all 并行，但各自返回 entries、source status、warnings、cache patch，由调用者按固定源顺序合并，最后只写一次缓存，避免并行改共享数组造成输出顺序漂移。每个 Server/CLI loader 实例按 stateDir 与加载选项复用在途工作；forceRefresh 不加入已有的普通已完成缓存，测试注入不同 fetch/限制的调用不得串用。Promise 在 finally 清理，不永久记住失败。

**依赖：**无。**验收：**两个被 gate 控制的 fake fetch 都在任一个释放前启动；同参数并发冷请求总网络调用从 4 降为 2；304、单源失败、body 超时、超限、过期 stale 与警告顺序不变。60 ms 双源样例应接近一个等待窗口，不能只用易抖动的毫秒断言，优先断言启动与请求计数。

### O7 · P1：纯配置变更不替换相同的 `.env`

**证据。**[transaction-writer.ts](../../../packages/core/src/transaction-writer.ts) 150–158 行在无 envUpdates 时令 `afterEnv=beforeEnv`，196–199 行却仍在 `.env` 存在时 write+rename。隔离事务确认字节未变、inode 已变。它增加 I/O 和外部文件观察者事件；config 本身也会变更，因此不能把省下这次 env 替换表述为消除所有 catalog 失效。

**实施。**准备阶段记录是否确有 env 内容变化、原文件是否存在。无变化且不需要创建文件时跳过 env 临时文件/rename；保留输入校验、写前 env 对比、完整备份、真实 Key 更新验证和 service-env 同步。显式 Key 更新即使值相同，也可能需要修复 service-env 分叉，不能直接整笔 no-op。暂不加入“所有配置无变化就跳过事务”的通用捷径，避免漏掉 afterWrite、manifest、Provider 状态等真实副作用。

**依赖：**无。**验收：**纯模型/策略写入 `.env` 字节、inode、mtime 均不变；真实 env 修改和同步仍发生；失败回滚与配置/环境持续变化拒绝仍成立。

### O8 · P1：删掉内部猜测，外部失败保持可见

这项主要降低决策复杂度和排错成本，**不宣称有显著直接 CPU 收益**。

| 具体位置 | 处理决定 | 原因与边界 |
| --- | --- | --- |
| `ModelsView.tsx:447,467` 的 `pickerVisible ?? true/availability` | 删除布尔字段的回退 | `api.ts:881–884` 已要求 v2 布尔字段；非法 DTO 应在 API 边界报错 |
| 同处 `pickerSource === undefined` 的导航分支 | 先核实所有响应入口并完善边界，再删除 | 现有 API 校验没有检查 pickerSource，不能把这个分支直接称为不可达 |
| `ProvidersView.tsx:134–137` 的读取失败→null，随后零计数/空问题 | 可选区域独立展示“未取得”，保留重试 | 不阻塞主列表是合理降级；失败被看成“没有问题/0 项”应收敛 |
| `ModelsView.tsx:130–136` config-status 失败隐藏清理入口 | 保留禁写，改为明确不可用 | 不因网络失败伪装成没有悬空项，也不退回旧逐条删除 |
| `routes/health.ts:44–49` env 读取异常→空内容 | 缺失与不可读分开；不可读形成明确报告或错误 | EACCES/I/O 失败不是空 `.env`；不为简单展示继续计算伪事实 |
| `routes/gateway.ts:24–35` 任意 JSON 解析失败→`{}` | 真正空 body 保持可选；非空非法 JSON 返回 400 | 不能让无效请求悄悄进入默认目标选择；路径/PID 守卫继续保留 |
| `json-state-store.ts:30–38` 通用 fallback | 按状态用途逐项约束，禁止全局修改默认行为 | 可重建元数据缓存与用户路径/停用/决定状态并非同等重要；先区分 ENOENT、坏 JSON、不可读 |
| runtime/plugin 探测失败→带 diagnostic 的 unknown/incomplete | 保留 | 缺证据时的保守状态是需求，不是旧代码包袱 |
| Models.dev stale fallback | 保留期限与 stale 标识 | 非权威建议允许已标记的离线数据；不可用于冒充运行时可用性 |
| legacy policy、主模型双形态、SecretRef 显式迁移 | 保留 | 当前仍支持的真实输入契约；不能用性能任务擅自缩小支持范围 |

**实施边界。**先处理确定可删的 v2 布尔死分支、明确的空 body/读失败误判。状态文件分类单独审阅测试后再修改，避免一轮“删除 catch”改变所有状态恢复语义。脱敏错误码即可，不输出原始配置、env 值或子进程 stderr。

**依赖：**O3 统一响应校验；其他部分可独立。**验收：**合法 v2 输出行为相同；缺字段、坏 JSON、不可读文件均可辨认；预期不存在仍有正常空状态；不自动恢复旧协议或开启原本禁用的动作。

## 5. 有价值但不进入第一批的调整

### C1：纯 policy 编辑不必为警告强制探测完整 runtime

从第一性原理看，纯规则删除/替换的模式、防清空、revision、primary/fallback 最终覆盖都由 config 决定；[model-policy-edit.ts](../../../packages/core/src/model-policy-edit.ts) 241–260 行的 inventory 用于“哪些模型失去放行”警告。unknown 本来也不阻止纯规则编辑。

但现有 [policy editing spec](2026-09-13-oc-switch-policy-editing-design.md) §4/§5 **明确要求事务内 fresh inventory**。这不是可直接删除的偶然实现细节。

建议后续单独更新该契约：纯规则编辑继续在锁内重读 config 和全部最终覆盖守卫；影响预览只用同 scope 最近已取得的目录事实，并明确完整度/采集时间。没有目录证据时只能说“影响数量未确认”，不能给精确零值或跳过提示。真正的启用/物化/目录清理/Provider 停用继续使用其现有新鲜证据要求。写后仍区分保存与 Gateway 确认。

**进入条件：**O1–O7 后写入等待仍主要花在这轮警告探测；先修订 Server/CLI/Web 响应与文案，再实施。不要在普通性能重构中暗中删掉 warning 或 freshness 约定。

### C2：Provider discover 补齐真实网络等待预算

[provider-sync.ts](../../../packages/core/src/provider-sync.ts) 228–235、267–277 行直接 fetch/json，未设置应用级 AbortSignal/body 时限；已有 5,000 模型/50 页限制只在响应解析后生效。单页慢响应仍会拖住用户动作。这是资源占用与尾延迟问题，尚无真实慢网络测量。

建议沿用元数据 loader 已有的有界读取思路：Provider 发现单请求 10 秒、整个分页操作 30 秒，响应 body 与 headers 共用单请求预算，每页最多 8 MiB；这些是本方案建议的初始预算，不是当前行为或上游限制。实际实现时以常量集中定义并可测试注入。取消对话框应中止本次请求；分页依赖 cursor，不能盲目并行。保留现有条数/页数和截断提示，超时明确失败，不静默返回成功空列表，不自动重试鉴权请求。

如真实有效 Provider 持续触及预算，应基于测量调整，不叠加多层重试和备用 URL。先做可复现的挂起 headers/body 与取消用例，再实施。

### 不建议现在做的事

| 候选 | 暂不做的理由 |
| --- | --- |
| 再做一次全站代码分割 | `App.tsx:29–35` 已 lazy 六个视图，`vite.config.ts:11–23` 已 vendor 分包；未取得首屏 bundle/解析瓶颈证据 |
| 默认上虚拟表格或分页框架 | Models 已按 Provider 选择，本地新增有 100 条限制；先消除重复投影。远端 5,000 行发现列表若出现实测渲染长任务，再局部处理 |
| 全面把文件同步 API 改成异步 | 小配置和最多默认 20 份备份不自动构成瓶颈；优先去掉重复写入和阻塞子进程 |
| 备份索引数据库、增量备份 | `DEFAULT_BACKUP_RETENTION=20`；缺少成本证据，不应为少量备份引入一致性系统 |
| 延长所有缓存 TTL、离线静默使用旧运行时事实 | 会损害外部 config/env 变化与运行可用性的一致性；先减少相同代次重复工作 |
| 用 Gateway default 列表完全取代 CLI all/status/plugin 来源 | 各来源承担不同事实，当前 inventory 依赖并集与完整度；删来源属于能力/协议变更 |
| 给备份关联 discovery 直接加长期缓存 | transaction-writer 159–163 行的关联用于备份元信息，写后同步还重新确认目标；需单独证明时效要求，不能只因慢就复用旧目标 |
| 微调 static-web 每次 index hash | `static-web.ts:63–78` 确有同步读取，但文件小且该检查保护前后端一致；先测其占比，不为省一次小 hash 引入漏检窗口 |
| 自动重试所有 API/SSH 写入 | 重复执行可能造成外部副作用；现有 sync 的读、确认、写顺序有因果依赖，不能为并行破坏顺序 |
| 合并所有兼容适配器、DTO 或增加 shared contracts 包 | 不直接解决当前成本，并违反项目不新增 contracts 包的约定 |

## 6. 交付顺序与验收方法

### 第一批：最短路径消除已证实成本

**切片 A：O1 + O3 的 Web 刷新责任。**先固定网络计数用例，再稳定 client、使用有效写响应、收拢 attention 刷新。同步移除 O8 的不可达布尔回退。不更改后端写入门禁。

**切片 B：O2 的 Core 投影。**先保留附录的相同合成输入，优化 exact 索引/Provider 聚合/attention；再收敛可删性批量判定。各步以相同 DTO、相同错误和新的测量结果验收。

完成 A/B 后测一次隔离页面的首次读取、暖刷新、规则写后刷新。若小目录交互已达预算，后续只做有明确收益的项目，不自动启动“全仓优化”。

### 第二批：削减外部与磁盘工作量

**切片 C：O4 + O5。**CLI 快路径与 Server 异步 discovery 分开验证；刷新合并必须包含写前/写后代次测试，不能只测普通并发 GET。

**切片 D：O6 + O7。**两者独立，可分别交付；计数、时序及文件身份断言比肉眼感觉更可靠。不要为少量同步文件读写另建 I/O 调度器。

**切片 E：O8 剩余外部错误边界。**按文件用途逐项做最小重现；记录哪些缺失是正常状态，哪些错误必须停止。C1/C2 只有在对应契约与预算确认后另行进入实现。

### 验证矩阵

| 改动面 | 必要验证入口 | 性能/行为验收 |
| --- | --- | --- |
| App/API/页面刷新 | Web `api.test.ts`、`views.test.tsx`、`runtime-models.test.tsx`、`model-attention.test.tsx`；补 App 组合场景 | 每操作一轮必要读取；连接与业务刷新分离；完整写响应被复用 |
| policy/inventory/attention | Core `model-policy*.test.ts`、`model-inventory.test.ts`、`model-attention.test.ts`、`runtime-review.test.ts` | DTO/能力/规则顺序语义一致；附录基线显著改善 |
| CLI 快路径与 discovery | CLI `cli.test.ts`、`runtime-review.test.ts`；Core `path-discovery.test.ts`、`gateway-runtime-target.test.ts` | state-only/固定路径零无关探测；歧义/唯一性与路径优先级不变 |
| Server 刷新合并 | Server `runtime-review.test.ts`、`app.test.ts` | 双 refresh 一轮；跨写入/配置变化必须新一轮；旧结果不覆盖 |
| 网络元数据与事务 | Core `model-metadata-catalog.test.ts`、`transaction-writer.test.ts`、`env-updates.test.ts` 及相关 gateway sync 测试 | 双源同时开始；合并在途请求；未变 env 不替换；真写入与回滚正常 |

实施时先运行切片相关测试与 typecheck。多个切片完成后统一执行项目 `bun run check`、`bun run acceptance` 和涉及的隔离浏览器 E2E，不在每个小步骤机械重跑全套。正常 `build` 会替换现有 dist；在不允许影响常驻实例的评估/实现会话中，应让等效构建输出到临时目录，保留常驻 dist。若运行完整 check，先确保其 build 输出不会影响当前服务。

浏览器验证使用隔离 API/Web（现有约定 17420/15173 或显式空闲端口）与完整真实 DTO fixture、假 OpenClaw，不复用常驻 7420。桌面/移动端验证现有布局、筛选与操作可达性；“表格横滚”和 body 溢出分别检查。

### 最终接受标准

- 已完成切片的请求/探测/文件写入数量符合 O1–O7 对应标准，能够用计数或时序验证。
- O2 在同环境同输入下达到目标；记录中位数、样本数、输入规模和未达项，不只给百分比。
- 冷启动、暖读取、写后刷新、外部配置变化、探测失败分别报告，不用一种场景代替全部。
- 规则、revision、unknown、主模型/fallback、插件/Provider 独立停用、凭据及真实 Gateway 关联约束无回退。
- 因错误不可用与真实空结果在用户界面可分辨；不增加静默降级或自动重试写入。
- 最终交付列出实际完成切片、当前 commit/diff、测试结果和未验证边界。方案中的测量目标不能冒充实施成果。

## 7. 交接说明与评估限制

1. 本次只新增本文档，业务代码未修改，优化尚未实施。临时实验全部使用合成配置与注入依赖，未读取真实 OpenClaw/凭据或操作常驻服务。
2. 本文以当前源码为准。2026-06-26 的结构优化草案包含已过时的 metadata/选择器描述和已完成的模块拆分，不能作为当前优化任务清单直接执行。
3. “低并发本地管理器”来自项目定位；具体活跃 Provider 数、runtime 目录规模、远端 CPU/磁盘、网络 RTT 和用户操作频率均未采样。实施前可采集这些非敏感计数，调整优先级，不收集配置原文或 token。
4. 本文的源码行号固定于基线 commit；后续实现按符号定位并更新文档。没有做生产 profiler、全量浏览器录制、内存泄漏长测或远端压测。
5. 需要特别防止两种误实施：把 O2 的 wildcard 对照当成修改用户 policy 的建议；把 O5 的共享刷新当成允许写后复用写前证据。

## 附录 A：可重跑的 Core 微基准

从仓库根目录运行。把下列内容保存到系统临时目录中的 `.ts` 文件，再用 `bun <该文件>` 执行。脚本只导入纯投影，不读用户文件，不执行外部命令。无需新增项目测试框架；实现 O2 后保持同样输入复测。

```ts
const root = process.cwd();
const { buildModelInventory } = await import(root + "/packages/core/src/model-inventory.ts");
const { buildModelAttention } = await import(root + "/packages/core/src/model-attention.ts");

function fixture(p: number, m: number, wildcard: boolean, available = true) {
  const providers: Record<string, { models: { id: string }[] }> = {};
  const refs: string[] = [];
  for (let i = 0; i < p; i++) {
    const id = `provider${i}`;
    const models = Array.from({ length: m }, (_, n) => ({ id: `model${n}` }));
    providers[id] = { models };
    refs.push(...models.map(model => `${id}/${model.id}`));
  }
  const config = {
    models: { providers },
    agents: { defaults: {
      model: refs[0],
      modelPolicy: { allow: wildcard ? Object.keys(providers).map(id => `${id}/*`) : refs }
    } }
  };
  const rows = refs.map(ref => ({ ref, available, tags: [] }));
  const runtime = {
    fallbackRefs: [], allowedRefs: refs, configuredModels: rows, allModels: rows,
    completeness: { status: true, configuredList: true, allList: true },
    diagnostics: [], capturedAt: "2026-09-26T00:00:00Z"
  };
  return { config, runtime };
}

function sample(fn: () => unknown) {
  for (let i = 0; i < 3; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[4], minMs: times[0], maxMs: times[8] };
}

console.log({ bun: Bun.version, platform: process.platform, arch: process.arch });
for (const [p, m, wildcard] of [
  [5, 20, false], [10, 50, false], [20, 50, false], [20, 100, false], [20, 100, true]
] as const) {
  const input = fixture(p, m, wildcard);
  console.log({ kind: "inventory", models: p * m, rules: wildcard ? p : p * m,
    ...sample(() => buildModelInventory(input)) });
}
for (const n of [100, 500, 1000, 2000]) {
  const input = fixture(Math.ceil(n / 100), Math.min(n, 100), true, false);
  const inventory = buildModelInventory(input);
  console.log({ kind: "attention-all-unavailable", models: n,
    ...sample(() => buildModelAttention(input.config, inventory)) });
}
```

## 附录 B：其余隔离实验的复现条件

- **刷新合并：**临时 config/env/stateDir，`createAppRuntime` 注入两个等待 gate 的 catalog provider；分别 `Promise.all` 调用两次普通 build 和两次 `refresh:true` build，计数每种 provider，不用真实 OpenClaw。
- **空批量：**`createApp` 注入同样 provider 与空 runtime discovery；先 GET inventory 取得 policyRevision，再 POST `values:[]`，断言新增调用数、HTTP 状态、removedCount 和 backupId。
- **固定路径：**临时 settings 明确 config/env，`createCommandContext({stateDir, env:{}, runtimeDiscoveryProvider:计数函数})`；连续取两次 activePaths，比较路径和计数。
- **元数据：**两个固定源均由 fake fetch 在 60 ms 后返回合法空 JSON 对象；分别单次冷 load、两个并发冷 load，每组独立 stateDir。记录请求数、启动峰值与总耗时；不请求 Models.dev。
- **env 替换：**临时 `.env` 写无敏感 fixture 内容；`writeOpenClawTransaction` 注入空 discovery，只修改 config；比较前后字节和 `stat` inode。备份与锁均在临时 stateDir。

以上实验服务于本次证据与后续回归计数。不要将其改成对真实个人配置、常驻服务或远端机器的自动压测。
