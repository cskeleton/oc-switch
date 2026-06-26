#!/usr/bin/env bun
/** E2E 用 API 服务：临时 fixture + 固定 token */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup } from "../packages/core/src/backup-manager";
import sample from "../packages/core/test/fixtures/openclaw.sample.json";
import { createApp } from "../packages/server/src/app";

const TOKEN = "e2e-test-token";
const PORT = 7420;
const fixtureBuiltinDir = join(import.meta.dir, "../packages/core/test/fixtures/presets/builtin");

const dir = mkdtempSync(join(tmpdir(), "oc-switch-e2e-"));
const openclawPath = join(dir, "openclaw.json");
const envPath = join(dir, ".env");
const stateDir = join(dir, ".oc-switch");
writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
const customDir = join(stateDir, "presets", "custom");
mkdirSync(customDir, { recursive: true });
createBackup({ openclawPath, envPath, stateDir, reason: "e2e seed", beforeHash: "seed" });

const app = createApp({
  token: TOKEN,
  paths: { openclawPath, envPath, stateDir },
  presetDirs: {
    builtinDir: fixtureBuiltinDir,
    customDir
  }
});

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch
});

console.log(`E2E API listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
