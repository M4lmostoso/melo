import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  registerActionTypes,
  onAction,
} from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSetting } from "../db/settings";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useComposerStore } from "../../stores/composerStore";
import { navigateToLabel } from "../../router/navigate";
import { normalizeEmail } from "@/utils/emailUtils";
import { playSound } from "../soundService";
import { t } from "@/i18n";

let initialized = false;
let notificationsEnabled = true;
// True once initNotifications has fully resolved (permission checked). Used to
// buffer notifications fired by the first sync cycle, which can run before init
// completes — without this they would silently no-op at the OS level.
let initCompleted = false;
type QueuedNotification = Parameters<typeof queueNewEmailNotification>;
const preInitBuffer: QueuedNotification[] = [];

/**
 * Diagnostic trail for "why didn't I get a notification?" — every suppression
 * decision is logged with its reason so misses are greppable in the console/log
 * output instead of being silent.
 */
export function logNotificationSuppressed(reason: string, detail?: string): void {
  console.info(`[notify] suppressed (${reason})${detail ? `: ${detail}` : ""}`);
}
// Tracks whether custom action types (Reply/Archive buttons) were successfully
// registered. On macOS, action buttons require "Alert" notification style; if
// registerActionTypes fails or the style isn't Alerts, fall back to "default"
// so the banner actually appears on the desktop instead of going to NC silently.
let actionTypesRegistered = false;

interface NotificationContext {
  threadId?: string;
  accountId?: string;
  fromAddress?: string;
  subject?: string;
  meetingUrl?: string;
}

let lastNotificationContext: NotificationContext | null = null;
const recentContexts = new Map<string, NotificationContext>();

async function showAndFocusMainWindow(): Promise<void> {
  const mainWindow = await WebviewWindow.getByLabel("main");
  if (mainWindow) {
    await mainWindow.show();
    await mainWindow.setFocus();
  }
}

/**
 * Initialize notification permissions and action types.
 */
export async function initNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const setting = await getSetting("notifications_enabled");
  notificationsEnabled = setting !== "false";

  if (!notificationsEnabled) {
    initCompleted = true;
    preInitBuffer.length = 0;
    logNotificationSuppressed("disabled in settings");
    return;
  }

  let granted = await isPermissionGranted();
  if (!granted) {
    const permission = await requestPermission();
    granted = permission === "granted";
  }

  if (!granted) {
    notificationsEnabled = false;
    initCompleted = true;
    preInitBuffer.length = 0;
    logNotificationSuppressed("OS permission denied");
    return;
  }

  // Register action types and handlers. NOTE: in tauri-plugin-notification these
  // commands (register_action_types / register_listener) exist only on mobile —
  // on desktop they throw "Command ... not found", so actionTypesRegistered stays
  // false and notify() sends plain (button-less) notifications. Action buttons such
  // as the calendar "Join" are therefore delivered via the in-app toast
  // (CalendarReminderToast), not the OS notification, on desktop.
  try {
    await registerActionTypes([
      {
        id: "default",
        actions: [],
      },
      {
        id: "email",
        actions: [
          { id: "reply", title: "Reply" },
          { id: "archive", title: "Archive" },
        ],
      },
      {
        id: "calendar",
        actions: [
          { id: "join", title: "Join" },
        ],
      },
      {
        id: "calendar-no-join",
        actions: [],
      },
    ]);
    actionTypesRegistered = true;

    await onAction(async (event) => {
      const actionId = event.actionTypeId;
      const ctx = lastNotificationContext;

      if (actionId === "join" && ctx?.meetingUrl) {
        openUrl(ctx.meetingUrl).catch((err) =>
          console.error("Failed to open meeting URL:", err),
        );
      } else if (actionId === "reply" && ctx?.threadId && ctx?.accountId) {
        await showAndFocusMainWindow();
        useComposerStore.getState().openComposer({
          mode: "reply",
          to: ctx.fromAddress ? [ctx.fromAddress] : [],
          subject: ctx.subject ? `Re: ${ctx.subject}` : "",
          threadId: ctx.threadId,
        });
      } else if (actionId === "archive" && ctx?.threadId && ctx?.accountId) {
        try {
          const { archiveThread } = await import("../emailActions");
          await archiveThread(ctx.accountId, ctx.threadId, []);
        } catch (err) {
          console.error("Failed to archive from notification:", err);
        }
      } else {
        await showAndFocusMainWindow();
        if (ctx?.threadId) {
          navigateToLabel("inbox", { threadId: ctx.threadId });
        }
      }
    });
  } catch {
    // Expected on desktop: register_action_types / register_listener are mobile-only,
    // so notifications are sent without action buttons (see note above).
  }

  // Flush notifications queued by a sync cycle that ran before init finished
  // (startup race: the first background sync starts before initNotifications).
  initCompleted = true;
  const buffered = preInitBuffer.splice(0, preInitBuffer.length);
  for (const args of buffered) queueNewEmailNotification(...args);
}

/**
 * Re-check the OS-level notification permission. macOS can revoke it after it
 * was granted (System Settings, Focus filters); without this the app would keep
 * silently dropping notifications forever. Called on window focus and from the
 * settings tab. Returns the effective state so the UI can show a warning.
 */
export async function recheckNotificationPermission(): Promise<{
  enabledInSettings: boolean;
  osPermissionGranted: boolean;
}> {
  const setting = await getSetting("notifications_enabled");
  const enabledInSettings = setting !== "false";
  let osPermissionGranted = false;
  try {
    osPermissionGranted = await isPermissionGranted();
  } catch {
    // Plugin unavailable (tests/browser) — treat as not granted, don't flip state.
    return { enabledInSettings, osPermissionGranted: notificationsEnabled };
  }
  const effective = enabledInSettings && osPermissionGranted;
  if (effective !== notificationsEnabled) {
    console.info(
      `[notify] permission re-check: notifications ${effective ? "re-enabled" : "disabled"} (settings=${enabledInSettings}, OS=${osPermissionGranted})`,
    );
    notificationsEnabled = effective;
  }
  return { enabledInSettings, osPermissionGranted };
}

/**
 * Send a desktop notification, attaching `actionTypeId` only when custom action
 * types actually registered. On macOS, sending a notification with an
 * UNREGISTERED actionTypeId silently drops it (it never reaches Notification
 * Center). registerActionTypes can fail (e.g. permission/style quirks), leaving
 * actionTypesRegistered=false — in that case we must send a plain notification
 * with no actionTypeId so it still appears, just without action buttons.
 */
function notify(opts: { title: string; body: string; actionTypeId?: string }): void {
  const { actionTypeId, ...rest } = opts;
  if (actionTypesRegistered && actionTypeId) {
    sendNotification({ ...rest, actionTypeId });
  } else {
    sendNotification(rest);
  }
}

/**
 * Show a notification for new emails.
 * Batches notifications to avoid spam during sync.
 */
let pendingCount = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function queueNewEmailNotification(
  from: string,
  subject: string,
  threadId?: string,
  accountId?: string,
  fromAddress?: string,
  snippet?: string,
): void {
  if (!initCompleted) {
    // Startup race: the first sync cycle can fire before initNotifications has
    // checked the OS permission — an immediate sendNotification would silently
    // no-op. Buffer and flush once init completes.
    preInitBuffer.push([from, subject, threadId, accountId, fromAddress, snippet]);
    return;
  }
  if (!notificationsEnabled) {
    logNotificationSuppressed("notifications disabled or OS permission missing", `from=${from} subject=${subject}`);
    return;
  }

  pendingCount++;

  // Store context for action handling
  const ctx = { threadId, accountId, fromAddress, subject };
  lastNotificationContext = ctx;
  if (threadId) recentContexts.set(threadId, ctx);

  // Play sound immediately (once per batch, debounced with the notification)
  if (!notifyTimer) void playSound("receive");

  // Debounce: wait 2s before showing, to batch during sync
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    if (pendingCount === 1) {
      // Title = sender name (shown bold on macOS, appears first); body = subject + snippet
      const bodyParts: string[] = [subject || "(No subject)"];
      if (snippet) {
        const preview = snippet.trim().slice(0, 200);
        bodyParts.push(preview);
      }
      notify({
        title: from,
        body: bodyParts.join("\n"),
        actionTypeId: "email",
      });
    } else if (pendingCount > 1) {
      notify({
        title: "Melo",
        body: `${pendingCount} new emails`,
        actionTypeId: "email",
      });
    }
    pendingCount = 0;
    notifyTimer = null;
  }, 2000);
}

/**
 * Determine if a new email should trigger a notification based on smart notification settings.
 * Pure function — no I/O, all config is passed in from the sync cycle.
 */
export function shouldNotifyForMessage(
  smartEnabled: boolean,
  allowedCategories: Set<string>,
  vipSenders: Set<string>,
  threadCategory: string | null,
  fromAddress?: string,
): boolean {
  if (!smartEnabled) return true; // Smart notifications off → notify everything
  if (fromAddress && vipSenders.has(normalizeEmail(fromAddress))) return true; // VIP always notifies
  const category = threadCategory ?? "Primary"; // uncategorized defaults to Primary
  return allowedCategories.has(category);
}

/**
 * Summary notification after a catch-up/full re-sync (Gmail HISTORY_EXPIRED
 * fallback, forced IMAP recovery). Those paths import mail without per-message
 * notifications — without this digest, everything that arrived during the gap
 * would land silently. Counts unread INBOX messages newer than the last
 * successful sync. Skipped for a first-ever sync (lastSyncAtSeconds null):
 * notifying about an entire just-imported mailbox would be noise.
 */
export async function notifySyncCatchUp(
  accountId: string,
  lastSyncAtSeconds: number | null,
): Promise<void> {
  if (!notificationsEnabled || !lastSyncAtSeconds) return;
  try {
    const { getDb } = await import("../db/connection");
    const db = await getDb();
    const rows = await db.select<{ count: number }[]>(
      `SELECT COUNT(DISTINCT m.id) as count
       FROM messages m
       INNER JOIN thread_labels tl
         ON tl.account_id = m.account_id AND tl.thread_id = m.thread_id
       WHERE m.account_id = $1 AND tl.label_id = 'INBOX'
         AND m.is_read = 0 AND m.internal_date > $2`,
      [accountId, lastSyncAtSeconds * 1000],
    );
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0) {
      void playSound("receive");
      notify({
        title: "Melo",
        body: t("notifications.syncCatchUp", { count }),
        actionTypeId: "email",
      });
    }
  } catch (err) {
    console.error("[notify] syncCatchUp failed:", err);
  }
}

/**
 * Show a notification for a follow-up reminder that fired.
 */
export function notifyFollowUpDue(
  subject: string,
  threadId?: string,
  accountId?: string,
): void {
  if (!notificationsEnabled) return;
  const ctx = { threadId, accountId, subject };
  lastNotificationContext = ctx;
  if (threadId) recentContexts.set(threadId, ctx);
  notify({
    title: "Follow up needed",
    body: subject || "(No subject)",
    actionTypeId: "email",
  });
}

/**
 * Show a notification for a snoozed email returning.
 */
export function notifySnoozeReturn(subject: string): void {
  if (!notificationsEnabled) return;
  notify({
    title: "Snoozed email returned",
    body: subject || "(No subject)",
  });
}

/**
 * Show a notification for an upcoming calendar event (5 minutes before start).
 * If a meeting URL is present, shows a "Join" action button.
 */
export function notifyUpcomingCalendarEvent(
  summary: string,
  meetingUrl: string | null,
): void {
  if (!notificationsEnabled) return;
  const ctx: NotificationContext = { subject: summary, meetingUrl: meetingUrl ?? undefined };
  lastNotificationContext = ctx;
  // The Join button only exists when action types registered; otherwise notify()
  // sends a plain (button-less) notification that still appears.
  notify({
    title: summary || t("calendar.reminder.eventFallback"),
    body: t("calendar.reminder.startingSoon"),
    actionTypeId: meetingUrl ? "calendar" : "calendar-no-join",
  });
}
