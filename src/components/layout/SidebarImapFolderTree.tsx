import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { t } from "@/i18n";
import { getAccount } from "@/services/db/accounts";
import { buildImapConfig } from "@/services/imap/imapConfigBuilder";
import { imapListFolders, type ImapFolder } from "@/services/imap/tauriCommands";
import { useActiveLabel } from "@/hooks/useRouteNavigation";

// Mirrors the filter in ImapFolderEditor — only show non-system custom folders
const HIDDEN_FOLDER_NAMES = new Set([
  "inbox",
  "archive",
  "drafts",
  "later",
  "sent",
  "spam",
  "junk",
  "templates",
  "trash",
  "blocked",
  "unsent messages",
  "working set",
]);

function isSystemFolder(f: ImapFolder): boolean {
  return f.special_use !== null || HIDDEN_FOLDER_NAMES.has(f.name.toLowerCase());
}

interface Props {
  accountId: string;
  activeAccountId: string | null;
  onFolderClick: (accountId: string, folderId: string) => void;
  // Load is deferred until this turns true (first time user expands the section)
  shouldLoad: boolean;
}

export function SidebarImapFolderTree({
  accountId,
  activeAccountId,
  onFolderClick,
  shouldLoad,
}: Props) {
  const [folders, setFolders] = useState<ImapFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const loadedRef = useRef(false);
  const activeLabel = useActiveLabel();

  const doLoad = useCallback(async () => {
    if (loadedRef.current || loading) return;
    setLoading(true);
    setError(null);
    try {
      const dbAccount = await getAccount(accountId);
      if (!dbAccount) throw new Error("Account not found");
      const config = buildImapConfig(dbAccount);
      const list = await imapListFolders(config);
      setFolders(list);
      loadedRef.current = true;
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [accountId, loading]);

  useEffect(() => {
    if (shouldLoad && !loadedRef.current) {
      doLoad();
    }
  }, [shouldLoad, doLoad]);

  const systemPaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of folders) if (isSystemFolder(f)) set.add(f.path);
    return set;
  }, [folders]);

  const rootFolders = useMemo(
    () =>
      folders
        .filter(
          (f) =>
            !isSystemFolder(f) &&
            (f.parent_path === null || systemPaths.has(f.parent_path)),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders, systemPaths],
  );

  const childrenOf = useCallback(
    (path: string) =>
      folders
        .filter((f) => f.parent_path === path && !isSystemFolder(f))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders],
  );

  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  function renderNode(folder: ImapFolder, depth: number): React.ReactNode {
    const isExpanded = expandedPaths.has(folder.path);
    const children = childrenOf(folder.path);
    const hasChildren = folder.has_children || children.length > 0;
    const labelId = `folder-${folder.path}`;
    const isActive = activeLabel === labelId && activeAccountId === accountId;

    return (
      <div key={folder.path}>
        <button
          onClick={() => onFolderClick(accountId, labelId)}
          className={`flex items-center gap-1.5 w-full py-1.5 pr-3 text-left text-[0.8125rem] transition-colors ${
            isActive
              ? "text-accent font-medium bg-accent/10"
              : "text-sidebar-text/80 hover:text-sidebar-text hover:bg-sidebar-hover"
          }`}
          style={{ paddingLeft: `${28 + depth * 12}px` }}
        >
          <span
            className="w-3 h-3 flex items-center justify-center shrink-0 text-sidebar-text/40"
            onClick={
              hasChildren
                ? (e) => {
                    e.stopPropagation();
                    toggleExpand(folder.path);
                  }
                : undefined
            }
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />
            ) : null}
          </span>
          {isExpanded && hasChildren ? (
            <FolderOpen size={13} className="shrink-0 text-sidebar-text/50" />
          ) : (
            <Folder size={13} className="shrink-0 text-sidebar-text/50" />
          )}
          <span className="flex-1 truncate">{folder.name}</span>
        </button>
        {isExpanded && children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 pl-8 text-[0.75rem] text-sidebar-text/40">
        <Loader2 size={11} className="animate-spin shrink-0" />
        <span>{t("common.loading")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 py-2 pl-8 text-[0.75rem] text-red-400/80">
        <AlertCircle size={11} className="shrink-0" />
        <button
          onClick={() => {
            loadedRef.current = false;
            doLoad();
          }}
          className="underline"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (rootFolders.length === 0) return null;

  return <div>{rootFolders.map((f) => renderNode(f, 0))}</div>;
}
