# Policy 规则原子编辑与规则层删除

- 日期：2026-09-16
- 状态：已实施（2026-09-16）。实现要点：Core `buildModelPolicyRevision` / `replaceModelPolicyRule` / `removeModelPolicyRule`；inventory 投影新增 `policyRevision` 与规则行 `editable`、`removable` 改为纯规则删除判定；API `PATCH|DELETE /api/model-policy/rules`（409 `policy-revision-conflict`）；CLI `model replace-policy-rule` / `model remove-policy-rule`；Web 规则行编辑对话框与统一纯规则删除入口。验收：`bun run check`、`bun run acceptance`（sole wildcard 原子替换 / 冗余 exact 纯规则删除 / 过期 revision 409）、Playwright E2E（编辑成功与 409 冲突，桌面+手机）全部通过。
- 基线：`2026-09-13-oc-switch-policy-editing-design.md` 已实施的添加/删除功能。
- 配套计划：`../plans/2026-09-16-policy-rule-replacement.md`。

## 1. 目标与判断

允许用户主动修改已有 exact / wildcard 规则。禁止隐式改写用户规则，不能解释为禁止用户显式编辑。规则编辑只改变 `agents.defaults.modelPolicy.allow`；目录、metadata、密钥、主模型和 fallback 不联动修改。

2026-09-16 源码与内存 fixture 核对结果：

- 当前没有原子替换 operation，也没有行内编辑入口。
- 当前可以先添加 exact，再删除覆盖它的 wildcard；“最后一条规则必然无法更换”不是准确描述。
- `removeModelPolicyExactRef` 同时承担引用清理语义，会拒绝删除被 wildcard 覆盖的 exact，也会无条件保护 primary/fallback exact。直接复用为规则编辑会导致“允许添加冗余规则，却不能删除它”。
- `removeModelPolicyWildcard` 已按剩余规则是否继续覆盖 primary/fallback 判断。规则层应对 exact 与 wildcard 使用一致的最终覆盖判断。

## 2. 范围与兼容边界

本期：新增规则原子替换、纯规则删除入口、规则面板切换到纯规则入口、过期编辑冲突检测，以及对应 CLI/API/测试。

保留既有 `removeModelPolicyExactRef` / `DELETE /api/model-policy/exact-ref` / `model remove-policy-ref` 的清理语义和 `removeMetadata` 行为。模型行的停用、rename、删除、Provider/插件停用及其 capability 不放宽。新增规则入口不接受 `removeMetadata`。

不做模式切换、整数组自由编辑、批量替换、invalid 条目修复、per-agent 策略写入、自动 wildcard 展开/挖洞/去重。legacy / unrestricted 本期仍不可编辑。未来“取消限制”应为显式模式操作；不得把删除最后一条解释为全部禁用。

## 3. Core 契约

扩展 `packages/core/src/model-policy-edit.ts`，复用现有匹配与校验能力，不新建通用规则引擎。

```ts
buildModelPolicyRevision(config: OpenClawConfig): string;

replaceModelPolicyRule(
  config: OpenClawConfig,
  value: string,
  rule: string,
  options?: AddModelPolicyRuleOptions & RemoveModelPolicyWildcardOptions
): OperationResult & { rule: string; kind: "exact" | "wildcard"; replacedCount: number };

removeModelPolicyRule(
  config: OpenClawConfig,
  value: string,
  options?: RemoveModelPolicyWildcardOptions
): OperationResult & { removedCount: number };
```

纯函数不得修改输入。revision 为带版本前缀的 SHA-256，输入为确定性序列化的当前 policy 模式及完整原始 allow（包括非字符串项），保留数组顺序、大小写、重复次数；不包含全配置、认证或 env，不回显原始非法值。与 policy 无关的配置变化不使 revision 失效，但最终保护必须对事务内最新 config 重算。

### 3.1 定位与重复项

- `value` 为读取到的旧字符串，按原字符串完全相同匹配，不 trim 旧值，不按排序后的行下标定位，不把 Provider 大小写折叠用于目标定位。
- 删除移除所有完全相同副本，返回 `removedCount`。
- 替换在每个匹配位置写入同一新规则，保留副本数量与原位置，返回 `replacedCount`。重复项数量大于 1 时 UI 和 CLI 明示“同时修改 N 条相同规则”。
- 新 `rule` trim；exact 沿用现有归一存储规则，wildcard 保留输入大小写。不得顺带改写其他条目。
- 新值归一后与旧值相同：Core 返回 `unchanged-rule`，Web 无修改时禁用保存，不产生备份。
- duplicate 检查排除本次全部旧值副本，再沿用添加规则的 exact 语义重复 / wildcard 完全相同重复规则。仅被其他 wildcard 覆盖允许并提示冗余。
- 旧值不存在返回 `policy-rule-not-found`；新增输入格式规则与现有添加入口共用。

### 3.2 最终状态保护

替换直接构造最终 allow，再校验；禁止调用现有删除后再添加来实现。

1. 当前必须为 restricted。
2. 删除不得使 raw allow 变 `[]`（现有 `last-rule-removal`）；不能伪造一条占位规则绕过。
3. 对 defaults primary 与合法 fallback：若编辑前被 policy 覆盖，编辑后仍须覆盖，否则拒绝。已存在的未覆盖问题不因无关编辑被扩大为全局阻断。
4. exact 与 wildcard 使用同一匹配器与覆盖保护。删除一个仍被其他规则覆盖的 primary exact 允许；模型行的停用/清理保护不变。
5. 非字符串项原样保留且始终报告配置问题；它们不贡献覆盖。沿用当前 raw 长度防清空语义，不把“仅剩非法项”报告为健康或可用。
6. 规则编辑不依赖 availability，unknown / 未知 Provider / 零目录命中不阻断。命中数量仅为当前已知目录提示，不能声称包含全部未来模型。
7. 本期保护范围保持 defaults primary/fallback；不能声称已验证所有 Agent、image/pdf/utility 或全部实际调用依赖，也不能直接照搬 Provider 停用的依赖规则来推断 defaults policy 的作用范围。

新增结构化错误码 `unchanged-rule`、`policy-revision-conflict`；其余沿用已有格式、模式、重复、防清空、primary/fallback 错误码。

## 4. inventory 与用户界面

- `ModelInventory` 新增 `policyRevision: string`；合法规则新增 `editable: boolean`，invalid 为 false。restricted 下合法字符串规则可打开编辑框，**不可删除不等于不可编辑**，最终结果由服务器校验。
- 规则面板 `removable` 改为纯规则删除的结果投影；不再用模型行 `canRemovePolicyExactRef` 推导。共用 Core 守卫，避免另一套 exact/OpenRouter 别名匹配。
- 模型行 capability 与引用清理向导仍用旧语义，不能被面板改动带着放宽。
- 行内“编辑”预填旧值；保存只提交一次替换请求。仅有一条且覆盖主模型的 wildcard 仍能打开编辑框。
- 删除 exact/wildcard 均走新的纯规则删除入口，无 metadata 复选项。面板提示：“规则编辑只修改选择策略；删除冗余规则不一定会停用模型。”
- 冲突时保留输入，提示“策略已变化，请刷新后重新核对”；禁止刷新 revision 后自动重试覆盖。
- 缺少 `policyRevision` 或 `editable` 的旧后端不提供新写入口，显示版本不支持；不得猜测 capability。
- 复用 Button、DataTable、现有对话框和 toast，桌面/手机不横向溢出。不加实时预览接口；保存前显示旧值、新值和重复副本数量即可。

## 5. REST、CLI 与事务

新增 REST：

```text
PATCH  /api/model-policy/rules  { value, rule, expectedRevision }
DELETE /api/model-policy/rules  { value, expectedRevision }
```

`expectedRevision` 必填；缺失/格式不合法 400，与事务内当前 revision 不同 409（`policy-revision-conflict`）。两个端点均在 `writeOpenClawTransaction` 的 mutate 内先比 revision，再按最新 config 校验和变更，`normalizeConfig:false`。外部改动触发 prepare 重做时仍使用原 expectedRevision，不能更新它后继续写。

响应沿用 `{ ok, backupId, warnings, runtimeConfirmed, diagnostics, inventory }`，替换附 `rule/kind/replacedCount`，删除附 `removedCount`。写后探测失败应报告“配置已保存，运行时未确认”，不能显示整体写失败或保证 IM 已应用。本期不重构全局运行时确认逻辑。

既有 POST 添加、DELETE wildcard、DELETE exact-ref 保留契约。新增 revision 检查只要求本期替换与纯规则删除；不宣称历史全部写入口都有浏览器级冲突保护。

新增 CLI：

```bash
oc-switch model replace-policy-rule 'cpa/*' 'cpa/g/*' --yes --json
oc-switch model remove-policy-rule 'cpa/m1' --yes --json
```

沿用现有非交互 `--yes` 规则。CLI 读取当前 config 得到 revision，经过确认后在事务内比对该 revision，冲突非零退出、不自动重试；不要求用户手工提供 hash。旧 CLI 命令不改语义。

## 6. 验收矩阵

| 场景 | 必须结果 |
|---|---|
| sole `cpa/*`，primary=`cpa/m1` → `cpa/m1` | 一次替换成功，无空数组中间态 |
| `cpa/*` → `cpa/g/*`，primary 在 g 外且无其他覆盖 | 拒绝，输入/磁盘不变 |
| primary 或 fallback 在新规则/其他规则中仍被覆盖 | 允许 |
| 删除被 wildcard 覆盖的 exact（含 primary exact） | 新规则入口允许，旧引用清理入口保持保护 |
| 删除唯一一条规则 | 拒绝；同一行仍可打开编辑 |
| 重复旧值、大小写变体、未触碰规则、非法项 | 只修改完全相同旧值，数量/位置契约一致，其余原样保留 |
| 新值重复、无变化、格式错误、旧值不存在 | 对应明确错误，无写入/新备份 |
| unknown/零命中/未知 Provider | 不阻断规则编辑，不冒充可用性保证 |
| 旧 revision，或预检期间 policy 被外部修改 | 409/CLI 非零，无覆盖；前端保留输入 |
| 无关配置变化，包括最新 primary/fallback 变化 | revision 不必改变；重读后保护最新依赖 |
| 旧后端缺新字段；写成功但运行探测失败 | 新入口不可用；后者明确报告保存成功但未确认 |
| 目录、metadata、其他配置、env | JSON 语义不变；env 文件字节不变 |

验证采用内存与临时目录 fixture，server 注入 fake providers，CLI/PW 用项目既有 fake openclaw；不得读取或写入真实 `~/.openclaw`，不得复用/停止常驻 7420。配置 JSON 可能重排格式，不能把语义不变写成整个配置文件字节不变。
