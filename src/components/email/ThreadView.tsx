import { useEffect, useState, useRef, useCallback } from "react";
import { MessageItem } from "./MessageItem";
import { ActionBar } from "./ActionBar";
import {
  getMessagesForThread,
  type DbMessage,
} from "@/services/db/messages";
import { useAccountStore } from "@/stores/accountStore";
import { useUIStore } from "@/stores/uiStore";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { useLabelStore, isSystemLabel } from "@/stores/labelStore";
import { LabelBreadcrumb } from "@/components/labels/LabelBreadcrumb";
import { useComposerStore } from "@/stores/composerStore";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { markThreadRead, deleteSingleMessage } from "@/services/emailActions";
import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { getSetting } from "@/services/db/settings";
import { getAllowlistedSenders } from "@/services/db/imageAllowlist";
import { normalizeEmail, buildReplyAllRecipients, buildReplyRecipients } from "@/utils/emailUtils";
import { VolumeX, LockKeyhole } from "lucide-react";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { restoreRemoteImages } from "@/utils/imageBlocker";
import { isNoReplyAddress } from "@/utils/noReply";
import { getDefaultSignature } from "@/services/db/signatures";
import { ThreadSummary } from "./ThreadSummary";
import { SmartReplySuggestions } from "./SmartReplySuggestions";
import { InlineReply } from "./InlineReply";
import { ContactSidebar } from "./ContactSidebar";
import { TaskSidebar } from "@/components/tasks/TaskSidebar";
import { AiTaskExtractDialog } from "@/components/tasks/AiTaskExtractDialog";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { MessageSkeleton } from "@/components/ui/Skeleton";
import { RawMessageModal } from "./RawMessageModal";
import { t } from "@/i18n";

const INITIAL_MESSAGES_TO_SHOW = 20;

interface ThreadViewProps {
  thread: Thread;
}

async function handlePopOut(thread: Thread) {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const windowLabel = `thread-${thread.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const url = `index.html?thread=${encodeURIComponent(thread.id)}&account=${encodeURIComponent(thread.accountId)}`;

    // Check if window already exists
    const existing = await WebviewWindow.getByLabel(windowLabel);
    if (existing) {
      await existing.setFocus();
      return;
    }

    const win = new WebviewWindow(windowLabel, {
      url,
      title: thread.subject ?? "Thread",
      width: 1040,
      height: 700,
      center: true,
      dragDropEnabled: false,
      // @ts-ignore - titleBarStyle is valid for macOS in Tauri 2
      titleBarStyle: "Overlay",
    });

    win.once("tauri://error", (e) => {
      console.error("Failed to create pop-out window:", e);
    });
  } catch (err) {
    console.error("Failed to open pop-out window:", err);
  }
}

export function ThreadView({ thread }: ThreadViewProps) {
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  // In global/unified view activeAccountId is null; fall back to the thread's own account.
  const threadAccountId = activeAccountId ?? thread.accountId;
  const activeLabel = useActiveLabel();
  // In the Trash view show ONLY the messages actually trashed (is_trashed=1), so a thread
  // with some active + some trashed messages displays just the trashed part here.
  const trashedOnly = activeLabel === "trash";

  // Resolve user labels for this thread (exclude system labels like INBOX, SENT, …)
  const allAccountLabels = useLabelStore((s) => s.allAccountLabels);
  const singleAccountLabels = useLabelStore((s) => s.labels);
  const contactSidebarVisible = useUIStore((s) => s.contactSidebarVisible);
  const contactSidebarTarget = useUIStore((s) => s.contactSidebarTarget);
  const toggleContactSidebar = useUIStore((s) => s.toggleContactSidebar);
  const taskSidebarVisible = useUIStore((s) => s.taskSidebarVisible);
  const [showTaskExtract, setShowTaskExtract] = useState(false);
   const storeSelectedMessageId = useThreadStore((s) => s.selectedMessageId);
   const [messages, setMessages] = useState<DbMessage[]>([]);
   const [selectedMessageId, setLocalSelectedMessageId] = useState<string | null>(null);
   const storeSetSelectedMessageId = useThreadStore((s) => s.setSelectedMessageId);
   const setSelectedMessageId = useCallback((id: string | null) => {
     setLocalSelectedMessageId(id);
     storeSetSelectedMessageId(id);
   }, [storeSetSelectedMessageId]);
  const [loading, setLoading] = useState(true);
  // null = not yet loaded; defer iframe rendering until setting is known
  const [blockImages, setBlockImages] = useState<boolean | null>(null);
  const [allowlistedSenders, setAllowlistedSenders] = useState<Set<string>>(new Set());
  // label IDs that are mapped to an IMAP folder (for the lock icon)
  const [mappedLabelIds, setMappedLabelIds] = useState<Set<string>>(new Set());

  // Preload settings eagerly on mount (parallel with message loading)
  useEffect(() => {
    getSetting("block_remote_images").then((val) => setBlockImages(val !== "false"));
  }, []);

  // Load which labels for this thread have an IMAP folder mapping (for lock icon)
  useEffect(() => {
    let cancelled = false;
    import("@/services/db/folderLabelMappings").then(({ getAllFolderLabelMappings }) =>
      getAllFolderLabelMappings(thread.accountId),
    ).then((rows) => {
      if (!cancelled) {
        setMappedLabelIds(new Set(rows.map((r) => r.label_id)));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [thread.accountId]);

  // Load all messages for the thread immediately.
  useEffect(() => {
    setLoading(true);
    getMessagesForThread(threadAccountId, thread.id, false, trashedOnly)
      .then(async (msgs) => {
        setMessages(msgs);
        if (storeSelectedMessageId && msgs.some((m) => m.id === storeSelectedMessageId)) {
          setLocalSelectedMessageId(storeSelectedMessageId);
        }
        // If we got 0 messages in a non-trash view this thread's messages are likely
        // stuck with is_trashed=1 from a past migration bug. Trigger a re-sync so
        // the server labels are re-applied and the messages surface on next load.
        if (msgs.length === 0 && !trashedOnly) {
          try {
            const { triggerSync } = await import("@/services/gmail/syncManager");
            triggerSync([threadAccountId]);
          } catch { /* IMAP accounts — no-op */ }
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [threadAccountId, thread.id]);

  // Check per-sender allowlist (single batch query instead of N queries)
  useEffect(() => {
    if (messages.length === 0) return;
    let cancelled = false;

    const senders: string[] = [];
    for (const msg of messages) {
      if (msg.from_address) senders.push(msg.from_address);
    }
    const uniqueSenders = [...new Set(senders)];

    getAllowlistedSenders(threadAccountId, uniqueSenders).then((allowed) => {
      if (!cancelled) setAllowlistedSenders(allowed);
    });

    return () => { cancelled = true; };
  }, [threadAccountId, messages]);

  // Update selected message when store value changes (e.g., from citation click)
  useEffect(() => {
    if (storeSelectedMessageId && messages.some(m => m.id === storeSelectedMessageId)) {
      setLocalSelectedMessageId(storeSelectedMessageId);
    }
  }, [storeSelectedMessageId, messages]);

  // On-demand body load for messages stored without a body. This happens when a
  // message exceeded Gmail's format=full inline limit at sync time (body served via
  // attachmentId, not body.data) — provider.fetchMessage now completes those. Fires
  // from MessageItem only when both body_html and body_text are null (a truly empty
  // row), so ordinary text-only emails never trigger a needless re-fetch.
  const loadMissingBody = useCallback(async (msg: DbMessage) => {
    try {
      const { getEmailProvider } = await import("@/services/email/providerFactory");
      const provider = await getEmailProvider(msg.account_id);
      const parsed = await provider.fetchMessage(msg.id);
      if (parsed.bodyHtml == null && parsed.bodyText == null) return;
      const { getDb } = await import("@/services/db/connection");
      const db = await getDb();
      await db.execute(
        "UPDATE messages SET body_html = $1, body_text = $2, body_cached = $3 WHERE id = $4 AND account_id = $5",
        [parsed.bodyHtml, parsed.bodyText, parsed.bodyHtml != null ? 1 : 0, msg.id, msg.account_id],
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, body_html: parsed.bodyHtml, body_text: parsed.bodyText } : m,
        ),
      );
    } catch (err) {
      console.error("Failed to load message body on demand:", err);
    }
  }, []);

  const openComposer = useComposerStore((s) => s.openComposer);
  const openMenu = useContextMenuStore((s) => s.openMenu);
  const defaultReplyMode = useUIStore((s) => s.defaultReplyMode);
  const lastMessage = messages[messages.length - 1];

  const accounts = useAccountStore((s) => s.accounts);
  const activeAccount = accounts.find((a) => a.id === threadAccountId);
  const threadAccount = accounts.find((a) => a.id === thread.accountId);
  const accountLabels =
    allAccountLabels[thread.accountId] ??
    (singleAccountLabels.length > 0 && singleAccountLabels[0]?.accountId === thread.accountId
      ? singleAccountLabels
      : []);
  const threadUserLabels = accountLabels.filter(
    (l) => thread.labelIds.includes(l.id) && !isSystemLabel(l.id),
  );

// Get selected message - either explicitly selected or last message as fallback
  const selectedMessage = messages.find(m => m.id === selectedMessageId) || lastMessage;


  const handleReply = useCallback(async (msgOverride?: DbMessage) => {
    const msg = msgOverride ?? selectedMessage;
    if (!msg) return;
    // Replying to a message I sent targets its original recipients, not me.
    const { to: replyToList } = buildReplyRecipients({
      replyTo: msg.reply_to,
      fromAddress: msg.from_address,
      toHeader: msg.to_addresses,
      selfEmails: accounts.map((a) => a.email),
    });
    const msgIndex = messages.findIndex(m => m.id === msg.id);
    const quotedMessages = msgIndex >= 0 ? messages.slice(0, msgIndex + 1) : messages;
    const rfcMsgId = msg.message_id_header ?? null;
    const refs = rfcMsgId
      ? [msg.references_header, rfcMsgId].filter(Boolean).join(" ")
      : null;
    openComposer({
      mode: "reply",
      to: replyToList,
      subject: `Re: ${msg.subject ?? ""}`,
      quotedHtml: buildThreadQuote(quotedMessages),
      threadId: msg.thread_id,
      inReplyToMessageId: rfcMsgId,
      references: refs,
      accountId: thread.accountId,
    });
  }, [selectedMessage, openComposer, messages, thread.accountId, accounts]);

  const handleReplyAll = useCallback(async (msgOverride?: DbMessage) => {
    const msg = msgOverride ?? selectedMessage;
    if (!msg || !activeAccount) return;
    const replyTo = msg.reply_to ?? msg.from_address;
    // Parse address-list headers (not a naive split) so display names
    // containing commas (e.g. "Lastname, Firstname <email>") stay intact.
    const { to: replyAllTo, cc: ccList } = buildReplyAllRecipients({
      replyTo,
      toHeader: msg.to_addresses,
      ccHeader: msg.cc_addresses,
      selfEmails: accounts.map((a) => a.email),
    });

    const msgIndex = messages.findIndex(m => m.id === msg.id);
    const quotedMessages = msgIndex >= 0 ? messages.slice(0, msgIndex + 1) : messages;
    const rfcMsgId = msg.message_id_header ?? null;
    const refs = rfcMsgId
      ? [msg.references_header, rfcMsgId].filter(Boolean).join(" ")
      : null;

    openComposer({
      mode: "replyAll",
      to: replyAllTo,
      cc: ccList,
      subject: `Re: ${msg.subject ?? ""}`,
      quotedHtml: buildThreadQuote(quotedMessages),
      threadId: msg.thread_id,
      inReplyToMessageId: rfcMsgId,
      references: refs,
      accountId: thread.accountId,
    });
  }, [selectedMessage, openComposer, activeAccount, accounts, messages, thread.accountId]);

  const handleForward = useCallback(async (msgOverride?: DbMessage) => {
    // Guard against being invoked directly as an onClick handler (which would pass
    // a click event as msgOverride): only accept a real DbMessage.
    const override = msgOverride && "id" in msgOverride ? msgOverride : undefined;
    const msg = override ?? selectedMessage;
    if (!msg) return;
    const msgIndex = messages.findIndex(m => m.id === msg.id);
    const quotedMessages = msgIndex >= 0 ? messages.slice(0, msgIndex + 1) : messages;
    const rfcMsgId = msg.message_id_header ?? null;
    const refs = rfcMsgId
      ? [msg.references_header, rfcMsgId].filter(Boolean).join(" ")
      : null;
    openComposer({
      mode: "forward",
      to: [],
      subject: `Fwd: ${msg.subject ?? thread.subject ?? ""}`,
      quotedHtml: buildThreadForwardQuote(quotedMessages),
      threadId: msg.thread_id,
      inReplyToMessageId: rfcMsgId,
      references: refs,
      accountId: thread.accountId,
      forwardSourceMessageId: msg.id,
    });
  }, [selectedMessage, openComposer, messages, thread.accountId, thread.subject]);

const handlePrint = useCallback(async () => {
    if (messages.length === 0) {
      console.warn("No messages to print");
      return;
    }

    const messageToPrint = selectedMessage || lastMessage;
    if (!messageToPrint) return;

    const date = new Date(messageToPrint.date).toLocaleString();
    const from = messageToPrint.from_name
      ? `${escapeHtml(messageToPrint.from_name)} &lt;${escapeHtml(messageToPrint.from_address ?? "")}&gt;`
      : escapeHtml(messageToPrint.from_address ?? "Unknown");
    const to = escapeHtml(messageToPrint.to_addresses ?? "");
    const cc = messageToPrint.cc_addresses ? escapeHtml(messageToPrint.cc_addresses) : "";
    const body = messageToPrint.body_html ? sanitizeHtml(messageToPrint.body_html) : escapeHtml(messageToPrint.body_text ?? "");

    let signatureHtml = "";
    try {
      const sig = await getDefaultSignature(threadAccountId);
      if (sig) signatureHtml = sig.body_html;
    } catch {
      // ignore
    }

    const printHtml = `
      <div style="margin-bottom:16px;color:#666;font-size:12px">
        <strong>From:</strong> ${from}<br/>
        <strong>To:</strong> ${to}${cc ? `<br/><strong>Cc:</strong> ${cc}` : ''}<br/>
        <strong>Date:</strong> ${date}
      </div>
      <div style="font-size:14px;line-height:1.6">${body}${signatureHtml ? `<div style="margin-top:24px;border-top:1px solid #ddd;padding-top:12px">${signatureHtml}</div>` : ''}</div>
    `;

    const dateObj = new Date(messageToPrint.date);
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
    const dd = String(dateObj.getDate()).padStart(2, "0");
    const sender = messageToPrint.from_name || messageToPrint.from_address || "Unknown";
    const subjectTitle = messageToPrint.subject || thread.subject || "No Subject";
    const printTitle = `${yyyy}.${mm}.${dd} - ${sender} - ${subjectTitle}`;

    const safeSubject = escapeHtml(thread.subject ?? "");

    const printDiv = document.createElement("div");
    printDiv.id = "melo-print-content";
    printDiv.innerHTML = `
      <div style="margin-top: 0 !important; padding-top: 0 !important;">
        <h1 style="font-size:20px; margin-top: 0 !important; margin-bottom: 16px; border-bottom: 2px solid #333; padding-bottom: 8px;">${safeSubject || "(No subject)"}</h1>
        ${printHtml}
      </div>
    `;
    document.body.appendChild(printDiv);

    const style = document.createElement("style");
    style.id = "melo-print-styles";
    style.textContent = `
      @page {
        margin: 10mm 15mm 15mm 15mm !important; /* Applica i margini a TUTTE le pagine (Top Right Bottom Left) */
      }

      @media print {
        body > *:not(#melo-print-content) {
          display: none !important;
        }

        #melo-print-content {
          display: block !important;
          width: 100% !important;
          margin: 0 !important;
          padding: 0 !important; /* Rimuoviamo il padding che si applicava solo all'inizio e fine del blocco */
          box-sizing: border-box !important;
          background: white !important;
          color: black !important;
        }

        html, body {
          background: white !important;
          background-image: none !important;
          overflow: visible !important;
          height: auto !important;
          min-height: auto !important;
          position: static !important;
          margin: 0 !important;
          padding: 0 !important;
        }

        #melo-print-content img {
          max-width: 100% !important;
          height: auto !important;
        }
      }

      @media screen {
        #melo-print-content { display: none !important; }
      }
    `;
    document.head.appendChild(style);

    const oldTitle = document.title;
    document.title = printTitle;

    setTimeout(() => {
      try {
        window.print();
      } catch (err) {
        console.error("Print failed:", err);
      }
    }, 250);

    const cleanup = () => {
      const printContent = document.getElementById("melo-print-content");
      const printStyles = document.getElementById("melo-print-styles");
      if (printContent) printContent.remove();
      if (printStyles) printStyles.remove();
      document.title = oldTitle;
      window.removeEventListener("afterprint", cleanup);
    };

    window.addEventListener("afterprint", cleanup);
    // Increased to 5 minutes so it doesn't destroy the DOM before "Save as PDF" completes
    setTimeout(cleanup, 300000);
  }, [messages, thread.subject, selectedMessage, lastMessage, threadAccountId]);

  // Message-level keyboard navigation (ArrowUp / ArrowDown)
  const [focusedMsgIdx, setFocusedMsgIdx] = useState(-1);
  const messageRefs = useRef<(HTMLDivElement | null)[]>([]);

  // Reset focused index when thread changes
  useEffect(() => {
    setFocusedMsgIdx(-1);
    setSelectedMessageId(null);
    // Reset any pinned contact so the sidebar reverts to this thread's sender.
    useUIStore.getState().setContactSidebarTarget(null);
  }, [thread.id]);

  // Scroll focused message into view
  useEffect(() => {
    if (focusedMsgIdx >= 0 && messageRefs.current[focusedMsgIdx]) {
      messageRefs.current[focusedMsgIdx]!.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focusedMsgIdx]);

  // Arrow key handler for message navigation (only in full-screen thread view)
  // In split-pane mode, arrows navigate the thread list instead (handled by useKeyboardShortcuts)
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  useEffect(() => {
    if (readingPanePosition !== "hidden") return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;
      if (isInputFocused) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedMsgIdx((prev) => {
          const next = prev + 1;
          return next < messages.length ? next : prev;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedMsgIdx((prev) => {
          const next = prev - 1;
          return next >= 0 ? next : prev;
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [messages.length, readingPanePosition]);

  const [visibleStart, setVisibleStart] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);

  // Reset visible window, stale refs, and scroll state when thread changes
  useEffect(() => {
    setVisibleStart(0);
    initialScrollDoneRef.current = false;
    messageRefs.current = [];
  }, [thread.id]);

  // On initial load, scroll so that message n-2 (third-to-last) is at the top.
  // We use a ResizeObserver because the last message's iframe loads asynchronously,
  // expanding scrollHeight after the initial render. We retry until scrollHeight is
  // large enough to reach the target offset, then disconnect.
  useEffect(() => {
    if (loading || messages.length < 3 || initialScrollDoneRef.current) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    // Scroll the third-to-last message to the top. When the last three messages
    // don't fill the viewport (e.g. short replies) the target can't reach the
    // very top — in that case clamp to the bottom so the latest messages are
    // still shown, instead of leaving the thread scrolled to the oldest ones.
    // While content is still loading we defer clamping (allowClamp=false) so a
    // not-yet-grown iframe isn't mistaken for a genuinely short message.
    const applyScroll = (allowClamp: boolean): boolean => {
      const targetEl = messageRefs.current[messages.length - 3];
      if (!targetEl) return false;
      const offset = targetEl.getBoundingClientRect().top - container.getBoundingClientRect().top;
      const maxScroll = container.scrollHeight - container.clientHeight;
      if (offset > maxScroll) {
        if (!allowClamp) return false;
        container.scrollTop = maxScroll;
      } else {
        container.scrollTop += offset;
      }
      initialScrollDoneRef.current = true;
      return true;
    };

    if (applyScroll(false)) return;

    // Content still loading — observe the container's children for size changes.
    // If the target can reach the top, commit immediately (snappy for long
    // messages). Otherwise, once resizes settle, commit a clamped scroll so
    // genuinely short trailing messages still land on the latest content.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (applyScroll(false)) {
        if (settleTimer) clearTimeout(settleTimer);
        observer.disconnect();
        return;
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        applyScroll(true);
        observer.disconnect();
      }, 300);
    });
    for (const child of container.children) observer.observe(child);

    return () => {
      if (settleTimer) clearTimeout(settleTimer);
      observer.disconnect();
    };
  }, [loading, messages.length]);

  // Compute visible slice — always shows last INITIAL_MESSAGES_TO_SHOW messages,
  // expanding upward when the user loads earlier messages.
  const visibleMessages = messages.length <= INITIAL_MESSAGES_TO_SHOW
    ? messages
    : messages.slice(messages.length - INITIAL_MESSAGES_TO_SHOW - visibleStart);

  const hiddenCount = messages.length - visibleMessages.length;

  const [rawMessageTarget, setRawMessageTarget] = useState<{
    messageId: string;
    accountId: string;
  } | null>(null);

  // Reload message list when a new message is sent within this thread (reply/forward)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { threadId: string };
      if (detail.threadId !== thread.id) return;
      getMessagesForThread(threadAccountId, thread.id, false, trashedOnly)
        .then(setMessages)
        .catch(console.error);
    };
    window.addEventListener("melo-message-sent", handler);
    return () => window.removeEventListener("melo-message-sent", handler);
  }, [thread.id, threadAccountId]);

  // Reload message list when a single message is deleted within this thread
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { messageId: string; threadId: string };
      if (detail.threadId !== thread.id) return;
      getMessagesForThread(threadAccountId, thread.id, false, trashedOnly)
        .then((msgs) => {
          setMessages(msgs);
          setSelectedMessageId(null);
        })
        .catch(console.error);
    };
    window.addEventListener("melo-message-deleted", handler);
    return () => window.removeEventListener("melo-message-deleted", handler);
  }, [thread.id, threadAccountId, setSelectedMessageId]);

  // Reload message list when a background sync completes, so a message that
  // arrives for this thread while it's already open (e.g. a bounce/NDR reply)
  // doesn't stay invisible until the component remounts.
  useEffect(() => {
    const handler = () => {
      getMessagesForThread(threadAccountId, thread.id, false, trashedOnly)
        .then(setMessages)
        .catch(console.error);
    };
    window.addEventListener("melo-sync-done", handler);
    return () => window.removeEventListener("melo-sync-done", handler);
  }, [thread.id, threadAccountId, trashedOnly]);

  // Listen for "View Source" event from context menu
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        messageId: string;
        accountId: string;
      };
      setRawMessageTarget(detail);
    };
    window.addEventListener("melo-view-raw-message", handler);
    return () => window.removeEventListener("melo-view-raw-message", handler);
  }, []);

  // Listen for extract-task event from keyboard shortcut
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { threadId: string } | undefined;
      if (detail?.threadId === thread.id) {
        setShowTaskExtract(true);
      }
    };
    window.addEventListener("melo-extract-task", handler);
    return () => window.removeEventListener("melo-extract-task", handler);
  }, [thread.id]);

  const handleMessageContextMenu = useCallback((e: React.MouseEvent, msg: DbMessage) => {
    e.preventDefault();
    openMenu("message", { x: e.clientX, y: e.clientY }, {
      messageId: msg.id,
      threadId: msg.thread_id,
      accountId: msg.account_id,
      fromAddress: msg.from_address,
      fromName: msg.from_name,
      replyTo: msg.reply_to,
      toAddresses: msg.to_addresses,
      ccAddresses: msg.cc_addresses,
      subject: msg.subject ?? thread.subject,
      date: msg.date,
      bodyHtml: msg.body_html,
      bodyText: msg.body_text,
    });
  }, [openMenu, thread.subject]);

  const handleExport = useCallback(async () => {
    if (messages.length === 0) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");

      const emlParts = messages.map((msg) => {
        const date = new Date(msg.date).toUTCString();
        const from = msg.from_name
          ? `${msg.from_name} <${msg.from_address}>`
          : (msg.from_address ?? "");
        const lines = [
          `From: ${from}`,
          `To: ${msg.to_addresses ?? ""}`,
          msg.cc_addresses ? `Cc: ${msg.cc_addresses}` : null,
          `Subject: ${msg.subject ?? ""}`,
          `Date: ${date}`,
          `Message-ID: <${msg.id}>`,
          `MIME-Version: 1.0`,
          `Content-Type: text/html; charset=UTF-8`,
          ``,
          msg.body_html ?? msg.body_text ?? "",
        ].filter((l): l is string => l !== null);
        return lines.join("\r\n");
      });

      const content = emlParts.join("\r\n\r\n");
      const defaultName = `${(thread.subject ?? "email").replace(/[^a-zA-Z0-9_-]/g, "_")}.eml`;

      const filePath = await save({
        defaultPath: defaultName,
        filters: [{ name: "Email", extensions: ["eml"] }],
      });
      if (filePath) {
        await writeTextFile(filePath, content);
      }
    } catch (err) {
      console.error("Failed to export thread:", err);
    }
  }, [messages, thread.subject]);

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <MessageSkeleton />
        <MessageSkeleton />
        <MessageSkeleton />
      </div>
    );
  }

  // Detect no-reply senders — disable reply buttons but still allow forward
  const noReply = isNoReplyAddress(lastMessage?.reply_to ?? lastMessage?.from_address);

  // The sidebar shows the contact clicked in a message header (target), falling
  // back to the thread's primary sender when opened via the action-bar toggle.
  const primarySender = selectedMessage?.from_address ?? null;
  const primarySenderName = selectedMessage?.from_name ?? null;
  const sidebarEmail = contactSidebarTarget?.email ?? primarySender;
  const sidebarName = contactSidebarTarget ? contactSidebarTarget.name : primarySenderName;

  return (
    <div className="flex h-full @container relative select-none">
      <div className="flex flex-col flex-1 min-w-0">
        {/* Unified action bar */}
        <ActionBar
          thread={thread}
          messages={messages}
          noReply={noReply}
          defaultReplyMode={defaultReplyMode}
          contactSidebarVisible={contactSidebarVisible}
          taskSidebarVisible={taskSidebarVisible}
          onReply={handleReply}
          onReplyAll={handleReplyAll}
          onForward={handleForward}
          onPrint={handlePrint}
          onExport={handleExport}
          onPopOut={() => handlePopOut(thread)}
          onToggleContactSidebar={toggleContactSidebar}
          onToggleTaskSidebar={() => useUIStore.getState().toggleTaskSidebar()}
        />

        {/* Thread subject */}
        <div data-tauri-drag-region className="px-6 py-3 border-b border-border-primary">
          <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            {thread.subject ?? t("threadView.noSubject")}
            {thread.isMuted && (
              <span className="text-warning shrink-0" title={t("threadView.muted")}>
                <VolumeX size={16} />
              </span>
            )}
          </h1>
          <div className="flex items-center justify-between mt-1 gap-4">
            <span className="text-xs text-text-tertiary shrink-0">
              {messages.length !== 1
                ? t("threadView.messageCountPlural", { count: messages.length })
                : t("threadView.messageCount", { count: messages.length })}
            </span>
            {threadUserLabels.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap justify-end">
                {threadUserLabels.map((label) => (
                  <span key={label.id} className="flex items-center gap-0.5">
                    {mappedLabelIds.has(label.id) && (
                      <span title={t("threadView.folderMapped")} className="shrink-0">
                        <LockKeyhole size={10} className="text-accent" />
                      </span>
                    )}
                    <LabelBreadcrumb
                      label={label}
                      accountColor={threadAccount?.color ?? label.colorBg}
                      onLeafClick={() => {}}
                    />
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* AI Summary */}
        <ThreadSummary
          threadId={thread.id}
          accountId={threadAccountId}
          messages={messages}
        />

        {/* Messages */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
          <ErrorBoundary name="MessageList">
            {hiddenCount > 0 && (
              <div className="px-6 py-3 border-b border-border-secondary">
                <button
                  onClick={() => setVisibleStart((s) => s + INITIAL_MESSAGES_TO_SHOW)}
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  {Math.min(hiddenCount, INITIAL_MESSAGES_TO_SHOW) !== 1
                    ? t("threadView.loadEarlierPlural", { count: Math.min(hiddenCount, INITIAL_MESSAGES_TO_SHOW), hidden: hiddenCount })
                    : t("threadView.loadEarlier", { count: Math.min(hiddenCount, INITIAL_MESSAGES_TO_SHOW), hidden: hiddenCount })}
                </button>
              </div>
            )}
            {visibleMessages.map((msg, i) => {
              const globalIdx = messages.length - visibleMessages.length + i;
              return (
                <MessageItem
                  key={msg.id}
                  ref={(el) => { messageRefs.current[globalIdx] = el; }}
                  message={msg}
                  isLast={globalIdx === messages.length - 1}
                  focused={globalIdx === focusedMsgIdx}
                  onSelect={setSelectedMessageId}
                  onNeedBody={() => loadMissingBody(msg)}
                  blockImages={blockImages}
                  senderAllowlisted={msg.from_address ? allowlistedSenders.has(normalizeEmail(msg.from_address)) : false}
                  isSpam={thread.labelIds.includes("SPAM")}
                  onContextMenu={(e) => handleMessageContextMenu(e, msg)}
                  onReply={() => handleReply(msg)}
                  onReplyAll={() => handleReplyAll(msg)}
                  onForward={() => handleForward(msg)}
                  onDelete={() => deleteSingleMessage(msg.account_id, msg.thread_id, msg.id).catch(console.error)}
                  onMarkRead={msg.is_read !== 1 ? () => {
                    markThreadRead(threadAccountId, thread.id, [msg.id], true).catch(console.error);
                    setMessages((prev) => prev.map((m) => m.id === msg.id ? { ...m, is_read: 1 } : m));
                  } : undefined}
                />
              );
            })}
          </ErrorBoundary>

          {/* Smart Reply Suggestions */}
          {messages.length > 0 && (
            <SmartReplySuggestions
              threadId={thread.id}
              accountId={threadAccountId}
              messages={messages}
              noReply={noReply}
            />
          )}

          {/* Inline Reply */}
          <InlineReply
            thread={thread}
            messages={messages}
            accountId={threadAccountId}
            noReply={noReply}
            onForward={(msg) => void handleForward(msg)}
            onSent={() => {
              getMessagesForThread(threadAccountId, thread.id, false, trashedOnly)
                .then(setMessages)
                .catch(console.error);
            }}
          />
        </div>
      </div>

      {/* Contact sidebar — overlay at narrow widths, inline at wide */}
      {contactSidebarVisible && sidebarEmail && (
        <>
          {/* Backdrop for overlay mode (narrow widths) */}
          <div
            className="absolute inset-0 z-10 bg-black/20 @[640px]:hidden"
            onClick={toggleContactSidebar}
          />
          <div className="absolute right-0 top-0 bottom-0 z-20 shadow-xl @[640px]:relative @[640px]:z-auto @[640px]:shadow-none">
            <ContactSidebar
              email={sidebarEmail}
              name={sidebarName}
              accountId={threadAccountId}
              onClose={toggleContactSidebar}
            />
          </div>
        </>
      )}

      {/* Task sidebar */}
      {taskSidebarVisible && (
        <TaskSidebar accountId={thread.accountId} threadId={thread.id} messages={messages} />
      )}

      {/* Raw message source modal */}
      {rawMessageTarget && (
        <RawMessageModal
          isOpen={true}
          onClose={() => setRawMessageTarget(null)}
          messageId={rawMessageTarget.messageId}
          accountId={rawMessageTarget.accountId}
        />
      )}

      {/* AI Task Extraction Dialog */}
      {showTaskExtract && (
        <AiTaskExtractDialog
          threadId={thread.id}
          accountId={threadAccountId}
          messages={messages}
          onClose={() => setShowTaskExtract(false)}
        />
      )}
    </div>
  );
}

function buildThreadQuote(msgs: DbMessage[]): string {
  if (msgs.length === 0) return "";
  return "<br><br>" + [...msgs].reverse().map(msg => {
    const date = new Date(msg.date).toLocaleString();
    const from = msg.from_name
      ? `${escapeHtml(msg.from_name)} &lt;${escapeHtml(msg.from_address ?? "")}&gt;`
      : escapeHtml(msg.from_address ?? "Unknown");
    const body = msg.body_html ? sanitizeHtml(msg.body_html) : escapeHtml(msg.body_text ?? "");
    return `<div style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;color:#666;margin-bottom:8px">On ${date}, ${from} wrote:<br>${body}</div>`;
  }).join("");
}

function buildThreadForwardQuote(msgs: DbMessage[]): string {
  if (msgs.length === 0) return "";
  // Newest message first (standard email forward convention)
  const parts = [...msgs].reverse().map(msg => {
    const date = new Date(msg.date).toLocaleString();
    // Restore blocked remote images so they appear correctly in the forwarded email
    const rawHtml = msg.body_html ? restoreRemoteImages(msg.body_html) : null;
    const body = rawHtml ? sanitizeHtml(rawHtml) : escapeHtml(msg.body_text ?? "");
    return `From: ${escapeHtml(msg.from_name ?? "")} &lt;${escapeHtml(msg.from_address ?? "")}&gt;<br>Date: ${date}<br>Subject: ${escapeHtml(msg.subject ?? "")}<br>To: ${escapeHtml(msg.to_addresses ?? "")}<br><br>${body}`;
  });
  return `<br><br>---------- Forwarded message ---------<br><br>${parts.join("<br><br>---------- Previous message ---------<br><br>")}`;
}
