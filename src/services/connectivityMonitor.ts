import { useUIStore } from "@/stores/uiStore";

/**
 * navigator.onLine only reports link-layer connectivity: behind a captive
 * portal or a DNS black hole it stays true while every real request fails,
 * so sends skip the offline queue and fail against a dead network.
 *
 * This probe requests a known HTTPS endpoint. Over HTTPS a captive portal
 * cannot impersonate the host (TLS cert mismatch → fetch throws), so ANY
 * response — regardless of status — proves real internet connectivity.
 *
 * The request MUST go through the Tauri HTTP plugin, not the webview fetch:
 * generate_204 sends no CORS headers, so the webview rejects the response
 * and the probe reports "offline" against a perfectly working network.
 */
const PROBE_URL = "https://www.googleapis.com/generate_204";
const PROBE_TIMEOUT_MS = 10_000;
const REPROBE_INTERVAL_MS = 30_000;
const FAILURE_DEBOUNCE_MS = 15_000;

let reprobeTimer: ReturnType<typeof setInterval> | null = null;
let lastFailureProbeAt = 0;
let probing = false;
let lastActivityAt = 0;
let activityListenerStarted = false;

/** How recent observed network activity must be to count as proof of connectivity. */
const ACTIVITY_FRESH_MS = 10_000;

/**
 * Record proof of real network activity (e.g. attachment download bytes
 * arriving from Rust). If bytes are flowing, we ARE online — a failed probe
 * during a large download just means the link is saturated, and flipping to
 * offline mode mid-download is exactly the false positive this prevents.
 */
export function reportNetworkActivity(): void {
  lastActivityAt = Date.now();
  // Flowing bytes while flagged offline → recover through the standard path.
  if (!useUIStore.getState().isOnline && navigator.onLine) {
    stopReprobeLoop();
    console.info("[connectivity] download activity observed while flagged offline — back online");
    window.dispatchEvent(new Event("online"));
  }
}

function hasFreshActivity(): boolean {
  return Date.now() - lastActivityAt < ACTIVITY_FRESH_MS;
}

/**
 * Subscribe to Rust attachment-download progress events as a connectivity
 * signal. Called once from App startup; safe to call repeatedly.
 */
export function initConnectivityActivitySignal(): void {
  if (activityListenerStarted) return;
  activityListenerStarted = true;
  import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen("attachment-download-progress", () => reportNetworkActivity()),
    )
    .catch(() => {
      activityListenerStarted = false;
    });
}

export async function probeConnectivity(): Promise<boolean> {
  try {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await tauriFetch(PROBE_URL, { method: "GET", signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function startReprobeLoop(): void {
  if (reprobeTimer) return;
  reprobeTimer = setInterval(async () => {
    if (hasFreshActivity() || await probeConnectivity()) {
      stopReprobeLoop();
      console.info("[connectivity] probe succeeded — back online");
      // Reuse the app's full online-recovery path (queue flush, sync, IDLE).
      window.dispatchEvent(new Event("online"));
    }
  }, REPROBE_INTERVAL_MS);
}

function stopReprobeLoop(): void {
  if (reprobeTimer) {
    clearInterval(reprobeTimer);
    reprobeTimer = null;
  }
}

/**
 * Call when a network-classified operation failed while navigator.onLine is
 * still true. Debounced probe: on failure the app flips to offline mode (so
 * writes queue instead of failing) and a re-probe loop brings it back.
 */
export function reportNetworkFailure(): void {
  if (!navigator.onLine) return; // real offline — the 'offline' event handles it
  if (!useUIStore.getState().isOnline) return; // already flagged
  // Bytes are actively flowing (e.g. a large attachment download saturating the
  // link) — the failure is congestion, not a dead network. Don't even probe:
  // the probe itself would likely time out behind the download traffic.
  if (hasFreshActivity()) return;
  const now = Date.now();
  if (probing || now - lastFailureProbeAt < FAILURE_DEBOUNCE_MS) return;
  lastFailureProbeAt = now;
  probing = true;
  void probeConnectivity()
    .then((ok) => {
      if (!ok) {
        console.warn(
          "[connectivity] navigator.onLine=true but probe failed (captive portal / dead network) — switching to offline mode",
        );
        useUIStore.getState().setOnline(false);
        startReprobeLoop();
      }
    })
    .finally(() => {
      probing = false;
    });
}

/** Called from the real 'online' event path — stop any pending re-probe loop. */
export function notifyBackOnline(): void {
  stopReprobeLoop();
}
