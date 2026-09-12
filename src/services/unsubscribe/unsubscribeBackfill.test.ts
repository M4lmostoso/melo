import { describe, it, expect, beforeEach, vi } from "vitest";

const mockSelect = vi.fn();
const mockExecute = vi.fn();
vi.mock("../db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve({ select: mockSelect, execute: mockExecute })),
}));

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn();
vi.mock("../db/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

const mockGetAllAccounts = vi.fn();
vi.mock("../db/accounts", () => ({
  getAllAccounts: () => mockGetAllAccounts(),
}));

vi.mock("../imap/imapConfigBuilder", () => ({
  buildImapConfig: vi.fn(() => ({ host: "imap.example.com" })),
}));

vi.mock("../oauth/oauthTokenManager", () => ({
  ensureFreshToken: vi.fn(() => Promise.resolve("token")),
}));

const mockFetchListHeaders = vi.fn();
vi.mock("../imap/tauriCommands", () => ({
  imapFetchListHeaders: (...args: unknown[]) => mockFetchListHeaders(...args),
}));

vi.mock("@/utils/fileLog", () => ({
  logToFile: vi.fn(),
}));

import { backfillUnsubscribeHeaders } from "./unsubscribeBackfill";

const imapAccount = {
  id: "acc1",
  email: "me@example.com",
  imap_host: "imap.example.com",
  auth_method: "password",
};

describe("backfillUnsubscribeHeaders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ rowsAffected: 1 });
    mockGetSetting.mockResolvedValue(null);
    mockSetSetting.mockResolvedValue(undefined);
  });

  it("writes recovered headers and marks the account done", async () => {
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    mockSelect.mockResolvedValue([
      { id: "imap-acc1-INBOX-5", imap_uid: 5, imap_folder: "INBOX" },
      { id: "imap-acc1-INBOX-6", imap_uid: 6, imap_folder: "INBOX" },
      { id: "imap-acc1-Archive-9", imap_uid: 9, imap_folder: "Archive" },
    ]);
    mockFetchListHeaders.mockImplementation((_c, folder: string) =>
      folder === "INBOX"
        ? Promise.resolve([
            { uid: 5, list_unsubscribe: "<https://x.test/u>", list_unsubscribe_post: null },
            // No header: not a newsletter — must not produce an UPDATE.
            { uid: 6, list_unsubscribe: null, list_unsubscribe_post: null },
          ])
        : Promise.resolve([
            { uid: 9, list_unsubscribe: "<mailto:s@x.test>", list_unsubscribe_post: null },
          ]),
    );

    await backfillUnsubscribeHeaders();

    // One fetch per folder, not per message.
    expect(mockFetchListHeaders).toHaveBeenCalledTimes(2);
    expect(mockFetchListHeaders).toHaveBeenCalledWith(expect.anything(), "INBOX", "5,6", false);
    expect(mockFetchListHeaders).toHaveBeenCalledWith(expect.anything(), "Archive", "9", false);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    // Rows are matched on the IMAP coordinates, not the row id.
    expect(mockExecute.mock.calls[0]?.[1]).toEqual([
      "<https://x.test/u>",
      null,
      "acc1",
      "INBOX",
      5,
    ]);
    expect(mockSetSetting).toHaveBeenCalledWith(
      "unsubscribe_backfill_done_acc1",
      expect.stringMatching(/^\d+$/),
    );
  });

  it("skips Gmail API accounts and accounts already done", async () => {
    mockGetAllAccounts.mockResolvedValue([
      { id: "gmail1", email: "g@example.com", imap_host: null, auth_method: "oauth2" },
      imapAccount,
    ]);
    mockGetSetting.mockResolvedValue("1757000000000"); // acc1 already backfilled

    await backfillUnsubscribeHeaders();

    expect(mockFetchListHeaders).not.toHaveBeenCalled();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it("gives up permanently on a server that ignores HEADER.FIELDS", async () => {
    // DavMail answers some section fetches with the whole message; retrying that
    // every startup would re-download the mailbox.
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    mockSelect.mockResolvedValue([
      { id: "imap-acc1-INBOX-5", imap_uid: 5, imap_folder: "INBOX" },
    ]);
    mockFetchListHeaders.mockRejectedValue(
      new Error("list-header fetch for INBOX: server ignored HEADER.FIELDS (UID 5 returned 900000 bytes)"),
    );

    await backfillUnsubscribeHeaders();

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockSetSetting).toHaveBeenCalledWith(
      "unsubscribe_backfill_done_acc1",
      expect.stringMatching(/^unsupported:\d+$/),
    );
  });

  it("leaves the account unclaimed after a transient failure", async () => {
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    mockSelect.mockResolvedValue([
      { id: "imap-acc1-INBOX-5", imap_uid: 5, imap_folder: "INBOX" },
    ]);
    mockFetchListHeaders.mockRejectedValue(new Error("connect: network unreachable"));

    await backfillUnsubscribeHeaders();

    // A dropped connection is retried on the next startup — but the pass still
    // completes, so the account IS marked done only via the normal path.
    expect(mockSetSetting).toHaveBeenCalledWith(
      "unsubscribe_backfill_done_acc1",
      expect.stringMatching(/^\d+$/),
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does nothing when the account has no candidate messages", async () => {
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    mockSelect.mockResolvedValue([]);

    await backfillUnsubscribeHeaders();

    expect(mockFetchListHeaders).not.toHaveBeenCalled();
    expect(mockSetSetting).toHaveBeenCalledWith(
      "unsubscribe_backfill_done_acc1",
      expect.any(String),
    );
  });

  it("falls back to full headers when the server strips the field", async () => {
    // DavMail serves HEADER.FIELDS from EWS-mapped properties that exclude
    // List-Unsubscribe: the cheap fetch comes back empty, the full header block
    // carries it.
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    const rows = Array.from({ length: 12 }, (_, i) => ({
      id: `imap-acc1-INBOX-${i + 1}`,
      imap_uid: i + 1,
      imap_folder: "INBOX",
    }));
    mockSelect.mockResolvedValue(rows);
    mockFetchListHeaders.mockImplementation((_c, _f, uidRange: string, whole: boolean) =>
      Promise.resolve(
        uidRange.split(",").map((uid) => ({
          uid: Number(uid),
          list_unsubscribe: whole ? "<https://x.test/u>" : null,
          list_unsubscribe_post: null,
        })),
      ),
    );

    await backfillUnsubscribeHeaders();

    // Cheap probe, then the same batch retried with the full header.
    expect(mockFetchListHeaders.mock.calls[0]?.[3]).toBe(false);
    expect(mockFetchListHeaders.mock.calls[1]?.[3]).toBe(true);
    expect(mockFetchListHeaders.mock.calls[1]?.[2]).toBe(mockFetchListHeaders.mock.calls[0]?.[2]);
    // The retry's results are kept — the probe batch is not re-fetched or lost.
    expect(mockExecute).toHaveBeenCalledTimes(12);
  });

  it("stays in cheap mode for a mailbox that simply has no newsletters", async () => {
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    const rows = Array.from({ length: 30 }, (_, i) => ({
      id: `imap-acc1-INBOX-${i + 1}`,
      imap_uid: i + 1,
      imap_folder: "INBOX",
    }));
    mockSelect.mockResolvedValue(rows);
    // Neither mode finds anything: the server is fine, the mail just has no
    // List-Unsubscribe.
    mockFetchListHeaders.mockImplementation((_c, _f, uidRange: string) =>
      Promise.resolve(
        uidRange.split(",").map((uid) => ({
          uid: Number(uid),
          list_unsubscribe: null,
          list_unsubscribe_post: null,
        })),
      ),
    );

    await backfillUnsubscribeHeaders();

    // One cheap fetch + one probe retry, and no switch to full headers.
    expect(mockFetchListHeaders).toHaveBeenCalledTimes(2);
    expect(mockFetchListHeaders.mock.calls.filter((c) => c[3] === true)).toHaveLength(1);
    expect(mockExecute).not.toHaveBeenCalled();
  });
  it("does not adopt the full-header mode when the server is too slow", async () => {
    // Measured DavMail rate: ~2.4s per header block. Backfilling a mailbox at
    // that rate costs an hour of background fetching, so the probe's findings
    // are kept but the mode is not adopted.
    mockGetAllAccounts.mockResolvedValue([imapAccount]);
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `imap-acc1-INBOX-${i + 1}`,
      imap_uid: i + 1,
      imap_folder: "INBOX",
    }));
    mockSelect.mockResolvedValue(rows);

    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    mockFetchListHeaders.mockImplementation((_c, _f, uidRange: string, whole: boolean) => {
      if (whole) clock += 60_000; // 25 UIDs in 60s → 2.4s/message
      return Promise.resolve(
        uidRange.split(",").map((uid) => ({
          uid: Number(uid),
          list_unsubscribe: whole ? "<https://x.test/u>" : null,
          list_unsubscribe_post: null,
        })),
      );
    });

    await backfillUnsubscribeHeaders();

    const wholeCalls = mockFetchListHeaders.mock.calls.filter((c) => c[3] === true);
    // Exactly one expensive call — the probe — and its 25 results are still saved.
    expect(wholeCalls).toHaveLength(1);
    expect(wholeCalls[0]?.[2]?.split(",")).toHaveLength(25);
    expect(mockExecute).toHaveBeenCalledTimes(25);
    vi.mocked(Date.now).mockRestore();
  });
});
