import type { DbAttachment } from "@/services/db/attachments";

/**
 * Open the Quick Look-style attachment preview in a dedicated WebviewWindow
 * (label `preview-*`, entry: PreviewWindow.tsx via the `?preview=` URL param).
 * The new window loads the attachment row from SQLite by its DB id, so only
 * the id crosses the window boundary.
 *
 * Returns false when no Tauri context is available (tests / browser dev) —
 * the caller should fall back to the in-page modal. Window creation itself is
 * fire-and-forget, mirroring the composer pop-out.
 */
export function openAttachmentPreviewWindow(att: DbAttachment): boolean {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return false;
  }
  void (async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      // Tauri window labels only allow [a-zA-Z0-9-/:_] — sanitize the id.
      // Re-previewing the same attachment focuses its existing window.
      const label = `preview-${att.id.replace(/[^a-zA-Z0-9\-/:_]/g, "_")}`;
      const existing = await WebviewWindow.getByLabel(label).catch(() => null);
      if (existing) {
        await existing.setFocus();
        return;
      }
      const params = new URLSearchParams();
      params.set("preview", att.id);
      new WebviewWindow(label, {
        url: `index.html?${params.toString()}`,
        title: att.filename ?? "",
        width: 960,
        height: 720,
        center: true,
        // @ts-ignore - titleBarStyle is valid for macOS in Tauri 2
        titleBarStyle: "Overlay",
      });
    } catch (err) {
      console.error("Failed to open attachment preview window:", err);
    }
  })();
  return true;
}
