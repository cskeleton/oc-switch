# 静态配置管理与异步运行时确认

日期：2026-10-08。执行计划：`docs/plans/2026-10-08-async-model-loading-and-apply.md`。

## 用户行为与语义调整

配置管理以本地 `openclaw.json`、`.env`、oc-switch state 为依据，先展示用户配置的 Provider 和模型。插件目录与完整运行时证据分别异步读取，不能阻塞本地配置展示。

对 `models.providers` 中明确存在的目录模型，保存主模型、启用/禁用、编辑和删除采用配置层校验，运行时 availability 不再是这些配置写入的先决条件。这是本次已授权设计对 2026-09-09 fresh/unknown 写门禁的限定调整，不将未取得的在线证据表示为 available。Primary/fallback、Provider 停用、wildcard、防清空、revision、备份与外部文件变化保护继续生效。

仅有 metadata 的引用不能被当作目录模型。运行时-only/插件模型启用或设主模型、materialize、悬空 metadata 的事务内复核、Provider/插件停用需要当前选择器证据的操作仍取得必要的 fresh inventory。

## 读取接口

- `GET /api/model-config`：独立的静态 DTO，读取本地配置、脱敏 Key 状态、policy 原始规则与静态操作权限；不调用插件、模型或 Gateway 探测。不得包含伪造的 availability/pickerVisible/needsAttention。静态模型与完整 inventory 是不同类型。
- `GET /api/model-extensions`：只读取插件 descriptors、公开 manifest 模型目录与诊断，复用已有插件缓存/进行中的请求，不等待完整运行时。
- 现有 `/api/model-inventory`、`/api/model-attention` 保持完整运行时语义。旧 `/api/models`、`/api/providers` 和协议 v2 保持兼容。

## 保存与确认

Web 普通保存只刷新静态视图；带 `confirmRuntime:false` 的已有确认类写接口保存后返回在线状态待确认，不同步执行完整写后确认。省略此选项保持旧消费者的写后确认行为。写入成功与确认成功分开。

用户点击「检查并确认」时，复用 `/api/model-inventory/refresh` 进行完整采集并更新问题列表。此入口不重启 Gateway、不自动清理引用，也不反复重写配置。需要环境变量同步或重启时使用现有明确的「同步并重启 Gateway」入口。

OpenClaw 可以热加载文件，保存后文案为「已保存，在线状态待确认」，不能断言「尚未应用」。刷新阶段区分未开始、进行中、成功与错误；加载中不是运行可用性 unknown，不生成假待办。

## 界面和请求生命周期

本地配置、插件区域、运行时区域独立更新，同名插件贡献不得让已经出现的配置 Provider 消失。保存、检查、插件读取期间持续显示操作文案和 spinner。保存失败保留输入；保存成功后的读取/核验失败保留已保存状态。

复用现有页面序号和缓存代次，保存开始/完成后作废旧运行时响应，避免旧读覆盖新配置。没有后台轮询、自动重启、无限重试或假百分比。

实现遵循 [React Effect cleanup](https://react.dev/reference/react/useEffect#fetching-data-with-effects) 的过期响应处理和 [W3C status messages](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22.html) 的可访问状态反馈。

## 验收

- 静态读取和明确 config 模型保存不启动插件/runtime 命令；带延迟 fixture 证明首屏和保存先完成。
- 插件读取与完整 inventory 共享一次插件发现；检查只采集一轮，写后不自动重新完整读取。
- 探测失败时配置可见，静态权限仍可用，运行时-only 权限不降级。
- 主模型/fallback、wildcard、防清空、409 和备份回滚回归保持；桌面/窄屏无新增 body 溢出，所有耗时动作有持续状态反馈。

## 本地试用修正：原生发现、参数同步与运行时引用

- 没有显式 baseUrl/api/apiKey 的原生 `openai` / `openai-codex` 配置，发现操作读取 OpenClaw 的完整公开模型目录，沿用原生鉴权体系；不读取/转发 Codex OAuth Token，也不要求补 `OPENAI_API_KEY`。显式 API Key/兼容地址渠道保持 HTTP `/models` 发现。弹窗标明目录来源，不将目录条目冒充账号调用权限。
- 同步参数及参数确认队列只刷新静态数据，保留已有插件/在线表格，并标注在线状态待确认，不清空为 manifest 预览。不触发额外完整探测。
- 在 config Provider 模型弹窗中，非本地目录的运行时模型标为「使用引用」。Core `canRemovePolicyExactRef` 允许时提供「移除引用」，明确只删除精确放行与 metadata；目录和 Key 保留。尚无证据时提供显式「检查引用」，真正 metadata-only 残留继续走独立清理接口。
- 回归结果：相关 Core/Server 293 项、全 Web 272 项通过，桌面/手机专项 E2E 6 项通过，typecheck/build 通过。全部写入测试使用隔离 fixture，未删除真实 `opencode/omen-alpha`。
