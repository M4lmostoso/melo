import { useEffect } from "react";
import { closeSelfWindow } from "@/services/windowLifecycle";

/**
 * Intercept the OS close (Cmd+W / red traffic light) of a secondary window and
 * route it through closeSelfWindow(), which hides the webview before destroying
 * it. Letting the OS destroy a WKWebView while its display link is still running
 * can segfault WebKit's scrolling tree and take the whole app down — see
 * services/windowLifecycle.ts.
 *
 * Use only in windows that have no close prompt of their own (the composer runs
 * its save/discard prompt first and closes via closeComposer()).
 */
export function useDeferredWindowClose(): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    import("@tauri-apps/api/webviewWindow")
      .then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().onCloseRequested((event) => {
          event.preventDefault();
          closeSelfWindow();
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
