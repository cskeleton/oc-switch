# 真实配置写 E2E

- 日期：2026-09-19
- 状态：脚本与单测已实施（2026-09-19）；首次真实执行待用户在场授权。实现要点：`scripts/e2e-real-config.ts`（三重门：env var + `--config` 路径校验（含 fixture 模式/临时目录拒绝，tmpDir 参数化供测试）+ TTY 确认；三场景经 CLI 子进程往返；还原为写前 `createBackup` 安全网 + 旁路字节写回 + 语义指纹/字节/`.env`/`provider-states.json` 不变四重断言，恢复原权限位；退出码 1 场景失败 / 2 还原失败 / 3 门禁拒绝；备份创建失败按门禁拒绝处理；场景失败即停止防级联；Gateway 只读对账 best-effort）；`scripts/e2e-real-config.test.ts` 18 用例全临时 fixture（全协议用例走真实 CLI 子进程 + PATH 前置假 openclaw 回放，还原失败经 restoreFile 注入），`package.json` test glob 纳入 `scripts`；`bun run check` 与 `bun run acceptance` 全绿。
- 基线：`AGENTS.md:12`（真实配置优先只读、写后须还原）；runtime spec「真实写入验证只在用户明确授权后执行」；现有隔离 E2E/acceptance 基础设施。
- 配套计划：暂无（评审通过后编写）。

## 1. 目标与判断

现有 E2E/acceptance 全部跑在隔离 fixture（mkdtemp HOME + fake openclaw 回放），能证明逻辑正确，但不能证明「真实 OpenClaw 配置 + 真实 Gateway 探测」链路下写入行为正确——JSON5 注释保留、真实插件目录合并、真实 runtime 探测、真实守卫触发都只在真实环境可验。本期设计一个 **opt-in 手动脚本**，在真实配置上做最小写入面验证并字节级还原。

2026-09-19 源码核对结论（设计前提）：

- **还原不能走 `restoreBackupSafely`**：它对 openclaw.json 做 JSON 归一重写（丢 JSON5 注释/格式），且恢复 `.env` 时会自动 sync gateway service env（副作用外溢）。还原必须旁路：写前 `readFileSync` 存原始字节，finally 原样写回并校验字节一致；`createBackup` 仍先跑，作为安全网（备份 0700/0600，保留并报告 id）。
- **现有防线是代码强制的**：`runCli` 硬抛「isolated HOME」、e2e 断言端口 ≠7420 且路径匹配 fixture 模式——真实写脚本必须是**独立入口**，不复用这些 harness，且自带反向防线。
- **写入面必须排除 `.env`**：env 写入会触发事务自动 `gatewayEnvSync`（改 service env 快照），还原面随之扩大。第一阶段只写 `openclaw.json` 子树。
- 无 CI，所有验证脚本均本地手动；本脚本同样不进 `check`/`acceptance`/`test:e2e` 默认链路。

## 2. 范围与兼容边界

本期（第一阶段）场景，全部只写 `openclaw.json`、不碰 `.env`/密钥/Gateway 进程：

1. **主模型切换**：读当前 primary → 切到另一有效模型 → 回读断言 `agents.defaults.model` 变化且 fallbacks 等未知键守恒 → 还原。
2. **Policy 规则往返**（restricted 时）：添加一条**已被现有 wildcard 覆盖的冗余 exact**（不改变有效选择范围，命中既有「冗余提示」语义）→ 断言存在 → 用批量/单条删除移除 → 断言消失。无 wildcard 可用时降级为「添加指向目录已有模型的 exact → 删除」，仍零有效变化。非 restricted 模式该场景跳过并报告。
3. **Provider 停用/恢复一对**：选一个**不贡献主模型/fallback** 的 config Provider → disable → 断言 `provider-states.json` 快照与目录保留 → enable 恢复 → 断言。若所有 Provider 都被 primary/fallback 引用则跳过并报告。

每个场景统一骨架：写前语义指纹 → 操作 → 生效断言 → 逆向操作还原；全部场景结束后统一字节写回 + 四重断言（字节一致、语义指纹等价、`.env` 不变、provider-states 不变）。

**明确不做（第一阶段）**：

- 不写 `.env`、不做 `provider add-custom`/Key 操作、不做 `sync push`（密钥面，留后续阶段单独授权）。
- 不 restart/apply Gateway、不做插件启停（影响运行中服务）；Gateway 对账只读（见 §4）。
- 不走 ssh 远端（claw 列为后续候选，届时经 `ssh claw` 部署后在其本机跑同一脚本）。
- 不进任何默认脚本/CI；不做定时或自动触发。
- 不要求字节级之外的格式约定；还原保真由旁路字节写回承担，不归一化真实配置。

## 3. 入口与安全门

新脚本 `scripts/e2e-real-config.ts`（`bun run scripts/e2e-real-config.ts -- --config <path>`），不进 `package.json` 默认脚本链。

双门 + 交互确认，缺一拒跑：

1. 环境变量 `OC_SWITCH_REAL_CONFIG_E2E=1`；
2. 显式 `--config <path>` 参数，且路径必须：文件存在、位于 `$HOME` 之下、**不匹配**任何 fixture 模式（`oc-switch-e2e-*` / mkdtemp 前缀）——反向复用现有防线的镜像断言；
3. 非 TTY 直接拒跑；TTY 显示目标路径、当前 primary、模式、场景清单与「将写入并还原」说明，用户输入确认词才开始。

运行中 Gateway 只提示不阻断（本阶段场景不依赖重启）；检测到 `oc-switch serve` 常驻实例占用同配置时提示「测试期间该实例会读到变化」，由用户确认继续。

## 4. 执行与还原协议

- **写前**：`createBackup`（reason `e2e-real-config`）→ 记录 backupId；`readFileSync` 存 `openclaw.json` 原始字节；core 读入做语义指纹（规范化 JSON 的稳定序列化 hash）。
- **写入**：全部经 core 公开 API / CLI 子进程（`bun run packages/cli/src/index.ts`，`OPENCLAW_CONFIG_PATH` 指向目标），与被测真实链路一致；不经 server（避免再起实例）。
- **还原（finally 无条件）**：字节写回 → 重读校验字节一致 + 语义指纹等价 → 报告产生的 backupId（保留不删，用户可自行清理；retention 20 自动滚动）。
- **任一还原断言失败**：立即停止后续场景，打印醒目告警 + 备份路径 + 当前文件状态，退出码 2（区别于场景失败 1 与门禁拒绝 3）。
- **Gateway 只读对账**：场景结束后若 `openclaw` CLI 可用，跑 `gateway config.get` 只读校验所选配置路径与已应用版本（不缓存、不重启），结果纳入报告；报告必须声明「运行中 Gateway 进程 env/选择器未验证，如需生效由用户手动 apply」。

## 5. 报告与验收

- 逐场景 pass/fail/skip + 还原证明（字节一致、指纹等价）+ backupId 列表 + Gateway 只读对账结果；全程不打印任何密钥值（复用 `assertNoSecrets` 模式的扫描）。
- 验收（实施后由用户授权执行一次）：本机真实配置跑通三场景，全部还原断言通过；报告贴入 spec 状态行。
- 实施自身的单测：脚本逻辑（门禁、指纹、还原、退出码）用临时目录 fixture 覆盖，**单测绝不触碰真实路径**（模拟 `--config` 指向临时文件验证全协议）。

## 6. 文档同步

实施并授权执行后：本 spec 状态改「已实施」附真实执行结论；`AGENTS.md`「已知后续」移除「真实配置写 E2E」、工具链节补脚本入口与双门说明、规格索引登记。
