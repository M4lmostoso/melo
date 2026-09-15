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

let closing = false;

/** Reset the in-flight guard (tests only). */
export function __resetCloseGuard(): void {
  closing = false;
}

/**
 * The hide → wait → destroy sequence runs in Rust (`close_window_deferred`).
 * It used to be a JS `setTimeout` scheduled right after `hide()` — but WebKit
 * suspends the timers of a hidden page, so the destroy never fired: every
 * closed thread/composer/preview window lingered invisible, and re-previewing
 * the same attachment just focused its hidden window (nothing appeared).
 */
export function closeSelfWindow(): void {
  if (closing) return;
  closing = true;

  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("close_window_deferred"))
    .catch(async (err) => {
      console.error("Deferred window close failed, destroying directly", err);
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        // destroy(), NOT close(): close() re-emits CloseRequested, and the
        // handlers that route the OS close through here call preventDefault —
        // the window would hide and then never actually go away.
        await getCurrentWindow().destroy();
      } catch {
        // Non-Tauri context (plain browser / tests)
        closing = false;
        window.close();
      }
    });
}
