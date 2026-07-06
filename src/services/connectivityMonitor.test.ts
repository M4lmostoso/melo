import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUIStore } from "@/stores/uiStore";
import { reportNetworkActivity, reportNetworkFailure } from "./connectivityMonitor";

describe("connectivityMonitor activity signal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useUIStore.setState({ isOnline: true });
  });

  it("does not even probe when download bytes are flowing (saturated link ≠ offline)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("saturated"));

    reportNetworkActivity();
    reportNetworkFailure();

    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
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
