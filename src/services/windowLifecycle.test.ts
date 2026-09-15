import { describe, it, expect, vi, beforeEach } from "vitest";
import { closeSelfWindow, __resetCloseGuard } from "./windowLifecycle";

const invoke = vi.fn((_cmd: string) => Promise.resolve());
const destroy = vi.fn(() => Promise.resolve());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invoke(cmd),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy }),
}));

describe("closeSelfWindow", () => {
  beforeEach(() => {
    invoke.mockClear();
    destroy.mockClear();
    __resetCloseGuard();
  });

  it("delegates hide-then-destroy to Rust (hidden webviews never fire JS timers)", async () => {
    closeSelfWindow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("close_window_deferred"));
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys directly when the Rust command fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("command not found"));

    closeSelfWindow();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
    err.mockRestore();
  });

  it("ignores re-entrant calls while a close is in flight", async () => {
    closeSelfWindow();
    closeSelfWindow();
    closeSelfWindow();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
