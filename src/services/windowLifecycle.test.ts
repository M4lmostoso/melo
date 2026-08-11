import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { closeSelfWindow, __resetCloseGuard } from "./windowLifecycle";

const hide = vi.fn(() => Promise.resolve());
const destroy = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide, destroy }),
}));

describe("closeSelfWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hide.mockClear();
    destroy.mockClear();
    __resetCloseGuard();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the window before destroying it", async () => {
    closeSelfWindow();
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));

    // Still alive at this point — the destroy is deferred to a later run-loop turn
    expect(destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys even when hide() rejects", async () => {
    hide.mockRejectedValueOnce(new Error("no such window"));

    closeSelfWindow();
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(200);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("ignores re-entrant calls while a close is in flight", async () => {
    closeSelfWindow();
    closeSelfWindow();
    closeSelfWindow();
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(200);

    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
