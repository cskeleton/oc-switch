import { describe, expect, test } from "bun:test";
import { summarizeConfigDiff } from "../src/diff";
import type { OpenClawConfig } from "../src/types";

describe("summarizeConfigDiff", () => {
  test("summarizes provider, allowlist, and primary changes only", () => {
    const before: OpenClawConfig = {
      models: { providers: { old: { models: [{ id: "a" }] } } },
      agents: { defaults: { model: "old/a", models: { "old/a": { alias: "a" } } } }
    };
    const after: OpenClawConfig = {
      models: { providers: { old: { models: [{ id: "a" }] }, next: { models: [{ id: "b" }] } } },
      agents: { defaults: { model: "next/b", models: { "old/a": { alias: "a" }, "next/b": { alias: "b" } } } }
    };

    expect(summarizeConfigDiff(before, after)).toEqual({
      providersAdded: ["next"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["next/b"],
      modelsDisabled: [],
      primaryChanged: { before: "old/a", after: "next/b" }
    });
  });
});
