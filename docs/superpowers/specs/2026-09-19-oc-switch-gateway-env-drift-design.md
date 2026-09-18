# Gateway 环境分叉检测（env-drift）

- 日期：2026-09-19
- 状态：已实施（2026-09-19）。实现要点：Core `inspectGatewayEnvDrift`（+ `unavailableGatewayEnvDriftReport` / `listAmbiguousGatewayEnvDriftCandidates`，`packages/core/src/gateway-env-drift.ts`）；API `GET /api/gateway/env-drift`（恒 200 + `report.status`）；CLI `gateway env-drift [--candidate] [--json]`（分叉 exit 0、unavailable exit 1）；Web Settings「环境分叉」卡片（`GatewayEnvDriftCard`）。验收：`bun run check`（core/server/cli 1178 pass、web 225 pass、typecheck、build）与 `bun run acceptance`（missing → sync-env 归零 → 手改快照 different → 歧义 candidates，含密钥不泄露断言）全部通过。偏离说明：`multiline-value` 不可达（解析器逐行 split），保留分支作防御；acceptance 走 API 而非 CLI 子进程（CLI 无 discovery 注入缝，CLI 契约由单测覆盖）。
- 基线：`2026-06-24-oc-switch-path-env-management-design.md` §15（Gateway 服务环境同步）与 §16（预告本端点，已标注实现）。
- 配套计划：`../plans/2026-09-19-gateway-env-drift.md`。

## 1. 目标与判断

把「`.env` 托管块与 Gateway service env 快照分叉」从隐性问题变成可见待办。典型场景：改了 API Key 但快照未同步或未重启，运行中进程仍用旧值；残留已删除的 Key；macOS 块外同名 Key 遮蔽托管块。

2026-09-19 源码核对结论（实现时须复用，不另造轮子）：

- 三态比较原语已存在：`inspectGatewayServiceEnvKeyStates`（`gateway-service-env-sync.ts`）返回 `missing | equal | different`，不暴露值；SecretRef 迁移预检（`routes/providers.ts`）已示范「读 envContent → automatic 关联 → 逐 key 三态」完整骨架。
- 目标解析已存在：`resolveGatewayRuntimeTarget`（`gateway-runtime-target.ts`），automatic 模式要求「带非空 `serviceEnvPath` 的路径匹配组恰 1 个」，错误码 `no-matching-group` / `no-service-env` / `ambiguous-match` / `stale-candidate` 等。
- 解析器已存在：`readManagedBlockEntries` / `readGatewaySystemdEnv` / `readLaunchdServiceEnv` / `readGatewayServiceEnvKeys`。
- 缺的是聚合层：方向性分类、extra/outside-conflict 检测、GET 路由与三端出口。

## 2. 范围与兼容边界

本期：Core 聚合函数 `inspectGatewayEnvDrift`、REST `GET /api/gateway/env-drift`、CLI `gateway env-drift`、Web 设置页分叉卡片与三端测试。

**明确不做（本期）**：

- 不并入 `buildModelAttention` 统一待办列表（远期候选；env 分叉不是模型配置问题）。
- 不读取运行中进程 env；只比较**文件**。报告文案必须说明「进程 env 固定于启动时，重启后才加载新值」。
- 不检测 `.env` 块外变量（同步源仅托管块，§15.1 既定）。
- 不自动修复：分叉只报告，修复仍走 `sync-env` / `apply` 或用户手动。
- 不提供 `--fail-on-drift` 之类的 CI gate 退出语义（远期候选）。
- 不缓存、不定时推送；每次请求现读文件、现做 discovery（与现有 gateway 路由一致）。
- 不回显任何 value（含 masked 指纹）；报告只含变量名与状态枚举。

## 3. Core 契约

在 `packages/core/src/gateway-service-env-sync.ts`（或同域新文件）新增纯函数，文件读取与目标解析留在调用方：

```ts
inspectGatewayEnvDrift(input: {
  envContent: string;          // active envPath 的 .env 内容
  target: GatewayServiceEnvTarget;
  serviceEnvContent: string | null;  // null 表示目标文件不存在
}): GatewayEnvDriftResult;
```

### 3.1 分叉分类（方向性语义，§15 优先级推导）

设 `sourceManaged` = 源 `.env` 托管块条目；`targetManaged` = 目标文件托管块条目；`targetAll` = 目标文件全部有效条目（systemd：全文裸 `KEY=VALUE`；launchd：块外 `export` ∪ 托管块）。

| state | 判定 | severity | 语义 |
|---|---|---|---|
| `equal` | key ∈ sourceManaged 且与 targetAll 同值 | info | 一致 |
| `missing-in-service` | key ∈ sourceManaged，targetAll 无 | info | 运行时由全局 `.env` 补足；进程重启后生效 |
| `different` | key ∈ sourceManaged，targetAll 同名不同值（含空值） | **blocking** | 快照旧值覆盖 `.env`，进程加载旧值 |
| `extra-in-service` | key ∈ targetManaged 但 ∉ sourceManaged | warning | 托管区残留；下次 sync 整体替换托管块时移除 |
| `outside-conflict` | key ∈ sourceManaged 且同时存在于目标托管块**内与外** | warning | 托管块由 sync 追加在文件末尾、运行时块内值生效，块外为残留；提示手动清理 |

仅出现在托管块**外**（或目标文件无托管块）的同名 key 不属于 `outside-conflict`：没有块内条目压制，其值实际生效，必须落入值比较——不同值即 `different`（blocking），相同为 `equal`。这正是「改过 Key 但快照从未 sync」的核心场景，不得降格为 warning。

- `extra-in-service` 必须限定在目标**托管块内**：systemd 快照块外的 OpenClaw 服务元变量、`HTTP_PROXY` 等属合法块外内容（§15.1 原样保留），不得误报为分叉。
- 值比较复用现有解析器的去引号语义；禁止把值放入任何输出。
- 源托管块中的空值/多行值：无法通过 sync 同步（`assertServiceFriendlyValue` 既定拒绝），entry 附 `unsyncable: "empty-value" | "multiline-value"`，severity 至少 warning；state 仍照常计算。
- 排序：blocking → warning → info，同级按 `envVar` 字母序。

### 3.2 结果 DTO

```ts
type GatewayEnvDriftState = "equal" | "missing-in-service" | "different" | "extra-in-service" | "outside-conflict";
type GatewayEnvDriftSeverity = "blocking" | "warning" | "info";

interface GatewayEnvDriftEntry {
  envVar: string;
  state: GatewayEnvDriftState;
  severity: GatewayEnvDriftSeverity;
  unsyncable?: "empty-value" | "multiline-value";
}

interface GatewayEnvDriftReport {
  version: 1;
  status: "ok" | "unavailable";
  target?: { candidateId: string; targetKind: "systemd" | "launchd"; serviceEnvPath: string };
  entries: GatewayEnvDriftEntry[];
  summary: { checked: number; equal: number; missingInService: number; different: number; extraInService: number; outsideConflict: number; unsyncable: number };
  warnings: string[];
  unavailable?: {
    code: GatewayRuntimeTargetErrorCode | "service-env-unreadable";
    message: string;
    candidates?: Array<{ candidateId: string; serviceManager?: "systemd" | "launchd"; serviceId?: string; serviceEnvPath?: string }>;
  };
}
```

- `serviceEnvContent === null`（目标文件不存在）：按全部源 key `missing-in-service` 计算，`warnings` 提示快照文件缺失；读取出错（权限等）→ `status: "unavailable"`，`code: "service-env-unreadable"`。
- `ambiguous-match` 时 `candidates` 必须给出可选项，供客户端带 `candidateId` 重试；不得猜测其一。

## 4. REST

```text
GET /api/gateway/env-drift[?candidateId=<id>]
```

- 路由加入 `packages/server/src/routes/gateway.ts`。无 `candidateId` → `resolveGatewayRuntimeTarget({ mode: "automatic" })`；有 → explicit 模式并做路径匹配校验。
- 响应恒为 200 + `{ ok: true, report }`：这是读报告，「无法唯一关联」是正常状态（未安装 Gateway、多实例歧义），不是客户端错误；`report.status` 承载区分。查询串以外的输入非法仍走现有 400。
- 每次请求现读 `envPath` 与目标文件、现做 discovery；不缓存（文件小，且 drift 必须反映刚发生的写入）。
- 报告与响应任何字段不得包含 env value；server 测试须 grep 断言 fixture 密钥值不出现在响应体。

## 5. CLI

```bash
oc-switch gateway env-drift [--candidate <id>] [--json]
```

- 计算成功（**包括存在分叉**）退出码 0——分叉是数据不是命令失败；`status: "unavailable"` 退出码 1 并打印原因（ambiguous 时列出候选，复用 `formatGatewayTargetError` 模式）。
- 人类可读输出：目标行（candidateId / targetKind / serviceEnvPath）→ 非 equal 条目表（key、state、severity；无 value 列）→ summary 行 → 下一步提示（存在 blocking/warning 时提示 `gateway sync-env` 或 `gateway apply`；blocking 文案须说明「运行中 Gateway 可能仍使用旧值，重启后生效」）。
- `--json` 输出完整 `GatewayEnvDriftReport`。

## 6. Web（设置页）

在 Settings 的 Gateway 区段新增「环境分叉」卡片，按 Settings 现有数据获取模式接入：

- `status: "ok"`：summary 徽章（「N 项分叉」/「一致」），可展开逐 key 行（变量名 + state/severity Pill，**无 value**）；存在 blocking/warning 时提供「同步」与「同步并重启」按钮（复用现有 sync-env / apply client 方法与确认交互），操作成功后重新拉取 drift。
- `different` 存在时卡片用 danger 语义色，文案「运行中 Gateway 可能仍使用旧值」。
- `unavailable` + `ambiguous-match`：列出候选供选择后带 `candidateId` 重取；其他 unavailable：弱化内联提示（如「未发现可关联的 Gateway 服务环境」），不弹错误 toast。
- 复用 Button / Pill / 共享组件；移动端不横向溢出。
- env 写入成功（GatewayApplyBanner 流程）后使 drift 查询失效并重取。

## 7. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| 源托管块 key 快照缺失 / 同值 / 不同值（含空值） | 分别 `missing-in-service`（info）/ `equal` / `different`（blocking） |
| 快照托管块残留已删 key | `extra-in-service`（warning）；systemd 块外服务元变量不误报 |
| launchd / systemd 同名 key 同时存在于托管块内与外 | `outside-conflict`（warning）；仅块外存在时按值比较（不同值 = `different`/blocking） |
| 源托管块空值 / 多行值 | entry 带 `unsyncable`，severity ≥ warning，state 照常计算 |
| 无候选 / 无 serviceEnvPath / 多候选歧义 / stale candidateId | 200 + `status:"unavailable"` + 对应 code；歧义附 candidates |
| 目标文件不存在 / 不可读 | 不存在→全 `missing-in-service` + warning；不可读→`service-env-unreadable` |
| sync-env / apply 成功后 | 再查 drift，源托管块 key 全部 `equal`，extra 清零 |
| 安全 | API/CLI/Web 输出不含任何 fixture 密钥值（含 masked） |
| 进程 env 与文件不一致 | 文案明确「文件级比较，重启后生效」，不声称探测运行中进程 |

测试隔离沿用既有缝：server 经 `AppOptions.runtimeDiscoveryProvider` 注入候选组 + 临时目录真实写 service env 文件；CLI 进程内 `registerGatewayCommands` + 注入 discovery；core 纯函数内存 fixture。任何测试不得读真实 `~/.openclaw` 或常驻实例。

## 8. 文档同步

实施后：`2026-06-24` spec §16 该条目标注已实现并指向本 spec；`AGENTS.md`「已知后续」移除 `GET /api/gateway/env-drift`，能力摘要补 env-drift 条目；本 spec 状态改为「已实施」并附验收结论。
