import { homedir } from "node:os";
import { join } from "node:path";

export interface OcSwitchPaths {
  openclawPath: string;
  envPath: string;
  stateDir: string;
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): OcSwitchPaths {
  const openclawPath = env.OPENCLAW_CONFIG_PATH ?? join(homedir(), ".openclaw", "openclaw.json");
  return {
    openclawPath,
    envPath: join(homedir(), ".openclaw", ".env"),
    stateDir: join(homedir(), ".oc-switch")
  };
}
