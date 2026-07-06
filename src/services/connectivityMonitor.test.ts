import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore } from "@/stores/uiStore";
import {
  probeConnectivity,
  reportNetworkActivity,
  reportNetworkFailure,
} from "./connectivityMonitor";

// The probe must use the Tauri HTTP plugin (Rust side, no webview CORS) —
// generate_204 has no CORS headers, so a webview fetch always rejects it.
const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

describe("connectivityMonitor activity signal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    tauriFetch.mockReset();
    useUIStore.setState({ isOnline: true });
  });

  it("does not even probe when download bytes are flowing (saturated link ≠ offline)", async () => {
    tauriFetch.mockRejectedValue(new Error("saturated"));

    reportNetworkActivity();
    reportNetworkFailure();

    await new Promise((r) => setTimeout(r, 20));
    expect(tauriFetch).not.toHaveBeenCalled();
    expect(useUIStore.getState().isOnline).toBe(true);
  });

  it("recovers to online when activity arrives while flagged offline", () => {
    useUIStore.setState({ isOnline: false });
    const onOnline = vi.fn();
    window.addEventListener("online", onOnline);

    reportNetworkActivity();

    expect(onOnline).toHaveBeenCalled();
    window.removeEventListener("online", onOnline);
  });
});

describe("probeConnectivity", () => {
  beforeEach(() => {
    tauriFetch.mockReset();
  });

  it("treats any response as online, even an opaque/error status", async () => {
    tauriFetch.mockResolvedValue({ status: 204 });
    await expect(probeConnectivity()).resolves.toBe(true);
    expect(tauriFetch).toHaveBeenCalledWith(
      "https://www.googleapis.com/generate_204",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reports offline when the request throws (dead network / TLS mismatch)", async () => {
    tauriFetch.mockRejectedValue(new Error("connection refused"));
    await expect(probeConnectivity()).resolves.toBe(false);
  });
});
