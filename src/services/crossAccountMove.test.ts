import { describe, it, expect, vi, beforeEach } from "vitest";
import { crossAccountMoveThreads, type CrossAccountMoveProgress } from "./crossAccountMove";

const mockDb = { select: vi.fn(), execute: vi.fn() };

vi.mock("./db/connection", () => ({ getDb: vi.fn(async () => mockDb) }));
vi.mock("./db/accounts", () => ({
  getAccount: vi.fn(async (id: string) => ({ id, provider: "imap", email: `${id}@x.test` })),
}));
vi.mock("./db/messages", () => ({ getMessagesForThread: vi.fn() }));
vi.mock("./db/pendingLabelAssignments", () => ({ addPendingLabelAssignments: vi.fn() }));
vi.mock("./imap/imapConfigBuilder", () => ({ buildImapConfig: vi.fn(() => ({ host: "h" })) }));
vi.mock("./imap/tauriCommands", () => ({
  imapFetchRawMessage: vi.fn(async () => "raw-bytes"),
  imapAppendMessage: vi.fn(async () => undefined),
  imapDeleteMessages: vi.fn(async () => undefined),
}));
vi.mock("./gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));
vi.mock("./gmail/syncManager", () => ({ triggerSync: vi.fn(async () => undefined) }));

import { getMessagesForThread } from "./db/messages";
import { imapAppendMessage, imapDeleteMessages } from "./imap/tauriCommands";

describe("crossAccountMoveThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockResolvedValue([]);
    mockDb.execute.mockResolvedValue(undefined);
  });

  it("reports progress per message and returns the moved/total counts", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One" },
      { id: "m2", imap_uid: 2, imap_folder: "INBOX", subject: "Two" },
    ] as never);

    const progress: CrossAccountMoveProgress[] = [];
    const result = await crossAccountMoveThreads("src", "dst", ["t1"], "inbox", (p) =>
      progress.push(p),
    );

    expect(result).toEqual({ moved: 2, total: 2 });
    expect(imapAppendMessage).toHaveBeenCalledTimes(2);
    expect(imapDeleteMessages).toHaveBeenCalledTimes(2);
    // Total is known before the first message leaves, so the UI can show a bar
    expect(progress[0]).toEqual({ done: 0, total: 2 });
    expect(progress).toContainEqual({ done: 0, total: 2, currentSubject: "One" });
    expect(progress[progress.length - 1]).toEqual({ done: 2, total: 2, currentSubject: "Two" });
  });

  it("counts a skipped message as not moved", async () => {
    // No imap_uid → cannot be fetched from the source, so it is skipped
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: null, imap_folder: "INBOX", subject: "Broken" },
      { id: "m2", imap_uid: 2, imap_folder: "INBOX", subject: "Fine" },
    ] as never);

    const result = await crossAccountMoveThreads("src", "dst", ["t1"]);

    expect(result).toEqual({ moved: 1, total: 2 });
    expect(imapAppendMessage).toHaveBeenCalledTimes(1);
  });
});
