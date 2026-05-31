import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Trash2, Pencil, ChevronDown, Check } from "lucide-react";
import { t } from "@/i18n";
import { TextField } from "@/components/ui/TextField";
import { useAccountStore } from "@/stores/accountStore";
import { useClickOutside } from "@/hooks/useClickOutside";
import { getUserLabelsForAccount, type UserLabel } from "@/services/db/userLabels";
import {
  getFiltersForAccount,
  insertFilter,
  updateFilter,
  deleteFilter,
  type DbFilterRule,
  type FilterCriteria,
  type FilterActions,
} from "@/services/db/filters";

export function FilterEditor() {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [openAccountDropdown, setOpenAccountDropdown] = useState(false);
  const accountDropdownRef = useRef<HTMLDivElement | null>(null);
  const [filters, setFilters] = useState<DbFilterRule[]>([]);
  const [labels, setLabels] = useState<UserLabel[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  useClickOutside(accountDropdownRef, () => setOpenAccountDropdown(false));

  useEffect(() => {
    if (!selectedAccountId) {
      if (activeAccountId) {
        setSelectedAccountId(activeAccountId);
      } else if (accounts.length > 0) {
        const first = accounts[0];
        if (first) setSelectedAccountId(first.id);
      }
    }
  }, [accounts, activeAccountId, selectedAccountId]);

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId),
    [accounts, selectedAccountId],
  );
  const accountInitial =
    (selectedAccount?.displayName ?? selectedAccount?.email ?? "?")[0]?.toUpperCase() ?? "?";

  const handleAccountSelect = useCallback((accountId: string) => {
    setSelectedAccountId(accountId);
    setOpenAccountDropdown(false);
  }, []);

  // Form state
  const [name, setName] = useState("");
  const [criteriaFrom, setCriteriaFrom] = useState("");
  const [criteriaTo, setCriteriaTo] = useState("");
  const [criteriaSubject, setCriteriaSubject] = useState("");
  const [criteriaBody, setCriteriaBody] = useState("");
  const [criteriaHasAttachment, setCriteriaHasAttachment] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  const [actionArchive, setActionArchive] = useState(false);
  const [actionStar, setActionStar] = useState(false);
  const [actionMarkRead, setActionMarkRead] = useState(false);
  const [actionTrash, setActionTrash] = useState(false);

  const loadFilters = useCallback(async () => {
    if (!selectedAccountId) return;
    const f = await getFiltersForAccount(selectedAccountId);
    setFilters(f);
  }, [selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId) return;
    loadFilters();
    getUserLabelsForAccount(selectedAccountId).then(setLabels);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFilters is stable, only re-run on selectedAccountId change
  }, [selectedAccountId]);

  const resetForm = useCallback(() => {
    setName("");
    setCriteriaFrom("");
    setCriteriaTo("");
    setCriteriaSubject("");
    setCriteriaBody("");
    setCriteriaHasAttachment(false);
    setActionLabel("");
    setActionArchive(false);
    setActionStar(false);
    setActionMarkRead(false);
    setActionTrash(false);
    setEditingId(null);
    setShowForm(false);
  }, []);

  const buildCriteria = (): FilterCriteria => {
    const c: FilterCriteria = {};
    if (criteriaFrom.trim()) c.from = criteriaFrom.trim();
    if (criteriaTo.trim()) c.to = criteriaTo.trim();
    if (criteriaSubject.trim()) c.subject = criteriaSubject.trim();
    if (criteriaBody.trim()) c.body = criteriaBody.trim();
    if (criteriaHasAttachment) c.hasAttachment = true;
    return c;
  };

  const buildActions = (): FilterActions => {
    const a: FilterActions = {};
    if (actionLabel) a.applyLabel = actionLabel;
    if (actionArchive) a.archive = true;
    if (actionStar) a.star = true;
    if (actionMarkRead) a.markRead = true;
    if (actionTrash) a.trash = true;
    return a;
  };

  const handleSave = useCallback(async () => {
    if (!selectedAccountId || !name.trim()) return;
    const criteria = buildCriteria();
    const actions = buildActions();

    if (editingId) {
      await updateFilter(editingId, { name: name.trim(), criteria, actions });
    } else {
      await insertFilter({
        accountId: selectedAccountId,
        name: name.trim(),
        criteria,
        actions,
      });
    }

    resetForm();
    await loadFilters();
  }, [selectedAccountId, name, editingId, resetForm, loadFilters, criteriaFrom, criteriaTo, criteriaSubject, criteriaBody, criteriaHasAttachment, actionLabel, actionArchive, actionStar, actionMarkRead, actionTrash]);

  const handleEdit = useCallback((filter: DbFilterRule) => {
    setEditingId(filter.id);
    setName(filter.name);

    let criteria: FilterCriteria = {};
    let actions: FilterActions = {};
    try { criteria = JSON.parse(filter.criteria_json); } catch { /* empty */ }
    try { actions = JSON.parse(filter.actions_json); } catch { /* empty */ }

    setCriteriaFrom(criteria.from ?? "");
    setCriteriaTo(criteria.to ?? "");
    setCriteriaSubject(criteria.subject ?? "");
    setCriteriaBody(criteria.body ?? "");
    setCriteriaHasAttachment(criteria.hasAttachment ?? false);
    setActionLabel(actions.applyLabel ?? "");
    setActionArchive(actions.archive ?? false);
    setActionStar(actions.star ?? false);
    setActionMarkRead(actions.markRead ?? false);
    setActionTrash(actions.trash ?? false);
    setShowForm(true);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await deleteFilter(id);
    if (editingId === id) resetForm();
    await loadFilters();
  }, [editingId, resetForm, loadFilters]);

  const handleToggleEnabled = useCallback(async (filter: DbFilterRule) => {
    await updateFilter(filter.id, { isEnabled: filter.is_enabled !== 1 });
    await loadFilters();
  }, [loadFilters]);

  const filterDescriptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const filter of filters) {
      try {
        const c = JSON.parse(filter.criteria_json) as FilterCriteria;
        const parts: string[] = [];
        if (c.from) parts.push(`from: ${c.from}`);
        if (c.to) parts.push(`to: ${c.to}`);
        if (c.subject) parts.push(`subject: ${c.subject}`);
        if (c.body) parts.push(`body: ${c.body}`);
        if (c.hasAttachment) parts.push(t("settings.filterEditor.hasAttachment"));
        map.set(filter.id, parts.join(", ") || t("settings.filterEditor.criteriaTitle"));
      } catch {
        map.set(filter.id, t("common.error"));
      }
    }
    return map;
  }, [filters]);

  return (
    <div className="space-y-3">
      {accounts.length > 1 && (
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
                  : selectedAccount?.email ?? t("settings.signatureEditor.selectAccount")}
              </span>
              <ChevronDown
                size={12}
                className={`shrink-0 text-text-secondary transition-transform duration-200 ${openAccountDropdown ? "rotate-180" : ""}`}
              />
            </button>
            {openAccountDropdown && (
              <div className="absolute left-0 top-full mt-1 py-1 w-full rounded-lg border border-border-primary bg-bg-primary shadow-lg z-50 glass-panel">
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
      )}

      {filters.map((filter) => (
        <div
          key={filter.id}
          className="flex items-center justify-between py-2 px-3 bg-bg-secondary rounded-md"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary flex items-center gap-2">
              {filter.name}
              {filter.is_enabled !== 1 && (
                <span className="text-[0.625rem] bg-bg-tertiary text-text-tertiary px-1.5 py-0.5 rounded">
                  {t("settings.filterEditor.disabled")}
                </span>
              )}
            </div>
            <div className="text-xs text-text-tertiary truncate">
              {filterDescriptions.get(filter.id) ?? t("settings.filterEditor.criteriaTitle")}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleToggleEnabled(filter)}
              className={`w-8 h-4 rounded-full transition-colors relative ${
                filter.is_enabled === 1 ? "bg-accent" : "bg-bg-tertiary"
              }`}
              title={filter.is_enabled === 1 ? t("settings.filterEditor.disabled") : t("settings.filterEditor.enabled")}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform shadow ${
                  filter.is_enabled === 1 ? "translate-x-4" : ""
                }`}
              />
            </button>
            <button
              onClick={() => handleEdit(filter)}
              className="p-1 text-text-tertiary hover:text-text-primary"
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => handleDelete(filter.id)}
              className="p-1 text-text-tertiary hover:text-danger"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      ))}

      {showForm ? (
        <div className="border border-border-primary rounded-md p-3 space-y-3">
          <TextField
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("settings.filterEditor.filterName")}
          />

          <div>
            <div className="text-xs font-medium text-text-secondary mb-1.5">{t("settings.filterEditor.criteriaTitle")}</div>
            <div className="space-y-1.5">
              <TextField
                type="text"
                value={criteriaFrom}
                onChange={(e) => setCriteriaFrom(e.target.value)}
                placeholder={t("settings.filterEditor.from") + " contains..."}
              />
              <TextField
                type="text"
                value={criteriaTo}
                onChange={(e) => setCriteriaTo(e.target.value)}
                placeholder={t("settings.filterEditor.to") + " contains..."}
              />
              <TextField
                type="text"
                value={criteriaSubject}
                onChange={(e) => setCriteriaSubject(e.target.value)}
                placeholder={t("settings.filterEditor.subject") + " contains..."}
              />
              <TextField
                type="text"
                value={criteriaBody}
                onChange={(e) => setCriteriaBody(e.target.value)}
                placeholder={t("settings.filterEditor.body") + " contains..."}
              />
              <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  checked={criteriaHasAttachment}
                  onChange={(e) => setCriteriaHasAttachment(e.target.checked)}
                  className="rounded"
                />
                {t("settings.filterEditor.hasAttachment")}
              </label>
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-text-secondary mb-1.5">{t("settings.filterEditor.actionsTitle")}</div>
            <div className="space-y-1.5">
              {labels.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary w-20">{t("settings.filterEditor.applyLabel")}</span>
                  <select
                    value={actionLabel}
                    onChange={(e) => setActionLabel(e.target.value)}
                    className="flex-1 bg-bg-tertiary text-text-primary text-xs px-2 py-1 rounded border border-border-primary"
                  >
                    <option value="">{t("settings.filterEditor.noLabels")}</option>
                    {labels.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={actionArchive} onChange={(e) => setActionArchive(e.target.checked)} className="rounded" />
                  {t("settings.filterEditor.archive")}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={actionStar} onChange={(e) => setActionStar(e.target.checked)} className="rounded" />
                  {t("settings.filterEditor.star")}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={actionMarkRead} onChange={(e) => setActionMarkRead(e.target.checked)} className="rounded" />
                  {t("settings.filterEditor.markRead")}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="checkbox" checked={actionTrash} onChange={(e) => setActionTrash(e.target.checked)} className="rounded" />
                  {t("settings.filterEditor.trash")}
                </label>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!name.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
            >
              {editingId ? t("settings.filterEditor.editFilter") : t("settings.filterEditor.saveFilter")}
            </button>
            <button
              onClick={resetForm}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded-md transition-colors"
            >
              {t("settings.filterEditor.cancelFilter")}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="text-xs text-accent hover:text-accent-hover"
        >
          + {t("settings.filterEditor.newFilter")}
        </button>
      )}
    </div>
  );
}
