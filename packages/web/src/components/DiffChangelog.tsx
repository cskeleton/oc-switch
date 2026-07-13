import type { LucideIcon } from "lucide-react";
import { ArrowRightLeft, KeyRound, Minus, Plus, Power, PowerOff, Settings, Star } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ConfigDiffSummary, CredentialDiffItem } from "../api";

const DEFAULT_VISIBLE = 5;

export interface DiffChangelogEntry {
  id: string;
  title: ReactNode;
  subtitle?: string;
  icon: LucideIcon;
  iconClassName: string;
}

/** 将 ConfigDiffSummary 映射为语义化 Changelog 条目（P0 在前） */
export function buildDiffChangelogEntries(diff: ConfigDiffSummary): DiffChangelogEntry[] {
  const entries: DiffChangelogEntry[] = [];
  const mergedCredentialKeys = new Set<string>();
  const providerIdsWithStateChange = new Set(diff.providerStateChanges.map((item) => item.providerId));
  const providerIdsWithFieldChanges = new Set(diff.providerFieldChanges.map((item) => item.providerId));

  for (const providerId of diff.providersAdded) {
    const credential = diff.credentialsChanged.find(
      (item) => item.change === "added" && item.providerId === providerId
    );
    if (credential) mergedCredentialKeys.add(credential.envVar);

    entries.push({
      id: `provider-added:${providerId}`,
      icon: Plus,
      iconClassName: "text-primary",
      title: credential ? (
        <>
          新增了 Provider <strong>{providerId}</strong>，并配置了 API Key（<code>{credential.envVar}</code>）
        </>
      ) : (
        <>
          新增了 Provider <strong>{providerId}</strong>
        </>
      )
    });
  }

  for (const providerId of diff.providersRemoved) {
    entries.push({
      id: `provider-removed:${providerId}`,
      icon: Minus,
      iconClassName: "text-destructive",
      title: (
        <>
          移除了 Provider <strong>{providerId}</strong>
        </>
      ),
      subtitle: "最近备份中仍存在"
    });
  }

  for (const item of diff.credentialsChanged) {
    if (mergedCredentialKeys.has(item.envVar)) continue;
    entries.push(credentialEntry(item));
  }

  for (const item of diff.providerStateChanges) {
    if (item.change === "disable") {
      entries.push({
        id: `provider-state:disable:${item.providerId}`,
        icon: PowerOff,
        iconClassName: "text-destructive",
        title: (
          <>
            停用了 Provider <strong>{item.providerId}</strong>
          </>
        ),
        subtitle: "备份中为：已启用"
      });
      continue;
    }

    entries.push({
      id: `provider-state:enable:${item.providerId}`,
      icon: Power,
      iconClassName: "text-primary",
      title: (
        <>
          启用了 Provider <strong>{item.providerId}</strong>
        </>
      ),
      subtitle: "备份中为：已停用"
    });
  }

  for (const ref of diff.modelsEnabled) {
    if (providerIdsWithStateChange.has(providerFromRef(ref))) continue;
    entries.push({
      id: `model-enabled:${ref}`,
      icon: Plus,
      iconClassName: "text-primary",
      title: (
        <>
          启用了模型 <strong>{ref}</strong>
        </>
      )
    });
  }

  for (const ref of diff.modelsDisabled) {
    if (providerIdsWithStateChange.has(providerFromRef(ref))) continue;
    entries.push({
      id: `model-disabled:${ref}`,
      icon: Minus,
      iconClassName: "text-destructive",
      title: (
        <>
          禁用了模型 <strong>{ref}</strong>
        </>
      ),
      subtitle: "备份中包含此配置"
    });
  }

  for (const item of diff.providerFieldChanges) {
    entries.push({
      id: `provider-field:${item.providerId}:${item.parameterName}`,
      icon: Settings,
      iconClassName: "text-muted-foreground",
      title: (
        <>
          修改了 <strong>{item.providerId}</strong> 的 <code>{item.parameterName}</code>
        </>
      ),
      subtitle: `当前: ${item.newValue}（原值: ${item.oldValue}）`
    });
  }

  for (const providerId of diff.providersChanged) {
    if (providerIdsWithFieldChanges.has(providerId)) continue;
    entries.push({
      id: `provider-changed:${providerId}`,
      icon: Settings,
      iconClassName: "text-muted-foreground",
      title: (
        <>
          变更了 Provider <strong>{providerId}</strong>
        </>
      ),
      subtitle: "非密钥字段有变"
    });
  }

  if (diff.primaryChanged) {
    const { before, after } = diff.primaryChanged;
    entries.push({
      id: "primary-changed",
      icon: Star,
      iconClassName: "text-primary",
      title: (
        <>
          主模型：<strong>{before ?? "(无)"}</strong>
          <ArrowRightLeft className="mx-1 inline h-3.5 w-3.5 align-text-bottom" />
          <strong>{after ?? "(无)"}</strong>
        </>
      )
    });
  }

  return entries;
}

function providerFromRef(ref: string): string {
  const slashIndex = ref.indexOf("/");
  return slashIndex < 0 ? ref : ref.slice(0, slashIndex);
}

function credentialEntry(item: CredentialDiffItem): DiffChangelogEntry {
  const subject = item.providerId ? <strong>{item.providerId}</strong> : <code>{item.envVar}</code>;

  if (item.change === "changed") {
    return {
      id: `credential-changed:${item.envVar}`,
      icon: KeyRound,
      iconClassName: "text-foreground",
      title: item.providerId ? (
        <>
          更新了 {subject} 的 API Key（<code>{item.envVar}</code>）
        </>
      ) : (
        <>
          更新了 API Key（<code>{item.envVar}</code>）
        </>
      ),
      subtitle: "相对最近备份已变更（无明文）"
    };
  }

  if (item.change === "added") {
    return {
      id: `credential-added:${item.envVar}`,
      icon: KeyRound,
      iconClassName: "text-primary",
      title: item.providerId ? (
        <>
          为 {subject} 写入了 API Key（<code>{item.envVar}</code>）
        </>
      ) : (
        <>
          写入了 API Key（<code>{item.envVar}</code>）
        </>
      )
    };
  }

  return {
    id: `credential-removed:${item.envVar}`,
    icon: KeyRound,
    iconClassName: "text-muted-foreground",
    title: (
      <>
        <code>{item.envVar}</code> 已不在当前托管块
      </>
    ),
    subtitle: "最近备份中曾存在"
  };
}

export function countDiffChangelogEntries(diff: ConfigDiffSummary): number {
  return buildDiffChangelogEntries(diff).length;
}

interface DiffChangelogProps {
  diff: ConfigDiffSummary;
  maxVisible?: number;
}

/** 备份差异语义化列表（方案 B） */
export function DiffChangelog({ diff, maxVisible = DEFAULT_VISIBLE }: DiffChangelogProps) {
  const [expanded, setExpanded] = useState(false);
  const entries = buildDiffChangelogEntries(diff);
  if (entries.length === 0) return null;

  const visibleEntries = expanded ? entries : entries.slice(0, maxVisible);
  const hiddenCount = entries.length - maxVisible;

  return (
    <ul className="mt-3 space-y-2" data-testid="diff-changelog">
      {visibleEntries.map((entry) => {
        const Icon = entry.icon;
        return (
          <li key={entry.id} className="flex gap-2 text-sm">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${entry.iconClassName}`} aria-hidden="true" />
            <div className="min-w-0">
              <div className="break-all text-foreground">{entry.title}</div>
              {entry.subtitle ? (
                <div className="mt-0.5 text-xs text-muted-foreground">{entry.subtitle}</div>
              ) : null}
            </div>
          </li>
        );
      })}
      {!expanded && hiddenCount > 0 ? (
        <li>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {`展开其余 ${hiddenCount} 项差异…`}
          </button>
        </li>
      ) : null}
    </ul>
  );
}
