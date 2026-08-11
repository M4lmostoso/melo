/**
 * Close the window this webview lives in — without tearing the WKWebView down
 * from inside its own render/callback stack.
 *
 * macOS crash (0.1.7 on macOS 26.5): destroying a secondary WKWebView while its
 * CVDisplayLink is still driving RemoteLayerTreeDrawingAreaProxy::didRefreshDisplay
 * makes WebKit dereference the already-freed ScrollingTree of the closed page
 * (SIGSEGV in WebCore::ScrollingTree::takePendingScrollUpdates, main thread).
 * That kills the whole app, not just the window — every webview lives in the
 * same UI process.
 *
 * Hiding first stops the display link for that page; deferring the close gets us
 * out of the current run-loop turn before the window is destroyed.
 */

/** Delay between hide and close — one run-loop turn plus margin. */
const CLOSE_DEFER_MS = 120;

let closing = false;

/** Reset the in-flight guard (tests only). */
export function __resetCloseGuard(): void {
  closing = false;
}

export function closeSelfWindow(): void {
  if (closing) return;
  closing = true;

  import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      // Best-effort: a hide() failure must never leave the window open forever.
      await Promise.resolve(win.hide()).catch(() => {});
      setTimeout(() => {
        // destroy(), NOT close(): close() re-emits CloseRequested, and the
        // handlers that route the OS close through here call preventDefault —
        // the window would hide and then never actually go away.
        Promise.resolve(win.destroy()).catch((err) => {
          console.error("Failed to close window", err);
          closing = false;
        });
      }, CLOSE_DEFER_MS);
    })
    .catch(() => {
      // Non-Tauri context (plain browser / tests)
      closing = false;
      window.close();
    });
}
