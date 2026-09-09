# oc-switch 跨机配置同步设计（本机 ↔ SSH 对端）

日期：2026-09-09
状态：已实现（v1），已通过 `bun run check` + `bun run acceptance`

## 0. 实现对照（Sync Audit，2026-09-09）

- core：`packages/core/src/config-sync.ts`（`SyncPayload` 用 `SyncSubtree{present,value?}` 包装，缺失与空严格可区分；`buildSyncPayload` / `applySyncPayload` / `projectSyncTarget` / `collectSyncRefs` / `classifySyncProviderRefs` / `buildSyncCheckReport`）；diff-guard 白名单仅加 `plugins.entries.<id>.enabled` 一个键位并已从 core index 导出。
- CLI：`packages/cli/src/commands/sync.ts`（`sync diff` / `sync push` / 隐藏 `sync-agent read-config|check|write|env-upsert`）+ `packages/cli/src/sync-executor.ts`（注入式 executor；默认 ssh BatchMode + 30s 超时；远端命令前置 `~/.bun/bin`/`~/bin`/`~/.npm-global/bin` PATH；`OC_SWITCH_REMOTE_CLI` 可覆盖远端命令名）。
- 测试：`packages/core/test/config-sync.test.ts`（17 例）、`packages/cli/test/cli-sync.test.ts`（10 例，假 ssh 双端 fixture）、`diff-guard.test.ts` +2 例；全套 `bun run check` + `bun run acceptance` 通过。
- 实现偏离（有意取舍）：
  1. §5.2「远端备份」不单列步骤——`writeOpenClawTransaction` 原子内含自动备份，测试已锁定可回滚；
  2. `sync-agent env-upsert` 按 key 循环 `applyEnvOperation`（每 key 一次既有事务），复用既有写入路径而非新建批量事务；
  3. 交互路径（确认提示、逐项插件确认、`--fill-keys` 密文输入）受无 pty 限制未做端到端测试，已覆盖全部非 TTY fail-closed 分支与 plumbing 直调。

## 1. 背景

用户在本机与 SSH 可达的 claw 主机上各部署了一套 oc-switch + OpenClaw，需要保持两边的第三方 provider 与模型配置一致。现状只有 `presets export/import`（provider 粒度、丢启用状态与主模型）与 backup/restore（备份 metadata 含路径，跨机路径不一致直接拒绝恢复），都不适合作为持续同步手段。

## 2. 范围

### 2.1 同步内容（in scope）

`openclaw.json` 的三个子树：

- `models.providers` —— config provider 与本地模型目录；
- `agents.defaults.models` 与 `agents.defaults.modelPolicy.allow` —— 有效启用状态（含指向插件 provider 的 ref）；
- `agents.defaults.model` —— 主模型（双形态，经 `primary-model.ts` 归一层读写，形状守恒，不丢 `fallbacks` 与未知键）。

### 2.2 不同步内容（out of scope）

- **插件 provider 的模型目录与安装**：目录来自插件 manifest，从不落 `openclaw.json`；插件安装/卸载是 OpenClaw 自身 domain。同步工具只做校验与提醒（例外：`enabled` 开关见 §6.3）。
- **密钥值**：`.env` 不传输；provider `apiKey` 的 SecretRef 只校验对端是否缺对应 env 变量。
- **对端其余配置**：gateway、`plugins.entries`（§6.3 例外之外）、本机路径等一律不动。
- **本地状态**：`provider-states.json`、`~/.oc-switch/settings.json`、备份目录等不跨机携带。
- **不做双向、不做 merge**（见 §3）。

## 3. 同步语义：单向 push + 子树覆盖

指定一端为 source of truth（默认本机），`sync push <host>` 把 §2.1 的三个子树**整体覆盖**到对端，对端其余内容原样保留。

选覆盖而非 merge 的理由：modelPolicy.allow 的写入规则是 fail-closed 的（不得创建/清空/改写用户 wildcard、不得隐式展开），自动合并无法安全表达「两端并集」；主模型 fallbacks 也有 fail-closed 保护。覆盖式语义下这些规则天然满足——目标端被子树整体替换，不存在需要逐条裁决的合并冲突。

代价与对策：对端本地私有的 provider/启用条目会被覆盖丢失。对策是写入前强制 **远端备份 + diff 预览 + 人工确认**（§5），让丢失在确认前可见。

## 4. 传输与执行：SSH 调用远端 oc-switch CLI

不直接 scp 糊文件。`sync push` 通过 ssh 在对端执行远端 oc-switch CLI 完成读取与写入：

- 写入仍经过 core 这个唯一 writer：自动备份、JSON5 读取、写入校验、`primary-model.ts` 归一层全部保持一致；
- 对端 config 路径由远端 settings 的活动路径解析（兼容 `OPENCLAW_CONFIG_PATH` 差异），可用 `--path` 显式指定；
- 前置条件：对端已安装 oc-switch 且 ssh 免密可达；preflight 阶段验证，不满足则报错退出。

## 5. 流程

1. **preflight**：ssh 连通性、远端 oc-switch 可用、远端 config 路径解析成功。
2. **远端备份**：写入前强制 `oc-switch backup`（复用既有备份机制，可回滚）。
3. **拉取远端 config 到本地做 diff 预览**：仅展示 §2.1 三个子树的差异；复用 diff-guard 白名单，白名单外的变化视为异常并中止（防呆：说明 payload 构造或远端配置超出预期）。
4. **人工确认**（非交互环境须显式 `--yes`）。
5. **远端写入**：三个子树覆盖（§3）。
6. **校验报告**（§6）：远端跑 `config-status` + 同步专项检查，输出行动清单。

## 6. 校验与提醒

启用状态与主模型可能引用「不同步」的东西（插件 provider、env 密钥），所以校验是正确性保障，不是可选项。原则：**校验 + 提醒 + 有限的显式 opt-in 操作，不自动做更多改动**。

### 6.1 插件 ref 校验

对同步后状态中的每个 provider ref（`models.providers` 之外的来源），用远端 `discoverPluginCatalog()` 判定：

- 插件已安装且 enabled → 正常；
- 插件已安装但 `enabled=false` → 提醒，并进入 §6.3 的可选自动开启；
- 插件未安装 → 提醒「对端需 `openclaw plugins install <id>`」，对应 ref 会在 `config-status` 中表现为 drift/unknown，**同步本身不算失败**，但报告中显著标注。

### 6.2 env 密钥校验

对同步后每个 provider 的 `apiKey` SecretRef / 插件 manifest `setup.providers[].envVars` 声明的变量名：

- 检查对端 `.env`（托管块内外都算）是否存在同名变量；
- 缺失时**只报变量名**（不回显任何值），提醒用户在对端自行设置；
- 支持在导入流程中交互式逐项填入（写入对端 `.env` 托管块，走既有 `.env` 写入路径），用户可逐项跳过；未填的项仅保留提醒，不做其他改动；
- 提醒「改 Key 后需 `sync-env` + `restart` Gateway」，但本命令不自动执行。

### 6.3 插件 enabled 的可选自动开启

对「已安装但 `plugins.entries.<id>.enabled=false`」且被同步后状态引用的插件：

- 默认只提醒；`--enable-plugins` 或交互确认后，写入 `plugins.entries.<id>.enabled=true`；
- **只能 false→true，绝不自动 disable**；`enabledByDefault` 生效、无显式条目的插件不写；
- 这是对 v1「不写 `plugins.entries`」边界的**刻意收窄扩展**：仅本命令、仅此字段、仅此方向；diff-guard 白名单相应只加 `plugins.entries.<id>.enabled` 一项；
- 写入仍走 core writer（含自动备份）；开启后提示需 restart/apply Gateway 生效，不自动重启；
- 插件未安装时此选项无效（不 install），退化为 §6.1 的提醒。

## 7. CLI 形态（草案）

```bash
oc-switch sync push <host> [--path <远端config路径>] [--yes]
                           [--enable-plugins] [--fill-keys]
oc-switch sync diff <host>   # 只跑 §5.1–5.3，等价于 dry-run 预览
```

- `sync diff` 不写任何东西，供推送前检查；
- 交互确认缺 TTY 时必须 `--yes`，否则 fail closed；
- Web/API 端暂不纳入 v1（避免 token 与长事务复杂度），后续可补只读的 `sync diff` 展示。

## 8. 安全与 fail-closed 规则

- 任何一步失败：已完成的远端备份保留，已写入的改动可由用户 `backup restore` 回滚；命令报告失败点，不静默续跑；
- 传输不携带任何密钥值；报告中不出现密钥值；
- 覆盖写仅在 diff-guard 白名单（三个子树 + §6.3 一项）内生效，白名单外差异中止；
- 远端备份 metadata 路径校验等既有防呆不变（本功能不做跨机 restore，规避路径不一致拒绝）。

## 9. 已知限制与后续

- 单向、单跳；多端同步靠多次 push，不做拓扑编排；
- 对端运行时-only 插件模型（manifest 之外的 shard 条目）oc-switch 本就不可见，相关 ref 仍会被判 drift（见插件 Provider 设计 §2.1），同步不放大也不解决该误差；
- 后续候选：`sync pull`（反向）、Web 端 diff 展示、对端版本兼容性检查（oc-switch/OpenClaw 版本差异提示）。
