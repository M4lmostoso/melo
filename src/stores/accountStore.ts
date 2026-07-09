import { create } from "zustand";
import { setSetting, deleteSetting } from "../services/db/settings";
import { updateAccountMeta } from "../services/db/accounts";

export interface Account {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  isActive: boolean;
  provider?: string;
  color: string | null;
  includeInGlobal: boolean;
  sortOrder: number;
  label: string | null;
  /** True when PEC mode is enabled (only ever set for IMAP certified-email accounts). */
  pecEnabled?: boolean;
}

interface AccountState {
  accounts: Account[];
  activeAccountId: string | null;
  /**
   * User-chosen default account (persisted setting `default_account_id`). Used as the
   * fallback account when no account is actively selected — e.g. composing a new email
   * from the unified inbox, or the initial active account on startup with no restored
   * selection. Null falls back to the first account by sort order.
   */
  defaultAccountId: string | null;
  /** Account of the currently viewed thread in a global view — display only, does not affect list filtering. */
  viewingAccountId: string | null;
  setAccounts: (accounts: Account[], restoredId?: string | null) => void;
  /** Pass null to enter unified-inbox context (no single active account). */
  setActiveAccount: (id: string | null) => void;
  /** Set (or clear, with null) the persisted default account. */
  setDefaultAccount: (id: string | null) => void;
  /** Hydrate the default account from persisted settings without re-writing it. */
  hydrateDefaultAccount: (id: string | null) => void;
  setViewingAccountId: (id: string | null) => void;
  addAccount: (account: Account) => void;
  removeAccount: (id: string) => void;
  reorderAccounts: (orderedIds: string[]) => Promise<void>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  activeAccountId: null,
  defaultAccountId: null,
  viewingAccountId: null,

  setAccounts: (accounts, restoredId) => {
    const isValid = (id: string | null | undefined): id is string =>
      !!id && accounts.some((a) => a.id === id);
    // Drop a stale default (account was removed since it was chosen).
    const defaultAccountId = isValid(get().defaultAccountId)
      ? get().defaultAccountId
      : null;
    const activeId =
      (isValid(restoredId) && restoredId) ||
      defaultAccountId ||
      accounts[0]?.id ||
      null;
    set({ accounts, activeAccountId: activeId, defaultAccountId });
  },

  setActiveAccount: (activeAccountId) => {
    if (activeAccountId !== null) {
      setSetting("active_account_id", activeAccountId).catch(() => {});
    }
    set({ activeAccountId, viewingAccountId: null });
  },

  setDefaultAccount: (defaultAccountId) => {
    if (defaultAccountId) {
      setSetting("default_account_id", defaultAccountId).catch(() => {});
    } else {
      deleteSetting("default_account_id").catch(() => {});
    }
    set({ defaultAccountId });
  },

  hydrateDefaultAccount: (defaultAccountId) => set({ defaultAccountId }),

  setViewingAccountId: (viewingAccountId) => set({ viewingAccountId }),

  addAccount: (account) =>
    set((state) => ({
      accounts: [...state.accounts, account],
      activeAccountId: state.activeAccountId ?? account.id,
    })),

  removeAccount: (id) =>
    set((state) => {
      const accounts = state.accounts.filter((a) => a.id !== id);
      const clearedDefault = state.defaultAccountId === id;
      if (clearedDefault) deleteSetting("default_account_id").catch(() => {});
      return {
        accounts,
        defaultAccountId: clearedDefault ? null : state.defaultAccountId,
        activeAccountId:
          state.activeAccountId === id
            ? (accounts[0]?.id ?? null)
            : state.activeAccountId,
      };
    }),

  reorderAccounts: async (orderedIds) => {
    set((state) => {
      const idToIndex = new Map(orderedIds.map((id, i) => [id, i]));
      const accounts = [...state.accounts].sort((a, b) => {
        const ia = idToIndex.get(a.id) ?? state.accounts.indexOf(a);
        const ib = idToIndex.get(b.id) ?? state.accounts.indexOf(b);
        return ia - ib;
      });
      return { accounts: accounts.map((a, i) => ({ ...a, sortOrder: i })) };
    });
    await Promise.all(
      orderedIds.map((id, i) => updateAccountMeta(id, { sortOrder: i })),
    );
  },
}));
