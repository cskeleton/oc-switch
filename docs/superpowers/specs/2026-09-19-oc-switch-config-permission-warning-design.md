# 配置文件权限警告（chmod 警告）

- 日期：2026-09-19
- 状态：已实施（2026-09-19）。实现要点：Core `buildPathIssues` 追加 `permissionsTooOpenIssue`（`(mode & 0o077) !== 0` → `paths:permissions-too-open:openclaw|env` warning，win32 跳过）；CLI `health` 增加 issues 汇总段与 `--json`；Web Settings「路径」tab 权限 banner。验收：`bun run check`（core/server/cli 1208 pass、web 237 pass、typecheck、build）与 `bun run acceptance`（0644 → 出现 warning → chmod 600 → 消失）全部通过。实施说明：`health` 保留原大小写重复输出、issues 段在前；Web 拉取挂在 Settings `load()`（覆盖挂载与路径切换）；两条既有「issues 为空」core 用例 fixture 补 chmod 0600（0644 不再是「无 issue」状态，属特性生效的必然适配）。
- 基线：`2026-06-24-oc-switch-path-env-management-design.md`（:509-514 登记「chmod 失败时操作继续、设置页显示权限警告」；写时收紧已实施，本 spec 覆盖读时检查）。
- 配套计划：任务量小，不单独建计划文件；任务分解见 §2-§5，验收见 §6。

## 1. 目标与判断

`openclaw.json` 与 `.env` 含 SecretRef/密钥材料，权限过宽（group/other 可读）是静默泄露面。core 现有写时收紧（`json-state-store` / `backup-manager` / service env 均 0600/0700），但从不检查这两个文件的现有权限。本期加只读检查与三端提示，**不自动 chmod**（改用户文件权限需显式动作，且 `chmod` 失败语义已在旧 spec 定义）。

2026-09-19 源码核对：`buildPathIssues`（`config-status.ts:117-198`）已是 paths 类检查聚集地，直接 fs 访问、真实文件 fixture 测试（`:206-218` chmod + win32 skip 先例）；`ConfigStatusIssue` id 模式 `source:kind:subject`；CLI 无任何命令输出 `issues[]`；Settings 页不消费 config-status。

## 2. Core

在 `buildPathIssues` 既有 `existsSync`/`accessSync` 链后追加 mode 检查：

- 对 `paths.openclawPath` 与 `paths.envPath`：`statSync` 成功且 `process.platform !== "win32"` 时，`(mode & 0o077) !== 0` 产生 **warning** issue：
  - id：`paths:permissions-too-open:openclaw` / `paths:permissions-too-open:env`
  - title：`openclaw.json 权限过宽` / `.env 权限过宽`
  - detail：当前权限位（八进制，如 `0644`）与路径；**不含文件内容**
  - action：`chmod 600 <path>`（人类可读建议，不自动执行）
- win32 跳过（mode 语义不可靠）；stat 失败（不存在/不可读）已被既有 missing/unreadable 分支覆盖，不重复报。
- 只检查这两个文件；不检查目录、`~/.oc-switch`（自有状态写时已收紧）。
- 非阻断：severity 固定 `warning`，不进 attention blocking 合并。

## 3. REST / CLI

- REST 零新端点：`GET /api/config-status` 的 `issues[]` 自动携带（五处 core 调用方零改动）。
- CLI `oc-switch health`：主 action 增加 issues 汇总段——调用 `inspectConfigStatus`，按 severity 列出 `title` + `action`（blocking 在前）；无 issue 时输出保持现状（大小写重复检查文案不变）。`--json` 时附 `issues` 数组。不改变 `health repair` 语义（repair 不处理权限警告，权限修复是用户手动 chmod）。

## 4. Web（Settings「路径」tab）

- Settings 页挂载时拉一次 `getConfigStatus()`（失败静默，不弹 toast）。
- 过滤 `source === "paths"` 且 id 以 `paths:permissions-too-open:` 开头的 issue，在路径选择器附近显示 warning banner：逐条 title + detail（权限位）+ action 命令（mono，可复制）。
- 路径切换/保存后重取。复用既有 banner/alert 组件与语义色 token；移动端不横滚。
- 不在 Dashboard 重复展示（Dashboard 配置健康卡是备份 diff 卡，本期不改它的语义）。

## 5. 不做

- 不自动 chmod、不提供「修复」按钮（权限变更由用户显式执行）。
- 不检查备份目录/stateDir/token 文件（写时已收紧）。
- 不接入 model-attention 待办；severity 不上 blocking。
- 不支持 win32 权限判定。

## 6. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| `openclaw.json` / `.env` mode 0644（或 0640 等含 group/other 位） | config-status issues 含对应 `paths:permissions-too-open:*` warning，detail 含八进制权限位 |
| 两者 0600 | 无该 issue |
| win32 | 不产生该 issue（测试 skip 模式沿用既有先例） |
| 文件不存在/不可读 | 既有 missing/unreadable 分支行为不变，不重复报权限 |
| CLI `health` | 输出权限 warning 与 action；0600 时输出与现状一致 |
| Web Settings | 过宽时路径 tab 显示 banner 含 chmod 命令；0600 或无 issue 时不显示 |
| acceptance | fixture chmod 0644 → config-status 出现 warning → chmod 600 → 消失 |

测试沿用既有缝：core 真实临时文件 + chmod + win32 skip；server `createTestApp` + `jsonRequest`；CLI `runCli` 环境变量注入；web test-setup 首行导入。
