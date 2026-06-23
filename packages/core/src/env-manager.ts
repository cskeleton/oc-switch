const START = "# oc-switch:start";
const END = "# oc-switch:end";

export interface EnvUpdateResult {
  content: string;
  changedKeys: string[];
}

export function updateManagedEnv(content: string, updates: Record<string, string>): EnvUpdateResult {
  const lines = content.length ? content.split(/\n/) : [];
  if (lines.at(-1) === "") lines.pop();

  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const unmanaged = new Set<string>();

  lines.forEach((line, index) => {
    const insideBlock = hasBlock && index > startIndex && index < endIndex;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match?.[1] && !insideBlock) unmanaged.add(match[1]);
  });

  for (const key of Object.keys(updates)) {
    if (unmanaged.has(key)) {
      throw new Error(`Refusing to overwrite unmanaged env var ${key}`);
    }
  }

  const blockValues = new Map<string, string>();
  if (hasBlock) {
    for (const line of lines.slice(startIndex + 1, endIndex)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match?.[1]) blockValues.set(match[1], match[2] ?? "");
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    blockValues.set(key, value);
  }

  const block = [
    START,
    ...Array.from(blockValues.entries()).map(([key, value]) => `${key}=${value}`),
    END
  ];

  const nextLines = hasBlock
    ? [...lines.slice(0, startIndex), ...block, ...lines.slice(endIndex + 1)]
    : [...lines, ...block];

  return {
    content: `${nextLines.join("\n")}\n`,
    changedKeys: Object.keys(updates)
  };
}
