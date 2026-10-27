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
const mockTrashThread = vi.fn();
vi.mock("../emailActions", () => ({
  archiveThread: (...args: unknown[]) => mockArchiveThread(...args),
  trashThread: (...args: unknown[]) => mockTrashThread(...args),
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
  cleanupSenderMail,
  findUnsubscribeLinkInHtml,
  getSubscriptions,
  isUnsubscribeSuggested,
  type SubscriptionEntry,
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

    expect(result).toEqual({ method: "mailto", success: true, cleaned: 0 });
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

    expect(result).toEqual({ method: "http_post", success: true, cleaned: 1 });
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

    expect(result).toEqual({ method: "browser", success: true, cleaned: 0 });
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

describe("findUnsubscribeLinkInHtml", () => {
  it("finds an English footer link", () => {
    const html = `<p>Hi</p><a href="https://shop.example.com">Shop</a>
      <a href="https://list.example.com/u/123">Unsubscribe</a>`;
    expect(findUnsubscribeLinkInHtml(html)).toBe("https://list.example.com/u/123");
  });

  it("finds an Italian footer link", () => {
    const html = `<a href="https://news.example.it/x">Clicca qui per disiscriverti</a>`;
    expect(findUnsubscribeLinkInHtml(html)).toBe("https://news.example.it/x");
  });

  it("prefers a real opt-out link over a preference centre", () => {
    const html = `<a href="https://e.example.com/prefs">Manage your preferences</a>
      <a href="https://e.example.com/optout">Cancella l'iscrizione</a>`;
    expect(findUnsubscribeLinkInHtml(html)).toBe("https://e.example.com/optout");
  });

  it("falls back to a preference centre or an unsubscribe-looking URL", () => {
    expect(
      findUnsubscribeLinkInHtml(`<a href="https://e.example.com/prefs">Gestisci le preferenze</a>`),
    ).toBe("https://e.example.com/prefs");
    expect(
      findUnsubscribeLinkInHtml(`<a href="https://e.example.com/unsubscribe?u=1">click here</a>`),
    ).toBe("https://e.example.com/unsubscribe?u=1");
  });

  it("ignores non-http links and bodies without one", () => {
    expect(findUnsubscribeLinkInHtml(`<a href="javascript:void(0)">Unsubscribe</a>`)).toBeNull();
    expect(findUnsubscribeLinkInHtml(`<a href="https://example.com">Read more</a>`)).toBeNull();
  });
});

describe("executeUnsubscribe without a List-Unsubscribe header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockGetSetting.mockResolvedValue("false");
  });

  it("opens the opt-out link found in the body", async () => {
    mockSelect.mockResolvedValueOnce([
      { body_html: `<a href="https://news.example.com/bye">Unsubscribe</a>` },
    ]);
    mockOpenUrl.mockResolvedValue(undefined);

    const result = await executeUnsubscribe("acc1", "", "news@example.com", "News", null, null);

    expect(result).toEqual({ method: "browser_body", success: true, cleaned: 0 });
    expect(mockOpenUrl).toHaveBeenCalledWith("https://news.example.com/bye");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("fails cleanly when no cached body carries a link", async () => {
    mockSelect.mockResolvedValueOnce([]);

    const result = await executeUnsubscribe("acc1", "", "news@example.com", "News", null, null, "trash");

    expect(result.success).toBe(false);
    expect(mockOpenUrl).not.toHaveBeenCalled();
    expect(mockTrashThread).not.toHaveBeenCalled();
  });
});

describe("cleanupSenderMail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrashThread.mockResolvedValue({ ok: true });
  });

  it("trashes only threads made up of the sender's own mail", async () => {
    mockSelect.mockResolvedValue([{ thread_id: "t1", message_ids: "m1,m2" }]);

    const count = await cleanupSenderMail("acc1", "News@Example.com", "trash");

    expect(count).toBe(1);
    expect(mockTrashThread).toHaveBeenCalledWith("acc1", "t1", ["m1", "m2"]);
    expect(mockArchiveThread).not.toHaveBeenCalled();
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(sql).toContain("NOT EXISTS");
    expect(params).toEqual(["acc1", "news@example.com"]);
  });

  it("an explicit cleanup runs regardless of the auto-archive setting", async () => {
    mockGetSetting.mockResolvedValue("false");
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockSelect.mockResolvedValue([{ thread_id: "t1", message_ids: "m1" }]);

    const result = await executeUnsubscribe(
      "acc1", "", "news@example.com", "News",
      "<https://list.example.com/u>", "List-Unsubscribe=One-Click", "trash",
    );

    expect(result).toEqual({ method: "http_post", success: true, cleaned: 1 });
    expect(mockTrashThread).toHaveBeenCalledWith("acc1", "t1", ["m1"]);
  });

  it("'none' keeps the mail even with auto-archive on", async () => {
    mockGetSetting.mockResolvedValue("true");
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await executeUnsubscribe(
      "acc1", "", "news@example.com", "News",
      "<https://list.example.com/u>", "List-Unsubscribe=One-Click", "none",
    );

    expect(result.cleaned).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockArchiveThread).not.toHaveBeenCalled();
  });
});

describe("getSubscriptions", () => {
  it("passes 30/90-day windows in milliseconds", async () => {
    mockSelect.mockReset().mockResolvedValue([]);
    const now = 1_800_000_000_000;
    await getSubscriptions("acc1", now);
    const [sql, params] = mockSelect.mock.calls[0]!;
    expect(params).toEqual(["acc1", now - 30 * 86_400_000, now - 90 * 86_400_000]);
    // IMAP seconds must be normalised before comparing to the windows.
    expect(sql).toContain("m.date * 1000");
    expect(sql).toContain("'Promotions', 'Newsletters'");
  });
});

describe("isUnsubscribeSuggested", () => {
  const base: SubscriptionEntry = {
    from_address: "a@b.c", from_name: null, latest_unsubscribe_header: null,
    latest_unsubscribe_post: null, message_count: 10, count_30d: 3, count_90d: 8,
    read_count: 0, latest_date: 0, status: null,
  };
  it("flags a steady sender never opened", () => {
    expect(isUnsubscribeSuggested(base)).toBe(true);
  });
  it("does not flag opened, rare or already-unsubscribed senders", () => {
    expect(isUnsubscribeSuggested({ ...base, read_count: 1 })).toBe(false);
    expect(isUnsubscribeSuggested({ ...base, message_count: 2 })).toBe(false);
    expect(isUnsubscribeSuggested({ ...base, status: "unsubscribed" })).toBe(false);
  });
});
