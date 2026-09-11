import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { upsertDisabledProviderState, type OcSwitchPaths, type OpenClawConfig, type PluginCatalogResult, type RuntimeModelSnapshot } from "@oc-switch/core";
import { createApp } from "../src/app";
import { createAppRuntime, type AppOptions } from "../src/context";
import { registerModelRoutes } from "../src/routes/models";
import { registerModelInventoryRoutes } from "../src/routes/model-inventory";
import { registerPluginRoutes } from "../src/routes/plugins";

const dirs: string[] = [];
const discovery = () => ({ status: "gateway-not-detected" as const, instances: [], candidateGroups: [], diagnostics: [] });
const emptyPlugins = (): PluginCatalogResult => ({ providers: [], plugins: [], diagnostics: [] });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-server-runtime-review-"));
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
  return { dir, paths, config };
}

function snapshot(available = true): RuntimeModelSnapshot {
  const entries = ["cpa/main", "cpa/local", "cpa/fallback", "cpa/runtime-only"].map(ref => ({ ref, available, tags: [] }));
  return {
    openClawVersion: "2026.9.3", fallbackRefs: [], allowedRefs: [],
    configuredModels: entries, allModels: entries,
    completeness: { status: true, configuredList: true, allList: true }, diagnostics: [], capturedAt: "2026-09-11T00:00:00Z"
  };
}

function appOptions(paths: OcSwitchPaths, extra: Partial<AppOptions> = {}): AppOptions {
  return { token: "fixture-token", paths, runtimeDiscoveryProvider: discovery, pluginCatalogProvider: emptyPlugins,
    runtimeModelCatalogProvider: () => snapshot(), ...extra };
}

async function request(app: ReturnType<typeof createApp>, url: string, method = "GET", body?: unknown) {
  const response = await app.request(url, { method, headers: { Authorization: "Bearer fixture-token", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, json: await response.json() as any };
}

function backups(paths: OcSwitchPaths): string[] {
  const dir = join(paths.stateDir, "backups");
  return existsSync(dir) ? readdirSync(dir) : [];
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("runtime review: direct HTTP writes", () => {
  test("settings path report uses the same pinned paths as inventory and writes", async () => {
    const ws = fixture();
    const other = fixture();
    const keys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { HOME: other.dir, OPENCLAW_HOME: other.dir, OPENCLAW_STATE_DIR: other.dir, OPENCLAW_CONFIG_PATH: other.paths.openclawPath });
    try {
      const app = createApp(appOptions(ws.paths));
      const { response, json } = await request(app, "/api/settings/paths");
      expect(response.status).toBe(200);
      expect(json.active).toEqual(ws.paths);
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  test("runtime-only available can enable and become primary without inventing a catalog entry", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths));
    expect((await request(app, "/api/models", "PATCH", { ref: "cpa/runtime-only", enabled: true })).response.status).toBe(200);
    expect((await request(app, "/api/models/primary", "PUT", { ref: "cpa/runtime-only" })).response.status).toBe(200);
    const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(saved.agents.defaults.model).toEqual({ primary: "cpa/runtime-only", fallbacks: ["cpa/fallback"] });
    expect(saved.agents.defaults.modelPolicy.allow).toContain("cpa/runtime-only");
    expect(saved.models).toEqual(ws.config.models);
  });

  for (const availability of ["unavailable", "unknown"] as const) {
    for (const action of ["enable", "use", "disable"] as const) {
      test(`${action} cannot bypass ${availability} with a known static model`, async () => {
        const ws = fixture();
        const runtime = snapshot(false);
        if (availability === "unknown") runtime.completeness.allList = false;
        const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => runtime }));
        const before = readFileSync(ws.paths.openclawPath, "utf8");
        const result = action === "use"
          ? await request(app, "/api/models/primary", "PUT", { ref: "cpa/local" })
          : await request(app, "/api/models", "PATCH", { ref: "cpa/local", enabled: action === "enable" });
        expect(result.response.status).toBe(400);
        expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
        expect(backups(ws.paths)).toEqual([]);
      });
    }
  }

  for (const action of ["enable", "use"] as const) {
    test(`${action} rechecks disabled providers after fresh runtime discovery`, async () => {
      const ws = fixture();
      const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => {
        upsertDisabledProviderState(ws.paths.stateDir, { providerId: "cpa", openclawPath: ws.paths.openclawPath,
          disabledAt: "2026-09-11T00:00:00Z", allowlistEntries: {} });
        return snapshot();
      } }));
      const before = readFileSync(ws.paths.openclawPath, "utf8");
      const result = action === "use"
        ? await request(app, "/api/models/primary", "PUT", { ref: "cpa/local" })
        : await request(app, "/api/models", "PATCH", { ref: "cpa/local", enabled: true });
      expect(result.response.status).toBe(400);
      expect(String(result.json.error)).toContain("disabled");
      expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
      expect(backups(ws.paths)).toEqual([]);
    });
  }

  test("PATCH model rejects a non-string alias instead of persisting arbitrary request data", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response, json } = await request(app, "/api/models", "PATCH", { ref: "cpa/local", enabled: true, alias: { auth: "AUTH_SECRET_MARKER" } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(json)).not.toContain("AUTH_SECRET_MARKER");
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });

  test("materialize requires an explicit enabled boolean", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response } = await request(app, "/api/models/materialize", "POST", { ref: "cpa/runtime-only", input: { id: "runtime-only" } });
    expect(response.status).toBe(400);
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });

  test("unknown exact ref removal is refused despite --style force fields", async () => {
    const ws = fixture();
    const runtime = snapshot(false);
    runtime.completeness.configuredList = false;
    const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => runtime }));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response } = await request(app, "/api/model-policy/exact-ref", "DELETE", { ref: "ghost/gone", removeMetadata: true, force: true });
    expect(response.status).toBe(400);
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });
});

describe("runtime review: cache and probe scope", () => {
  test("30 second TTL caches facts, expires at the boundary, and refresh invalidates both catalogs", () => {
    const ws = fixture();
    let now = 1_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let available = true;
    const runtime = createAppRuntime(appOptions(ws.paths, { runtimeModelCatalogProvider: () => snapshot(available) }));
    try {
      expect(runtime.buildCurrentInventory().models.find(row => row.ref === "cpa/local")?.availability).toBe("available");
      available = false;
      now += 29_999;
      expect(runtime.buildCurrentInventory().models.find(row => row.ref === "cpa/local")?.availability).toBe("available");
      now += 1;
      expect(runtime.buildCurrentInventory().models.find(row => row.ref === "cpa/local")?.availability).toBe("unavailable");
      available = true;
      expect(runtime.buildCurrentInventory({ refresh: true }).models.find(row => row.ref === "cpa/local")?.availability).toBe("available");
    } finally { clock.mockRestore(); }
  });

  test("external config replacement invalidates facts before TTL rather than mixing old runtime and new config", () => {
    const ws = fixture();
    const runtime = createAppRuntime(appOptions(ws.paths, { runtimeModelCatalogProvider: () => {
      const fresh = snapshot();
      const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
      if (config.models.providers.cpa.models.some((model: { id: string }) => model.id === "added")) fresh.allModels.push({ ref: "cpa/added", available: true, tags: [] });
      return fresh;
    } }));
    runtime.buildCurrentInventory();
    ws.config.models!.providers!.cpa!.models!.push({ id: "added" });
    writeFileSync(ws.paths.openclawPath, JSON.stringify(ws.config));
    expect(runtime.buildCurrentInventory().models.find(row => row.ref === "cpa/added")?.availability).toBe("available");
  });

  test("source env changes invalidate runtime auth facts without exposing env values", () => {
    const ws = fixture();
    const runtime = createAppRuntime(appOptions(ws.paths, { runtimeModelCatalogProvider: () => snapshot(existsSync(ws.paths.envPath)) }));
    expect(runtime.buildCurrentInventory().models.find(row => row.ref === "cpa/local")?.availability).toBe("unavailable");
    writeFileSync(ws.paths.envPath, "PROVIDER_API_KEY=AUTH_SECRET_MARKER\n");
    const inventory = runtime.buildCurrentInventory();
    expect(inventory.models.find(row => row.ref === "cpa/local")?.availability).toBe("available");
    expect(JSON.stringify(inventory)).not.toContain("AUTH_SECRET_MARKER");
  });

  test("provider exceptions produce only constant diagnostics", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths, {
      pluginCatalogProvider() { throw new Error("AUTH_SECRET_MARKER in plugin stderr"); },
      runtimeModelCatalogProvider() { throw new Error("AUTH_SECRET_MARKER in status auth"); }
    }));
    const result = await request(app, "/api/model-inventory");
    expect(result.response.status).toBe(200);
    expect(JSON.stringify(result.json)).not.toContain("AUTH_SECRET_MARKER");
    expect(result.json.models.every((row: { availability: string }) => row.availability === "unknown")).toBe(true);
    expect(result.json.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("runtime review: plugin state and request validation", () => {
  function plugins(enabled: boolean): PluginCatalogResult {
    return { providers: [], diagnostics: [], plugins: [{ id: "example", origin: "bundled", enabled,
      providerIds: ["plugin-a", "plugin-b"], nonModelCapabilities: ["speech", "tools"] }] };
  }

  for (const observed of [true, false, "missing", "error"] as const) {
    test(`plugin disable confirms the observed target, not just complete model probes (${observed})`, async () => {
      const ws = fixture();
      const app = createApp(appOptions(ws.paths, { pluginCatalogProvider: () => {
        const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
        if (saved.plugins?.entries?.example?.enabled === false) {
          if (observed === "error") throw new Error("AUTH_SECRET_MARKER");
          if (observed === "missing") return emptyPlugins();
          return plugins(observed);
        }
        return plugins(true);
      } }));
      const beforePolicy = structuredClone(ws.config.agents!.defaults);
      const { response, json } = await request(app, "/api/plugins/example/state", "PATCH", { enabled: false, confirm: true });
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.runtimeConfirmed).toBe(observed === false);
      expect(json.affectedProviderIds).toEqual(["plugin-a", "plugin-b"]);
      expect(JSON.stringify(json)).not.toContain("AUTH_SECRET_MARKER");
      const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
      expect(saved.plugins.entries.example).toEqual({ enabled: false });
      expect(saved.agents.defaults).toEqual(beforePolicy);
      expect(backups(ws.paths).length).toBe(1);
    });
  }

  test("a partial plugin catalog is not authorization to mutate a descriptor", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths, { pluginCatalogProvider: () => ({ ...plugins(true), diagnostics: ["plugin catalog incomplete"] }) }));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response } = await request(app, "/api/plugins/example/state", "PATCH", { enabled: false, confirm: true });
    expect(response.status).toBe(400);
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });

  test("malformed JSON does not echo parser source or auth text", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    for (const [method, path] of [["PATCH", "/api/models"], ["DELETE", "/api/model-policy/exact-ref"], ["POST", "/api/models/materialize"], ["PATCH", "/api/plugins/example/state"]]) {
      const response = await app.request(path!, { method: method!, headers: { Authorization: "Bearer fixture-token", "content-type": "application/json" }, body: '{"auth":"AUTH_SECRET_MARKER",invalid}' });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("AUTH_SECRET_MARKER");
    }
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });

  test("exact deletion rejects null removeMetadata instead of silently treating it as false", async () => {
    const ws = fixture();
    const app = createApp(appOptions(ws.paths));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response } = await request(app, "/api/model-policy/exact-ref", "DELETE", { ref: "ghost/gone", removeMetadata: null });
    expect(response.status).toBe(400);
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });
});

for (const action of ["enable", "use", "materialize", "exact", "plugin"] as const) {
  test(`HTTP ${action} keeps the transaction and probes on one selected config even if active paths change`, async () => {
    const ws = fixture();
    const other = fixture();
    const beforeOther = readFileSync(other.paths.openclawPath, "utf8");
    const probePaths: string[] = [];
    const runtime = createAppRuntime(appOptions(ws.paths, {
      pluginCatalogProvider(paths) {
        probePaths.push(paths.openclawPath);
        runtime.setActivePaths(other.paths);
        return { providers: [], diagnostics: [], plugins: [{ id: "example", origin: "bundled", enabled: true,
          providerIds: ["plugin-a"], nonModelCapabilities: [] }] };
      },
      runtimeModelCatalogProvider(paths) {
        probePaths.push(paths.openclawPath);
        return snapshot(paths.openclawPath === ws.paths.openclawPath);
      }
    }));
    const app = new Hono();
    registerModelRoutes(app, runtime);
    registerModelInventoryRoutes(app, runtime);
    registerPluginRoutes(app, runtime);
    const [url, method, body] = action === "use"
      ? ["/api/models/primary", "PUT", { ref: "cpa/local" }]
      : action === "enable" ? ["/api/models", "PATCH", { ref: "cpa/runtime-only", enabled: true }]
      : action === "materialize" ? ["/api/models/materialize", "POST", { ref: "cpa/runtime-only", input: { id: "runtime-only", enabled: false } }]
      : action === "exact" ? ["/api/model-policy/exact-ref", "DELETE", { ref: "ghost/gone" }]
      : ["/api/plugins/example/state", "PATCH", { enabled: false, confirm: true }];
    const response = await app.request(url as string, { method: method as string, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.ok).toBe(true);
    expect(probePaths.every(path => path === ws.paths.openclawPath)).toBe(true);
    expect(readFileSync(other.paths.openclawPath, "utf8")).toBe(beforeOther);
    expect(backups(other.paths)).toEqual([]);
    expect(backups(ws.paths).length).toBe(1);
    if (action === "exact") expect(json.inventory.policyRules.some((rule: { value: string }) => rule.value === "ghost/gone")).toBe(false);
  });
}

test("HTTP materialize returns a structured provider-config-required blocker", async () => {
  const ws = fixture();
  const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => {
    const result = snapshot();
    result.allModels.push({ ref: "new-provider/live", available: true, tags: [] });
    return result;
  } }));
  const before = readFileSync(ws.paths.openclawPath, "utf8");
  const { response, json } = await request(app, "/api/models/materialize", "POST", { ref: "new-provider/live", input: { id: "live", enabled: false } });
  expect(response.status).toBe(400);
  expect(json.code).toBe("provider-config-required");
  expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  expect(backups(ws.paths)).toEqual([]);
});

test("HTTP error mapping does not return raw parsing or unexpected type errors", async () => {
  const { jsonError } = await import("../src/errors");
  const responder = { json: (body: unknown, status: number) => Response.json(body, { status }) };
  for (const error of [new SyntaxError("AUTH_SECRET_MARKER in JSON source"), new TypeError("AUTH_SECRET_MARKER in an internal exception")]) {
    const response = jsonError(responder, error);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("AUTH_SECRET_MARKER");
  }
});

test("HTTP exact-ref deletion cannot empty restricted policy or clean metadata on failure", async () => {
  const ws = fixture();
  ws.config.agents!.defaults!.modelPolicy = { allow: ["ghost/gone"] };
  writeFileSync(ws.paths.openclawPath, JSON.stringify(ws.config));
  const before = readFileSync(ws.paths.openclawPath, "utf8");
  const app = createApp(appOptions(ws.paths));
  const { response } = await request(app, "/api/model-policy/exact-ref", "DELETE", { ref: "ghost/gone", removeMetadata: true });
  expect(response.status).toBe(400);
  expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  expect(backups(ws.paths)).toEqual([]);
});

for (const action of ["delete", "edit", "batch-remove", "keep-enabled-only"] as const) {
  test(`legacy HTTP ${action} cannot clean or edit unknown catalog entries`, async () => {
    const ws = fixture();
    ws.config.models!.providers!.cpa!.models!.push({ id: "orphan" });
    writeFileSync(ws.paths.openclawPath, JSON.stringify(ws.config));
    const runtime = snapshot(false);
    runtime.completeness.allList = false;
    const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => runtime }));
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const result = action === "delete" ? await request(app, "/api/models", "DELETE", { ref: "cpa/local", force: true })
      : action === "edit" ? await request(app, "/api/models", "PUT", { ref: "cpa/local", model: { id: "local", name: "Changed", enabled: true } })
      : await request(app, "/api/providers/cpa/models/batch-remove", "POST", action === "batch-remove" ? { modelIds: ["local"] } : { keepEnabledOnly: true });
    expect(result.response.status).toBe(400);
    expect(String(result.json.error)).toContain("unknown");
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
    expect(backups(ws.paths)).toEqual([]);
  });
}

test("DELETE model requires a real force boolean and cannot coerce 'false' into forced primary deletion", async () => {
  const ws = fixture();
  const app = createApp(appOptions(ws.paths));
  const before = readFileSync(ws.paths.openclawPath, "utf8");
  const { response } = await request(app, "/api/models", "DELETE", { ref: "cpa/main", force: "false" });
  expect(response.status).toBe(400);
  expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  expect(backups(ws.paths)).toEqual([]);
});

test("unknown runtime does not lock Provider connection repair", async () => {
  const ws = fixture();
  const runtime = snapshot(false);
  runtime.completeness.allList = false;
  const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => runtime }));
  const { response } = await request(app, "/api/providers/cpa", "PUT", { baseUrl: "https://repaired.example/v1", api: "openai-completions" });
  expect(response.status).toBe(200);
  expect(JSON.parse(readFileSync(ws.paths.openclawPath, "utf8")).models.providers.cpa.baseUrl).toBe("https://repaired.example/v1");
});

for (const action of ["exact", "materialize", "plugin"] as const) {
  test(`HTTP ${action} reruns runtime/descriptor preflight when Core retries a changed config`, async () => {
    const ws = fixture();
    let calls = 0;
    const extra: Partial<AppOptions> = action === "plugin" ? {
      pluginCatalogProvider() {
        calls += 1;
        if (calls === 1) writeFileSync(ws.paths.openclawPath, JSON.stringify({ ...ws.config, channels: { external: true } }));
        return { providers: [], diagnostics: [], plugins: [{ id: "example", origin: "bundled", enabled: true,
          providerIds: [calls === 1 ? "other" : "cpa"], nonModelCapabilities: [] }] };
      }
    } : {
      runtimeModelCatalogProvider() {
        calls += 1;
        if (calls === 1) {
          const changed = structuredClone(ws.config);
          changed.agents!.defaults!.model = action === "exact" ? "ghost/gone" : "cpa/runtime-only";
          writeFileSync(ws.paths.openclawPath, JSON.stringify(changed));
        }
        return snapshot();
      }
    };
    const app = createApp(appOptions(ws.paths, extra));
    const result = action === "exact" ? await request(app, "/api/model-policy/exact-ref", "DELETE", { ref: "ghost/gone", removeMetadata: true })
      : action === "materialize" ? await request(app, "/api/models/materialize", "POST", { ref: "cpa/runtime-only", input: { id: "runtime-only", enabled: false } })
      : await request(app, "/api/plugins/example/state", "PATCH", { enabled: false, confirm: true });
    expect(result.response.status).toBe(400);
    expect(calls).toBe(2);
    const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(saved.models).toEqual(ws.config.models);
    expect(saved.agents.defaults.modelPolicy.allow).toEqual(ws.config.agents!.defaults!.modelPolicy!.allow);
    if (action === "plugin") {
      expect(saved.channels.external).toBe(true);
      expect(saved.plugins).toBeUndefined();
    } else expect(saved.agents.defaults.model).toBe(action === "exact" ? "ghost/gone" : "cpa/runtime-only");
    expect(backups(ws.paths)).toEqual([]);
  });
}

test("HTTP batch cleanup only gates removed models, leaving unrelated unknown rows untouched", async () => {
  const ws = fixture();
  const runtime = snapshot(false);
  runtime.completeness.allList = false;
  runtime.configuredModels.find(model => model.ref === "cpa/local")!.available = true;
  const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => runtime }));
  const { response } = await request(app, "/api/providers/cpa/models/batch-remove", "POST", { modelIds: ["local"] });
  expect(response.status).toBe(200);
  const saved = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
  expect(saved.models.providers.cpa.models.map((model: { id: string }) => model.id)).toEqual(["main", "fallback"]);
});

test("HTTP explicit catalog deletion remains available for confirmed unavailable models", async () => {
  const ws = fixture();
  const app = createApp(appOptions(ws.paths, { runtimeModelCatalogProvider: () => snapshot(false) }));
  const { response } = await request(app, "/api/models", "DELETE", { ref: "cpa/local" });
  expect(response.status).toBe(200);
  expect(JSON.parse(readFileSync(ws.paths.openclawPath, "utf8")).models.providers.cpa.models.map((model: { id: string }) => model.id)).not.toContain("local");
});
