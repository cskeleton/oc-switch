# 设计文档：仪表盘备份差异 Changelog（方案 B · 合并版）

> 日期：2026-07-09  
> 状态：已确认  
> 落点：Dashboard「配置健康」卡片（与最近备份对比）  
> 关联实现：`GET /api/diff`、`summarizeConfigDiff`、备份目录内 `openclaw.json` + `.env`

## 1. 目标与原则

用自然语义化行为列表（方案 B），让用户一眼看懂「做了什么、影响了谁」。

**信息优先级（用户已确认）：**

1. **最重要（P0）**：新增了哪些 Provider、删除了哪些 Provider、修改了哪些 Key/Credentials  
2. **同样有用（P1）**：停用/启用、模型（或其它配置项）增删、非密钥参数修改、主模型切换  

原则：

- 直观：动作词 + 主体名称，去掉无意义路径（如 `a.b.c`）
- 不冗余：副标题只在有对比价值时出现（新增通常无副标题）
- 安全：API Key / `.env` value **永不**以明文或可逆形式展示
- 边界：本卡片是「相对最近备份的 diff」，不是 `/api/config-status` 健康问题列表

---

## 2. 变更行为与文案模板

### 2.1 P0 — Provider 与 Credentials（视觉与排序最前）

| 动作 | 主标题 | 副标题 | 图标语义 |
|------|--------|--------|----------|
| 新增 Provider | 新增了 Provider **`{id}`** | （无） | ➕ / 信息色 |
| 删除 Provider | 移除了 Provider **`{id}`** | 最近备份中仍存在 | ➖ / 危险色 |
| 更新 Credentials | 更新了 **`{providerId}`** 的 API Key（`{ENV_VAR}`） | 相对最近备份已变更（无明文） | 🔑 / 警告色 |
| 新增 Credentials | 为 **`{providerId}`** 写入了 API Key（`{ENV_VAR}`） | （无） | 🔑 / 信息色 |
| 移除 Credentials | **`{ENV_VAR}`** 已不在当前托管块 | 最近备份中曾存在 | 🔑 / 静音色 |

同一 Provider「新增 + 写入 Key」可合并为一条：  
「新增了 Provider **`{id}`**，并配置了 API Key（`{ENV_VAR}`）」。

### 2.2 P1 — 停用 / 启用

当 Provider（或其它可开关组件）相对备份的启用状态变化时：

| 动作 | 主标题 | 副标题 | 图标语义 |
|------|--------|--------|----------|
| 停用 | 停用了 {类型} **`{名称}`** | 备份中为：已启用 | 🚫 / 警告色 |
| 启用 | 启用了 {类型} **`{名称}`** | 备份中为：已停用 | 🟢 / 成功色 |

*示例*：🚫 停用了 LLM 提供商 **`cherryin`**（备份中为：已启用）

> **数据说明**：可逆 Provider disable 存在 `provider-states.json`，与纯 `openclaw.json` 备份 diff 不完全同构。首版若无法稳定从「当前 vs 最近备份」推导 disable/enable，可先用 allowlist / 配置存在性近似，或将 disable 状态对比列为实现阶段显式任务；**文案模板保留**。

### 2.3 P1 — 新增 / 删除（非 Provider 主体，或模型等）

| 动作 | 主标题 | 副标题 | 图标语义 |
|------|--------|--------|----------|
| 新增 | 新增了 {类型} **`{名称}`** | （无） | ➕ / 信息色 |
| 删除 | 移除了 {类型} **`{名称}`** | 备份中包含此配置 | ➖ / 危险色 |

映射到现有 diff 时：

- `modelsEnabled` → 启用/新增了模型 **`{ref}`**（文案用「启用了模型」更贴 allowlist 语义）
- `modelsDisabled` → 禁用/移除了模型 **`{ref}`**

*示例*：➕ 新增了模型 **`claude-3-opus`**（若产品文案统一为「启用了模型」亦可）

> 首版**不做**「插件」等 oc-switch 域外实体；模板中的 `{类型}` 限于 Provider / 模型 / 主模型等已有概念。

### 2.4 P1 — 参数 / 非密钥字段修改

| 动作 | 主标题 | 副标题 | 图标语义 |
|------|--------|--------|----------|
| 修改 | 修改了 **`{名称}`** 的 `{参数名}` | 当前: `{新值}`（原值: `{旧值}`）— **仅非密钥字段** | ⚙️ / 中性色 |
| Provider 笼统变更 | 变更了 Provider **`{id}`** | 非密钥字段有变（当无法拆到具体参数时） | ⚙️ / 中性色 |

*示例*：⚙️ 修改了 **`gpt-4o`** 的 `contextWindow`（当前: 128000，原值: 64000）

约束：

- **密钥类变更走 §2.1**，禁止套用「当前/原值」模板
- 现有 `providersChanged` 仅有 id 列表时，首版可用「变更了 Provider **`{id}`**」笼统条；字段级 old/new 为增强项（需扩展 core diff）

### 2.5 P1 — 主模型切换

| 动作 | 主标题 | 副标题 |
|------|--------|--------|
| 主模型 | 主模型：`{before}` → `{after}` | （无，或「相对最近备份」） |

对应现有 `primaryChanged`。

---

## 3. UI 展现与限制策略

1. **字重**：动作词常规字重；主体 id / env var 加粗或 Badge；副标题小号 muted。
2. **排序**：P0（Provider 增删 → Credentials）→ P1（停用/启用 → 模型 → 参数/Provider 变更 → 主模型）。
3. **平铺上限**：默认最多 **5** 条；超出显示「展开其余 N 项差异…」（卡片内展开优先于跳转）。
4. **样式**：Web theme token；禁止依赖未声明的硬编码色阶工具类。
5. **安全**：任何 Credentials 相关行不得渲染 value。

---

## 4. 数据契约

### 4.1 已有 → 可直接映射

| 字段 | 模板 |
|------|------|
| `providersAdded` | §2.1 新增 Provider |
| `providersRemoved` | §2.1 删除 Provider |
| `providersChanged` | §2.4 笼统「变更了 Provider」 |
| `modelsEnabled` / `modelsDisabled` | §2.3 |
| `primaryChanged` | §2.5 |

### 4.2 须扩展（P0 Credentials）

`GET /api/diff` 今日只比备份与当前的 `openclaw.json`。备份已含 `.env`，须增加：

```ts
export interface CredentialDiffItem {
  envVar: string;
  providerId?: string;
  change: "added" | "removed" | "changed";
}

// ConfigDiffSummary 增加：
credentialsChanged: CredentialDiffItem[];
```

比较托管块内 Key 的存在性与值相等性；响应**只**返回变量名与 change，不返回 value。

### 4.3 可选增强（实现阶段可分期）

- 字段级 `providersChanged` 明细（参数名 + 非密钥 old/new）
- disable/enable 与 `provider-states` / 备份快照的稳定对比

---

## 5. 实现落点（确认后）

| 层 | 改动 |
|----|------|
| core | 扩展 backup diff（含 `.env` → `credentialsChanged`）；文案映射可放 web 或 core 纯函数 |
| server | `GET /api/diff` 读备份 `.env` + 当前 env |
| web | `HealthCard` 按 §2–§3 渲染；镜像类型 |
| 测试 | P0/P1 文案、无明文、折叠 |

技术栈：现有 Bun/TS monorepo + React。**不**采用独立 `changelog.js` + `node:test`。

---

## 6. Self-Review

- [x] 用户 P0（Provider 增删 + Key）保留为最前
- [x] 原方案 B 的停用/启用、增删、参数修改、主模型均纳入 P1
- [x] 密钥与非密钥修改模板分离
- [x] 标明 API / disable 数据缺口与分期
- [x] 与 Config Status 边界清晰
