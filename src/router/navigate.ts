import { router } from "./index";

/** Known system labels that map to /mail/$label */
const SYSTEM_LABELS = new Set([
  "inbox", "starred", "snoozed", "sent", "drafts", "trash", "spam", "all",
  "unified-inbox",
]);

/**
 * Navigate to a label/view. Handles routing for system labels, custom labels,
 * smart folders, and special views (settings, calendar).
 */
export function navigateToLabel(
  label: string,
  opts?: { category?: string; threadId?: string },
): void {
  if (label === "settings") {
    router.navigate({ to: "/settings/$tab", params: { tab: "general" } });
    return;
  }

  if (label === "tasks") {
    router.navigate({ to: "/tasks" });
    return;
  }

  if (label === "attachments") {
    router.navigate({ to: "/attachments" });
    return;
  }

  if (label === "calendar") {
    router.navigate({ to: "/calendar" });
    return;
  }

  if (label === "help") {
    router.navigate({ to: "/help/$topic", params: { topic: "getting-started" } });
    return;
  }

  // "No label" filter — threads with no user label assigned
  if (label === "__no_label__") {
    router.navigate({ to: "/label/$labelId", params: { labelId: "__no_label__" } });
    return;
  }

  // Label prefix filter — sentinel "prefix:<path>" navigates to /label/$labelId
  // where labelId encodes the prefix. EmailList detects and uses prefix-based queries.
  if (label.startsWith("prefix:")) {
    router.navigate({
      to: "/label/$labelId",
      params: { labelId: label },
    });
    return;
  }

  if (label.startsWith("smart-folder:")) {
    const folderId = label.replace("smart-folder:", "");
    if (opts?.threadId) {
      router.navigate({
        to: "/smart-folder/$folderId/thread/$threadId",
        params: { folderId, threadId: opts.threadId },
      });
    } else {
      router.navigate({
        to: "/smart-folder/$folderId",
        params: { folderId },
      });
    }
    return;
  }

  if (SYSTEM_LABELS.has(label)) {
    const search: Record<string, string> = {};
    if (opts?.category) search["category"] = opts.category;
    if (opts?.threadId) {
      router.navigate({
        to: "/mail/$label/thread/$threadId",
        params: { label, threadId: opts.threadId },
        search,
      });
    } else {
      router.navigate({
        to: "/mail/$label",
        params: { label },
        search,
      });
    }
    return;
  }

  // Custom user label
  if (opts?.threadId) {
    router.navigate({
      to: "/label/$labelId/thread/$threadId",
      params: { labelId: label, threadId: opts.threadId },
    });
  } else {
    router.navigate({
      to: "/label/$labelId",
      params: { labelId: label },
    });
  }
}

/**
 * Navigate to a thread within the current mail context.
 * Appends /thread/$threadId to the current route.
 */
export function navigateToThread(threadId: string): Promise<void> {
  const { location } = router.state;
  const pathname = location.pathname;

  // Already on a mail/$label route
  const mailMatch = pathname.match(/^\/mail\/([^/]+)/);
  if (mailMatch) {
    return router.navigate({
      to: "/mail/$label/thread/$threadId",
      params: { label: mailMatch[1]!, threadId },
      search: location.search as Record<string, string>,
    });
  }

  // On a custom label route — read decoded labelId from router state, not raw URL,
  // to avoid double-encoding when labelId contains special characters (e.g. "prefix:A/B").
  if (pathname.startsWith("/label/")) {
    const currentMatch = router.state.matches.find(
      (m) => m.routeId === "/label/$labelId" || m.routeId === "/label/$labelId/thread/$threadId",
    );
    const labelId = (currentMatch?.params as { labelId?: string } | undefined)?.labelId;
    if (labelId) {
      return router.navigate({
        to: "/label/$labelId/thread/$threadId",
        params: { labelId, threadId },
        search: location.search as Record<string, string>,
      });
    }
  }

  // On a smart folder route
  const sfMatch = pathname.match(/^\/smart-folder\/([^/]+)/);
  if (sfMatch) {
    return router.navigate({
      to: "/smart-folder/$folderId/thread/$threadId",
      params: { folderId: sfMatch[1]!, threadId },
      search: location.search as Record<string, string>,
    });
  }

  // Fallback: navigate to inbox with thread
  return router.navigate({
    to: "/mail/$label/thread/$threadId",
    params: { label: "inbox", threadId },
  });
}

/**
 * Navigate to settings with an optional tab.
 */
export function navigateToSettings(tab = "general"): void {
  router.navigate({ to: "/settings/$tab", params: { tab } });
}

/**
 * Navigate to help with an optional topic.
 */
export function navigateToHelp(topic = "getting-started"): void {
  router.navigate({ to: "/help/$topic", params: { topic } });
}

/**
 * Navigate back (deselect thread → go to parent list route).
 */
export function navigateBack(): Promise<void> {
  const { location } = router.state;
  const pathname = location.pathname;

  // If on a thread sub-route, go to parent
  const mailThreadMatch = pathname.match(/^\/mail\/([^/]+)\/thread\//);
  if (mailThreadMatch) {
    return router.navigate({
      to: "/mail/$label",
      params: { label: mailThreadMatch[1]! },
      search: location.search as Record<string, string>,
    });
  }

  const labelThreadMatch = pathname.match(/^\/label\/([^/]+)\/thread\//);
  if (labelThreadMatch) {
    return router.navigate({
      to: "/label/$labelId",
      params: { labelId: labelThreadMatch[1]! },
      search: location.search as Record<string, string>,
    });
  }

  const sfThreadMatch = pathname.match(/^\/smart-folder\/([^/]+)\/thread\//);
  if (sfThreadMatch) {
    return router.navigate({
      to: "/smart-folder/$folderId",
      params: { folderId: sfThreadMatch[1]! },
      search: location.search as Record<string, string>,
    });
  }

  // Not on a thread route — navigate to inbox
  return router.navigate({ to: "/mail/$label", params: { label: "inbox" } });
}

/**
 * Get the active label from the current router state (non-React helper).
 */
export function getActiveLabel(): string {
  const matches = router.state.matches;
  for (const match of matches) {
    if (match.routeId === "/mail/$label" || match.routeId === "/mail/$label/thread/$threadId") {
      return (match.params as { label: string }).label;
    }
    if (match.routeId === "/label/$labelId" || match.routeId === "/label/$labelId/thread/$threadId") {
      return (match.params as { labelId: string }).labelId;
    }
    if (match.routeId === "/smart-folder/$folderId" || match.routeId === "/smart-folder/$folderId/thread/$threadId") {
      return `smart-folder:${(match.params as { folderId: string }).folderId}`;
    }
    if (match.routeId === "/settings/$tab" || match.routeId === "/settings") {
      return "settings";
    }
    if (match.routeId === "/attachments") {
      return "attachments";
    }
    if (match.routeId === "/tasks") {
      return "tasks";
    }
    if (match.routeId === "/calendar") {
      return "calendar";
    }
    if (match.routeId === "/help/$topic" || match.routeId === "/help") {
      return "help";
    }
  }
  return "inbox";
}

/**
 * Get the selected thread ID from the current router state (non-React helper).
 */
export function getSelectedThreadId(): string | null {
  const matches = router.state.matches;
  for (const match of matches) {
    const params = match.params as Record<string, string>;
    if (params["threadId"]) {
      return params["threadId"];
    }
    // Fallback for ThreadWindow which uses "thread" param
    if (params["thread"]) {
      return params["thread"];
    }
  }
  return null;
}
