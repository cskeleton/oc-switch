import { describe, expect, test } from "bun:test";
import { discoverRunningOpenClawInstances } from "../src/path-discovery";

describe("discoverRunningOpenClawInstances", () => {
  test("parses pgrep output into running instance paths", () => {
    const instances = discoverRunningOpenClawInstances({
      probe: () => [
        "12345 openclaw gateway --config /data/openclaw/openclaw.json",
        "99999 unrelated"
      ].join("\n")
    });

    expect(instances).toEqual([{
      pid: 12345,
      openclawPath: "/data/openclaw/openclaw.json",
      envPath: "/data/openclaw/.env"
    }]);
  });

  test("returns empty array when probe fails", () => {
    expect(discoverRunningOpenClawInstances({
      probe: () => { throw new Error("pgrep unavailable"); }
    })).toEqual([]);
  });
});
