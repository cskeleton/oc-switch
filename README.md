# oc-switch

**Manage local OpenClaw provider and model configuration — via CLI and Web GUI.**

oc-switch reads and writes `openclaw.json` and the managed block in `~/.openclaw/.env`. It never touches unrelated config sections. Built for day-to-day tasks: switch primary models, add providers, clean stale allowlist entries, backup/restore, and inspect config health.

**通过 CLI 与 Web 界面管理本机 OpenClaw 的 Provider 与模型配置。**

oc-switch 读写 `openclaw.json` 及 `~/.openclaw/.env` 中由工具托管的密钥块，不修改无关配置。适用于日常运维：切换主模型、增删 Provider、清理陈旧 allowlist、备份恢复与配置健康检查。

---

## Features / 功能特性

| | English | 中文 |
|---|---------|------|
| **Providers** | List, add (preset or custom), edit, delete, disable/enable, sync, merge case duplicates | 列出、添加（模板或自定义）、编辑、删除、关闭/启用、同步、合并大小写重复项 |
| **Models** | Unified inventory across config / plugin / OpenClaw runtime; pending handling for unavailable refs; switch primary model (`use`) | 统一 inventory（本地配置 / 插件 / OpenClaw 运行时三来源）；不可用引用进入待处理区段；切换主模型 |
| **Runtime awareness** | Three independent dimensions: policy / plugin state / availability; probe failures degrade to `unknown`, never misreported as unavailable | 三维独立状态：策略 / 插件状态 / 运行可用性；探测失败降级为「无法确认」，绝不误判为不可用 |
| **Plugin model providers** | Group by plugin with a single plugin-level switch (e.g. one xiaomi plugin → two providers); warnings cover non-model capabilities (speech, tools…) | 按插件分组、一组一个插件级开关（如 xiaomi 插件同时贡献两个 Provider）；停用确认框完整提示非模型能力（语音、工具等）影响 |
| **Safety** | Auto-backup on every write; `diff` before restore; API keys only in `.env` | 每次写入自动备份；恢复前可 `diff`；API Key 仅存于 `.env` |
| **Migration** | `import` / `presets export`, full backup & restore | `import` / `presets export`、完整备份与恢复 |
| **Web GUI** | React SPA with dark/light theme, proxies `/api` to REST server | React 单页应用，深浅色主题，`/api` 代理至 REST 服务 |
| **Health** | Config health checks, unified `GET /api/config-status` | 配置健康检查、统一配置状态 API |
| **Paths** | Switch active `openclaw.json` / `.env` paths via settings | 可在设置中切换活动的配置与 env 路径 |

---

## Requirements / 环境要求

- [Bun](https://bun.sh) ≥ 1.2
- An existing [OpenClaw](https://github.com/openclaw) installation with `~/.openclaw/openclaw.json`

---

## Install & Run / 安装与运行

```bash
git clone https://github.com/cskeleton/oc-switch.git
cd oc-switch
bun install

# CLI — 命令行
bun run cli -- status
bun run cli -- providers list

# Or invoke entrypoint directly — 或直接调用入口
bun run packages/cli/src/index.ts status
```

### Environment variables / 环境变量

| Variable | Default | Purpose / 用途 |
|----------|---------|----------------|
| `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | OpenClaw config file / 配置文件路径 |
| `HOME` | current user home | Resolves `~/.openclaw/.env` and `~/.oc-switch/` / 解析 env 与状态目录 |

State and backups live under `~/.oc-switch/` (backups in `~/.oc-switch/backups/`).

状态与备份位于 `~/.oc-switch/`（备份在 `~/.oc-switch/backups/`）。

---

## Local Quick Start / 本机快速启动

One command from any directory to run the Web GUI on a single port (API + static SPA). Requires Bun and a clone of this repo.

任意工作目录一条命令启动 Web 管理界面（单端口同时提供 API 与静态前端）。需已安装 Bun 并克隆本仓库。

```bash
# From repo root — 在仓库根目录执行
bun run build
./scripts/install-local-launcher.sh
```

Ensure `~/bin` is on your `PATH`. If not, add to your shell profile (e.g. `~/.zshrc`):

确保 `~/bin` 在 `PATH` 中；若否，写入 shell 配置（如 `~/.zshrc`）：

```bash
export PATH="$HOME/bin:$PATH"
```

Then:

然后：

```bash
oc-switch start    # background serve + Web GUI / 后台启动
oc-switch restart  # restart background process / 重启后台进程
oc-switch stop     # stop background process / 停止后台进程
```

Open http://127.0.0.1:7420. Logs: `~/.oc-switch/serve.log`. Authenticate via the Web login box, or rotate a persisted token with `oc-switch token rotate`.

打开 http://127.0.0.1:7420。日志：`~/.oc-switch/serve.log`。在 Web 登录框输入 token，或执行 `oc-switch token rotate` 生成持久 token。

Re-run `bun run build` after Web UI changes before `oc-switch start`.

修改 Web 前端后须重新 `bun run build`，再执行 `oc-switch start`。

**Development / 开发调试** still uses two terminals (`serve` + `web dev`) — see [Local Web GUI](#local-web-gui--本地-web-界面) below.

日常开发仍用双进程（`serve` + `web dev`）——见下方 [本地 Web 界面](#local-web-gui--本地-web-界面)。

---

## Local Web GUI / 本地 Web 界面

Web GUI is a Vite SPA that proxies `/api` to the oc-switch REST server.

Web 界面为 Vite SPA，将 `/api` 代理到 oc-switch REST 服务。

```bash
# Terminal 1 — REST API (default http://127.0.0.1:7420)
bun run cli -- serve

# Terminal 2 — Web GUI (default http://127.0.0.1:5173)
bun run --cwd packages/web dev
```

Open http://127.0.0.1:5173. When `serve` runs on localhost without `--token`, a one-time ephemeral token is printed to the terminal — paste it into the login prompt.

打开 http://127.0.0.1:5173。本地 `serve` 未指定 `--token` 时，终端会打印一次性临时 token，粘贴到登录框即可。

Production-style preview / 生产式预览：

```bash
bun run build
bun run cli -- serve
bun run --cwd packages/web preview
```

---

## Remote VPS Usage / 远程 VPS 使用

Binding to all interfaces requires an explicit token; the server refuses to start otherwise.

绑定 `0.0.0.0` 必须显式传入 `--token`，否则服务拒绝启动。

```bash
# On VPS — MUST pass --token with --host 0.0.0.0
# VPS 上 — 使用 0.0.0.0 时必须带 --token
oc-switch serve --host 0.0.0.0 --port 7420 --token <your-secret-token>
```

**Recommended / 推荐：** use an SSH tunnel instead of exposing the port publicly:

优先使用 SSH 隧道，而非将端口公网暴露：

```bash
# On your Mac — forward remote API to localhost
# 本机 — 将远端 API 转发到 localhost
ssh -L 7420:127.0.0.1:7420 user@your-vps

# On VPS — bind localhost only
# VPS — 仅绑定 localhost
oc-switch serve --host 127.0.0.1 --port 7420 --token <your-secret-token>
```

Rotate the persisted API token / 轮换持久化 API token：

```bash
oc-switch token rotate
```

---

## CLI Reference / CLI 参考

```bash
# Server / 服务
oc-switch start                    # background local launcher / 本机后台启动
oc-switch restart                  # restart background launcher / 重启后台服务
oc-switch stop                     # stop background launcher / 停止后台服务
oc-switch serve [--port 7420] [--host 127.0.0.1] [--token <secret>]
oc-switch token rotate

# Read / 查询
oc-switch status
oc-switch health
oc-switch providers list
oc-switch models list [--provider <name>]
oc-switch presets list
oc-switch diff

# Provider CRUD
oc-switch provider add <preset-id> --key <api-key> [--models m1,m2]
oc-switch provider add-custom ...          # custom provider / 自定义 Provider
oc-switch provider edit <name> [--base-url <url>] [--key <api-key>]
oc-switch provider delete <name> [--force]
oc-switch provider disable <name>          # reversible / 可逆关闭
oc-switch provider enable <name>
oc-switch provider sync <name>
oc-switch providers merge-duplicates       # merge case duplicates / 合并大小写重复

# Model operations — splits only on the first slash
# 模型操作 — 仅在第一个 / 处拆分 provider 与 model
oc-switch models inventory [--json]    # unified inventory / 统一 inventory（三来源合并）
oc-switch models unavailable [--json]  # pending unavailable/unknown rows / 待处理区段
oc-switch model reconcile <ref> [--yes]          # materialize runtime model / 补全运行时模型
oc-switch model remove-policy-ref <ref> [--remove-metadata] [--yes]  # 删除 policy 精确引用
oc-switch use <provider>/<model-id...>
oc-switch model add <provider>/<model-id...> [--alias <alias>]
oc-switch model remove <provider>/<model-id...>
oc-switch model enable <provider>/<model-id...>
oc-switch model disable <provider>/<model-id...>

# Plugin model providers — one plugin-level switch
# 模型插件 — 一个插件级开关（只写 plugins.entries.<id>.enabled）
oc-switch plugin enable <plugin-id> [--yes]
oc-switch plugin disable <plugin-id> [--yes]

# Presets & backup / 预设与备份
oc-switch import
oc-switch presets export <provider-id>
oc-switch backup list
oc-switch backup restore <timestamp>
```

Example — model ref with slashes in the model id / 模型 ID 含斜杠的示例：

```bash
oc-switch use nvidia/deepseek-ai/deepseek-v4-flash
# → provider: nvidia, modelId: deepseek-ai/deepseek-v4-flash
```

---

## Project Structure / 项目结构

```
oc-switch/
├── packages/
│   ├── core/     # OpenClaw file I/O & business logic / 文件读写与业务逻辑
│   ├── cli/      # Commander CLI / 命令行
│   ├── server/   # Hono REST API / REST 服务
│   └── web/      # React + Vite SPA / Web 界面
├── presets/README.md  # 预设目录说明（数据在 ~/.oc-switch/presets/）
└── scripts/           # Acceptance smoke tests / 验收脚本
```

---

## Important Notes / 重要说明

### Model Policy Compatibility / 模型策略兼容

OpenClaw 2026.9 separates the provider catalog (`models.providers`), aliases/per-model settings (`agents.defaults.models`), and selection policy (`agents.defaults.modelPolicy.allow`). An omitted policy retains legacy restrictions only before migration; the migration marker or a policy object prevents metadata from becoming an implicit allowlist again. An explicit `[]` permits any model; a non-empty list permits matching exact refs or trailing prefix wildcards.

OpenClaw 2026.9 将 Provider 目录、模型别名/参数和选择策略分开。oc-switch 默认展示当前 Gateway 的模型选项；“管理配置目录 / 管理全部配置”可查看未选用项。Gateway 不可达或配置尚未应用时明确标注推算视图，不冒充 IM 的在线结果；默认 Agent 以外的独立策略可能产生不同选项。

停用 Provider 或模型插件会移出对应的精确/通配选择规则，保留 `.env` 密钥；插件还会设为 `enabled=false`。恢复时合并保存的规则。可勾选清理 metadata，或另用删除 Provider 清理目录。未启用插件默认折叠，停用状态、闲置 metadata 和备用 Key 不再进入待处理。开放策略下停用需要建立仅保留当前其他可见模型的显式策略；无法安全表达时拒绝，绝不将 restricted 清为 `[]`。主模型、fallback 和其他 Agent 的显式依赖仍会阻止停用。

CLI 示例：`oc-switch provider disable <id> [--cleanup-metadata]`、`oc-switch provider enable <id>`、`oc-switch plugin disable <id> --yes [--cleanup-metadata]`、`oc-switch plugin enable <id> --yes`。模型探测已改为异步并行；Web 同 scope 请求共享缓存，配置变化或手动刷新会重新探测。

详见 [2026.9 选择器与停用规格](docs/superpowers/specs/2026-09-11-model-picker-and-disable-design.md)。

### Runtime Model Inventory / 运行时模型协调

oc-switch combines config, plugin manifests and runtime catalog evidence while keeping policy, plugin state and availability separate. The default Web view follows the Gateway picker; catalog management is a separate view. `available: null` means unconfirmed, and `missing: true` is a reference placeholder. Availability is OpenClaw's report, not a paid inference probe performed by oc-switch.

oc-switch 合并配置、插件 manifest 和运行时目录证据；策略、插件启停与可用性独立。默认 Web 视图跟随 Gateway 选择器，目录管理为独立视图。`available:null` 表示未确认，`missing:true` 只是引用占位；不会为检查可用性实际发送推理请求。

Only selected or protected refs enter the pending list (`models unavailable`). An unused/disabled model is not a task to repair. You can retain metadata while removing an exact policy ref; this remains possible when availability is unknown because it only narrows selection. Primary/fallback, wildcard and last-rule protections still apply. Enabling, setting the primary, and materializing runtime models require positive runtime evidence.

待处理只包含已选用或受保护引用的问题。闲置/停用模型不要求修复；可停用精确选择规则并保留 metadata。未知可用性时也可主动移除不受保护的精确规则；启用、设主模型和物化目录仍要求明确运行证据。主模型、fallback、单模型 wildcard 与最后一条规则保护保留。

Plugin groups have one switch, including plugins contributing multiple providers. Disabling removes that group's selection rules and writes `plugins.entries.<id>.enabled=false`; saved rules can be restored. The dialog explains non-model capabilities affected. Already-disabled plugins remain collapsed, with a group action for residual picker entries. No API keys are deleted.

一个插件一组开关，完整提示语音、工具、钩子等影响。停用移出该组选择规则并写 `enabled=false`，恢复合并保存规则。未启用插件折叠显示；旧停用状态残留的 IM 选项可整组移出。`.env` 密钥始终保留。

Writes preserve unrelated configuration. Explicit whole-provider/plugin suspension may remove its own wildcard rules; other rules, including duplicates, remain unchanged. Preflight config/env changes trigger one retry, then a clear failure. Runtime confirmation checks the observed plugin state and picker visibility; unconfirmed writes remain successful writes and are reported separately.

写入不归一无关配置。明确的整 Provider/插件停用可移出自己的 wildcard，其他规则和重复次数不变。预检文件变化重试一次，持续变化明确拒绝。配置写入与 Gateway 生效确认分开，不能把命令成功等同于 IM 已应用。

### Backup & Restore / 备份与恢复

Every write creates a backup under `~/.oc-switch/backups/` containing both `openclaw.json` and `.env`.

每次写入会在 `~/.oc-switch/backups/` 生成包含 `openclaw.json` 与 `.env` 的备份。

`oc-switch backup restore <timestamp>` **replaces your live config and env file** with the snapshot. Run `oc-switch diff` first. Restore also backs up the current state before overwriting.

`backup restore` **会用快照覆盖当前配置与 env**。请先执行 `diff`。恢复前也会自动备份当前状态。

### JSON5 Formatting / JSON5 格式化

OpenClaw configs may use JSON5 (comments, trailing commas). oc-switch parses JSON5 on read but writes formatted JSON on save. Comments will be lost on the next write; semantic changes are limited to provider/model sections.

OpenClaw 配置可能含 JSON5 注释与尾逗号。读取时支持 JSON5，保存时写为标准 JSON，注释将在下次写入时丢失；语义变更仅限 provider/model 相关字段。

### No API Keys in JSON / 密钥不入 JSON

API keys live only in `~/.openclaw/.env` inside the `# oc-switch:start` … `# oc-switch:end` managed block. New provider writes store a canonical SecretRef on `models.providers.*.apiKey`: `{ "source": "env", "provider": "default", "id": "ENV_VAR" }`. The Providers page detects legacy `${ENV_VAR}`, `$ENV_VAR`, and two-field EnvRef values and offers an explicit, backed-up migration when the source `.env` contains one non-empty, simple value. A missing key in the associated Gateway service snapshot is allowed because OpenClaw can fall back to the global `.env`; a same-name service value that differs from `.env` blocks migration because process environment takes precedence. `authHeader` is a boolean switch, not a secret field. CLI, logs, REST, and Web GUI never print full key values.

API Key 仅写在 `.env` 托管块内；新建 Provider 时，`openclaw.json` 的 `models.providers.*.apiKey` 写 canonical SecretRef：`{ "source": "env", "provider": "default", "id": "ENV_VAR" }`。Providers 页会检查旧 `${ENV_VAR}`、`$ENV_VAR` 与两字段 EnvRef；源 `.env` 存在唯一、非空且语法简单的值时，用户可明确确认并在备份后迁移。已关联 Gateway 服务快照缺少该变量不阻止迁移，因为 OpenClaw 可回退读取全局 `.env`；若快照中存在同名但不同值，则因进程环境优先而阻止迁移。`authHeader` 是 boolean 开关，不保存密钥。CLI、日志、API 与 Web 界面均不回显完整密钥。

---

## Development / 开发

```bash
bun run test          # unit tests / 单元测试
bun run typecheck     # TypeScript
bun run build         # build Web GUI / 构建 Web
bun run check         # test + typecheck + build
bun run acceptance    # acceptance smoke (temp fixtures) / 验收冒烟
bun run test:e2e      # Playwright (requires build) / 浏览器 E2E
```

---

## License / 许可证

MIT
