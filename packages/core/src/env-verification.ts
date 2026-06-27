const START = "# oc-switch:start";
const END = "# oc-switch:end";

export interface EnvWriteVerificationEntry {
  envVar: string;
  verified: boolean;
  managed: boolean;
  maskedValue?: string | undefined;
  reason?: "missing-managed-value" | "value-mismatch" | undefined;
}

export interface EnvWriteVerification {
  verified: boolean;
  entries: EnvWriteVerificationEntry[];
}

/** 仅展示本次写入值的短指纹，避免短值泄露比例过高 */
export function maskSecretValue(value: string): string | undefined {
  if (value.length < 16) return undefined;
  return `${value.slice(0, 6)}********${value.slice(-6)}`;
}

function readManagedRawValue(content: string, envVar: string): { found: boolean; value?: string } {
  const lines = content.length ? content.split(/\n/) : [];
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  if (startIndex < 0 || endIndex <= startIndex) return { found: false };

  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match?.[1] === envVar) return { found: true, value: match[2] ?? "" };
  }
  return { found: false };
}

/** 写后校验只比较托管块内的最终值，不返回磁盘明文 */
export function verifyEnvWrite(content: string, updates: Record<string, string>): EnvWriteVerification {
  const entries = Object.entries(updates).map(([envVar, expectedValue]): EnvWriteVerificationEntry => {
    const current = readManagedRawValue(content, envVar);
    if (!current.found) {
      return {
        envVar,
        verified: false,
        managed: false,
        reason: "missing-managed-value"
      };
    }
    if (current.value !== expectedValue) {
      return {
        envVar,
        verified: false,
        managed: true,
        reason: "value-mismatch"
      };
    }
    const masked = maskSecretValue(expectedValue);
    return {
      envVar,
      verified: true,
      managed: true,
      ...(masked ? { maskedValue: masked } : {})
    };
  });

  return {
    verified: entries.every((entry) => entry.verified),
    entries
  };
}
