import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSelect = vi.fn();
const mockExecute = vi.fn();
vi.mock("../db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect, execute: mockExecute })),
}));

const mockGetSetting = vi.fn();
vi.mock("../db/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

const mockArchiveThread = vi.fn();
vi.mock("../emailActions", () => ({
  archiveThread: (...args: unknown[]) => mockArchiveThread(...args),
}));

const mockSendMessage = vi.fn();
vi.mock("../email/providerFactory", () => ({
  getEmailProvider: vi.fn(() => Promise.resolve({ sendMessage: mockSendMessage })),
}));

vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(() => Promise.resolve({ id: "acc1", email: "me@example.com" })),
}));

vi.mock("../../utils/emailBuilder", () => ({
  buildRawEmail: vi.fn(() => "cmF3"),
}));

const mockOpenUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));

const mockFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => mockFetch(...args),
}));

import {
  parseUnsubscribeHeaders,
  executeUnsubscribe,
  archiveAfterUnsubscribe,
} from "./unsubscribeManager";

describe("parseUnsubscribeHeaders", () => {
  it("keeps both targets of a real header", () => {
    // The exact shape the Rust raw-header reader now stores for IMAP mail.
    const parsed = parseUnsubscribeHeaders(
      "<https://list.example.com/u?id=a,b>, <mailto:stop@example.com?subject=unsub>",
      "List-Unsubscribe=One-Click",
    );
    expect(parsed.httpUrl).toBe("https://list.example.com/u?id=a,b");
    expect(parsed.mailtoAddress).toBe("stop@example.com?subject=unsub");
    expect(parsed.hasOneClick).toBe(true);
  });

  it("handles a mailto-only header", () => {
    const parsed = parseUnsubscribeHeaders("<mailto:stop@example.com>", null);
    expect(parsed.httpUrl).toBeNull();
    expect(parsed.mailtoAddress).toBe("stop@example.com");
    expect(parsed.hasOneClick).toBe(false);
  });
});

describe("archiveAfterUnsubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockArchiveThread.mockResolvedValue({ ok: true });
  });

  it("archives the sender's remaining inbox threads when enabled", async () => {
    mockGetSetting.mockResolvedValue("true");
    mockSelect.mockResolvedValue([
      { thread_id: "t1", message_ids: "m1,m2" },
      { thread_id: "t2", message_ids: "m3" },
    ]);

    const archived = await archiveAfterUnsubscribe("acc1", "News@Example.com");

    expect(archived).toBe(2);
    expect(mockArchiveThread).toHaveBeenCalledWith("acc1", "t1", ["m1", "m2"]);
    expect(mockArchiveThread).toHaveBeenCalledWith("acc1", "t2", ["m3"]);
    // Sender is matched case-insensitively.
    expect(mockSelect.mock.calls[0]?.[1]).toEqual(["acc1", "news@example.com"]);
  });

  it("does nothing when the setting is off", async () => {
    mockGetSetting.mockResolvedValue("false");
    const archived = await archiveAfterUnsubscribe("acc1", "news@example.com");
    expect(archived).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockArchiveThread).not.toHaveBeenCalled();
  });

  it("keeps going when one thread fails to archive", async () => {
    mockGetSetting.mockResolvedValue("true");
    mockSelect.mockResolvedValue([
      { thread_id: "t1", message_ids: "m1" },
      { thread_id: "t2", message_ids: "m2" },
    ]);
    mockArchiveThread.mockRejectedValueOnce(new Error("offline"));

    const archived = await archiveAfterUnsubscribe("acc1", "news@example.com");

    expect(archived).toBe(1);
    expect(mockArchiveThread).toHaveBeenCalledTimes(2);
  });
});

describe("executeUnsubscribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockSelect.mockResolvedValue([]);
    mockGetSetting.mockResolvedValue("false"); // auto-archive off unless a test asks
    mockArchiveThread.mockResolvedValue({ ok: true });
  });

  it("sends a mailto unsubscribe through the account's provider", async () => {
    // Regression: this path used getGmailClient directly, so on IMAP accounts a
    // mailto-only sender could not be unsubscribed from at all.
    mockSendMessage.mockResolvedValue({ id: "sent1" });

    const result = await executeUnsubscribe(
      "acc1",
      "t1",
      "news@example.com",
      "News",
      "<mailto:stop@example.com>",
      null,
    );

    expect(result).toEqual({ method: "mailto", success: true });
    expect(mockSendMessage).toHaveBeenCalledWith("cmF3");
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("prefers the RFC 8058 one-click POST and then cleans up", async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockGetSetting.mockResolvedValue("true");
    mockSelect.mockResolvedValue([{ thread_id: "t1", message_ids: "m1" }]);

    const result = await executeUnsubscribe(
      "acc1",
      "t1",
      "news@example.com",
      "News",
      "<https://list.example.com/u>, <mailto:stop@example.com>",
      "List-Unsubscribe=One-Click",
    );

    expect(result).toEqual({ method: "http_post", success: true });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockArchiveThread).toHaveBeenCalledWith("acc1", "t1", ["m1"]);
  });

  it("falls back to the browser and records the action when sending fails", async () => {
    mockSendMessage.mockRejectedValue(new Error("smtp down"));
    mockOpenUrl.mockResolvedValue(undefined);

    const result = await executeUnsubscribe(
      "acc1",
      "t1",
      "news@example.com",
      "News",
      "<https://list.example.com/u>, <mailto:stop@example.com>",
      null,
    );

    expect(result).toEqual({ method: "browser", success: true });
    expect(mockOpenUrl).toHaveBeenCalledWith("https://list.example.com/u");
    // The action is recorded regardless of which method won.
    expect(mockExecute).toHaveBeenCalled();
  });

  it("does not archive anything when every method fails", async () => {
    mockGetSetting.mockResolvedValue("true");
    mockSendMessage.mockRejectedValue(new Error("smtp down"));
    mockOpenUrl.mockRejectedValue(new Error("no browser"));

    const result = await executeUnsubscribe(
      "acc1",
      "t1",
      "news@example.com",
      "News",
      "<https://list.example.com/u>, <mailto:stop@example.com>",
      null,
    );

    expect(result.success).toBe(false);
    expect(mockArchiveThread).not.toHaveBeenCalled();
  });
});
