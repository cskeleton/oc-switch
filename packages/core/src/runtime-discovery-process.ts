import type { GatewayProcess } from "./runtime-discovery-types";

/** 严格校验 OpenClaw Gateway 的 argv token 结构 */
export function isStrictOpenClawGatewayProcess(process: GatewayProcess): boolean {
  const [runtime, entrypoint, command] = process.argv;
  return (
    /(^|\/)node(js)?$/.test(runtime ?? "") &&
    /\/openclaw\/dist\/index\.js$/.test(entrypoint ?? "") &&
    command === "gateway"
  );
}
