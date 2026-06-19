import { create } from "zustand";
import { getAllContacts, getLearnedNamesFromMessages } from "@/services/db/contacts";
import { getAllAccounts } from "@/services/db/accounts";

interface ContactsState {
  contactsMap: Record<string, string>;
  loadContacts: () => Promise<void>;
  updateContactInCache: (email: string, displayName: string | null) => void;
}

export const useContactsStore = create<ContactsState>((set) => ({
  contactsMap: {},

  loadContacts: async () => {
    // Priority (lowest → highest): names learned from message headers,
    // then the user's own account display names, then explicitly stored contacts.
    // The first two are best-effort: a failure there must never prevent the
    // authoritative stored-contact names from loading.
    const map: Record<string, string> = {};
    try {
      Object.assign(map, await getLearnedNamesFromMessages());
    } catch (e) {
      console.error("loadContacts: learned names failed", e);
    }
    try {
      for (const a of await getAllAccounts()) {
        if (a.display_name) map[a.email.toLowerCase()] = a.display_name;
      }
    } catch (e) {
      console.error("loadContacts: account names failed", e);
    }
    // Stored contacts take priority over everything above.
    for (const c of await getAllContacts()) {
      if (c.display_name) map[c.email.toLowerCase()] = c.display_name;
    }
    set({ contactsMap: map });
  },

  updateContactInCache: (email, displayName) =>
    set((state) => {
      const key = email.toLowerCase();
      if (!displayName) {
        const next = { ...state.contactsMap };
        delete next[key];
        return { contactsMap: next };
      }
      return { contactsMap: { ...state.contactsMap, [key]: displayName } };
    }),
}));
