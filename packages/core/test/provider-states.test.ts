import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProviderStates,
  removeDisabledProviderState,
  upsertDisabledProviderState
} from "../src/provider-states";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "oc-switch-provider-states-"));
}

describe("provider-states", () => {
  test("returns an empty versioned state when the file does not exist", () => {
    const stateDir = tempStateDir();
    try {
      expect(readProviderStates(stateDir)).toEqual({
        version: 1,
        disabledProviders: {}
      });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("upserts, overwrites, and removes a disabled provider snapshot", () => {
    const stateDir = tempStateDir();
    try {
      upsertDisabledProviderState(stateDir, {
        providerId: "nvidia",
        openclawPath: "/tmp/openclaw.json",
        disabledAt: "2026-06-25T12:00:00.000Z",
        allowlistEntries: {
          "nvidia/model-a": { alias: "a" }
        }
      });
      upsertDisabledProviderState(stateDir, {
        providerId: "nvidia",
        openclawPath: "/tmp/openclaw.json",
        disabledAt: "2026-06-25T12:05:00.000Z",
        allowlistEntries: {
          "nvidia/model-b": { alias: "b", agentRuntime: { id: "codex" } }
        }
      });

      const states = readProviderStates(stateDir);
      expect(Object.keys(states.disabledProviders)).toEqual(["nvidia"]);
      expect(states.disabledProviders.nvidia).toMatchObject({
        providerId: "nvidia",
        disabledAt: "2026-06-25T12:05:00.000Z",
        allowlistEntries: {
          "nvidia/model-b": { alias: "b", agentRuntime: { id: "codex" } }
        }
      });

      const path = join(stateDir, "provider-states.json");
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);

      removeDisabledProviderState(stateDir, "nvidia");
      expect(readProviderStates(stateDir).disabledProviders.nvidia).toBeUndefined();
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
