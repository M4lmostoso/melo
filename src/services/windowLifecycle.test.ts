import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { closeSelfWindow, __resetCloseGuard } from "./windowLifecycle";

const hide = vi.fn(() => Promise.resolve());
const close = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide, close }),
}));

describe("closeSelfWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hide.mockClear();
    close.mockClear();
    __resetCloseGuard();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the window before closing it", async () => {
    closeSelfWindow();
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));

    // Still open at this point — the close is deferred to a later run-loop turn
    expect(close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes even when hide() rejects", async () => {
    hide.mockRejectedValueOnce(new Error("no such window"));

    closeSelfWindow();
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(200);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores re-entrant calls while a close is in flight", async () => {
    closeSelfWindow();
    closeSelfWindow();
    closeSelfWindow();
    await vi.waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(200);

    expect(close).toHaveBeenCalledTimes(1);
  });
});
