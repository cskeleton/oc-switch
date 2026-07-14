import { describe, expect, test } from "bun:test";
import { parseLaunchAgentGatewayMetadata } from "../src/gateway-launchd-metadata";

const wrapperPath = "/Users/gc/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh";
const serviceEnvPath = "/Users/gc/.openclaw/service-env/ai.openclaw.gateway.env";
const currentArgs = [
  "/bin/sh",
  wrapperPath,
  serviceEnvPath,
  "/opt/homebrew/opt/node/bin/node",
  "/opt/homebrew/lib/node_modules/openclaw/dist/index.js",
  "gateway",
  "--port",
  "18789"
];

function plistWithArgumentArrays(...argumentArrays: string[][]): string {
  const arrays = argumentArrays.map((argumentsList) => [
    "<key>ProgramArguments</key>",
    "<array>",
    ...argumentsList.map((argument) => `<string>${argument}</string>`),
    "</array>"
  ].join("\n"));
  return `<plist><dict>${arrays.join("\n")}</dict></plist>`;
}

type ExpectedParseReason =
  | "missing-program-arguments"
  | "ambiguous-program-arguments"
  | "invalid-xml"
  | "insufficient-arguments"
  | "invalid-wrapper-path"
  | "invalid-service-env-path"
  | "path-layout-mismatch"
  | "invalid-gateway-command";

function expectParseReason(plistContent: string, reason: ExpectedParseReason): void {
  let caught: unknown;
  try {
    parseLaunchAgentGatewayMetadata(plistContent);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe("LaunchAgentMetadataParseError");
  expect((caught as Error & { reason?: string }).reason).toBe(reason);
}

describe("parseLaunchAgentGatewayMetadata", () => {
  test("缺少 ProgramArguments 时返回稳定 reason", () => {
    expectParseReason("<plist><dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>",
      "missing-program-arguments");
  });

  test("解析当前 /bin/sh wrapper 布局", () => {
    expect(parseLaunchAgentGatewayMetadata(plistWithArgumentArrays(currentArgs))).toEqual({
      wrapperPath,
      serviceEnvPath,
      gatewayCommand: currentArgs.slice(3)
    });
  });

  test("解析旧 wrapper 布局", () => {
    const legacyArgs = currentArgs.slice(1);
    expect(parseLaunchAgentGatewayMetadata(plistWithArgumentArrays(legacyArgs))).toEqual({
      wrapperPath,
      serviceEnvPath,
      gatewayCommand: legacyArgs.slice(2)
    });
  });

  test("解码 plist XML entities", () => {
    const args = [
      "/bin/sh",
      "/Users/gc/A&amp;B/service-env/ai.openclaw.gateway-env-wrapper.sh",
      "/Users/gc/A&amp;B/service-env/ai.openclaw.gateway.env",
      "/opt/node",
      "/opt/openclaw/dist/index.js",
      "gateway",
      "--label",
      "&quot;primary&apos;s&lt;preview&gt;&quot;"
    ];

    expect(parseLaunchAgentGatewayMetadata(plistWithArgumentArrays(args))).toEqual({
      wrapperPath: "/Users/gc/A&B/service-env/ai.openclaw.gateway-env-wrapper.sh",
      serviceEnvPath: "/Users/gc/A&B/service-env/ai.openclaw.gateway.env",
      gatewayCommand: [
        "/opt/node",
        "/opt/openclaw/dist/index.js",
        "gateway",
        "--label",
        "\"primary's<preview>\""
      ]
    });
  });

  test("拒绝参数不足", () => {
    expectParseReason(plistWithArgumentArrays([
      "/bin/sh",
      wrapperPath,
      serviceEnvPath
    ]), "insufficient-arguments");
  });

  test("拒绝 wrapper 不在 service-env 目录", () => {
    const args = [...currentArgs];
    args[1] = "/Users/gc/.openclaw/bin/ai.openclaw.gateway-env-wrapper.sh";
    expectParseReason(plistWithArgumentArrays(args), "invalid-wrapper-path");
  });

  test("拒绝 wrapper 后缀错误", () => {
    const args = [...currentArgs];
    args[1] = "/Users/gc/.openclaw/service-env/ai.openclaw.gateway-wrapper.sh";
    expectParseReason(plistWithArgumentArrays(args), "invalid-wrapper-path");
  });

  test("拒绝 env 与 wrapper 目录不一致", () => {
    const args = [...currentArgs];
    args[2] = "/Users/gc/other/service-env/ai.openclaw.gateway.env";
    expectParseReason(plistWithArgumentArrays(args), "path-layout-mismatch");
  });

  test("拒绝 env 后缀错误", () => {
    const args = [...currentArgs];
    args[2] = "/Users/gc/.openclaw/service-env/ai.openclaw.gateway.txt";
    expectParseReason(plistWithArgumentArrays(args), "invalid-service-env-path");
  });

  test("拒绝非 OpenClaw gateway command", () => {
    const withoutGateway = currentArgs.map((argument) => argument === "gateway" ? "status" : argument);
    expectParseReason(plistWithArgumentArrays(withoutGateway), "invalid-gateway-command");

    const wrongEntry = currentArgs.map((argument) =>
      argument.endsWith("/openclaw/dist/index.js") ? "/opt/other/dist/index.js" : argument
    );
    expectParseReason(plistWithArgumentArrays(wrongEntry), "invalid-gateway-command");
  });

  test("拒绝 gateway 仅作为后续参数出现", () => {
    const args = currentArgs.map((argument) => argument === "gateway" ? "status" : argument);
    args.push("gateway");
    expectParseReason(plistWithArgumentArrays(args), "invalid-gateway-command");
  });

  test("拒绝同一 plist 中不明确的 ProgramArguments 数组", () => {
    expectParseReason(
      plistWithArgumentArrays(currentArgs, currentArgs.slice(1)),
      "ambiguous-program-arguments"
    );
  });

  test("只接受 plist 顶层 dict 的直接 ProgramArguments", () => {
    const argumentArray = plistWithArgumentArrays(currentArgs)
      .replace(/^<plist><dict><key>ProgramArguments<\/key>|<\/dict><\/plist>$/g, "");
    const nestedOnly = [
      "<plist><dict>",
      "<key>EnvironmentVariables</key><dict>",
      "<key>ProgramArguments</key>",
      argumentArray,
      "</dict>",
      "</dict></plist>"
    ].join("");
    expectParseReason(nestedOnly, "missing-program-arguments");

    const topLevelAndNested = plistWithArgumentArrays(currentArgs).replace(
      "</dict></plist>",
      `<key>EnvironmentVariables</key><dict><key>ProgramArguments</key>${argumentArray}</dict></dict></plist>`
    );
    expect(parseLaunchAgentGatewayMetadata(topLevelAndNested).serviceEnvPath).toBe(serviceEnvPath);
  });

  test("忽略注释、处理指令与 DOCTYPE 中的伪节点", () => {
    const plist = [
      "<?xml version=\"1.0\"?>",
      "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
      "<plist><dict>",
      "<!-- <key>ProgramArguments</key><array><string>fake</string></array> -->",
      plistWithArgumentArrays(currentArgs).replace(/^<plist><dict>|<\/dict><\/plist>$/g, ""),
      "</dict></plist>"
    ].join("\n");
    expect(parseLaunchAgentGatewayMetadata(plist).serviceEnvPath).toBe(serviceEnvPath);
  });

  test("解码十进制与十六进制数字实体", () => {
    const plist = plistWithArgumentArrays([
      "/bin/sh",
      "/Users/gc/&#46;openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh",
      "/Users/gc/&#x2E;openclaw/service-env/ai.openclaw.gateway.env",
      "/opt/node",
      "/opt/openclaw/dist/index.js",
      "gateway"
    ]);
    expect(parseLaunchAgentGatewayMetadata(plist)).toMatchObject({ wrapperPath, serviceEnvPath });
  });

  test("拒绝 XML 1.0 禁止的原始控制字符", () => {
    for (const controlCharacter of ["\u0000", "\u0001"]) {
      expectParseReason(
        plistWithArgumentArrays([...currentArgs, `--label=${controlCharacter}`]),
        "invalid-xml"
      );
    }
  });

  test("允许 XML 1.0 的 TAB、LF 与 CR", () => {
    const plist = plistWithArgumentArrays(currentArgs).replace(
      "<key>ProgramArguments</key>",
      "\t<key>ProgramArguments</key>\r\n"
    );
    expect(parseLaunchAgentGatewayMetadata(plist).wrapperPath).toBe(wrapperPath);
  });

  test("拒绝 XML 1.0 范围外的数字实体", () => {
    for (const entity of ["&#0;", "&#xD800;", "&#x110000;", "&#1114112;"]) {
      const plist = plistWithArgumentArrays([...currentArgs, `--label=${entity}`]);
      expectParseReason(plist, "invalid-xml");
    }
  });

  test("拒绝未知或格式错误 XML entity", () => {
    const unknown = plistWithArgumentArrays(currentArgs.map((value) =>
      value === wrapperPath ? value.replace(".openclaw", "&unknown;openclaw") : value
    ));
    expectParseReason(unknown, "invalid-xml");

    const malformed = plistWithArgumentArrays(currentArgs.map((value) =>
      value === wrapperPath ? value.replace(".openclaw", "&#xZZ;openclaw") : value
    ));
    expectParseReason(malformed, "invalid-xml");
  });

  test("拒绝不完整或嵌套异常的 XML 结构", () => {
    expectParseReason(
      plistWithArgumentArrays(currentArgs).replace("</string>", ""),
      "invalid-xml"
    );
    expectParseReason(
      plistWithArgumentArrays(currentArgs).replace(
        `<string>${wrapperPath}</string>`,
        `<string><string>${wrapperPath}</string></string>`
      ),
      "invalid-xml"
    );
  });

  test("要求 ProgramArguments 后紧邻完整 array", () => {
    const plist = plistWithArgumentArrays(currentArgs).replace(
      "<key>ProgramArguments</key>",
      "<key>ProgramArguments</key><key>Other</key>"
    );
    expectParseReason(plist, "invalid-xml");
  });

  test("拒绝 Gateway command 前置额外 token", () => {
    const args = [...currentArgs];
    args.splice(3, 0, "--inspect");
    expectParseReason(plistWithArgumentArrays(args), "invalid-gateway-command");
  });

  test("拒绝非 node 可执行文件", () => {
    const args = [...currentArgs];
    args[3] = "/bin/sh";
    expectParseReason(plistWithArgumentArrays(args), "invalid-gateway-command");
  });

  test("拒绝相对路径与未规范化路径", () => {
    const relative = [...currentArgs];
    relative[1] = "service-env/ai.openclaw.gateway-env-wrapper.sh";
    relative[2] = "service-env/ai.openclaw.gateway.env";
    expectParseReason(plistWithArgumentArrays(relative), "invalid-wrapper-path");

    const traversed = [...currentArgs];
    traversed[1] = "/Users/gc/.openclaw/tmp/../service-env/ai.openclaw.gateway-env-wrapper.sh";
    expectParseReason(plistWithArgumentArrays(traversed), "invalid-wrapper-path");
  });

  test("拒绝空 string 路径参数", () => {
    const args = [...currentArgs];
    args[1] = "";
    expectParseReason(plistWithArgumentArrays(args), "invalid-wrapper-path");
  });
});
