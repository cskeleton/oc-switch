import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { upsertDisabledProviderState, type OpenClawConfig, type PluginCatalogResult, type RuntimeModelSnapshot } from "@oc-switch/core";
import { createCommandContext, type CommandContext, type CreateCommandContextOptions } from "../src/command-context";
import { registerModelCommands } from "../src/commands/models";
import { registerPluginCommands } from "../src/commands/plugins";
import { registerProviderCommands } from "../src/commands/providers";

const dirs: string[] = [];
const originalPath = process.env.PATH;
const originalExitCode = process.exitCode;
const emptyPlugins = (): PluginCatalogResult => ({ providers: [], plugins: [], diagnostics: [] });
const discovery = () => ({ status: "gateway-not-detected" as const, instances: [], candidateGroups: [], diagnostics: [] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-runtime-review-"));
  dirs.push(dir);
  const paths = { openclawPath: join(dir, "openclaw.json"), envPath: join(dir, ".env"), stateDir: join(dir, "state") };
  const config: OpenClawConfig = {
    models: { providers: { cpa: { models: [{ id: "main" }, { id: "local" }, { id: "fallback" }] } } },
    agents: { defaults: {
      model: { primary: "cpa/main", fallbacks: ["cpa/fallback"] },
      models: { "cpa/main": {}, "cpa/local": { alias: "keep" }, "ghost/gone": { alias: "keep" } },
      modelPolicy: { allow: ["cpa/main", "cpa/local", "cpa/fallback", "ghost/gone"] }
    } }
  };
  writeFileSync(paths.openclawPath, JSON.stringify(config));
  mkdirSync(paths.stateDir);
  writeFileSync(join(paths.stateDir, "settings.json"), JSON.stringify({ openclawPath: paths.openclawPath, envPath: paths.envPath }));
  // 即使被审阅的旧命令绕过注入，也不能调用开发机真实 openclaw。
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const stub = join(binDir, "openclaw");
  writeFileSync(stub, "#!/bin/sh\nexit 67\n");
  chmodSync(stub, 0o755);
  return { dir, paths, config, binDir };
}

function snapshot(available = true): RuntimeModelSnapshot {
  const entries = ["cpa/main", "cpa/local", "cpa/fallback", "cpa/runtime-only"].map(ref => ({ ref, available, tags: [] }));
  return { openClawVersion: "2026.9.3", fallbackRefs: [], allowedRefs: [], configuredModels: entries, allModels: entries,
    completeness: { status: true, configuredList: true, allList: true }, diagnostics: [], capturedAt: "2026-09-11T00:00:00Z" };
}

function contextFor(ws: ReturnType<typeof fixture>, options: CreateCommandContextOptions = {}) {
  return createCommandContext({ env: { HOME: ws.dir }, stateDir: ws.paths.stateDir, runtimeDiscoveryProvider: discovery,
    pluginCatalogProvider: emptyPlugins, runtimeModelCatalogProvider: () => snapshot(), ...options });
}

async function run(context: CommandContext, args: string[]) {
  const program = new Command().exitOverride();
  registerModelCommands(program, context);
  registerPluginCommands(program, context);
  registerProviderCommands(program, context);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values) => { stdout.push(values.join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...values) => { stderr.push(values.join(" ")); });
  const warn = spyOn(console, "warn").mockImplementation((...values) => { stderr.push(values.join(" ")); });
  process.exitCode = 0;
  try { await program.parseAsync(args, { from: "user" }); }
  catch (error) { stderr.push(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally { log.mockRestore(); error.mockRestore(); warn.mockRestore(); }
  const code = process.exitCode;
  process.exitCode = originalExitCode ?? 0;
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

function backups(ws: ReturnType<typeof fixture>) {
  const dir = join(ws.paths.stateDir, "backups");
  return existsSync(dir) ? readdirSync(dir) : [];
}

afterEach(() => {
  process.env.PATH = originalPath;
  process.exitCode = originalExitCode ?? 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("runtime-only available CLI enable/use succeeds without a static catalog definition", async () => {
  const ws = fixture();
  const context = contextFor(ws);
  expect((await run(context, ["model", "enable", "cpa/runtime-only"])).code).toBe(0);
  expect((await run(context, ["use", "cpa/runtime-only"])).code).toBe(0);
  const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
  expect(saved.agents.defaults.model).toEqual({ primary: "cpa/runtime-only", fallbacks: ["cpa/fallback"] });
  expect(saved.models).toEqual(ws.config.models);
});

for (const availability of ["unavailable", "unknown"] as const) {
  for (const action of ["enable", "use", "disable"] as const) {
    test(`CLI ${action} refuses ${availability} even for a known config model`, async () => {
      const ws = fixture();
      const runtime = snapshot(false);
      if (availability === "unknown") runtime.completeness.allList = false;
      const context = contextFor(ws, { runtimeModelCatalogProvider: () => runtime });
      const before = readFileSync(ws.paths.openclawPath, "utf8");
      const result = await run(context, action === "use" ? ["use", "cpa/local"] : ["model", action, "cpa/local"]);
      expect(result.code).not.toBe(0);
      expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
      expect(backups(ws)).toEqual([]);
    });
  }
}

for (const action of ["enable", "use"] as const) {
  test(`CLI ${action} rechecks disabled state inside the mutation after discovery`, async () => {
    const ws = fixture();
    const context = contextFor(ws, { runtimeModelCatalogProvider: () => {
      upsertDisabledProviderState(ws.paths.stateDir, { providerId: "cpa", openclawPath: ws.paths.openclawPath,
        disabledAt: "2026-09-11T00:00:00Z", allowlistEntries: {} });
      return snapshot();
    } });
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const result = await run(context, action === "use" ? ["use", "cpa/local"] : ["model", action, "cpa/local"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("disabled");
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws)).toEqual([]);
  });
}

test("CLI discovery exceptions become unknown with secret-free diagnostics, matching the API", async () => {
  const ws = fixture();
  const context = contextFor(ws, {
    runtimeModelCatalogProvider() { throw new Error("AUTH_SECRET_MARKER from status auth"); },
    pluginCatalogProvider() { throw new Error("AUTH_SECRET_MARKER from plugin stderr"); }
  });
  const result = await run(context, ["models", "inventory", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("AUTH_SECRET_MARKER");
  const inventory = JSON.parse(result.stdout);
  expect(inventory.models.every((row: { availability: string }) => row.availability === "unknown")).toBe(true);
  expect(inventory.diagnostics.length).toBeGreaterThan(0);
});

test("CLI reconcile --yes cannot report success when availability is unknown", async () => {
  const ws = fixture();
  const runtime = snapshot(false);
  runtime.completeness.allList = false;
  const context = contextFor(ws, { runtimeModelCatalogProvider: () => runtime });
  const before = readFileSync(ws.paths.openclawPath, "utf8");
  const result = await run(context, ["model", "reconcile", "cpa/runtime-only", "--yes", "--json"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("unknown");
  expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  expect(backups(ws)).toEqual([]);
});

test("CLI plugin state refreshes a previously cached descriptor before primary/fallback preflight", async () => {
  const ws = fixture();
  let providerId = "other";
  const context = contextFor(ws, { pluginCatalogProvider: () => ({ providers: [], diagnostics: [], plugins: [{
    id: "example", origin: "bundled", enabled: true, providerIds: [providerId], nonModelCapabilities: ["speech"]
  }] }) });
  context.pluginCatalog();
  providerId = "cpa";
  const before = readFileSync(ws.paths.openclawPath, "utf8");
  const result = await run(context, ["plugin", "disable", "example", "--yes", "--json"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("primary");
  expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  expect(backups(ws)).toEqual([]);
});

for (const command of ["models", "providers"] as const) {
  test(`legacy CLI ${command} list uses the selected context plugin catalog, not an unscoped probe`, async () => {
    const ws = fixture();
    // spawnSync 在 Bun 内可能使用启动时的环境；在进程边界固定 HOME/PATH，回归也不会真探测。
    const script = `
      import { Command } from "commander";
      import { createCommandContext } from "./packages/cli/src/command-context";
      import { registerModelCommands } from "./packages/cli/src/commands/models";
      import { registerProviderCommands } from "./packages/cli/src/commands/providers";
      const context = createCommandContext({ env: process.env, stateDir: ${JSON.stringify(ws.paths.stateDir)},
        runtimeDiscoveryProvider: () => ({ status: "gateway-not-detected", instances: [], candidateGroups: [], diagnostics: [] }),
        pluginCatalogProvider: () => ({ plugins: [], diagnostics: [], providers: [{
          pluginId: "test-plugin", providerId: "fixture-only", origin: "bundled", enabled: true,
          models: [{ id: "plugin-model" }], apiKeyEnvVars: []
        }] }) });
      const program = new Command();
      registerModelCommands(program, context);
      registerProviderCommands(program, context);
      await program.parseAsync([${JSON.stringify(command)}, "list"], { from: "user" });
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, HOME: ws.dir, OPENCLAW_CONFIG_PATH: ws.paths.openclawPath,
        OPENCLAW_STATE_DIR: undefined, PATH: `${ws.binDir}:${originalPath ?? ""}` }, stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(0);
    expect(stdout).toContain("fixture-only");
  });
}

for (const observed of [true, false, "missing", "error"] as const) {
  test(`CLI plugin confirmation checks the observed target state (${observed})`, async () => {
    const ws = fixture();
    const context = contextFor(ws, { pluginCatalogProvider: () => {
      const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
      const written = saved.plugins?.entries?.example?.enabled === false;
      if (written && observed === "error") throw new Error("AUTH_SECRET_MARKER");
      if (written && observed === "missing") return emptyPlugins();
      return { providers: [], diagnostics: [], plugins: [{ id: "example", origin: "bundled",
        enabled: written ? observed as boolean : true, providerIds: ["plugin-a", "plugin-b"], nonModelCapabilities: ["speech"] }] };
    } });
    const result = await run(context, ["plugin", "disable", "example", "--yes", "--json"]);
    expect(result.code).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.ok).toBe(true);
    expect(json.runtimeConfirmed).toBe(observed === false);
    expect(json.affectedProviderIds).toEqual(["plugin-a", "plugin-b"]);
    expect(result.stdout + result.stderr).not.toContain("AUTH_SECRET_MARKER");
    expect(JSON.parse(readFileSync(ws.paths.openclawPath, "utf8")).plugins.entries.example).toEqual({ enabled: false });
  });
}

test("CLI refuses plugin state changes when descriptor discovery is partial", async () => {
  const ws = fixture();
  const context = contextFor(ws, { pluginCatalogProvider: () => ({ providers: [], diagnostics: ["plugin catalog incomplete"], plugins: [{
    id: "example", origin: "bundled", enabled: true, providerIds: ["other"], nonModelCapabilities: []
  }] }) });
  const before = readFileSync(ws.paths.openclawPath, "utf8");
  const result = await run(context, ["plugin", "disable", "example", "--yes"]);
  expect(result.code).not.toBe(0);
  expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  expect(backups(ws)).toEqual([]);
});

for (const action of ["enable", "use", "materialize", "exact", "plugin"] as const) {
  test(`CLI ${action} pins probe and write paths if settings change during discovery`, async () => {
    const ws = fixture();
    const other = fixture();
    const beforeOther = readFileSync(other.paths.openclawPath, "utf8");
    const probePaths: string[] = [];
    const context = contextFor(ws, {
      pluginCatalogProvider(paths) {
        probePaths.push(paths.openclawPath);
        writeFileSync(join(ws.paths.stateDir, "settings.json"), JSON.stringify({ openclawPath: other.paths.openclawPath, envPath: other.paths.envPath }));
        return { providers: [], diagnostics: [], plugins: [{ id: "example", origin: "bundled", enabled: true,
          providerIds: ["plugin-a"], nonModelCapabilities: [] }] };
      },
      runtimeModelCatalogProvider(paths) {
        probePaths.push(paths.openclawPath);
        return snapshot(paths.openclawPath === ws.paths.openclawPath);
      }
    });
    const args = action === "use" ? ["use", "cpa/local"]
      : action === "enable" ? ["model", "enable", "cpa/runtime-only"]
      : action === "materialize" ? ["model", "reconcile", "cpa/runtime-only", "--yes"]
      : action === "exact" ? ["model", "remove-policy-ref", "ghost/gone", "--yes"]
      : ["plugin", "disable", "example", "--yes"];
    const result = await run(context, args);
    expect(result.code).toBe(0);
    expect(probePaths.every(path => path === ws.paths.openclawPath)).toBe(true);
    expect(readFileSync(other.paths.openclawPath, "utf8")).toBe(beforeOther);
    expect(backups(other)).toEqual([]);
    expect(backups(ws).length).toBe(1);
  });
}

test("CLI error messages do not echo parsing or unexpected type error payloads", async () => {
  const { commandErrorMessage } = await import("../src/errors");
  for (const error of [new SyntaxError("AUTH_SECRET_MARKER in JSON"), new TypeError("AUTH_SECRET_MARKER in runtime error"), { auth: "AUTH_SECRET_MARKER" }]) {
    expect(commandErrorMessage(error)).not.toContain("AUTH_SECRET_MARKER");
    expect(commandErrorMessage(error).length).toBeGreaterThan(0);
  }
  expect(commandErrorMessage(new Error("Model is the primary model"))).toContain("primary model");
});

for (const action of ["remove", "batch-remove", "keep-enabled-only"] as const) {
  test(`legacy CLI ${action} refuses to clean unknown model entries`, async () => {
    const ws = fixture();
    ws.config.models!.providers!.cpa!.models!.push({ id: "orphan" });
    writeFileSync(ws.paths.openclawPath, JSON.stringify(ws.config));
    const runtime = snapshot(false);
    runtime.completeness.allList = false;
    const context = contextFor(ws, { runtimeModelCatalogProvider: () => runtime });
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const args = action === "remove" ? ["model", "remove", "cpa/local", "--force"]
      : action === "batch-remove" ? ["provider", "models", "remove", "cpa", "--ids", "local"]
      : ["provider", "models", "remove", "cpa", "--keep-enabled-only"];
    const result = await run(context, args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown");
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws)).toEqual([]);
  });
}

for (const action of ["exact", "materialize", "plugin"] as const) {
  test(`CLI ${action} rechecks fresh evidence during Core's config-change retry`, async () => {
    const ws = fixture();
    let calls = 0;
    const options: CreateCommandContextOptions = action === "plugin" ? {
      pluginCatalogProvider() {
        calls += 1;
        if (calls === 1) writeFileSync(ws.paths.openclawPath, JSON.stringify({ ...ws.config, channels: { external: true } }));
        return { providers: [], diagnostics: [], plugins: [{ id: "example", origin: "bundled", enabled: true,
          providerIds: [calls === 1 ? "other" : "cpa"], nonModelCapabilities: [] }] };
      }
    } : {
      runtimeModelCatalogProvider() {
        calls += 1;
        // reconcile 还有一次只读预览，变更放在事务内探测而非预览阶段。
        if (calls === (action === "materialize" ? 2 : 1)) {
          const changed = structuredClone(ws.config);
          changed.agents!.defaults!.model = action === "exact" ? "ghost/gone" : "cpa/runtime-only";
          writeFileSync(ws.paths.openclawPath, JSON.stringify(changed));
        }
        return snapshot();
      }
    };
    const context = contextFor(ws, options);
    const args = action === "exact" ? ["model", "remove-policy-ref", "ghost/gone", "--remove-metadata", "--yes"]
      : action === "materialize" ? ["model", "reconcile", "cpa/runtime-only", "--yes"]
      : ["plugin", "disable", "example", "--yes"];
    const result = await run(context, args);
    expect(result.code).not.toBe(0);
    expect(calls).toBe(action === "exact" ? 2 : 3);
    const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(saved.models).toEqual(ws.config.models);
    expect(saved.agents.defaults.modelPolicy.allow).toEqual(ws.config.agents!.defaults!.modelPolicy!.allow);
    if (action === "plugin") {
      expect(saved.channels.external).toBe(true);
      expect(saved.plugins).toBeUndefined();
    } else expect(saved.agents.defaults.model).toBe(action === "exact" ? "ghost/gone" : "cpa/runtime-only");
    expect(backups(ws)).toEqual([]);
  });
}

test("API and CLI inventory return identical DTOs for the same isolated runtime facts", async () => {
  const { createApp } = await import("@oc-switch/server");
  const ws = fixture();
  const runtime = snapshot();
  const context = contextFor(ws, { runtimeModelCatalogProvider: () => runtime });
  const app = createApp({ token: "fixture-token", paths: ws.paths, runtimeDiscoveryProvider: discovery,
    pluginCatalogProvider: emptyPlugins, runtimeModelCatalogProvider: () => runtime });
  const response = await app.request("/api/model-inventory", { headers: { Authorization: "Bearer fixture-token" } });
  const cli = await run(context, ["models", "inventory", "--json"]);
  expect(response.status).toBe(200);
  expect(cli.code).toBe(0);
  const inventory = JSON.parse(cli.stdout);
  expect(inventory.models.find((model: { ref: string }) => model.ref === "cpa/runtime-only").availability).toBe("available");
  expect(inventory.models.find((model: { ref: string }) => model.ref === "ghost/gone").availability).toBe("unavailable");
  expect(inventory).toEqual(await response.json());
});
