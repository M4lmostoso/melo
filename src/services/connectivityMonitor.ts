import { useUIStore } from "@/stores/uiStore";

/**
 * navigator.onLine only reports link-layer connectivity: behind a captive
 * portal or a DNS black hole it stays true while every real request fails,
 * so sends skip the offline queue and fail against a dead network.
 *
 * This probe requests a known HTTPS endpoint. Over HTTPS a captive portal
 * cannot impersonate the host (TLS cert mismatch → fetch throws), so ANY
 * response — regardless of status — proves real internet connectivity.
 */
const PROBE_URL = "https://www.googleapis.com/generate_204";
const PROBE_TIMEOUT_MS = 10_000;
const REPROBE_INTERVAL_MS = 30_000;
const FAILURE_DEBOUNCE_MS = 15_000;

let reprobeTimer: ReturnType<typeof setInterval> | null = null;
let lastFailureProbeAt = 0;
let probing = false;

export async function probeConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(PROBE_URL, { method: "GET", cache: "no-store", signal: controller.signal });
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
    if (await probeConnectivity()) {
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
