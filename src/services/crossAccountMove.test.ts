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
vi.mock("./imap/tauriCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./imap/tauriCommands")>()),
  imapFetchRawMessageBase64: vi.fn(async () => "cmF3LWJ5dGVz"),
  imapAppendMessage: vi.fn(async () => undefined),
  imapDeleteMessages: vi.fn(async () => undefined),
}));
vi.mock("./imap/messageHelper", () => ({ findSpecialFolder: vi.fn(async () => null) }));
vi.mock("./db/folderLabelMappings", () => ({ getLabelFolderMapping: vi.fn(async () => null) }));
vi.mock("./gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));
vi.mock("./gmail/syncManager", () => ({ triggerSync: vi.fn(async () => undefined) }));

import { getMessagesForThread } from "./db/messages";
import { imapAppendMessage, imapDeleteMessages } from "./imap/tauriCommands";
import { addPendingLabelAssignments } from "./db/pendingLabelAssignments";
import { getLabelFolderMapping } from "./db/folderLabelMappings";
import { findSpecialFolder } from "./imap/messageHelper";

describe("crossAccountMoveThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLabelFolderMapping).mockResolvedValue(null);
    vi.mocked(findSpecialFolder).mockResolvedValue(null);
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

  it("carries over the label the thread was dropped on in the target account", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One", message_id_header: "<a@b>" },
    ] as never);
    // 1st select: the drop target resolves to a real user label of the target
    // account; 2nd/3rd: the name-based carry-over lookup finds nothing.
    mockDb.select
      .mockResolvedValueOnce([{ id: "label-9" }])
      .mockResolvedValue([]);

    await crossAccountMoveThreads("src", "dst", ["t1"], "label-9");

    expect(addPendingLabelAssignments).toHaveBeenCalledWith("dst", "<a@b>", ["label-9"]);
  });

  it("appends into the folder the drop-target label is mapped to", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One", date: 1_700_000_000_000 },
    ] as never);
    mockDb.select.mockResolvedValueOnce([{ id: "label-9" }]).mockResolvedValue([]);
    vi.mocked(getLabelFolderMapping).mockResolvedValue("Archivio/2024");

    await crossAccountMoveThreads("src", "dst", ["t1"], "label-9");

    expect(imapAppendMessage).toHaveBeenCalledWith(
      expect.anything(), "Archivio/2024", expect.any(String), undefined, expect.any(String),
    );
  });

  it("files the thread into the folder a carried-over label is mapped to", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One", date: 1_700_000_000_000 },
    ] as never);
    // Dropped on the account itself ("inbox"), but the thread carries a label
    // that exists by name in the target and is mapped to a folder there.
    mockDb.select
      .mockResolvedValueOnce([{ name: "Progetti/BEE" }])
      .mockResolvedValueOnce([{ id: "label-bee", name: "Progetti/BEE" }])
      .mockResolvedValue([]);
    vi.mocked(getLabelFolderMapping).mockResolvedValue("INBOX.Progetti.BEE");

    await crossAccountMoveThreads("src", "dst", ["t1"], "inbox");

    expect(imapAppendMessage).toHaveBeenCalledWith(
      expect.anything(), "INBOX.Progetti.BEE", expect.any(String), undefined, expect.any(String),
    );
  });

  it("keeps an explicit system-folder drop even when a carried-over label is mapped", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One", date: 1_700_000_000_000 },
    ] as never);
    mockDb.select
      .mockResolvedValueOnce([{ name: "Progetti/BEE" }])
      .mockResolvedValueOnce([{ id: "label-bee", name: "Progetti/BEE" }])
      .mockResolvedValue([]);
    vi.mocked(getLabelFolderMapping).mockResolvedValue("INBOX.Progetti.BEE");
    vi.mocked(findSpecialFolder).mockResolvedValue("Cestino");

    await crossAccountMoveThreads("src", "dst", ["t1"], "trash");

    expect(imapAppendMessage).toHaveBeenCalledWith(
      expect.anything(), "Cestino", expect.any(String), undefined, expect.any(String),
    );
  });

  it("resolves system folder keys through the target's special-use folders", async () => {
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One", date: 1_700_000_000_000 },
    ] as never);
    vi.mocked(findSpecialFolder).mockResolvedValue("Posta inviata");

    await crossAccountMoveThreads("src", "dst", ["t1"], "sent");

    expect(findSpecialFolder).toHaveBeenCalledWith("dst", "\\Sent");
    expect(imapAppendMessage).toHaveBeenCalledWith(
      expect.anything(), "Posta inviata", expect.any(String), undefined, expect.any(String),
    );
  });

  it("preserves the original date as the INTERNALDATE and the read state as \\Seen", async () => {
    const date = new Date(2024, 1, 1, 9, 15, 30).getTime();
    vi.mocked(getMessagesForThread).mockResolvedValue([
      { id: "m1", imap_uid: 1, imap_folder: "INBOX", subject: "One", date, is_read: 1 },
    ] as never);

    await crossAccountMoveThreads("src", "dst", ["t1"], "inbox");

    expect(imapAppendMessage).toHaveBeenCalledWith(
      expect.anything(),
      "INBOX",
      expect.any(String),
      "(\\Seen)",
      expect.stringMatching(/^01-Feb-2024 09:15:30 [+-]\d{4}$/),
    );
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
