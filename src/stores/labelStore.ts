import { create } from "zustand";
import {
  getUserLabelsForAccount,
  upsertUserLabel,
  deleteUserLabel,
  updateUserLabelSortOrder,
} from "@/services/db/userLabels";
import { getLabelsForAccount, upsertLabel, deleteLabel as dbDeleteLabel, updateLabelSortOrder } from "@/services/db/labels";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { useAccountStore } from "./accountStore";

export interface Label {
  id: string;
  accountId: string;
  name: string;
  type: string;
  colorBg: string | null;
  colorFg: string | null;
  sortOrder: number;
}

// System labels already shown as dedicated nav items — filter from label list
const SYSTEM_LABEL_IDS = new Set([
  "INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "STARRED",
  "UNREAD", "IMPORTANT", "SNOOZED", "CHAT",
]);
const CATEGORY_PREFIX = "CATEGORY_";

export function isSystemLabel(id: string): boolean {
  return SYSTEM_LABEL_IDS.has(id) || id.startsWith(CATEGORY_PREFIX);
}

/** Returns white for dark backgrounds, black for light (WCAG relative luminance). */
function contrastFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.179 ? "#000000" : "#ffffff";
}

function mapUserLabels(rows: Awaited<ReturnType<typeof getUserLabelsForAccount>>): Label[] {
  return rows
    .filter((l) => !isSystemLabel(l.id))
    .map((l) => ({
      id: l.id,
      accountId: l.account_id ?? "",
      name: l.name,
      type: "user",
      colorBg: l.color ?? null,
      colorFg: l.color ? contrastFg(l.color) : null,
      sortOrder: l.sort_order,
    }));
}

function isGmailAccount(accountId: string): boolean {
  return (
    useAccountStore.getState().accounts.find((a) => a.id === accountId)?.provider === "gmail_api"
  );
}

/**
 * Seed user_labels from the internal labels table for a Gmail account.
 * Runs at load time if user_labels is empty — handles migration gaps,
 * new accounts added after v58, and any prior migration rollback.
 */
async function seedGmailUserLabels(accountId: string): Promise<void> {
  const dbLabels = await getLabelsForAccount(accountId);
  const userTypeLabels = dbLabels.filter((l) => l.type === "user");
  await Promise.all(
    userTypeLabels.map((l) =>
      upsertUserLabel({
        id: l.id,
        name: l.name,
        color: l.color_bg ?? null,
        accountId,
        systemLabelId: l.id,
        sortOrder: l.sort_order,
      }),
    ),
  );
}

interface LabelState {
  labels: Label[];
  allAccountLabels: Record<string, Label[]>;
  unreadCounts: Record<string, number>;
  categoryUnreadCounts: Record<string, number>;
  globalUnreadCounts: Record<string, Record<string, number>>;
  scheduledCounts: Record<string, number>;
  draftCounts: Record<string, number>;
  isLoading: boolean;
  loadLabels: (accountId: string) => Promise<void>;
  loadAllAccountLabels: (accountIds: string[]) => Promise<void>;
  refreshUnreadCounts: (accountId: string) => Promise<void>;
  refreshGlobalUnreadCounts: (accountIds: string[]) => Promise<void>;
  refreshScheduledCounts: (accountIds: string[]) => Promise<void>;
  refreshDraftCounts: (accountIds: string[]) => Promise<void>;
  clearLabels: () => void;
  createLabel: (accountId: string, name: string, color?: { textColor: string; backgroundColor: string }) => Promise<void>;
  updateLabel: (accountId: string, labelId: string, updates: { name?: string; color?: { textColor: string; backgroundColor: string } | null }) => Promise<void>;
  deleteLabel: (accountId: string, labelId: string) => Promise<void>;
  reorderLabels: (accountId: string, labelIds: string[]) => Promise<void>;
  _reloadAccountLabels: (accountId: string) => Promise<void>;
}

export const useLabelStore = create<LabelState>((set, get) => ({
  labels: [],
  allAccountLabels: {},
  unreadCounts: {},
  categoryUnreadCounts: {},
  globalUnreadCounts: {},
  scheduledCounts: {},
  draftCounts: {},
  isLoading: false,

  loadLabels: async (accountId: string) => {
    set({ isLoading: true });
    try {
      let rows = await getUserLabelsForAccount(accountId);
      // If user_labels is empty for a Gmail account, seed from labels table at runtime.
      // Handles migration gaps, new accounts added post-v58, and prior rollbacks.
      if (rows.length === 0 && isGmailAccount(accountId)) {
        await seedGmailUserLabels(accountId);
        rows = await getUserLabelsForAccount(accountId);
      }
      set({ labels: mapUserLabels(rows), isLoading: false });
    } catch (err) {
      console.error("Failed to load labels:", err);
      set({ isLoading: false });
    }
  },

  loadAllAccountLabels: async (accountIds: string[]) => {
    try {
      const rows = await Promise.all(
        accountIds.map(async (id) => {
          let r = await getUserLabelsForAccount(id);
          if (r.length === 0 && isGmailAccount(id)) {
            await seedGmailUserLabels(id);
            r = await getUserLabelsForAccount(id);
          }
          return r;
        }),
      );
      const allAccountLabels: Record<string, Label[]> = {};
      accountIds.forEach((id, i) => {
        allAccountLabels[id] = mapUserLabels(rows[i] ?? []);
      });
      set({ allAccountLabels });
    } catch (err) {
      console.error("Failed to load all account labels:", err);
    }
  },

  refreshUnreadCounts: async (accountId: string) => {
    try {
      const { getUnreadCountsByLabel, getUnreadCountsByCategory } = await import("@/services/db/threads");
      const [unreadCounts, categoryUnreadCounts] = await Promise.all([
        getUnreadCountsByLabel(accountId),
        getUnreadCountsByCategory(accountId),
      ]);
      set({ unreadCounts, categoryUnreadCounts });
    } catch (err) {
      console.error("Failed to refresh label unread counts:", err);
    }
  },

  refreshGlobalUnreadCounts: async (accountIds: string[]) => {
    try {
      const { getGlobalUnreadCounts } = await import("@/services/db/threads");
      const countsMap = await getGlobalUnreadCounts(accountIds);
      const globalUnreadCounts: Record<string, Record<string, number>> = {};
      for (const [accountId, labelMap] of countsMap) {
        globalUnreadCounts[accountId] = Object.fromEntries(labelMap);
      }
      set({ globalUnreadCounts });
    } catch (err) {
      console.error("Failed to refresh global unread counts:", err);
    }
  },

  refreshScheduledCounts: async (accountIds: string[]) => {
    try {
      const { getScheduledCountsByAccounts } = await import("@/services/db/scheduledEmails");
      const counts = await getScheduledCountsByAccounts(accountIds);
      set({ scheduledCounts: counts });
    } catch (err) {
      console.error("Failed to refresh scheduled counts:", err);
    }
  },

  refreshDraftCounts: async (accountIds: string[]) => {
    try {
      const { getDraftCountsByAccounts } = await import("@/services/db/threads");
      const draftCounts = await getDraftCountsByAccounts(accountIds);
      set({ draftCounts });
    } catch (err) {
      console.error("Failed to refresh draft counts:", err);
    }
  },

  clearLabels: () =>
    set({
      labels: [],
      allAccountLabels: {},
      unreadCounts: {},
      categoryUnreadCounts: {},
      globalUnreadCounts: {},
      scheduledCounts: {},
      draftCounts: {},
      isLoading: false,
    }),

  createLabel: async (accountId, name, color?) => {
    if (isGmailAccount(accountId)) {
      // Gmail: create on server, mirror to both tables
      const client = await getGmailClient(accountId);
      const gmailLabel = await client.createLabel(name, color);
      await upsertLabel({
        id: gmailLabel.id,
        accountId,
        name: gmailLabel.name,
        type: gmailLabel.type,
        colorBg: gmailLabel.color?.backgroundColor ?? null,
        colorFg: gmailLabel.color?.textColor ?? null,
      });
      await upsertUserLabel({
        id: gmailLabel.id,
        name: gmailLabel.name,
        color: gmailLabel.color?.backgroundColor ?? color?.backgroundColor ?? null,
        accountId,
        systemLabelId: gmailLabel.id,
      });
    } else {
      // IMAP / iCloud: user_labels only, no server operation
      const id = crypto.randomUUID();
      await upsertUserLabel({
        id,
        name,
        color: color?.backgroundColor ?? null,
        accountId,
        systemLabelId: null,
      });
    }
    await get().loadLabels(accountId);
    await get()._reloadAccountLabels(accountId);
  },

  updateLabel: async (accountId, labelId, updates) => {
    if (isGmailAccount(accountId)) {
      // Gmail: update on server, mirror to both tables
      const client = await getGmailClient(accountId);
      const gmailLabel = await client.updateLabel(labelId, updates);
      await upsertLabel({
        id: gmailLabel.id,
        accountId,
        name: gmailLabel.name,
        type: gmailLabel.type,
        colorBg: gmailLabel.color?.backgroundColor ?? null,
        colorFg: gmailLabel.color?.textColor ?? null,
      });
      await upsertUserLabel({
        id: gmailLabel.id,
        name: gmailLabel.name,
        color: gmailLabel.color?.backgroundColor ?? null,
        accountId,
        systemLabelId: gmailLabel.id,
      });
    } else {
      // IMAP: update user_labels only
      await upsertUserLabel({
        id: labelId,
        name: updates.name ?? "",
        color: updates.color?.backgroundColor ?? null,
        accountId,
      });
    }
    await get().loadLabels(accountId);
    await get()._reloadAccountLabels(accountId);
  },

  deleteLabel: async (accountId, labelId) => {
    if (isGmailAccount(accountId)) {
      const client = await getGmailClient(accountId);
      await client.deleteLabel(labelId);
      await dbDeleteLabel(accountId, labelId);
    }
    await deleteUserLabel(labelId);
    await get().loadLabels(accountId);
    await get()._reloadAccountLabels(accountId);
  },

  reorderLabels: async (accountId, labelIds) => {
    const labelOrders = labelIds.map((id, index) => ({ id, sortOrder: index }));
    await updateUserLabelSortOrder(accountId, labelOrders);
    // Keep labels table sort_order in sync for Gmail
    if (isGmailAccount(accountId)) {
      await updateLabelSortOrder(accountId, labelOrders);
    }
    await get().loadLabels(accountId);
    await get()._reloadAccountLabels(accountId);
  },

  _reloadAccountLabels: async (accountId: string) => {
    try {
      const rows = await getUserLabelsForAccount(accountId);
      const labels = mapUserLabels(rows);
      set((s) => ({ allAccountLabels: { ...s.allAccountLabels, [accountId]: labels } }));
    } catch { /* silent */ }
  },
}));
