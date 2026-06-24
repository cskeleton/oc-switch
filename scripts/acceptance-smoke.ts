#!/usr/bin/env bun
/**
 * Phase 5.3 验收烟雾测试
 * 使用临时 fixture 目录，不修改用户真实 OpenClaw 配置。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listBackups } from "../packages/core/src/backup-manager";
import sample from "../packages/core/test/fixtures/openclaw.sample.json";
import { createApp } from "../packages/server/src/app";

const repoRoot = join(import.meta.dir, "..");
const CLI_ENTRY = join(repoRoot, "packages/cli/src/index.ts");
const TOKEN = "acceptance-smoke-token";
const SERVER_PORT = 17_421;

/** 疑似真实密钥的输出模式（与 builtin-presets 测试保持一致） */
const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{8,}\b/,
  /\bBearer\s+[a-zA-Z0-9._-]{8,}\b/i,
  /\b(api[_-]?key|apikey)\s*[:=]\s*["']?[a-zA-Z0-9._-]{12,}/i
];

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function assert(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/** 扫描输出，确保不含 API Key 形态字符串 */
function assertNoSecrets(text: string, label: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      fail(`${label} 输出疑似包含密钥: ${pattern}`);
    }
  }
}

/** 运行 CLI 子进程并收集 stdout/stderr */
async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr, combined: stdout + stderr };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-acceptance-"));
  const outputs: string[] = [];

  try {
    // 准备临时目录与 fixture
    const openclawPath = join(dir, "openclaw.json");
    const envDir = join(dir, ".openclaw");
    mkdirSync(envDir, { recursive: true });
    const envPath = join(envDir, ".env");
    const stateDir = join(dir, ".oc-switch");
    const initialEnv = "# 用户自有变量\nUSER_DEFINED_API_KEY=keep-me\n";
    writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
    writeFileSync(envPath, initialEnv);

    const cliEnv = {
      OPENCLAW_CONFIG_PATH: openclawPath,
      HOME: dir
    };

    // CLI 只读命令
    let result = await runCli(["status"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, `status 退出码应为 0，实际 ${result.code}`);
    assert(result.stdout.includes("Providers: 3"), "status 应报告 3 个 provider");
    assert(result.stdout.includes("Allowlist models: 4"), "status 应报告 4 个 allowlist 模型");

    result = await runCli(["providers", "list"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, "providers list 应成功");
    assert(result.stdout.includes("nvidia"), "providers list 应包含 nvidia");

    result = await runCli(["models", "list"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, "models list 应成功");
    assert(result.stdout.includes("deepseek-ai/deepseek-v4-flash"), "models list 应保留斜杠 model id");

    // CLI 写入：切换 primary model（不写入 API Key）
    result = await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], cliEnv);
    outputs.push(result.combined);
    assert(result.code === 0, "use 应成功");
    assert(
      result.stdout.includes("Primary model set to nvidia/deepseek-ai/deepseek-v4-flash"),
      "use 应确认 primary 已切换"
    );

    result = await runCli([
      "provider", "add-custom",
      "--id", "acceptance-custom",
      "--name", "Acceptance Custom",
      "--api", "openai-completions",
      "--base-url", "https://api.acceptance.example",
      "--env", "ACCEPTANCE_CUSTOM_API_KEY",
      "--key", "acceptance-secret-value",
      "--models", "acceptance-model,vendor/acceptance-model",
      "--aliases", "acceptance-model:acceptance,vendor/acceptance-model:vendor-acceptance"
    ], cliEnv);
    outputs.push(result.stdout, result.stderr);
    assert(result.code === 0, "provider add-custom 应成功");
    assert(result.stdout.includes("Added custom provider acceptance-custom"), "provider add-custom 应确认新增 provider");

    const customConfig = JSON.parse(readFileSync(openclawPath, "utf8")) as {
      models: { providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }> };
      agents: { defaults: { models: Record<string, { alias?: string }> } };
    };
    assert(
      customConfig.models.providers["acceptance-custom"]?.baseUrl === "https://api.acceptance.example/v1",
      "自定义 openai provider 应自动补 /v1"
    );
    assert(
      customConfig.agents.defaults.models["acceptance-custom/vendor/acceptance-model"]?.alias === "vendor-acceptance",
      "自定义 provider 应支持带斜杠的 model id"
    );
    assert(
      readFileSync(envPath, "utf8").includes("ACCEPTANCE_CUSTOM_API_KEY=acceptance-secret-value"),
      "自定义 provider API Key 应写入 .env managed block"
    );

    // 验证备份包已创建
    const backups = listBackups(stateDir);
    assert(backups.length > 0, "写入后应存在至少一个备份包");
    const latestBackupDir = join(stateDir, "backups", backups[0]!.id);
    assert(existsSync(join(latestBackupDir, "openclaw.json")), "备份包应包含 openclaw.json");
    assert(existsSync(join(latestBackupDir, ".env")), "备份包应包含 .env");

    const envAfter = readFileSync(envPath, "utf8");
    assert(envAfter.includes("USER_DEFINED_API_KEY=keep-me"), "用户自有 env 变量应保留");
    assert(envAfter.includes("# oc-switch:start"), "自定义 provider 写入后应存在 managed block");

    // REST 服务鉴权测试
    const customDir = join(stateDir, "presets", "custom");
    mkdirSync(customDir, { recursive: true });
    const app = createApp({
      token: TOKEN,
      paths: { openclawPath, envPath, stateDir },
      presetDirs: {
        builtinDir: join(repoRoot, "presets", "builtin"),
        customDir
      },
      repoRoot
    });
    const server = Bun.serve({
      port: SERVER_PORT,
      hostname: "127.0.0.1",
      fetch: app.fetch
    });

    try {
      const baseUrl = `http://127.0.0.1:${SERVER_PORT}`;

      const appEnvUpdate = await fetch(`${baseUrl}/api/env`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          type: "upsert",
          envVar: "USER_DEFINED_API_KEY",
          value: "new-managed-value",
          confirmMigration: true
        })
      });
      const appEnvUpdateJson = await appEnvUpdate.json() as Record<string, unknown>;
      outputs.push(JSON.stringify(appEnvUpdateJson));
      assert(appEnvUpdate.status === 200, "env update 应成功");
      assert(!JSON.stringify(appEnvUpdateJson).includes("new-managed-value"), "env update 响应不得回显新值");

      const latestAfterEnvUpdate = listBackups(stateDir)[0];
      assert(latestAfterEnvUpdate !== undefined, "env update 后应存在备份");
      const latestBackupDirAfterEnvUpdate = join(stateDir, "backups", latestAfterEnvUpdate.id);
      const latestMetadata = JSON.parse(readFileSync(join(latestBackupDirAfterEnvUpdate, "metadata.json"), "utf8")) as {
        openclawPath?: string;
        envPath?: string;
      };
      assert(latestMetadata.openclawPath === openclawPath, "备份 metadata 应记录 openclawPath");
      assert(latestMetadata.envPath === envPath, "备份 metadata 应记录 envPath");

      const unauth = await fetch(`${baseUrl}/api/status`);
      const unauthBody = await unauth.text();
      outputs.push(unauthBody);
      assert(unauth.status === 401, "无 token 请求应返回 401");
      assert(!unauthBody.includes("nvidia"), "401 响应不得泄漏 provider 配置");
      assert(!unauthBody.includes("minimax-portal"), "401 响应不得泄漏 primary model");

      const auth = await fetch(`${baseUrl}/api/status`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
      });
      const authJson = await auth.json() as Record<string, unknown>;
      outputs.push(JSON.stringify(authJson));
      assert(auth.status === 200, "携带 token 请求应返回 200");
      assert(authJson.primaryModel === "nvidia/deepseek-ai/deepseek-v4-flash", "授权后应返回更新后的 primary");
    } finally {
      server.stop();
    }

    // 汇总扫描所有输出
    for (const text of outputs) {
      assertNoSecrets(text, "acceptance");
    }

    console.log("✓ acceptance smoke passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
