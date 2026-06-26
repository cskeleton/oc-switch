# oc-switch Provider 关闭/恢复设计规格

> 日期：2026-06-25  
> 状态：待评审  
> 目标：提供一个可以直接关闭整个 Provider 的能力，让该 Provider 的模型不再出现在 OpenClaw 菜单中，同时保留 Provider 配置以便后续无损恢复。

---

## 1. 背景

oc-switch 现在已经支持：

- 单个模型启用/禁用：通过增删 `agents.defaults.models[ModelRef]` 控制模型是否出现在 OpenClaw 菜单
- Provider 删除：删除 `models.providers[providerId]`，并级联删除该 Provider 前缀下的 allowlist
- Provider 模型维护：保留 `models.providers[providerId].models[]` 作为模型目录

用户遇到的实际场景是：某个 Provider 暂时不用了，例如最近不续费、不想在菜单里看到它，但未来可能恢复。当前只能一个个关闭模型，成本高；如果直接删除 Provider，又会丢掉 Provider 配置和模型目录，恢复成本过高。

本功能补齐一个介于“单模型禁用”和“永久删除 Provider”之间的操作：**关闭 Provider**。

## 2. 目标

### 2.1 用户目标

- 用户可以一键关闭某个 Provider，不需要逐个禁用模型。
- 关闭后，该 Provider 下的模型不再出现在 OpenClaw 菜单中。
- 关闭后，Provider 仍保留在 oc-switch 的 Providers 列表中，并明确标记为“已关闭”。
- 用户可以一键恢复关闭的 Provider，尽量保留关闭前的 alias、`agentRuntime` 和未知 allowlist 字段。
- 用户仍然可以选择永久删除 Provider，清理 `models.providers` 中不再需要的配置。

### 2.2 工程目标

- 继续让 `agents.defaults.models` 作为 OpenClaw 菜单可见性的唯一真实来源。
- 不向 OpenClaw 配置引入 oc-switch 专属字段。
- 关闭 Provider 不删除 `models.providers[providerId]`，不修改 `.env`，不标记 env orphan。
- 恢复 Provider 不依赖备份，而是依赖 oc-switch 自己保存的当前关闭状态快照。
- 关闭/恢复都走现有事务写入、备份和 diff guard。
- Provider 包含当前主模型时，拒绝关闭。

## 3. 非目标

- 不实现自动续费检测、健康检查或按 Provider 成本自动关闭。
- 不提供历史操作日志。
- 不把已关闭 Provider 从 oc-switch Providers 列表中隐藏。
- 不自动删除 `.env` API Key。
- 不改变现有删除 Provider 的语义。
- 不在关闭 Provider 时自动切换主模型。
- 不保证状态快照缺失时能恢复 alias、`agentRuntime` 或未知 allowlist 字段。

## 4. 产品语义

### 4.1 关闭 Provider

关闭 Provider 的真实效果是：

1. 保留 `models.providers[providerId]` 和其中的 `models[]`。
2. 从 `agents.defaults.models` 中删除所有第一段等于 `providerId` 的 ModelRef。
3. 将被删除的 allowlist entries 原样保存到 oc-switch 状态文件中。

示例：

关闭前：

```json
{
  "models": {
    "providers": {
      "nvidia": {
        "models": [
          { "id": "deepseek-ai/deepseek-v4-flash" },
          { "id": "z-ai/glm5.1" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "models": {
        "nvidia/deepseek-ai/deepseek-v4-flash": { "alias": "nv-flash" },
        "nvidia/z-ai/glm5.1": { "alias": "nv-glm", "agentRuntime": { "id": "codex" } }
      }
    }
  }
}
```

关闭后：

```json
{
  "models": {
    "providers": {
      "nvidia": {
        "models": [
          { "id": "deepseek-ai/deepseek-v4-flash" },
          { "id": "z-ai/glm5.1" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "models": {}
    }
  }
}
```

### 4.2 恢复 Provider

恢复 Provider 的真实效果是：

1. 读取 oc-switch 状态文件中该 Provider 的 allowlist 快照。
2. 校验快照属于当前 active `openclaw.json`。
3. 将快照中的 allowlist entries 原样写回 `agents.defaults.models`。
4. 删除该 Provider 的关闭状态快照。

恢复不修改 `models.providers[providerId]`，也不修改 `.env`。

### 4.3 关闭与删除的区别

| 操作 | 是否出现在 OpenClaw 菜单 | 是否保留 `models.providers` | 是否可一键恢复 | 是否影响 `.env` |
| --- | --- | --- | --- | --- |
| 关闭 Provider | 否 | 是 | 是 | 否 |
| 删除 Provider | 否 | 否 | 否，需备份或重新添加 | 不删 key，只标 orphan |

如果用户确认某个 Provider 永久不用，应继续使用现有“删除 Provider”能力，避免 `models.providers` 长期累积无用配置。

## 5. 主模型规则

如果当前主模型 `agents.defaults.model` 的 provider 前缀等于目标 Provider ID，关闭操作必须失败。

错误提示：

```text
Provider nvidia contains the primary model. Switch primary model before disabling this provider.
```

Web 文案使用中文：

```text
该 Provider 包含当前主模型，请先切换主模型后再关闭。
```

理由：关闭 Provider 后该 Provider 的模型会从菜单中消失。如果保留主模型引用，会造成默认模型指向一个不可见模型。首版不自动切换主模型，避免隐式改变用户的默认模型选择。

## 6. 状态文件设计

### 6.1 文件位置

新增状态文件：

```text
~/.oc-switch/provider-states.json
```

实际路径来自当前 `OcSwitchPaths.stateDir`：

```text
${stateDir}/provider-states.json
```

该文件只保存**当前处于关闭状态的 Provider 快照**，不是操作日志。恢复 Provider 后删除对应条目；重复关闭同一个 Provider 时覆盖同一个条目。

### 6.2 文件结构

```ts
export interface ProviderStatesFile {
  version: 1;
  disabledProviders: Record<string, DisabledProviderState>;
}

export interface DisabledProviderState {
  providerId: string;
  openclawPath: string;
  disabledAt: string;
  allowlistEntries: Record<string, AllowlistEntry>;
}
```

JSON 示例：

```json
{
  "version": 1,
  "disabledProviders": {
    "nvidia": {
      "providerId": "nvidia",
      "openclawPath": "/Users/gc/.openclaw/openclaw.json",
      "disabledAt": "2026-06-25T12:00:00.000Z",
      "allowlistEntries": {
        "nvidia/deepseek-ai/deepseek-v4-flash": {
          "alias": "nv-flash"
        },
        "nvidia/z-ai/glm5.1": {
          "alias": "nv-glm",
          "agentRuntime": { "id": "codex" }
        }
      }
    }
  }
}
```

### 6.3 增长控制

状态文件不会随开关次数无限增长：

- 关闭 Provider：新增或覆盖 `disabledProviders[providerId]`
- 恢复 Provider：删除 `disabledProviders[providerId]`
- 删除 Provider：删除 `disabledProviders[providerId]`
- 已开启 Provider：不保留状态

因此文件大小只和“当前关闭了多少 Provider、这些 Provider 关闭前启用了多少模型”有关。

### 6.4 路径保护

每条状态记录保存 `openclawPath`。恢复时必须校验：

```text
state.openclawPath === currentPaths.openclawPath
```

不一致时拒绝恢复，并提示用户当前 active 配置路径与快照路径不同，避免在切换 OpenClaw 配置后误恢复到另一份配置。

### 6.5 写入一致性

`provider-states.json` 必须和 OpenClaw 配置写入共用现有 `stateDir/write.lock`。

实现时扩展 `writeOpenClawTransaction`，增加类似 `afterWrite` 的回调，回调在 `openclaw.json` 写入成功后、写锁释放前执行：

- 关闭 Provider：`afterWrite` 写入关闭快照
- 恢复 Provider：`afterWrite` 删除关闭快照
- 删除 Provider：`afterWrite` 删除关闭快照

如果 `afterWrite` 抛错，事务写入器必须恢复 `openclaw.json` 和 `.env` 到备份状态，并继续抛出错误。这样不会出现 OpenClaw 配置已关闭但恢复快照没有保存的状态。

## 7. Core 设计

### 7.1 Provider 状态文件模块

新增模块：

```text
packages/core/src/provider-states.ts
```

职责：

- 读取 `${stateDir}/provider-states.json`
- 写入 `${stateDir}/provider-states.json`
- upsert 关闭快照
- 删除关闭快照
- 查询某 Provider 是否已关闭

接口：

```ts
export interface DisabledProviderState {
  providerId: string;
  openclawPath: string;
  disabledAt: string;
  allowlistEntries: Record<string, AllowlistEntry>;
}

export interface ProviderStatesFile {
  version: 1;
  disabledProviders: Record<string, DisabledProviderState>;
}

export function readProviderStates(stateDir: string): ProviderStatesFile;
export function writeProviderStates(stateDir: string, states: ProviderStatesFile): void;
export function upsertDisabledProviderState(stateDir: string, state: DisabledProviderState): void;
export function removeDisabledProviderState(stateDir: string, providerId: string): void;
```

写入规则：

- 创建 `stateDir`，权限尽量设置为 `0700`
- 文件权限尽量设置为 `0600`
- JSON 使用稳定缩进，末尾换行
- 文件不存在时返回 `{ version: 1, disabledProviders: {} }`

### 7.2 Core 操作

新增纯配置操作：

```ts
export interface DisableProviderResult extends OperationResult {
  disabledState: {
    providerId: string;
    allowlistEntries: Record<string, AllowlistEntry>;
  };
}

export function disableProvider(config: OpenClawConfig, providerId: string): DisableProviderResult;

export function restoreDisabledProvider(
  config: OpenClawConfig,
  providerId: string,
  allowlistEntries: Record<string, AllowlistEntry>
): OperationResult;
```

`disableProvider` 规则：

1. `ensureDefaults(config)`
2. 校验 Provider 存在
3. 如果 `agents.defaults.model` 属于该 Provider，抛错
4. 收集 allowlist 中所有第一段等于 `providerId` 的 entries
5. 删除这些 allowlist entries
6. 返回被删除 entries 快照

`restoreDisabledProvider` 规则：

1. `ensureDefaults(config)`
2. 校验 Provider 存在
3. 对输入快照中的每个 ref 校验第一段等于 `providerId`
4. 将 entries 原样写回 `agents.defaults.models`
5. 不改变 `agents.defaults.model`

如果 Provider 当前没有启用模型，`disableProvider` 仍允许成功，快照为空。这样 UI 可以把“当前无启用模型”的 Provider 标为关闭。

### 7.3 已关闭 Provider 的写入限制

Provider 已关闭时，除 Provider 级恢复操作外，所有会新增该 Provider allowlist entry 的入口都必须拒绝：

- `PATCH /api/models` 将模型从 disabled 改为 enabled
- `POST /api/models` 新增模型且 `model.enabled === true`
- `PUT /api/models` 编辑模型且 `model.enabled === true`
- CLI `model enable <ref>`
- 从 preset 更新同一个已关闭 Provider 且请求启用模型

错误提示：

```text
Provider nvidia is disabled. Restore the provider before enabling models.
```

Web 文案：

```text
该 Provider 已关闭，请先恢复 Provider 后再启用模型。
```

理由：如果允许绕过 Provider 级恢复单独启用模型，会破坏“关闭 Provider = 整个 Provider 不出现在菜单”的语义，也会让关闭快照和当前 allowlist 出现部分重叠。

### 7.4 ProviderSummary 扩展

扩展 `ProviderSummary`：

```ts
export interface ProviderSummary {
  id: string;
  api: string | undefined;
  baseUrl: string | undefined;
  modelCount: number;
  enabledModelCount: number;
  containsPrimary: boolean;
  disabled: boolean;
}
```

`disabled` 不从 OpenClaw 配置单独推断，而由 provider states 文件决定。Server 的 `GET /api/providers` 读取配置列表后，按 `provider-states.json` 注入状态。

理由：`enabledModelCount === 0` 不一定表示用户显式关闭过 Provider，也可能是刚添加时选择了默认不启用模型。

## 8. Server API 设计

### 8.1 查询 Providers

`GET /api/providers` 返回的每个 Provider 增加：

```json
{
  "id": "nvidia",
  "modelCount": 12,
  "enabledModelCount": 0,
  "containsPrimary": false,
  "disabled": true
}
```

### 8.2 关闭/恢复 Provider

新增端点：

```text
PATCH /api/providers/:id/state
```

关闭请求：

```json
{ "enabled": false }
```

恢复请求：

```json
{ "enabled": true }
```

关闭响应：

```json
{
  "ok": true,
  "providerId": "nvidia",
  "enabled": false,
  "disabledModelCount": 12,
  "backupId": "2026-06-25T12-00-00-000Z"
}
```

恢复响应：

```json
{
  "ok": true,
  "providerId": "nvidia",
  "enabled": true,
  "restoredModelCount": 12,
  "backupId": "2026-06-25T12-05-00-000Z"
}
```

关闭实现顺序：

1. 读取当前配置
2. 调用 `disableProvider`
3. 通过 `writeOpenClawTransaction` 写入配置
4. 在同一事务的 `afterWrite` 中 upsert `provider-states.json`
5. 返回 backupId 和关闭模型数量

恢复实现顺序：

1. 读取 `provider-states.json`
2. 校验目标 Provider 有关闭快照
3. 校验快照 `openclawPath` 等于当前 active path
4. 调用 `restoreDisabledProvider`
5. 通过 `writeOpenClawTransaction` 写入配置
6. 在同一事务的 `afterWrite` 中删除 `provider-states.json` 中对应快照
7. 返回 backupId 和恢复模型数量

如果配置写入失败，不更新 provider states 文件。这样避免状态文件显示已关闭，但 OpenClaw 配置实际未关闭。

### 8.3 删除 Provider 时清理状态

现有 `DELETE /api/providers/:id` 成功后，在同一事务的 `afterWrite` 中删除 `provider-states.json.disabledProviders[id]`。

删除 Provider 的 env orphan 行为保持不变。

### 8.4 模型启用入口保护

Server 在处理模型启用或新增 enabled 模型前，读取 `provider-states.json`。如果目标 provider 当前已关闭，则返回 400。

受影响端点：

- `PATCH /api/models`
- `POST /api/models`
- `PUT /api/models`
- `POST /api/providers` 更新已存在 Provider 且启用模型

Provider 级恢复端点 `PATCH /api/providers/:id/state { "enabled": true }` 是唯一可以批量恢复关闭快照的入口。

## 9. CLI 设计

新增命令：

```bash
oc-switch provider disable <id>
oc-switch provider enable <id>
```

关闭成功输出：

```text
Disabled provider nvidia (12 model(s) hidden)
```

恢复成功输出：

```text
Enabled provider nvidia (12 model(s) restored)
```

关闭失败输出：

```text
Provider nvidia contains the primary model. Switch primary model before disabling this provider.
```

`oc-switch providers list` 输出增加状态列：

```text
nvidia  openai-completions  disabled  0/12
```

状态值：

- `enabled`
- `disabled`

CLI 的 `model enable`、`model add --enable`、`provider add` 更新已关闭 Provider 且启用模型时，也必须拒绝并提示先恢复 Provider。

## 10. Web 设计

### 10.1 Providers 页

Providers 表格增加状态展示：

- 启用中：显示“已启用”
- 已关闭：显示“已关闭”

操作区增加：

- 启用中且不包含主模型：显示“关闭”
- 启用中且包含主模型：显示禁用态“关闭”，hover/title 或点击提示“该 Provider 包含当前主模型，请先切换主模型后再关闭”
- 已关闭：显示“恢复”

现有“删除”按钮保留，继续表示永久删除 Provider 定义。

### 10.2 Models 页

Models 页左侧 Provider 列表继续显示已关闭 Provider，并标记“已关闭”。

选择已关闭 Provider 时：

- 右侧仍可看到 provider 模型定义
- 所有模型处于“已禁用”区域
- 单个模型启用开关禁用，并提示“该 Provider 已关闭，请先恢复 Provider 后再启用模型”

首版不提供“部分恢复”状态。恢复已关闭 Provider 必须走 Provider 行上的“恢复”操作。

### 10.3 关闭确认

点击关闭时展示确认：

```text
关闭 nvidia？

该 Provider 的 12 个已启用模型将从 OpenClaw 菜单中隐藏。Provider 配置和模型目录会保留，可稍后恢复。
```

点击恢复时展示确认：

```text
恢复 nvidia？

将恢复关闭前保存的 12 个模型启用状态。
```

## 11. 降级与异常

### 11.1 快照缺失

如果 Provider 当前没有关闭快照，但用户希望恢复，Server 返回错误：

```text
Provider nvidia has no disabled state snapshot
```

Web 可以提示：

```text
没有找到关闭快照。可以手动启用模型，或重新从 Provider 模型列表中选择需要启用的模型。
```

首版不自动“启用全部模型”作为恢复按钮，避免误启用用户原本没有启用过的模型。

### 11.2 快照路径不一致

如果当前 active `openclawPath` 与快照中的 `openclawPath` 不一致，恢复失败。

Web 提示：

```text
该关闭快照属于另一份 OpenClaw 配置，请切回对应配置路径后再恢复。
```

### 11.3 Provider 已不存在

如果状态文件里存在关闭快照，但 `models.providers[providerId]` 已不存在：

- `GET /api/providers` 不展示该状态
- `provider enable <id>` 返回 Provider not found
- 删除 Provider 成功后应清理该状态，减少残留

## 12. 测试策略

### 12.1 Core 单测

新增覆盖：

- `disableProvider` 删除 allowlist，但保留 `models.providers[providerId].models[]`
- `disableProvider` 只按 ModelRef 第一段匹配 provider，保留 model id 内部斜杠
- `disableProvider` 返回完整 allowlist 快照，包括 alias、`agentRuntime` 和未知字段
- `disableProvider` 遇到当前主模型 provider 时抛错
- `restoreDisabledProvider` 原样恢复 allowlist entries
- `restoreDisabledProvider` 拒绝快照中 provider 前缀不匹配的 ref
- provider states 文件读写不存在文件、覆盖同 Provider、删除同 Provider

### 12.2 Server 测试

新增覆盖：

- `GET /api/providers` 返回 `disabled`
- `PATCH /api/providers/:id/state { enabled: false }` 写配置、写备份、写 provider-states
- `PATCH /api/providers/:id/state { enabled: true }` 恢复 allowlist、删除 provider-states
- 关闭包含主模型的 Provider 返回 400
- 已关闭 Provider 下启用单个模型返回 400
- 恢复路径不一致的快照返回 400
- 删除 Provider 后清理 provider-states

### 12.3 CLI 测试

新增覆盖：

- `provider disable <id>` 隐藏该 Provider 所有 enabled models
- `provider enable <id>` 恢复关闭快照
- `providers list` 输出 enabled/disabled 状态
- 包含主模型时 disable 失败
- Provider 已关闭时，`model enable` 失败并提示先恢复 Provider

### 12.4 Web 测试

新增覆盖：

- Providers 页显示“已关闭”
- 点击关闭调用 `patchProviderState(id, false)`
- 点击恢复调用 `patchProviderState(id, true)`
- 包含主模型的 Provider 关闭按钮不可用或点击后显示错误
- 已关闭 Provider 的单模型启用开关不可用
- 删除 Provider 与关闭 Provider 是两个不同操作

## 13. Sync Audit 要点

实现完成后需要对照本规格检查：

- 关闭 Provider 是否没有删除 `models.providers`
- 关闭 Provider 是否没有修改 `.env` 或标记 env orphan
- 包含主模型的 Provider 是否无法关闭
- 恢复是否来自 `provider-states.json`，而不是备份
- `provider-states.json` 是否只保存当前关闭状态，不保存历史操作记录
- 已关闭 Provider 是否无法通过单模型启用绕过恢复入口
- 删除 Provider 是否仍然永久移除 `models.providers`，并清理关闭状态
- Web 文案是否清楚区分“关闭”和“删除”
