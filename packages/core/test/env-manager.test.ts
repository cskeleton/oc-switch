import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateManagedEnv } from "../src/env-manager";

const fixture = readFileSync(join(import.meta.dir, "fixtures/env.sample"), "utf8");

describe("updateManagedEnv", () => {
  test("updates only oc-switch block", () => {
    const result = updateManagedEnv(fixture, { NVIDIA_API_KEY: "new-value", ELYSIVER_API_KEY: "created" });
    expect(result.content).toContain("USER_DEFINED_API_KEY=keep-me");
    expect(result.content).toContain("NVIDIA_API_KEY=new-value");
    expect(result.content).toContain("ELYSIVER_API_KEY=created");
    expect(result.content).toContain("OTHER_SETTING=keep-too");
    expect(result.changedKeys).toEqual(["NVIDIA_API_KEY", "ELYSIVER_API_KEY"]);
  });

  test("rejects unmanaged key collision by default", () => {
    expect(() => updateManagedEnv(fixture, { USER_DEFINED_API_KEY: "replace" })).toThrow(
      "Refusing to overwrite unmanaged env var USER_DEFINED_API_KEY"
    );
  });

  test("creates managed block when env file has no block", () => {
    const result = updateManagedEnv("PLAIN=value\n", { NEW_API_KEY: "secret" });
    expect(result.content).toBe("PLAIN=value\n# oc-switch:start\nNEW_API_KEY=secret\n# oc-switch:end\n");
  });
});
