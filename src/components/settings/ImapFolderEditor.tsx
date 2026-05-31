import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Plus,
  Pencil,
  Trash2,
  Check,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/accountStore";
import { useClickOutside } from "@/hooks/useClickOutside";
import { getAccount } from "@/services/db/accounts";
import { buildImapConfig } from "@/services/imap/imapConfigBuilder";
import {
  imapListFolders,
  imapCreateFolder,
  imapRenameFolder,
  imapDeleteFolder,
  type ImapFolder,
  type ImapConfig,
} from "@/services/imap/tauriCommands";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

// --- helpers ---

// Folders always hidden from IMAP management — either flagged by the server
// via RFC 6154 special-use attributes, or matched by well-known name.
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

function isSystemFolder(folder: ImapFolder): boolean {
  return (
    folder.special_use !== null ||
    HIDDEN_FOLDER_NAMES.has(folder.name.toLowerCase())
  );
}

// --- FolderTreeNode ---

interface FolderTreeNodeProps {
  folder: ImapFolder;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  renameName: string;
  onToggleExpand: () => void;
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDeleteRequest: () => void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  children?: React.ReactNode;
  createInputNode?: React.ReactNode;
}

function FolderTreeNode({
  folder,
  depth,
  isExpanded,
  isSelected,
  isRenaming,
  renameName,
  onToggleExpand,
  onSelect,
  onRenameStart,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDeleteRequest,
  renameInputRef,
  children,
  createInputNode,
}: FolderTreeNodeProps) {
  const hasChildren = folder.has_children || !!children;
  const showChildren = isExpanded && (children || createInputNode);

  return (
    <div>
      <div
        className={`flex items-center gap-1 py-1 rounded-md cursor-pointer group transition-colors select-none ${
          isSelected
            ? "bg-accent/10 text-accent"
            : "hover:bg-bg-hover text-text-primary"
        }`}
        style={{ paddingLeft: `${8 + depth * 16}px`, paddingRight: "8px" }}
        onClick={onSelect}
      >
        {/* expand/collapse toggle */}
        <span
          className="w-4 h-4 flex items-center justify-center shrink-0 text-text-tertiary"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleExpand();
          }}
        >
          {hasChildren ? (
            isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : null}
        </span>

        {/* folder icon */}
        <span className="shrink-0 text-text-secondary">
          {isExpanded && hasChildren ? (
            <FolderOpen size={14} />
          ) : (
            <Folder size={14} />
          )}
        </span>

        {/* name or inline rename input */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameName}
            onChange={(e) => onRenameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameCommit();
              if (e.key === "Escape") onRenameCancel();
            }}
            onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 text-xs bg-bg-primary border border-accent rounded px-1 py-0.5 outline-none"
          />
        ) : (
          <span className="flex-1 min-w-0 text-xs truncate">{folder.name}</span>
        )}

        {/* message count */}
        {!isRenaming && folder.exists > 0 && (
          <span className="text-[0.6rem] text-text-tertiary shrink-0 tabular-nums ml-1">
            {folder.exists}
          </span>
        )}

        {/* hover actions */}
        {!isRenaming && (
          <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0 ml-1">
            <button
              title={t("common.edit")}
              onClick={(e) => {
                e.stopPropagation();
                onRenameStart();
              }}
              className="p-0.5 rounded hover:bg-bg-tertiary text-text-tertiary hover:text-text-primary transition-colors"
            >
              <Pencil size={11} />
            </button>
            <button
              title={t("common.delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteRequest();
              }}
              className="p-0.5 rounded hover:bg-bg-tertiary text-text-tertiary hover:text-red-400 transition-colors"
            >
              <Trash2 size={11} />
            </button>
          </span>
        )}
      </div>

      {showChildren && (
        <div>
          {children}
          {createInputNode}
        </div>
      )}
    </div>
  );
}

// --- ImapFolderEditor ---

export function ImapFolderEditor() {
  const accounts = useAccountStore((s) => s.accounts);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  // Only IMAP-based accounts (imap + icloud are both IMAP under the hood)
  const imapAccounts = useMemo(
    () =>
      accounts.filter(
        (a) => a.provider === "imap" || a.provider === "icloud",
      ),
    [accounts],
  );

  // account dropdown
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [openAccountDropdown, setOpenAccountDropdown] = useState(false);
  const accountDropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(accountDropdownRef, () => setOpenAccountDropdown(false));

  // folder data
  const [folders, setFolders] = useState<ImapFolder[]>([]);
  const [imapConfig, setImapConfig] = useState<ImapConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  // tree UI state
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // inline create: undefined = hidden, null = root level, string = parent path
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [createName, setCreateName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  // inline rename
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // delete confirm
  const [deleteTarget, setDeleteTarget] = useState<ImapFolder | null>(null);
  const [busy, setBusy] = useState(false);

  // --- init selected account ---
  useEffect(() => {
    if (selectedAccountId) return;
    const preferred =
      imapAccounts.find((a) => a.id === activeAccountId) ?? imapAccounts[0];
    if (preferred) setSelectedAccountId(preferred.id);
  }, [imapAccounts, activeAccountId, selectedAccountId]);

  const selectedAccount = useMemo(
    () => imapAccounts.find((a) => a.id === selectedAccountId),
    [imapAccounts, selectedAccountId],
  );

  const accountInitial =
    (selectedAccount?.displayName ?? selectedAccount?.email ?? "?")[0]?.toUpperCase() ?? "?";

  const handleAccountSelect = useCallback((id: string) => {
    setSelectedAccountId(id);
    setOpenAccountDropdown(false);
    setSelectedPath(null);
    setCreatingUnder(undefined);
    setRenamingPath(null);
    setOpError(null);
  }, []);

  // --- load folders ---
  const loadFolders = useCallback(async () => {
    if (!selectedAccountId) return;
    setLoading(true);
    setLoadError(null);
    setFolders([]);
    setSelectedPath(null);
    setCreatingUnder(undefined);
    setRenamingPath(null);
    setOpError(null);
    try {
      const dbAccount = await getAccount(selectedAccountId);
      if (!dbAccount) throw new Error("Account not found");
      const config = buildImapConfig(dbAccount);
      setImapConfig(config);
      const list = await imapListFolders(config);
      setFolders(list);
      // auto-expand INBOX
      const inbox = list.find((f) => f.path.toLowerCase() === "inbox");
      setExpandedPaths(new Set(inbox ? [inbox.path] : []));
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // --- derived tree data ---
  const delimiter = folders[0]?.delimiter ?? "/";

  // Pre-compute the set of paths belonging to system (hidden) folders so we can
  // efficiently check parentage without an O(n²) find() inside useMemo.
  const systemPaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of folders) {
      if (isSystemFolder(f)) set.add(f.path);
    }
    return set;
  }, [folders]);

  // A non-system folder is a "root" in the visible tree when:
  //   a) it has no parent on the server (parent_path === null), OR
  //   b) its direct parent is a system folder (e.g. INBOX/MyFolder on servers
  //      that nest everything under INBOX — INBOX is hidden but MyFolder must
  //      surface at the top of the visible tree).
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

  // --- tree expand/collapse ---
  const toggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // --- create ---
  const startCreate = useCallback(
    (parentPath: string | null) => {
      setCreatingUnder(parentPath);
      setCreateName("");
      setRenamingPath(null);
      if (parentPath !== null) {
        setExpandedPaths((prev) => new Set([...prev, parentPath]));
      }
      setTimeout(() => createInputRef.current?.focus(), 50);
    },
    [],
  );

  const cancelCreate = useCallback(() => {
    setCreatingUnder(undefined);
    setCreateName("");
  }, []);

  const commitCreate = useCallback(async () => {
    if (!imapConfig || !createName.trim()) return;
    const name = createName.trim();
    const path =
      creatingUnder != null ? `${creatingUnder}${delimiter}${name}` : name;
    setBusy(true);
    setOpError(null);
    try {
      await imapCreateFolder(imapConfig, path);
      cancelCreate();
      await loadFolders();
    } catch (e) {
      setOpError(t("settings.imapFolderEditor.errorCreate", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }, [imapConfig, createName, creatingUnder, delimiter, cancelCreate, loadFolders]);

  // --- rename ---
  const startRename = useCallback((folder: ImapFolder) => {
    setRenamingPath(folder.path);
    setRenameName(folder.name);
    setCreatingUnder(undefined);
    setTimeout(() => renameInputRef.current?.focus(), 50);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
    setRenameName("");
  }, []);

  const commitRename = useCallback(async () => {
    if (!imapConfig || !renamingPath || !renameName.trim()) return;
    const folder = folders.find((f) => f.path === renamingPath);
    if (!folder) return;
    const newLeaf = renameName.trim();
    const newPath =
      folder.parent_path != null
        ? `${folder.parent_path}${delimiter}${newLeaf}`
        : newLeaf;
    if (newPath === folder.path) {
      cancelRename();
      return;
    }
    setBusy(true);
    setOpError(null);
    try {
      await imapRenameFolder(imapConfig, folder.raw_path, newPath);
      cancelRename();
      await loadFolders();
    } catch (e) {
      setOpError(t("settings.imapFolderEditor.errorRename", { error: String(e) }));
      cancelRename();
    } finally {
      setBusy(false);
    }
  }, [imapConfig, renamingPath, renameName, folders, delimiter, cancelRename, loadFolders]);

  // --- delete ---
  const requestDelete = useCallback((folder: ImapFolder) => {
    setDeleteTarget(folder);
  }, []);

  const commitDelete = useCallback(async () => {
    if (!imapConfig || !deleteTarget) return;
    setBusy(true);
    setOpError(null);
    try {
      await imapDeleteFolder(imapConfig, deleteTarget.raw_path);
      setDeleteTarget(null);
      if (selectedPath === deleteTarget.path) setSelectedPath(null);
      await loadFolders();
    } catch (e) {
      setOpError(t("settings.imapFolderEditor.errorDelete", { error: String(e) }));
      setDeleteTarget(null);
    } finally {
      setBusy(false);
    }
  }, [imapConfig, deleteTarget, selectedPath, loadFolders]);

  // --- inline create input node ---
  function renderInlineCreate(parentPath: string | null) {
    if (creatingUnder === undefined) return null;
    if (creatingUnder !== parentPath) return null;
    const depth = parentPath == null ? 0 : parentPath.split(delimiter).length;
    return (
      <div
        className="flex items-center gap-1 py-1"
        style={{ paddingLeft: `${8 + depth * 16 + 20}px`, paddingRight: "8px" }}
      >
        <span className="w-4 h-4 shrink-0" />
        <Folder size={14} className="shrink-0 text-text-secondary" />
        <input
          ref={createInputRef}
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitCreate();
            if (e.key === "Escape") cancelCreate();
          }}
          placeholder={t("settings.imapFolderEditor.createPlaceholder")}
          className="flex-1 min-w-0 text-xs bg-bg-primary border border-accent rounded px-1 py-0.5 outline-none"
          disabled={busy}
        />
      </div>
    );
  }

  // --- recursive tree renderer ---
  function renderNode(folder: ImapFolder, depth: number): React.ReactNode {
    const isExpanded = expandedPaths.has(folder.path);
    const isSelected = selectedPath === folder.path;
    const isRenaming = renamingPath === folder.path;
    const nodeChildren = childrenOf(folder.path);

    return (
      <FolderTreeNode
        key={folder.path}
        folder={folder}
        depth={depth}
        isExpanded={isExpanded}
        isSelected={isSelected}
        isRenaming={isRenaming}
        renameName={renameName}
        onToggleExpand={() => toggleExpand(folder.path)}
        onSelect={() => {
          setSelectedPath(folder.path);
          if (!isRenaming) cancelRename();
          cancelCreate();
        }}
        onRenameStart={() => startRename(folder)}
        onRenameChange={setRenameName}
        onRenameCommit={commitRename}
        onRenameCancel={cancelRename}
        onDeleteRequest={() => requestDelete(folder)}
        renameInputRef={renameInputRef}
        createInputNode={isExpanded ? renderInlineCreate(folder.path) : null}
      >
        {isExpanded && nodeChildren.map((child) => renderNode(child, depth + 1))}
      </FolderTreeNode>
    );
  }

  // --- render ---

  if (imapAccounts.length === 0) {
    return (
      <p className="text-xs text-text-tertiary">
        {t("settings.imapFolderEditor.noImapAccounts")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* account dropdown — only shown when multiple IMAP accounts */}
      {imapAccounts.length > 1 && (
        <div className="flex items-center gap-2 py-2 px-3 bg-bg-secondary rounded-md">
          <div className="w-5 h-5 rounded-full bg-accent/15 text-accent text-[0.6rem] font-bold flex items-center justify-center shrink-0 select-none">
            {accountInitial}
          </div>
          <div ref={accountDropdownRef} className="relative flex-1 min-w-0">
            <button
              onClick={() => setOpenAccountDropdown((v) => !v)}
              className="flex items-center gap-2 w-full text-left px-1 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            >
              <span className="truncate">
                {selectedAccount?.displayName
                  ? `${selectedAccount.displayName} (${selectedAccount.email})`
                  : selectedAccount?.email ??
                    t("settings.signatureEditor.selectAccount")}
              </span>
              <ChevronDown
                size={12}
                className={`shrink-0 text-text-secondary transition-transform duration-200 ${
                  openAccountDropdown ? "rotate-180" : ""
                }`}
              />
            </button>
            {openAccountDropdown && (
              <div className="absolute left-0 top-full mt-1 py-1 w-full rounded-lg border border-border-primary bg-bg-primary shadow-lg z-50 glass-panel">
                {imapAccounts.map((account) => {
                  const isActive = account.id === selectedAccountId;
                  return (
                    <button
                      key={account.id}
                      onClick={() => handleAccountSelect(account.id)}
                      className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                        isActive
                          ? "bg-accent/8 text-accent"
                          : "text-text-primary hover:bg-bg-hover"
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate leading-tight">
                          {account.displayName || account.email.split("@")[0]}
                        </div>
                        <div className="text-[0.625rem] text-text-secondary truncate leading-tight">
                          {account.email}
                        </div>
                      </div>
                      {isActive && <Check size={12} className="shrink-0 text-accent" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* toolbar */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => startCreate(selectedPath)}
          disabled={loading || busy || !imapConfig}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40 transition-colors"
        >
          <Plus size={13} />
          {t("settings.imapFolderEditor.newFolder")}
        </button>
        <button
          onClick={loadFolders}
          disabled={loading || busy}
          title={t("common.retry")}
          className="p-1 rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* operation error */}
      {opError && (
        <div className="flex items-start gap-2 text-xs text-red-400 bg-red-400/8 px-3 py-2 rounded-md">
          <AlertCircle size={13} className="shrink-0 mt-0.5" />
          <span>{opError}</span>
        </div>
      )}

      {/* load error */}
      {loadError && (
        <div className="flex items-center justify-between text-xs text-red-400 bg-red-400/8 px-3 py-2 rounded-md">
          <span className="flex items-center gap-2">
            <AlertCircle size={13} className="shrink-0" />
            {t("settings.imapFolderEditor.errorLoad", { error: loadError })}
          </span>
          <button
            onClick={loadFolders}
            className="underline ml-2 shrink-0 hover:text-red-300"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* folder tree */}
      {!loadError && (
        <div className="border border-border-primary rounded-md overflow-hidden bg-bg-secondary">
          {loading ? (
            <div className="p-4 text-xs text-text-tertiary text-center">
              {t("common.loading")}
            </div>
          ) : (
            <div className="py-1 max-h-80 overflow-y-auto">
              {rootFolders.map((f) => renderNode(f, 0))}
              {renderInlineCreate(null)}
            </div>
          )}
        </div>
      )}

      {/* delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={commitDelete}
        title={t("settings.imapFolderEditor.deleteTitle")}
        message={t("settings.imapFolderEditor.deleteMessage", {
          name: deleteTarget?.name ?? "",
        })}
        confirmLabel={t("common.delete")}
        variant="danger"
        loading={busy}
      />
    </div>
  );
}
