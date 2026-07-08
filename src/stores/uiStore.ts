import { create } from "zustand";
import { setSetting } from "@/services/db/settings";
import { DEFAULT_COLOR_THEME, type ColorThemeId } from "@/constants/themes";
import type { FontFamilyId } from "@/constants/fonts";
import type { DbScheduledEmail } from "@/services/db/scheduledEmails";

type Theme = "light" | "dark" | "system";
type ReadingPanePosition = "right" | "bottom" | "hidden";
type ReadFilter = "all" | "read" | "unread";
export type EmailDensity = "compact" | "default" | "spacious";
export type DefaultReplyMode = "reply" | "replyAll";
export type MarkAsReadBehavior = "instant" | "2s" | "manual";
export type FontScale = "small" | "default" | "large" | "xlarge";
export type BackgroundMode = "flat" | "aurora" | "spotlight";
export type ComposerFontFamily = FontFamilyId;
export type AppFontFamily = FontFamilyId;
export type ComposerFontSize =
  | "10px"
  | "12px"
  | "14px"
  | "16px"
  | "18px"
  | "20px"
  | "24px";
export type InboxViewMode = "unified" | "split";
export type AccountSyncPhase = "idle" | "syncing" | "error";
export interface AccountSyncState {
  phase: AccountSyncPhase;
  error?: string;
  /** Epoch ms of the last sync that completed without error. */
  lastSyncedAt?: number;
  /**
   * Set by the watchdog when an account hasn't completed a successful sync for
   * far longer than the normal cadence — i.e. it looks silently stuck.
   */
  isStale?: boolean;
  /**
   * Messages the server listed but refused to serve during the last sync
   * (e.g. DavMail body stalls). Non-zero = mailbox not fully mirrored; surfaced
   * as a visible warning so incompleteness is never silent.
   */
  unfetchableCount?: number;
  /**
   * The OAuth refresh token was rejected (invalid_grant — revoked/expired).
   * Sync is dead until the user re-authorizes; surfaced as a prominent banner
   * instead of letting mail silently stop arriving.
   */
  needsReauth?: boolean;
}

export interface SidebarNavItem {
  id: string;
  visible: boolean;
}

interface UIState {
  theme: Theme;
  sidebarCollapsed: boolean;
  contactSidebarVisible: boolean;
  /** When set, the contact sidebar shows this specific contact instead of the
   *  thread's primary sender. Cleared when the sidebar is toggled via the action
   *  bar or when the open thread changes. */
  contactSidebarTarget: { email: string; name: string | null } | null;
  readingPanePosition: ReadingPanePosition;
  readFilter: ReadFilter;
  emailListWidth: number;
  emailDensity: EmailDensity;
  defaultReplyMode: DefaultReplyMode;
  markAsReadBehavior: MarkAsReadBehavior;
  fontScale: FontScale;
  appFontFamily: AppFontFamily;
  colorTheme: ColorThemeId;
  sendAndArchive: boolean;
  composerFontFamily: ComposerFontFamily;
  composerFontSize: ComposerFontSize;
  inboxViewMode: InboxViewMode;
  taskSidebarVisible: boolean;
  sidebarNavConfig: SidebarNavItem[] | null;
  backgroundMode: BackgroundMode;
  isOnline: boolean;
  pendingOpsCount: number;
  isSyncingFolder: string | null;
  accountSyncStatuses: Record<string, AccountSyncState>;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleContactSidebar: () => void;
  setContactSidebarVisible: (visible: boolean) => void;
  /** Open the contact sidebar focused on a specific contact (e.g. clicked in a
   *  message header). */
  openContactSidebar: (email: string, name: string | null) => void;
  setContactSidebarTarget: (target: { email: string; name: string | null } | null) => void;
  setReadingPanePosition: (position: ReadingPanePosition) => void;
  setReadFilter: (filter: ReadFilter) => void;
  setEmailListWidth: (width: number) => void;
  setEmailDensity: (density: EmailDensity) => void;
  setDefaultReplyMode: (mode: DefaultReplyMode) => void;
  setMarkAsReadBehavior: (behavior: MarkAsReadBehavior) => void;
  setFontScale: (scale: FontScale) => void;
  setAppFontFamily: (family: AppFontFamily) => void;
  setColorTheme: (theme: ColorThemeId) => void;
  setSendAndArchive: (enabled: boolean) => void;
  setComposerFontFamily: (family: ComposerFontFamily) => void;
  setComposerFontSize: (size: ComposerFontSize) => void;
  setInboxViewMode: (mode: InboxViewMode) => void;
  toggleTaskSidebar: () => void;
  setTaskSidebarVisible: (visible: boolean) => void;
  setSidebarNavConfig: (config: SidebarNavItem[]) => void;
  restoreSidebarNavConfig: (config: SidebarNavItem[]) => void;
  setBackgroundMode: (mode: BackgroundMode) => void;
  setOnline: (online: boolean) => void;
  setPendingOpsCount: (count: number) => void;
  setSyncingFolder: (folder: string | null) => void;
  setAccountSyncPhase: (accountId: string, phase: AccountSyncPhase, error?: string) => void;
  setAccountSyncHealth: (accountId: string, health: { lastSyncedAt?: number; unfetchableCount?: number; isStale?: boolean; needsReauth?: boolean }) => void;
  selectedScheduledEmail: DbScheduledEmail | null;
  setSelectedScheduledEmail: (email: DbScheduledEmail | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  theme: "system",
  sidebarCollapsed: false,
  contactSidebarVisible: true,
  contactSidebarTarget: null,
  readingPanePosition: "right",
  readFilter: "all",
  emailListWidth: 320,
  emailDensity: "default",
  defaultReplyMode: "reply",
  markAsReadBehavior: "instant",
  fontScale: "default",
  appFontFamily: "system",
  colorTheme: DEFAULT_COLOR_THEME,
  sendAndArchive: false,
  composerFontFamily: "system",
  composerFontSize: "14px",
  inboxViewMode: "unified",
  taskSidebarVisible: false,
  sidebarNavConfig: null,
  backgroundMode: "flat",
  isOnline: true,
  pendingOpsCount: 0,
  isSyncingFolder: null,
  accountSyncStatuses: {},
  selectedScheduledEmail: null,

  setTheme: (theme) => set({ theme }),
  toggleSidebar: () =>
    set((state) => {
      const collapsed = !state.sidebarCollapsed;
      setSetting("sidebar_collapsed", String(collapsed)).catch(() => {});
      return { sidebarCollapsed: collapsed };
    }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleContactSidebar: () =>
    set((state) => {
      const visible = !state.contactSidebarVisible;
      setSetting("contact_sidebar_visible", String(visible)).catch(() => {});
      // Toggling via the action bar always shows the thread's primary sender.
      return { contactSidebarVisible: visible, contactSidebarTarget: null };
    }),
  setContactSidebarVisible: (contactSidebarVisible) =>
    set({ contactSidebarVisible }),
  openContactSidebar: (email, name) =>
    set(() => {
      setSetting("contact_sidebar_visible", "true").catch(() => {});
      return { contactSidebarVisible: true, contactSidebarTarget: { email, name } };
    }),
  setContactSidebarTarget: (contactSidebarTarget) => set({ contactSidebarTarget }),
  setReadingPanePosition: (readingPanePosition) => {
    setSetting("reading_pane_position", readingPanePosition).catch(() => {});
    set({ readingPanePosition });
  },
  setReadFilter: (readFilter) => {
    setSetting("read_filter", readFilter).catch(() => {});
    set({ readFilter });
  },
  setEmailListWidth: (emailListWidth) => {
    setSetting("email_list_width", String(emailListWidth)).catch(() => {});
    set({ emailListWidth });
  },
  setEmailDensity: (emailDensity) => {
    setSetting("email_density", emailDensity).catch(() => {});
    set({ emailDensity });
  },
  setDefaultReplyMode: (defaultReplyMode) => {
    setSetting("default_reply_mode", defaultReplyMode).catch(() => {});
    set({ defaultReplyMode });
  },
  setMarkAsReadBehavior: (markAsReadBehavior) => {
    setSetting("mark_as_read_behavior", markAsReadBehavior).catch(() => {});
    set({ markAsReadBehavior });
  },
  setFontScale: (fontScale) => {
    setSetting("font_size", fontScale).catch(() => {});
    set({ fontScale });
  },
  setAppFontFamily: (appFontFamily) => {
    setSetting("app_font_family", appFontFamily).catch(() => {});
    set({ appFontFamily });
  },
  setColorTheme: (colorTheme) => {
    setSetting("color_theme", colorTheme).catch(() => {});
    set({ colorTheme });
  },
  setSendAndArchive: (sendAndArchive) => {
    setSetting("send_and_archive", String(sendAndArchive)).catch(() => {});
    set({ sendAndArchive });
  },
  setComposerFontFamily: (composerFontFamily) => {
    setSetting("composer_font_family", composerFontFamily).catch(() => {});
    set({ composerFontFamily });
  },
  setComposerFontSize: (composerFontSize) => {
    setSetting("composer_font_size", composerFontSize).catch(() => {});
    set({ composerFontSize });
  },
  setInboxViewMode: (inboxViewMode) => {
    setSetting("inbox_view_mode", inboxViewMode).catch(() => {});
    set({ inboxViewMode });
  },
  toggleTaskSidebar: () =>
    set((state) => {
      const visible = !state.taskSidebarVisible;
      setSetting("task_sidebar_visible", String(visible)).catch(() => {});
      return { taskSidebarVisible: visible };
    }),
  setTaskSidebarVisible: (taskSidebarVisible) => set({ taskSidebarVisible }),
  setSidebarNavConfig: (sidebarNavConfig) => {
    setSetting("sidebar_nav_config", JSON.stringify(sidebarNavConfig)).catch(
      () => {},
    );
    set({ sidebarNavConfig });
  },
  restoreSidebarNavConfig: (sidebarNavConfig) => set({ sidebarNavConfig }),
  setBackgroundMode: (backgroundMode) => {
    setSetting("background_mode", backgroundMode).catch(() => {});
    set({ backgroundMode });
  },
  setOnline: (isOnline) => set({ isOnline }),
  setPendingOpsCount: (pendingOpsCount) => set({ pendingOpsCount }),
  setSyncingFolder: (isSyncingFolder) => set({ isSyncingFolder }),
  setSelectedScheduledEmail: (selectedScheduledEmail) => set({ selectedScheduledEmail }),
  setAccountSyncPhase: (accountId, phase, error) =>
    set((state) => ({
      accountSyncStatuses: {
        ...state.accountSyncStatuses,
        // Preserve health fields (lastSyncedAt / unfetchableCount) across phase changes.
        [accountId]: { ...state.accountSyncStatuses[accountId], phase, error },
      },
    })),
  setAccountSyncHealth: (accountId, health) =>
    set((state) => ({
      accountSyncStatuses: {
        ...state.accountSyncStatuses,
        [accountId]: {
          phase: state.accountSyncStatuses[accountId]?.phase ?? "idle",
          ...state.accountSyncStatuses[accountId],
          ...health,
        },
      },
    })),
}));
