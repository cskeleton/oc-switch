# oc-switch

oc-switch manages local OpenClaw provider and model configuration via CLI and WebGUI. It reads and writes `openclaw.json` and the managed block in `~/.openclaw/.env` without touching unrelated config sections.

## Install & Run

```bash
# Clone and install dependencies
git clone <repo-url> oc-switch && cd oc-switch
bun install

# Run CLI directly from the repo
bun run cli -- status
bun run cli -- providers list

# Or invoke the entrypoint
bun run packages/cli/src/index.ts status
```

Environment overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` | OpenClaw config file |
| `HOME` | current user home | Resolves `~/.openclaw/.env` and `~/.oc-switch/` state |

State and backups live under `~/.oc-switch/` (backups in `~/.oc-switch/backups/`).

## Local WebGUI

WebGUI is a Vite SPA that proxies `/api` to the oc-switch REST server.

```bash
# Terminal 1 — REST API (default http://127.0.0.1:7420)
bun run cli -- serve

# Terminal 2 — WebGUI (default http://127.0.0.1:5173)
bun run --cwd packages/web dev
```

Open http://127.0.0.1:5173 in your browser. When `serve` runs on localhost without `--token`, a one-time ephemeral token is printed to the terminal; paste it into the WebGUI login prompt.

Production-style preview after build:

```bash
bun run build
bun run cli -- serve
bun run --cwd packages/web preview
```

## Remote VPS Usage

Binding to all interfaces requires an explicit token; the server refuses to start otherwise.

```bash
# On the VPS — MUST pass --token when using --host 0.0.0.0
oc-switch serve --host 0.0.0.0 --port 7420 --token <your-secret-token>
```

**Recommended:** prefer an SSH tunnel instead of exposing the port publicly:

```bash
# On your Mac — forward remote API to localhost
ssh -L 7420:127.0.0.1:7420 user@your-vps

# On the VPS — bind localhost only
oc-switch serve --host 127.0.0.1 --port 7420 --token <your-secret-token>
```

Then run the WebGUI locally (`bun run --cwd packages/web dev`) or build and preview it; Vite proxies `/api` to `127.0.0.1:7420`.

Rotate the persisted API token:

```bash
oc-switch token rotate
```

## CLI Reference

```bash
# Server
oc-switch serve [--port 7420] [--host 127.0.0.1] [--token <secret>]
oc-switch token rotate

# Read
oc-switch status
oc-switch providers list
oc-switch models list [--provider <name>]
oc-switch presets list
oc-switch diff

# Provider CRUD
oc-switch provider add <preset-id> --key <api-key> [--models m1,m2]
oc-switch provider edit <name> [--base-url <url>] [--key <api-key>]
oc-switch provider delete <name> [--force]
oc-switch provider sync <name>

# Model operations (<provider>/<model-id...> splits only on the first slash)
oc-switch use <provider>/<model-id...>
oc-switch model add <provider>/<model-id...> [--alias <alias>]
oc-switch model remove <provider>/<model-id...>
oc-switch model enable <provider>/<model-id...>
oc-switch model disable <provider>/<model-id...>

# Presets & backup
oc-switch import
oc-switch presets export <provider-id>
oc-switch backup list
oc-switch backup restore <timestamp>
```

Example — model ref with slashes in the model id:

```bash
oc-switch use nvidia/deepseek-ai/deepseek-v4-flash
# → provider: nvidia, modelId: deepseek-ai/deepseek-v4-flash
```

## Backup & Restore Warning

Every write creates a backup package under `~/.oc-switch/backups/` containing both `openclaw.json` and `.env`.

`oc-switch backup restore <timestamp>` **replaces your live config and env file** with the backup snapshot. Review `oc-switch diff` first. Restore also creates a pre-restore backup of the current state.

## JSON5 Formatting Caveat

OpenClaw configs may use JSON5 (comments, trailing commas). oc-switch parses JSON5 on read but writes formatted JSON on save. If your source file contains comments, CLI/WebGUI will warn that the next write may reformat the file. Semantic changes are limited to `models.providers.*`, `agents.defaults.models.*`, and `agents.defaults.model` (see `oc-switch diff`).

## No API Keys in JSON

API keys are stored only in `~/.openclaw/.env` inside the `# oc-switch:start` … `# oc-switch:end` managed block. `openclaw.json` keeps env references such as `{ "source": "env", "id": "NVIDIA_API_KEY" }`. CLI output, logs, REST responses, and WebGUI screens never print full API key values.

## Development

```bash
bun run test          # unit tests (core, cli, server, web)
bun run typecheck     # TypeScript project references
bun run build         # build WebGUI
bun run check         # test + typecheck + web build
bun run acceptance    # end-to-end acceptance smoke (temp fixtures only)
bun run test:e2e      # Playwright browser tests (requires build)
```

See [docs/acceptance-checklist.md](docs/acceptance-checklist.md) for the full acceptance matrix mapped to design §10.
