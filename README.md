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
| **Models** | Add/remove, enable/disable allowlist, switch primary model (`use`) | 增删模型、启用/禁用 allowlist、切换主模型 |
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
oc-switch use <provider>/<model-id...>
oc-switch model add <provider>/<model-id...> [--alias <alias>]
oc-switch model remove <provider>/<model-id...>
oc-switch model enable <provider>/<model-id...>
oc-switch model disable <provider>/<model-id...>

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
├── presets/builtin/   # Optional builtin templates / 可选内置模板
└── scripts/           # Acceptance smoke tests / 验收脚本
```

---

## Important Notes / 重要说明

### Backup & Restore / 备份与恢复

Every write creates a backup under `~/.oc-switch/backups/` containing both `openclaw.json` and `.env`.

每次写入会在 `~/.oc-switch/backups/` 生成包含 `openclaw.json` 与 `.env` 的备份。

`oc-switch backup restore <timestamp>` **replaces your live config and env file** with the snapshot. Run `oc-switch diff` first. Restore also backs up the current state before overwriting.

`backup restore` **会用快照覆盖当前配置与 env**。请先执行 `diff`。恢复前也会自动备份当前状态。

### JSON5 Formatting / JSON5 格式化

OpenClaw configs may use JSON5 (comments, trailing commas). oc-switch parses JSON5 on read but writes formatted JSON on save. Comments will be lost on the next write; semantic changes are limited to provider/model sections.

OpenClaw 配置可能含 JSON5 注释与尾逗号。读取时支持 JSON5，保存时写为标准 JSON，注释将在下次写入时丢失；语义变更仅限 provider/model 相关字段。

### No API Keys in JSON / 密钥不入 JSON

API keys live only in `~/.openclaw/.env` inside the `# oc-switch:start` … `# oc-switch:end` managed block. `openclaw.json` keeps env references like `{ "source": "env", "id": "NVIDIA_API_KEY" }`. CLI, logs, REST, and Web GUI never print full key values.

API Key 仅写在 `.env` 托管块内；`openclaw.json` 保留 env 引用。CLI、日志、API 与 Web 界面均不回显完整密钥。

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
