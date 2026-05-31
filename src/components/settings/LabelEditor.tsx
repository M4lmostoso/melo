import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Trash2, Pencil, ChevronUp, ChevronDown, Check, X, Users } from "lucide-react";
import { t } from "@/i18n";
import { useAccountStore } from "@/stores/accountStore";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useLabelStore, type Label } from "@/stores/labelStore";
import { LabelForm } from "@/components/labels/LabelForm";
import { LabelBreadcrumb } from "@/components/labels/LabelBreadcrumb";

const ALL_ACCOUNTS = "__all__";

export function LabelEditor() {
  const accounts = useAccountStore((s) => s.accounts);
  const { labels, allAccountLabels, loadLabels, loadAllAccountLabels, deleteLabel, reorderLabels } = useLabelStore();

  // Initialise once: prefer the active account, fall back to ALL
  const [selectedAccountId, setSelectedAccountId] = useState<string>(
    () => useAccountStore.getState().activeAccountId ?? ALL_ACCOUNTS,
  );
  const [openDropdown, setOpenDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(dropdownRef, () => setOpenDropdown(false));

  const isAllAccounts = selectedAccountId === ALL_ACCOUNTS;
  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId),
    [accounts, selectedAccountId],
  );
  const accountInitial = isAllAccounts
    ? null
    : (selectedAccount?.displayName ?? selectedAccount?.email ?? "?")[0]?.toUpperCase() ?? "?";

  const handleAccountSelect = useCallback((id: string) => {
    setSelectedAccountId(id);
    setOpenDropdown(false);
  }, []);

  // Load data for the selected scope
  useEffect(() => {
    if (isAllAccounts) {
      loadAllAccountLabels(accounts.map((a) => a.id));
    } else {
      loadLabels(selectedAccountId);
    }
  }, [selectedAccountId, isAllAccounts, accounts, loadLabels, loadAllAccountLabels]);

  // Visible labels: single account or merged from all
  const visibleLabels: Label[] = useMemo(() => {
    if (!isAllAccounts) return labels;
    return accounts.flatMap((a) => allAccountLabels[a.id] ?? []);
  }, [isAllAccounts, labels, accounts, allAccountLabels]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setShowForm(false);
    setError(null);
  }, []);

  const handleEdit = useCallback((label: Label) => {
    setEditingId(label.id);
    setShowForm(true);
    setError(null);
  }, []);

  const handleDelete = useCallback(async (label: Label) => {
    setError(null);
    try {
      await deleteLabel(label.accountId, label.id);
      if (editingId === label.id) resetForm();
      // Refresh the correct scope
      if (isAllAccounts) {
        loadAllAccountLabels(accounts.map((a) => a.id));
      } else {
        loadLabels(selectedAccountId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.labelEditor.deleteLabel") + " failed");
    }
  }, [deleteLabel, editingId, resetForm, isAllAccounts, loadAllAccountLabels, loadLabels, selectedAccountId, accounts]);

  const handleMoveUp = useCallback(async (label: Label, _index: number) => {
    // Reorder only within the same account group
    const group = visibleLabels.filter((l) => l.accountId === label.accountId);
    const groupIndex = group.findIndex((l) => l.id === label.id);
    if (groupIndex === 0) return;
    const newOrder = group.map((l) => l.id);
    [newOrder[groupIndex - 1], newOrder[groupIndex]] = [newOrder[groupIndex]!, newOrder[groupIndex - 1]!];
    await reorderLabels(label.accountId, newOrder);
    if (isAllAccounts) {
      loadAllAccountLabels(accounts.map((a) => a.id));
    } else {
      loadLabels(selectedAccountId);
    }
  }, [visibleLabels, reorderLabels, isAllAccounts, loadAllAccountLabels, loadLabels, selectedAccountId, accounts]);

  const handleMoveDown = useCallback(async (label: Label, _index: number) => {
    const group = visibleLabels.filter((l) => l.accountId === label.accountId);
    const groupIndex = group.findIndex((l) => l.id === label.id);
    if (groupIndex >= group.length - 1) return;
    const newOrder = group.map((l) => l.id);
    [newOrder[groupIndex], newOrder[groupIndex + 1]] = [newOrder[groupIndex + 1]!, newOrder[groupIndex]!];
    await reorderLabels(label.accountId, newOrder);
    if (isAllAccounts) {
      loadAllAccountLabels(accounts.map((a) => a.id));
    } else {
      loadLabels(selectedAccountId);
    }
  }, [visibleLabels, reorderLabels, isAllAccounts, loadAllAccountLabels, loadLabels, selectedAccountId, accounts]);

  const editingLabel = editingId ? visibleLabels.find((l) => l.id === editingId) ?? null : null;

  // In "all accounts" mode group by account for display
  const groupedForAll = useMemo(() => {
    if (!isAllAccounts) return null;
    return accounts
      .map((a) => ({ account: a, labels: allAccountLabels[a.id] ?? [] }))
      .filter((g) => g.labels.length > 0);
  }, [isAllAccounts, accounts, allAccountLabels]);

  return (
    <div className="space-y-3">
      {/* Account selector */}
      <div className="flex items-center gap-2 py-2 px-3 bg-bg-secondary rounded-md">
        <div className="w-5 h-5 rounded-full bg-accent/15 text-accent text-[0.6rem] font-bold flex items-center justify-center shrink-0 select-none">
          {accountInitial ?? <Users size={11} />}
        </div>
        <div ref={dropdownRef} className="relative flex-1 min-w-0">
          <button
            onClick={() => setOpenDropdown((v) => !v)}
            className="flex items-center gap-2 w-full text-left px-1 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <span className="truncate flex-1">
              {isAllAccounts
                ? t("settings.labelEditor.allAccounts")
                : selectedAccount?.displayName
                  ? `${selectedAccount.displayName} (${selectedAccount.email})`
                  : selectedAccount?.email ?? "—"}
            </span>
            <ChevronDown
              size={12}
              className={`shrink-0 text-text-secondary transition-transform duration-200 ${openDropdown ? "rotate-180" : ""}`}
            />
          </button>
          {openDropdown && (
            <div className="absolute left-0 top-full mt-1 py-1 w-full rounded-lg border border-border-primary bg-bg-primary shadow-lg z-50 glass-panel">
              {/* All accounts option */}
              <button
                onClick={() => handleAccountSelect(ALL_ACCOUNTS)}
                className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                  isAllAccounts ? "bg-accent/8 text-accent" : "text-text-primary hover:bg-bg-hover"
                }`}
              >
                <Users size={12} className="shrink-0" />
                <span className="flex-1 text-xs font-medium truncate">
                  {t("settings.labelEditor.allAccounts")}
                </span>
                {isAllAccounts && <Check size={12} className="shrink-0 text-accent" />}
              </button>
              <div className="mx-2 my-1 border-t border-border-primary/50" />
              {accounts.map((account) => {
                const isActive = account.id === selectedAccountId;
                return (
                  <button
                    key={account.id}
                    onClick={() => handleAccountSelect(account.id)}
                    className={`flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors ${
                      isActive ? "bg-accent/8 text-accent" : "text-text-primary hover:bg-bg-hover"
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

      {error && (
        <div className="flex items-center gap-2 px-3 py-2 bg-danger/10 text-danger text-xs rounded-md">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="shrink-0"><X size={12} /></button>
        </div>
      )}

      {/* All-accounts grouped view */}
      {isAllAccounts && groupedForAll ? (
        groupedForAll.length === 0 ? (
          <p className="text-sm text-text-tertiary">{t("settings.labelEditor.noLabels")}</p>
        ) : (
          <div className="space-y-4">
            {groupedForAll.map(({ account, labels: groupLabels }) => (
              <div key={account.id}>
                <p className="text-[0.7rem] font-medium text-text-tertiary uppercase tracking-wider mb-1.5 px-1">
                  {account.label ?? account.displayName ?? account.email}
                </p>
                <div className="space-y-1.5">
                  {groupLabels.map((label, index) => (
                    <LabelRow
                      key={label.id}
                      label={label}
                      index={index}
                      total={groupLabels.length}
                      isEditing={showForm && editingId === label.id}
                      editingLabel={editingLabel}
                      accountColor={account.color}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      onMoveUp={handleMoveUp}
                      onMoveDown={handleMoveDown}
                      onFormDone={resetForm}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        /* Single-account flat view */
        <>
          {visibleLabels.length === 0 && !showForm && (
            <p className="text-sm text-text-tertiary">{t("settings.labelEditor.noLabels")}</p>
          )}
          <div className="space-y-1.5">
            {visibleLabels.map((label, index) => (
              <LabelRow
                key={label.id}
                label={label}
                index={index}
                total={visibleLabels.length}
                isEditing={showForm && editingId === label.id}
                editingLabel={editingLabel}
                accountColor={selectedAccount?.color}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onFormDone={resetForm}
              />
            ))}
          </div>
          {showForm && !editingId && selectedAccountId && selectedAccountId !== ALL_ACCOUNTS ? (
            <LabelForm accountId={selectedAccountId} onDone={resetForm} />
          ) : !showForm && selectedAccountId !== ALL_ACCOUNTS && (
            <button
              onClick={() => { setShowForm(true); setEditingId(null); setError(null); }}
              className="text-xs text-accent hover:text-accent-hover"
            >
              + {t("settings.labelEditor.addLabel")}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── LabelRow ────────────────────────────────────────────────────────────────

interface LabelRowProps {
  label: Label;
  index: number;
  total: number;
  isEditing: boolean;
  editingLabel: Label | null;
  accountColor?: string | null;
  onEdit: (label: Label) => void;
  onDelete: (label: Label) => void;
  onMoveUp: (label: Label, index: number) => void;
  onMoveDown: (label: Label, index: number) => void;
  onFormDone: () => void;
}

function LabelRow({
  label, index, total, isEditing, editingLabel, accountColor,
  onEdit, onDelete, onMoveUp, onMoveDown, onFormDone,
}: LabelRowProps) {
  return (
    <div>
      <div className="flex items-center justify-between py-2 px-3 bg-bg-secondary rounded-md">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {label.colorBg ? (
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: label.colorBg }} />
          ) : (
            <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-text-tertiary/30" />
          )}
          <LabelBreadcrumb
            label={label}
            accountColor={accountColor ?? label.colorBg}
            onLeafClick={() => onEdit(label)}
          />
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => onMoveUp(label, index)}
            disabled={index === 0}
            className="p-1 text-text-tertiary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("settings.labelEditor.moveUp")}
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => onMoveDown(label, index)}
            disabled={index >= total - 1}
            className="p-1 text-text-tertiary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("settings.labelEditor.moveDown")}
          >
            <ChevronDown size={13} />
          </button>
          <button
            onClick={() => onEdit(label)}
            className="p-1 text-text-tertiary hover:text-text-primary"
            title={t("settings.labelEditor.editLabel")}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(label)}
            className="p-1 text-text-tertiary hover:text-danger"
            title={t("settings.labelEditor.deleteLabel")}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {isEditing && (
        <div className="mt-1">
          <LabelForm accountId={label.accountId} label={editingLabel} onDone={onFormDone} />
        </div>
      )}
    </div>
  );
}
