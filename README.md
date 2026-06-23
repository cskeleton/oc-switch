# oc-switch

oc-switch manages local OpenClaw provider and model configuration.

## Phase 1 Commands

```bash
oc-switch status
oc-switch providers list
oc-switch models list
oc-switch models list --provider nvidia
oc-switch use nvidia/deepseek-ai/deepseek-v4-flash
oc-switch model enable nvidia/deepseek-ai/deepseek-v4-flash --alias nv-ds-flash
oc-switch model disable nvidia/deepseek-ai/deepseek-v4-flash
```

`OPENCLAW_CONFIG_PATH` can point to a non-default `openclaw.json` for testing.

The tool writes `.env` keys only inside the `# oc-switch:start` and `# oc-switch:end` managed block. Config writes create backup packages under `~/.oc-switch/backups/`.
