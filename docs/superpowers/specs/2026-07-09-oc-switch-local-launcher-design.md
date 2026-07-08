# oc-switch 本机快速启动（PATH 启动器 + 单进程 Web）设计规格

> 日期：2026-07-09  
> 状态：已接受（实现计划：`docs/superpowers/plans/2026-07-09-oc-switch-local-launcher.md`，本地未纳入 Git）  
> 决策摘要：方案 B（`serve` 同端口托管 SPA）+ 方案 A（`~/bin/oc-switch` 薄包装指向本仓库）；不做 `bun compile` / `.app` / 菜单栏。

---

## 1. 背景与目标

日常使用 oc-switch Web GUI 时，需要分别启动 REST（`:7420`）与 Vite/preview（`:5173`），且必须在仓库目录内执行。用户本机已安装 Bun、仓库路径固定，需求是：

1. **任意工作目录**一条命令启动 / 关闭 Web 管理界面。
2. **单进程、单端口**：浏览器只访问一个 URL。
3. **不依赖**把 CLI 编译成独立二进制（本机有 Bun 即可）。

### 1.1 成功标准

- 安装启动器后，在任意目录执行 `oc-switch start` 可打开 Web GUI。
- `oc-switch stop` 可停止由 `start` 拉起的后台进程。
- 同一端口同时提供 `/api/*` 与前端静态资源；无需再开第二个 Terminal。
- 前台 `oc-switch serve` 行为对开发调试仍然可用（可同时托管静态资源）。

### 1.2 非目标（本轮）

- 不做 `bun compile` 单文件二进制。
- 不做 macOS `.app`、Automator、菜单栏常驻。
- 不改变 claw 远端部署流程（仍可继续用 `serve` + `web preview` 双进程，或日后自行采用同端口托管）。
- 不把 Web token 自动注入浏览器（仍用现有登录框 + `sessionStorage`；`start` 保证使用**持久** token，避免每次 ephemeral）。
- 不自动在每次 `start` 前执行 `bun run build`（前端有改动时由用户显式 build）。

---

## 2. 架构总览

```text
任意目录
  └─ oc-switch (~/bin 薄包装)
       └─ bun run <repo>/packages/cli/src/index.ts <subcommand>
            ├─ start  → 后台 serve + PID + open 浏览器
            ├─ stop   → 按 PID 结束进程
            └─ serve  → 前台：API +（若有 dist）静态 SPA
```

| 组件 | 职责 |
|------|------|
| `~/bin/oc-switch` | 固定指向本机仓库 CLI 入口；不复制业务逻辑 |
| `serve` | `Bun.serve`：`/api/*` → Hono；其余 → `packages/web/dist` |
| `start` / `stop` | 后台生命周期：PID 文件、持久 token、打开浏览器 |
| `packages/web/dist` | 由 `bun run build` 产出；缺失则拒绝以「带 GUI」方式启动 |

仓库内可提供可选安装脚本（如 `scripts/install-local-launcher.sh`），将包装脚本安装到 `~/bin/oc-switch`（若 `~/bin` 不存在则创建；并提示确保 `~/bin` 在 `PATH` 中）。

---

## 3. PATH 启动器

### 3.1 包装脚本行为

- 路径：默认安装为 `$HOME/bin/oc-switch`（可执行）。
- 内容语义：`exec bun run "<REPO_ROOT>/packages/cli/src/index.ts" "$@"`。
- `REPO_ROOT`：安装时写入绝对路径（本机为 `/Users/gc/Dev/MyProject/oc-switch`，脚本内用安装时解析的路径，不硬编码用户名到公开文档示例以外的地方）。
- 不设置额外环境变量；OpenClaw / oc-switch 路径解析逻辑与现有 CLI 一致。

### 3.2 安装与卸载

- **安装**：仓库提供脚本或 README 一行命令，创建/覆盖 `~/bin/oc-switch`。
- **卸载**：删除该文件即可；不修改 `~/.oc-switch/` 状态。
- **前置**：本机已安装 `bun`，且 `~/bin` 在 `PATH` 中（若否，README 说明如何加入 shell profile）。

### 3.3 与开发入口的关系

- 仓库内 `bun run cli -- …` / `bun run packages/cli/src/index.ts …` 保持不变。
- PATH 启动器与仓库入口调用同一套 CLI；无第二套命令实现。

---

## 4. 单进程静态托管（`serve`）

### 4.1 静态根目录

- 默认：`<repoRoot>/packages/web/dist`（`repoRoot` 与现有 `packages/cli/src/command-context.ts` 一致：自 `packages/cli/src` 上溯三级）。
- 可选覆盖：环境变量 `OC_SWITCH_WEB_DIST`（绝对路径）；便于测试或非常规布局。未设置时用默认。

### 4.2 请求路由

1. 路径以 `/api` 开头（含 `/api` 与 `/api/...`）：交给现有 Hono `app.fetch`（认证与现网一致）。
2. 其余 `GET`/`HEAD`：
   - 若静态根下存在对应文件（防目录穿越：解析后必须仍在静态根内），则按扩展名返回合适 `Content-Type`。
   - 否则返回 `index.html`（SPA fallback），`Content-Type: text/html`。
3. 非 `GET`/`HEAD` 且非 `/api`：返回 `404`（不把 POST 等误落到 `index.html`）。

### 4.3 缺失 `dist` 时的行为

| 场景 | 行为 |
|------|------|
| 前台 `serve`，无 dist | **仍可启动**，仅提供 API；启动时打印一行警告：Web GUI 不可用，请先 `bun run build`。 |
| `start`，无 dist | **拒绝启动**（非零退出），明确提示先在仓库执行 `bun run build`。 |

理由：`serve` 仍可用于无头 API / 远程隧道；`start` 的产品意图是打开 GUI，无静态资源则无意义。

### 4.4 端口与绑定

- 默认：`--host 127.0.0.1`、`--port 7420`（与现有一致）。
- 端口已被占用：启动失败并报错，**不**自动改端口。
- `start` 将同一 host/port 传给后台 `serve`；可选透传 `--port` / `--host`（若实现成本低则支持，否则首版固定默认值并在 spec 实现计划中二选一——**首版：`start`/`stop` 使用默认 127.0.0.1:7420；需要自定义时用前台 `serve`**）。

### 4.5 与 Vite 开发模式的关系

- 日常「改前端」仍用：`serve`（可无 dist）+ `packages/web` 的 `dev`（5173 + proxy）。
- 「偶尔管理 OpenClaw」用：`build` 一次 + `start`（单端口）。
- 本轮不删除、不改变 Vite `dev`/`preview` 配置；`preview` 双进程方式仍可用但不作为推荐日常路径。

---

## 5. `start` / `stop` 生命周期

### 5.1 状态文件

| 文件 | 位置 | 用途 |
|------|------|------|
| PID | `~/.oc-switch/serve.pid`（即 `stateDir/serve.pid`） | 后台进程 PID，纯文本一行数字 |
| Token | `~/.oc-switch/token.json` | 现有持久 Bearer token |

`stateDir` 解析与现有 CLI 一致（默认 `~/.oc-switch`）。

### 5.2 `oc-switch start`

顺序：

1. 解析静态根；若不存在或缺少 `index.html` → 报错退出。
2. 若 `serve.pid` 存在且该 PID 仍为存活的 oc-switch serve 进程（命令行匹配 `packages/cli/src/index.ts serve`）→ 打印「已在运行」与 URL，仍执行打开浏览器，退出码 0。
3. 若 pid 文件存在但进程已死，或进程存活但**不是** oc-switch serve → 删除陈旧 pid（不向无关进程发信号），继续启动。
4. **启动前**探测默认端口：若 `127.0.0.1:7420` 已在监听 → 失败并提示端口占用（覆盖前台 `serve` 占用场景）。
5. 确保持久 token：若无 `token.json` 有效 token，则生成并写入（等同一次静默 persist，不必强制用户先跑 `token rotate`）。`start` **不**使用 ephemeral token。
6. 以后台方式启动与 `serve` 相同的服务（detached / 不挂当前 TTY），工作目录可为仓库根或任意；逻辑上通过 `bun` 调用同一 CLI 入口 `serve --host 127.0.0.1 --port 7420`（token 走持久化，不把 token 写进进程参数，避免 `ps` 泄露）。
7. 将子进程 PID 写入 `serve.pid`（权限建议 `0600`）。
8. 短暂等待就绪：要求**子进程仍存活且** HTTP 可连；子进程已退出（如 bind 失败）或超时 → 报错并尝试清理。不得仅因「端口上已有任意 HTTP 服务」判定成功。
9. 在 stdout 打印 URL；执行 `open http://127.0.0.1:7420`（macOS）。非 macOS 可跳过 `open` 仅打印 URL（本规格以 macOS 为主；实现时用 `process.platform === "darwin"` 判断）。
10. 提示用户：若浏览器未登录，到终端或 `~/.oc-switch/token.json` 取 token 粘贴（**不得**在日志中完整打印 token；可提示「使用已持久化 token，见 token rotate / 登录框」）。首次无 session 时用户仍需粘贴一次；`token rotate` 后需重新粘贴。

### 5.3 `oc-switch stop`

1. 读 `serve.pid`；不存在 → 打印未在运行，退出 0。
2. 若 PID 无效或进程已死 → 清理 pid 文件，退出 0。
3. 若进程存活但命令行**不是** oc-switch serve → 清理 pid 文件，**不发送信号**，提示后退出 0。
4. 向确认归属的 PID 发终止信号（先 `SIGTERM`，短等后仍存活则 `SIGKILL`）。
5. 删除 `serve.pid`（在发信号前已清文件亦可；不得留下指向无关进程的 pid）。
6. **仅**停止由本机制记录且校验通过的 PID；不扫描杀所有 bun 进程。

### 5.4 与前台 `serve` 的交互

- 用户手动前台 `serve` 时**不**写 `serve.pid`（避免 `stop` 误杀交互会话——或：前台也不写 pid）。**首版约定：只有 `start` 写 pid；`stop` 只管理 `start` 拉起的进程。**
- 若前台 `serve` 已占用 7420，`start` 失败并提示端口占用。

### 5.5 日志

- 后台 `start`：子进程 stdout/stderr 可追加到 `~/.oc-switch/serve.log`（可选但推荐，便于排错）；若实现，在 README 提及路径。
- 不在日志中写入完整 API token 或 `.env` 密钥。

---

## 6. 文档与索引

实现完成后更新：

- `README.md`：新增「本机快速启动」小节（安装 `~/bin`、build、start/stop）。
- `AGENTS.md` 规格索引表：增加本文件一行。
- 可选：`scripts/install-local-launcher.sh` 与简短注释（中文）。

不把本机绝对路径写进公开 README 的可复制示例中作为唯一路径；安装脚本在运行时检测仓库根。

---

## 7. 测试要点

| 层级 | 用例 |
|------|------|
| Server / serve 集成 | 有 dist 时 `GET /` 返回 HTML；`GET /api/status` 仍需 Bearer；未知前端路由 fallback 到 `index.html`；`POST /unknown` 非 200 HTML |
| CLI | `start` 无 dist → 非零；`stop` 无 pid → 0；pid 陈旧时 `start` 可覆盖 |
| 安全 | 静态路径 `../` 不得读出 dist 外文件 |
| 回归 | 无 dist 时前台 `serve` 仍可响应 `/api/*` |

测试使用临时目录 fixture 作为 `OC_SWITCH_WEB_DIST` / 临时 stateDir，避免碰真实 `~/.oc-switch`。

---

## 8. 实现落点（供计划拆分）

| 改动 | 建议位置 |
|------|----------|
| 静态文件 + SPA fallback | `packages/server` 或 `packages/cli` 的 `serve` 装配处（优先在 serve 的 `fetch` 包装层，避免污染纯 API 的 `createApp` 单测；或 `createApp` 增加可选 `webDistDir`） |
| `start` / `stop` | `packages/cli/src/commands/` 新文件 + `index.ts` 注册 |
| PID / 日志辅助 | `packages/core` 小模块或 cli 本地 helper（若仅 cli 使用可放 cli） |
| 安装脚本 | `scripts/install-local-launcher.sh` |
| 文档 | `README.md`、`AGENTS.md` 索引 |

---

## 9. 决策记录

| 问题 | 决定 |
|------|------|
| 全局启动方式 | `~/bin` 包装 → 源码 CLI（非 compile） |
| Web 交付 | `serve` 托管 `web/dist`，单端口 |
| 启停 UX | CLI `start` / `stop`；`start` 自动 `open` 浏览器 |
| 自定义端口（start） | 首版固定 7420；自定义用前台 `serve` |
| ephemeral token | `start` 禁用；确保持久 token |
| 无 dist | `start` 失败；前台 `serve` 仅 API + 警告 |
