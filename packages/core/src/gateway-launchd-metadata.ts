import { basename, dirname, isAbsolute, normalize } from "node:path";

export interface LaunchAgentGatewayMetadata {
  wrapperPath: string;
  serviceEnvPath: string;
  gatewayCommand: string[];
}

export type LaunchAgentMetadataParseErrorReason =
  | "missing-program-arguments"
  | "ambiguous-program-arguments"
  | "invalid-xml"
  | "insufficient-arguments"
  | "invalid-wrapper-path"
  | "invalid-service-env-path"
  | "path-layout-mismatch"
  | "invalid-gateway-command";

export class LaunchAgentMetadataParseError extends Error {
  readonly reason: LaunchAgentMetadataParseErrorReason;

  constructor(reason: LaunchAgentMetadataParseErrorReason, message: string) {
    super(message);
    this.name = "LaunchAgentMetadataParseError";
    this.reason = reason;
  }
}

interface XmlElement {
  name: string;
  children: Array<XmlElement | string>;
}

function invalidXml(message: string): never {
  throw new LaunchAgentMetadataParseError("invalid-xml", message);
}

function isXml10CodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function assertValidXml10Characters(content: string): void {
  for (const character of content) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isXml10CodePoint(codePoint)) {
      invalidXml("LaunchAgent plist contains a character forbidden by XML 1.0");
    }
  }
}

function stripIgnoredXmlMarkup(content: string): string {
  let result = "";
  let index = 0;
  while (index < content.length) {
    if (content.startsWith("<!--", index)) {
      const end = content.indexOf("-->", index + 4);
      if (end < 0) invalidXml("LaunchAgent plist contains an unclosed XML comment");
      index = end + 3;
      continue;
    }
    if (content.startsWith("<?", index)) {
      const end = content.indexOf("?>", index + 2);
      if (end < 0) invalidXml("LaunchAgent plist contains an unclosed processing instruction");
      index = end + 2;
      continue;
    }
    if (/^<!DOCTYPE\b/i.test(content.slice(index))) {
      let cursor = index + 9;
      let quote: "'" | "\"" | null = null;
      let subsetDepth = 0;
      for (; cursor < content.length; cursor += 1) {
        const character = content[cursor];
        if (quote) {
          if (character === quote) quote = null;
          continue;
        }
        if (character === "'" || character === "\"") {
          quote = character;
        } else if (character === "[") {
          subsetDepth += 1;
        } else if (character === "]") {
          if (subsetDepth === 0) invalidXml("LaunchAgent plist contains an invalid DOCTYPE");
          subsetDepth -= 1;
        } else if (character === ">" && subsetDepth === 0) {
          break;
        }
      }
      if (cursor >= content.length || quote || subsetDepth !== 0) {
        invalidXml("LaunchAgent plist contains an unclosed DOCTYPE");
      }
      index = cursor + 1;
      continue;
    }
    if (content.startsWith("<!", index)) {
      invalidXml("LaunchAgent plist contains unsupported XML declaration markup");
    }
    result += content[index];
    index += 1;
  }
  return result;
}

function decodeXmlEntities(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "&") {
      result += character;
      continue;
    }
    const semicolonIndex = value.indexOf(";", index + 1);
    if (semicolonIndex < 0) invalidXml("LaunchAgent plist contains an unterminated XML entity");
    const entity = value.slice(index + 1, semicolonIndex);
    const namedEntities: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'"
    };
    if (namedEntities[entity] !== undefined) {
      result += namedEntities[entity];
    } else {
      const decimalMatch = entity.match(/^#([0-9]+)$/);
      const hexadecimalMatch = entity.match(/^#x([0-9A-Fa-f]+)$/);
      const codePoint = decimalMatch?.[1]
        ? Number.parseInt(decimalMatch[1], 10)
        : hexadecimalMatch?.[1]
          ? Number.parseInt(hexadecimalMatch[1], 16)
          : Number.NaN;
      if (
        !Number.isInteger(codePoint) ||
        !isXml10CodePoint(codePoint)
      ) {
        invalidXml("LaunchAgent plist contains an unsupported XML entity");
      }
      result += String.fromCodePoint(codePoint);
    }
    index = semicolonIndex;
  }
  return result;
}

function findTagEnd(content: string, startIndex: number): number {
  let quote: "'" | "\"" | null = null;
  for (let index = startIndex + 1; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function hasValidAttributes(attributes: string): boolean {
  let remaining = attributes;
  while (remaining.length > 0) {
    const match = remaining.match(
      /^\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"]*"|'[^']*')/
    );
    if (!match?.[0]) return remaining.trim().length === 0;
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

function parseXmlSubset(plistContent: string): XmlElement {
  assertValidXml10Characters(plistContent);
  const content = stripIgnoredXmlMarkup(plistContent);
  const documentRoot: XmlElement = { name: "#document", children: [] };
  const stack = [documentRoot];
  let index = 0;

  while (index < content.length) {
    const current = stack.at(-1);
    if (!current) invalidXml("LaunchAgent plist XML stack is invalid");
    if (content[index] !== "<") {
      const nextTag = content.indexOf("<", index);
      const end = nextTag < 0 ? content.length : nextTag;
      current.children.push(decodeXmlEntities(content.slice(index, end)));
      index = end;
      continue;
    }

    const tagEnd = findTagEnd(content, index);
    if (tagEnd < 0) invalidXml("LaunchAgent plist contains an unclosed XML tag");
    const tag = content.slice(index + 1, tagEnd);
    const closingMatch = tag.match(/^\/\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*$/);
    if (closingMatch?.[1]) {
      if (stack.length === 1 || stack.at(-1)?.name !== closingMatch[1]) {
        invalidXml("LaunchAgent plist contains mismatched XML tags");
      }
      stack.pop();
      index = tagEnd + 1;
      continue;
    }

    const selfClosing = /\/\s*$/.test(tag);
    const openingTag = selfClosing ? tag.replace(/\/\s*$/, "") : tag;
    const openingMatch = openingTag.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/);
    if (!openingMatch?.[1] || !hasValidAttributes(openingMatch[2] ?? "")) {
      invalidXml("LaunchAgent plist contains an invalid XML opening tag");
    }
    const element: XmlElement = { name: openingMatch[1], children: [] };
    current.children.push(element);
    if (!selfClosing) stack.push(element);
    index = tagEnd + 1;
  }

  if (stack.length !== 1) invalidXml("LaunchAgent plist contains unclosed XML elements");
  const roots = documentRoot.children.filter(
    (child): child is XmlElement => typeof child !== "string"
  );
  const nonWhitespaceText = documentRoot.children.some(
    (child) => typeof child === "string" && child.trim().length > 0
  );
  if (roots.length !== 1 || nonWhitespaceText) {
    invalidXml("LaunchAgent plist must contain exactly one root element");
  }
  return roots[0]!;
}

function elementText(element: XmlElement): string {
  if (element.children.some((child) => typeof child !== "string")) {
    invalidXml(`LaunchAgent plist ${element.name} element contains nested XML`);
  }
  return element.children.join("");
}

function resolvePlistTopLevelDict(root: XmlElement): XmlElement {
  if (root.name !== "plist") {
    invalidXml("LaunchAgent plist root element must be plist");
  }
  const elements: XmlElement[] = [];
  for (const child of root.children) {
    if (typeof child === "string") {
      if (child.trim().length > 0) invalidXml("LaunchAgent plist root contains raw text");
      continue;
    }
    elements.push(child);
  }
  if (elements.length !== 1 || elements[0]?.name !== "dict") {
    invalidXml("LaunchAgent plist must contain one top-level dict");
  }
  return elements[0];
}

function collectDirectProgramArgumentArrays(dict: XmlElement): XmlElement[] {
  const matches: XmlElement[] = [];
  for (let index = 0; index < dict.children.length; index += 1) {
    const child = dict.children[index];
    if (child === undefined || typeof child === "string") continue;
    if (child.name === "key" && elementText(child).trim() === "ProgramArguments") {
      let siblingIndex = index + 1;
      while (
        typeof dict.children[siblingIndex] === "string" &&
        (dict.children[siblingIndex] as string).trim().length === 0
      ) {
        siblingIndex += 1;
      }
      const array = dict.children[siblingIndex];
      if (typeof array === "string" || array?.name !== "array") {
        invalidXml("LaunchAgent ProgramArguments key must be followed by an array");
      }
      matches.push(array);
    }
  }
  return matches;
}

function parseProgramArguments(plistContent: string): string[] {
  const root = parseXmlSubset(plistContent);
  const arrays = collectDirectProgramArgumentArrays(resolvePlistTopLevelDict(root));
  if (arrays.length === 0) {
    throw new LaunchAgentMetadataParseError(
      "missing-program-arguments",
      "LaunchAgent plist is missing ProgramArguments"
    );
  }
  if (arrays.length !== 1) {
    throw new LaunchAgentMetadataParseError(
      "ambiguous-program-arguments",
      "LaunchAgent plist contains ambiguous ProgramArguments"
    );
  }
  const argumentsList: string[] = [];
  for (const child of arrays[0]!.children) {
    if (typeof child === "string") {
      if (child.trim().length > 0) invalidXml("LaunchAgent ProgramArguments contains raw text");
      continue;
    }
    if (child.name !== "string") {
      invalidXml("LaunchAgent ProgramArguments may only contain string elements");
    }
    argumentsList.push(elementText(child));
  }
  return argumentsList;
}

function isCanonicalAbsolutePath(value: string): boolean {
  return value.length > 0 && isAbsolute(value) && normalize(value) === value;
}

function isOpenClawGatewayCommand(command: string[]): boolean {
  const executableName = basename(command[0] ?? "");
  return (
    (executableName === "node" || executableName === "nodejs") &&
    /\/openclaw\/dist\/index\.js$/.test(command[1] ?? "") &&
    command[2] === "gateway"
  );
}

/** 解析并校验 LaunchAgent 中 OpenClaw Gateway 的启动元数据 */
export function parseLaunchAgentGatewayMetadata(plistContent: string): LaunchAgentGatewayMetadata {
  const programArguments = parseProgramArguments(plistContent);
  const wrapperIndex = programArguments[0] === "/bin/sh" ? 1 : 0;
  const wrapperPath = programArguments[wrapperIndex] ?? "";
  const serviceEnvPath = programArguments[wrapperIndex + 1] ?? "";
  const gatewayCommand = programArguments.slice(wrapperIndex + 2);

  if (programArguments.length < wrapperIndex + 5) {
    throw new LaunchAgentMetadataParseError(
      "insufficient-arguments",
      "LaunchAgent ProgramArguments has insufficient arguments"
    );
  }
  if (
    !isCanonicalAbsolutePath(wrapperPath) ||
    basename(dirname(wrapperPath)) !== "service-env" ||
    !basename(wrapperPath).endsWith("-env-wrapper.sh")
  ) {
    throw new LaunchAgentMetadataParseError(
      "invalid-wrapper-path",
      "LaunchAgent wrapper path is invalid"
    );
  }
  if (!isCanonicalAbsolutePath(serviceEnvPath) || !basename(serviceEnvPath).endsWith(".env")) {
    throw new LaunchAgentMetadataParseError(
      "invalid-service-env-path",
      "LaunchAgent service env path is invalid"
    );
  }
  if (dirname(serviceEnvPath) !== dirname(wrapperPath)) {
    throw new LaunchAgentMetadataParseError(
      "path-layout-mismatch",
      "LaunchAgent wrapper and service env directories do not match"
    );
  }
  if (!isOpenClawGatewayCommand(gatewayCommand)) {
    throw new LaunchAgentMetadataParseError(
      "invalid-gateway-command",
      "LaunchAgent command must invoke OpenClaw Gateway"
    );
  }

  return {
    wrapperPath,
    serviceEnvPath,
    gatewayCommand
  };
}
