import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() calls are hoisted — must use inline factories, not external references
vi.mock("./tauriCommands", () => ({
  imapListFolders: vi.fn(),
  imapGetFolderStatus: vi.fn(),
  imapFetchMessages: vi.fn(),
  imapFetchNewUids: vi.fn(),
  imapSearchAllUids: vi.fn(),
  imapRawSearchAllUids: vi.fn(),
  imapSearchFolder: vi.fn(),
  imapDeltaCheck: vi.fn(),
  // Rust-backed fetch+store and thread finalization (the streaming sync path).
  imapFetchAndStore: vi.fn(),
  imapStoreThreads: vi.fn(async () => 0),
}));
vi.mock("./imapConfigBuilder", () => ({
  buildImapConfig: vi.fn(() => ({
    host: "imap.example.com",
    port: 993,
    security: "ssl",
    username: "user@example.com",
    password: "secret",
    auth_method: "password",
  })),
}));
vi.mock("./folderMapper", () => ({
  mapFolderToLabel: vi.fn((folder: { path: string }) => ({
    labelId: folder.path,
    labelName: folder.path,
    type: "user",
  })),
  getLabelsForMessage: vi.fn(
    (mapping: { labelId: string }, isRead: boolean, isStarred: boolean) => {
      const labels = [mapping.labelId];
      if (!isRead) labels.push("UNREAD");
      if (isStarred) labels.push("STARRED");
      return labels;
    },
  ),
  syncFoldersToLabels: vi.fn(),
  getSyncableFolders: vi.fn((folders: unknown[]) => folders),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
  updateMessageThreadIds: vi.fn(),
  deleteMessagesForFolder: vi.fn(),
  purgeImapDuplicates: vi.fn(async () => 0),
  purgeOrphanPlaceholderThreads: vi.fn(async () => 0),
  getStoredImapUidsForFolder: vi.fn(async () => []),
}));
vi.mock("../db/deletedImapUids", () => ({
  clearDeletedImapUidsForFolder: vi.fn(async () => {}),
  pruneDeletedImapUids: vi.fn(async () => {}),
  getDeletedImapUidsForFolder: vi.fn(async () => new Set<number>()),
}));
vi.mock("../db/unfetchableUids", () => ({
  getSkippedUidsForFolder: vi.fn(async () => new Set<number>()),
  recordUnfetchableAttempts: vi.fn(async () => {}),
  recordDuplicateUids: vi.fn(async () => {}),
  clearUnfetchableUids: vi.fn(async () => {}),
  pruneGoneUnfetchableUids: vi.fn(async () => {}),
  getUnfetchableCountForAccount: vi.fn(async () => 0),
  getUnfetchableMaxRetries: vi.fn(async () => 3),
}));
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(),
  setThreadLabels: vi.fn(),
  deleteThread: vi.fn(),
  recalculateThreadStats: vi.fn(),
  getThreadSubjectMap: vi.fn(async () => new Map()),
  getMutedThreadIds: vi.fn(async () => new Set<string>()),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  getAccount: vi.fn(),
  updateAccountSyncState: vi.fn(),
}));
vi.mock("../db/connection", () => ({
  withTransaction: vi.fn(async (fn: () => Promise<void>) => fn()),
  // mergeGroupsByRfcId / getThreadsWithExternalSenders query the DB directly; with no
  // real DB return no rows so threading proceeds on the in-memory groups alone.
  getDb: vi.fn(async () => ({
    select: vi.fn(async () => []),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
  })),
  executeAtomicBatch: vi.fn(async () => {}),
}));
vi.mock("../db/folderSyncState", () => ({
  upsertFolderSyncState: vi.fn(),
  getAllFolderSyncStates: vi.fn(),
}));
vi.mock("../db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn(() => []),
  getPendingOpResourceIds: vi.fn(async () => new Set()),
}));
vi.mock("@/services/ai/urgencyPipeline", () => ({
  processThreadUrgency: vi.fn(async () => {}),
}));

import { imapInitialSync, imapDeltaSync, formatImapDate, computeSinceDate, isConnectionError, isUnfetchableMessageError, reconcileDeletedMessages } from "./imapSync";
import {
  createMockImapAccount,
  createMockImapFolder,
  createMockImapFolderStatus,
} from "@/test/mocks";
import type { ImapSyncHeader } from "./tauriCommands";
import {
  imapListFolders,
  imapSearchFolder,
  imapFetchAndStore,
  imapStoreThreads,
  imapDeltaCheck,
  imapGetFolderStatus,
  imapSearchAllUids,
  imapRawSearchAllUids,
} from "./tauriCommands";
import { getAccount } from "../db/accounts";
import { getAllFolderSyncStates, upsertFolderSyncState } from "../db/folderSyncState";
import { deleteMessagesForFolder, getStoredImapUidsForFolder } from "../db/messages";
import { recordUnfetchableAttempts, recordDuplicateUids, getUnfetchableCountForAccount } from "../db/unfetchableUids";
import { getDb, executeAtomicBatch } from "../db/connection";

describe("imapInitialSync", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapFetchAndStore = vi.mocked(imapFetchAndStore);
  const mockImapStoreThreads = vi.mocked(imapStoreThreads);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapStoreThreads.mockResolvedValue(0);
  });

  afterEach(() => {
    mockImapSearchFolder.mockReset();
    mockImapFetchAndStore.mockReset();
    mockImapListFolders.mockReset();
    vi.useRealTimers();
  });

  /** Build an ImapSyncHeader as returned by the Rust imap_fetch_and_store command. */
  function makeHeader(uid: number, overrides: Partial<ImapSyncHeader> = {}): ImapSyncHeader {
    return {
      local_id: `imap-acc-1-INBOX-${uid}`,
      uid,
      message_id: `<m${uid}@test>`,
      in_reply_to: null,
      references: null,
      subject: `Subject ${uid}`,
      date: Math.floor(Date.now() / 1000),
      label_id: "INBOX",
      is_read: true,
      is_starred: false,
      is_draft: false,
      has_attachments: false,
      snippet: "snippet",
      from_address: "sender@test.com",
      from_name: "Sender",
      stored: true,
      ...overrides,
    };
  }

  /**
   * Configure mocks for a single folder: imapSearchFolder returns the UIDs and
   * imap_fetch_and_store returns the corresponding headers (Rust already wrote the
   * messages/attachments to SQLite, so it only returns header slices for threading).
   */
  function setupFolder(folder: string, headers: ImapSyncHeader[]) {
    const mockFolder = createMockImapFolder({ path: folder, raw_path: folder, exists: headers.length });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    mockImapSearchFolder.mockResolvedValue({
      uids: headers.map((h) => h.uid),
      folder_status: createMockImapFolderStatus({ exists: headers.length }),
    });
    mockImapFetchAndStore.mockResolvedValue(headers);
  }

  /** Run a sync to completion, flushing the internal inter-batch/inter-folder delays. */
  async function runSync(daysBack = 365, onProgress?: Parameters<typeof imapInitialSync>[2]) {
    const p = imapInitialSync("acc-1", daysBack, onProgress);
    await vi.runAllTimersAsync();
    return p;
  }

  it("fetches + stores messages per folder via imap_fetch_and_store", async () => {
    setupFolder("INBOX", [makeHeader(1), makeHeader(2)]);

    await runSync();

    // Rust does the IMAP fetch + DB write in one call; TS no longer upserts per-message.
    expect(mockImapFetchAndStore).toHaveBeenCalledTimes(1);
    expect(mockImapFetchAndStore).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "acc-1",
      "INBOX",
      "INBOX",
      [1, 2],
      expect.any(Number),
    );
  });

  it("returns an empty messages array (bodies are stored by Rust, not accumulated)", async () => {
    setupFolder("INBOX", [makeHeader(1)]);

    const result = await runSync();

    expect(result.messages).toEqual([]);
  });

  it("finalizes threads via imap_store_threads", async () => {
    setupFolder("INBOX", [makeHeader(1), makeHeader(2)]);

    await runSync();

    expect(mockImapStoreThreads).toHaveBeenCalledTimes(1);
    const [accountId, updates, allLocalIds] = mockImapStoreThreads.mock.calls[0]!;
    expect(accountId).toBe("acc-1");
    expect(updates.length).toBeGreaterThan(0);
    expect(allLocalIds).toEqual(
      expect.arrayContaining(["imap-acc-1-INBOX-1", "imap-acc-1-INBOX-2"]),
    );
  });

  it("passes a date cutoff to imap_fetch_and_store when daysBack > 0", async () => {
    setupFolder("INBOX", [makeHeader(1)]);

    await runSync(365);

    const cutoff = mockImapFetchAndStore.mock.calls[0]![5];
    expect(cutoff).toBeGreaterThan(0);
  });

  it("handles empty folders gracefully", async () => {
    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 0 });
    mockImapListFolders.mockResolvedValue([mockFolder]);

    const result = await runSync();

    expect(mockImapSearchFolder).not.toHaveBeenCalled();
    expect(mockImapFetchAndStore).not.toHaveBeenCalled();
    expect(result.messages).toEqual([]);
  });

  it("reports progress through all phases", async () => {
    setupFolder("INBOX", [makeHeader(1)]);

    const phases: string[] = [];
    await runSync(365, (progress) => phases.push(progress.phase));

    expect(phases).toContain("folders");
    expect(phases).toContain("messages");
    expect(phases).toContain("threading");
    expect(phases).toContain("storing_threads");
    expect(phases).toContain("done");
  });

  it("uses imapSearchFolder with a SINCE date filter", async () => {
    setupFolder("INBOX", [makeHeader(1)]);

    await runSync();

    expect(mockImapSearchFolder).toHaveBeenCalledTimes(1);
    expect(mockImapSearchFolder).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "INBOX",
      expect.stringMatching(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/),
    );
  });

  it("continues after a folder fetch error when another folder succeeds", async () => {
    const folders = [
      createMockImapFolder({ path: "f1", raw_path: "f1", exists: 1 }),
      createMockImapFolder({ path: "f2", raw_path: "f2", exists: 1 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockResolvedValue({
      uids: [1],
      folder_status: createMockImapFolderStatus({ exists: 1 }),
    });
    // First folder's fetch fails (non-connection error), second succeeds.
    mockImapFetchAndStore
      .mockRejectedValueOnce(new Error("PARSE failed"))
      .mockResolvedValueOnce([makeHeader(1)]);

    const result = await runSync();

    // Folder error is swallowed; the successful folder still gets its threads stored.
    expect(result.messages).toEqual([]);
    expect(mockImapStoreThreads).toHaveBeenCalledTimes(1);
  });

  it("isolates and skips a single unfetchable (poison) UID, keeping its neighbours", async () => {
    const POISON = 2;
    const mockFolder = createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 3 });
    mockImapListFolders.mockResolvedValue([mockFolder]);
    mockImapSearchFolder.mockResolvedValue({
      uids: [1, 2, 3],
      folder_status: createMockImapFolderStatus({ exists: 3 }),
    });
    // The server can never serve UID 2's body (DavMail-style stall). The whole
    // batch fails until the poison UID is isolated to a singleton, which is then
    // skipped — UIDs 1 and 3 must still be stored.
    mockImapFetchAndStore.mockImplementation(
      async (_config, _accountId, _folder, _labelId, uids: number[]) => {
        if (uids.includes(POISON)) {
          throw new Error(`read literal for UID ${POISON}: literal stalled: no data for 30s`);
        }
        return uids.map((u) => makeHeader(u));
      },
    );

    await runSync();

    expect(mockImapStoreThreads).toHaveBeenCalledTimes(1);
    const allLocalIds = mockImapStoreThreads.mock.calls[0]![2];
    expect(allLocalIds).toContain("imap-acc-1-INBOX-1");
    expect(allLocalIds).toContain("imap-acc-1-INBOX-3");
    expect(allLocalIds).not.toContain("imap-acc-1-INBOX-2");
  });

  it("circuit breaker skips remaining folders after 5 consecutive connection failures", async () => {
    const folders = Array.from({ length: 8 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue(new Error("TCP connect timed out (os error 60)"));

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(5);
  });

  it("circuit breaker resets on successful folder sync", async () => {
    const folders = [
      createMockImapFolder({ path: "f1", raw_path: "f1", exists: 10 }),
      createMockImapFolder({ path: "f2", raw_path: "f2", exists: 10 }),
      createMockImapFolder({ path: "f3", raw_path: "f3", exists: 10 }),
      createMockImapFolder({ path: "f4", raw_path: "f4", exists: 10 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);

    // First 2 fail with connection error, 3rd succeeds, 4th fails.
    mockImapSearchFolder
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockRejectedValueOnce(new Error("TCP connect timed out"))
      .mockResolvedValueOnce({
        uids: [1],
        folder_status: createMockImapFolderStatus({ exists: 1 }),
      })
      .mockRejectedValueOnce(new Error("TCP connect timed out"));
    mockImapFetchAndStore.mockResolvedValue([makeHeader(1, { label_id: "f3", local_id: "imap-acc-1-f3-1" })]);

    const syncPromise = imapInitialSync("acc-1");
    await vi.runAllTimersAsync();
    await syncPromise;

    // All 4 folders attempted (breaker reset after the success on f3).
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(4);
  });

  it("continues on non-connection errors without triggering circuit breaker", async () => {
    const folders = Array.from({ length: 6 }, (_, i) =>
      createMockImapFolder({ path: `folder-${i}`, raw_path: `folder-${i}`, exists: 10 }),
    );
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue(new Error("PARSE failed: invalid response"));

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
    expect(mockImapSearchFolder).toHaveBeenCalledTimes(6);
  });
});

describe("formatImapDate", () => {
  it("formats a date as DD-Mon-YYYY for IMAP SINCE criterion", () => {
    // 2024-03-15 UTC
    const date = new Date(Date.UTC(2024, 2, 15));
    expect(formatImapDate(date)).toBe("15-Mar-2024");
  });

  it("handles single-digit days without zero-padding", () => {
    const date = new Date(Date.UTC(2024, 0, 5));
    expect(formatImapDate(date)).toBe("5-Jan-2024");
  });

  it("handles December correctly", () => {
    const date = new Date(Date.UTC(2024, 11, 31));
    expect(formatImapDate(date)).toBe("31-Dec-2024");
  });
});

describe("computeSinceDate", () => {
  it("returns a date daysBack+1 days ago in DD-Mon-YYYY format", () => {
    const result = computeSinceDate(365);
    // Should match DD-Mon-YYYY format
    expect(result).toMatch(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/);
  });

  it("adds 1-day safety margin", () => {
    // For daysBack=0, should still go back 1 day
    const result = computeSinceDate(0);
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    expect(result).toBe(formatImapDate(yesterday));
  });
});

describe("isConnectionError", () => {
  it("detects 'timed out' errors", () => {
    expect(isConnectionError("TCP connect timed out (os error 60)")).toBe(true);
  });

  it("detects 'connection' errors", () => {
    expect(isConnectionError("connection reset by peer")).toBe(true);
  });

  it("detects TLS errors", () => {
    expect(isConnectionError("tls handshake failed")).toBe(true);
  });

  it("detects DNS errors", () => {
    expect(isConnectionError("dns resolution failed")).toBe(true);
  });

  it("detects ECONNREFUSED errors", () => {
    expect(isConnectionError("connect ECONNREFUSED 127.0.0.1:993")).toBe(true);
  });

  it("detects socket errors", () => {
    expect(isConnectionError("socket hang up")).toBe(true);
  });

  it("detects network errors", () => {
    expect(isConnectionError("network is unreachable")).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isConnectionError("PARSE failed: invalid response")).toBe(false);
    expect(isConnectionError("authentication failed")).toBe(false);
  });
});

describe("isUnfetchableMessageError", () => {
  it("detects a DavMail body stall", () => {
    expect(
      isUnfetchableMessageError("read literal for UID 11853: literal stalled: no data for 30s (12/45678 bytes)"),
    ).toBe(true);
  });

  it("detects a connection closed mid-literal", () => {
    expect(isUnfetchableMessageError("read literal for UID 7: connection closed mid-literal (3/9000 bytes)")).toBe(true);
  });

  it("does NOT treat transient connection errors as unfetchable", () => {
    expect(isUnfetchableMessageError("TCP connect timed out (os error 60)")).toBe(false);
    expect(isUnfetchableMessageError("connection reset by peer")).toBe(false);
    expect(isUnfetchableMessageError("socket hang up")).toBe(false);
  });
});

describe("imapInitialSync — all-folders-fail propagation", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
  });

  afterEach(() => {
    // Reset search mock implementation to prevent leaking into subsequent tests
    mockImapSearchFolder.mockReset();
    vi.useRealTimers();
  });

  it("throws when all folders fail and no messages were stored", async () => {
    const folders = [
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX", exists: 10 }),
      createMockImapFolder({ path: "Sent", raw_path: "Sent", exists: 5 }),
    ];
    mockImapListFolders.mockResolvedValue(folders);
    mockImapSearchFolder.mockRejectedValue("authentication failed");

    let caughtError: Error | null = null;
    const syncPromise = imapInitialSync("acc-1").catch((err: Error) => {
      caughtError = err;
    });
    await vi.runAllTimersAsync();
    await syncPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toContain("All folders failed to sync");
  });
});

describe("imapDeltaSync — UIDVALIDITY purge safety", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockImapSearchFolder = vi.mocked(imapSearchFolder);
  const mockImapGetFolderStatus = vi.mocked(imapGetFolderStatus);
  const mockImapSearchAllUids = vi.mocked(imapSearchAllUids);
  const mockDeleteMessagesForFolder = vi.mocked(deleteMessagesForFolder);
  const mockGetStoredImapUidsForFolder = vi.mocked(getStoredImapUidsForFolder);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapListFolders.mockResolvedValue([
      createMockImapFolder({ path: "INBOX", raw_path: "INBOX" }),
    ]);
    // One existing folder, previously synced with a valid UIDVALIDITY.
    mockGetAllFolderSyncStates.mockResolvedValue([
      {
        account_id: "acc-1",
        folder_path: "INBOX",
        uidvalidity: 100,
        last_uid: 50,
        modseq: null,
        last_sync_at: Math.floor(Date.now() / 1000),
      },
    ]);
    // Server reports UIDVALIDITY changed → folder would be purged & resynced.
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 999, new_uids: [], uidvalidity_changed: true },
    ]);
    // We still hold messages locally for this folder.
    mockGetStoredImapUidsForFolder.mockResolvedValue([
      { id: "imap-acc-1-INBOX-1", uid: 1 },
      { id: "imap-acc-1-INBOX-2", uid: 2 },
    ]);
  });

  it("does NOT purge the folder when the server search returns 0 UIDs (flaky/failed search)", async () => {
    // daysBack default (>0) → purge branch uses imapSearchFolder; simulate empty result.
    mockImapSearchFolder.mockResolvedValue({
      uids: [],
      folder_status: createMockImapFolderStatus({ uidvalidity: 999 }),
    });

    await imapDeltaSync("acc-1");

    expect(mockDeleteMessagesForFolder).not.toHaveBeenCalled();
  });

  it("does NOT purge the folder when the resync search itself throws", async () => {
    mockImapSearchFolder.mockRejectedValue(new Error("connection reset"));

    await imapDeltaSync("acc-1");

    expect(mockDeleteMessagesForFolder).not.toHaveBeenCalled();
  });

  it("DOES purge when the server genuinely returns UIDs for the changed folder", async () => {
    mockImapSearchFolder.mockResolvedValue({
      uids: [10, 11, 12],
      folder_status: createMockImapFolderStatus({ uidvalidity: 999 }),
    });
    mockImapGetFolderStatus.mockResolvedValue(createMockImapFolderStatus({ uidvalidity: 999 }));
    mockImapSearchAllUids.mockResolvedValue([10, 11, 12]);
    vi.mocked(imapFetchAndStore).mockResolvedValue([]);
    vi.mocked(imapStoreThreads).mockResolvedValue(0);

    await imapDeltaSync("acc-1");

    expect(mockDeleteMessagesForFolder).toHaveBeenCalledWith("acc-1", "INBOX");
  });
});

describe("imapDeltaSync — full reconcile (cursor reset to 0)", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockImapRawSearchAllUids = vi.mocked(imapRawSearchAllUids);
  const mockGetStoredImapUidsForFolder = vi.mocked(getStoredImapUidsForFolder);
  const mockImapFetchAndStore = vi.mocked(imapFetchAndStore);
  const mockUpsertFolderSyncState = vi.mocked(upsertFolderSyncState);
  const mockImapStoreThreads = vi.mocked(imapStoreThreads);

  function header(uid: number): ImapSyncHeader {
    return {
      local_id: `imap-acc-1-INBOX-${uid}`,
      uid,
      message_id: `<m${uid}@t>`,
      in_reply_to: null,
      references: null,
      subject: `S${uid}`,
      date: Math.floor(Date.now() / 1000),
      label_id: "INBOX",
      is_read: true,
      is_starred: false,
      is_draft: false,
      has_attachments: false,
      snippet: "s",
      from_address: "a@b.com",
      from_name: "A",
      stored: true,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-1" }));
    mockImapListFolders.mockResolvedValue([createMockImapFolder({ path: "INBOX", raw_path: "INBOX" })]);
    // Folder previously synced but cursor reset to 0 → needs a full reconcile.
    mockGetAllFolderSyncStates.mockResolvedValue([
      { account_id: "acc-1", folder_path: "INBOX", uidvalidity: 1, last_uid: 0, modseq: null, last_sync_at: Math.floor(Date.now() / 1000) },
    ]);
    mockImapStoreThreads.mockResolvedValue(0);
  });

  it("enumerates with SEARCH NOT DELETED and fetches only the UIDs missing locally", async () => {
    // Server has 5 messages; we already hold 1 and 3 (e.g. from an earlier
    // partial/truncated run). The DavMail range-search path must NOT be trusted.
    mockImapRawSearchAllUids.mockResolvedValue([1, 2, 3, 4, 5]);
    mockGetStoredImapUidsForFolder
      .mockResolvedValueOnce([
        { id: "imap-acc-1-INBOX-1", uid: 1 },
        { id: "imap-acc-1-INBOX-3", uid: 3 },
      ])
      // storedAfter (post-fetch): now everything present
      .mockResolvedValue([
        { id: "imap-acc-1-INBOX-1", uid: 1 },
        { id: "imap-acc-1-INBOX-2", uid: 2 },
        { id: "imap-acc-1-INBOX-3", uid: 3 },
        { id: "imap-acc-1-INBOX-4", uid: 4 },
        { id: "imap-acc-1-INBOX-5", uid: 5 },
      ]);
    mockImapFetchAndStore.mockResolvedValue([header(2), header(4), header(5)]);

    await imapDeltaSync("acc-1");

    // Only the missing UIDs [2,4,5] are fetched — never a range query.
    expect(mockImapFetchAndStore).toHaveBeenCalledTimes(1);
    expect(mockImapFetchAndStore).toHaveBeenCalledWith(
      expect.anything(), "acc-1", "INBOX", "INBOX", [2, 4, 5], expect.any(Number),
    );
    // delta_check ranged result is ignored on a full reconcile.
    expect(mockImapDeltaCheck).not.toHaveBeenCalled();
    // Cursor advanced to the server max so normal delta resumes next cycle.
    const persistedStates = mockUpsertFolderSyncState.mock.calls.map((c) => c[0]);
    expect(persistedStates).toContainEqual(
      expect.objectContaining({ folder_path: "INBOX", last_uid: 5 }),
    );
  });

  it("does NOT advance the cursor when enumeration returns 0 UIDs (resumable)", async () => {
    mockImapRawSearchAllUids.mockResolvedValue([]);
    mockGetStoredImapUidsForFolder.mockResolvedValue([{ id: "imap-acc-1-INBOX-1", uid: 1 }]);

    await imapDeltaSync("acc-1");

    expect(mockImapFetchAndStore).not.toHaveBeenCalled();
    // No folder state persisted → cursor stays 0 → reconcile retried next cycle.
    expect(mockUpsertFolderSyncState).not.toHaveBeenCalled();
  });

  it("reports unfetchableCount for messages the server won't serve (DavMail body stall)", async () => {
    // Server lists 1,2,3; we fetch but UID 2's body never comes (stall) so only
    // 1 and 3 end up stored. The gap must be surfaced, not silently dropped.
    mockImapRawSearchAllUids.mockResolvedValue([1, 2, 3]);
    mockGetStoredImapUidsForFolder
      .mockResolvedValueOnce([]) // before fetch: nothing stored
      .mockResolvedValue([
        { id: "imap-acc-1-INBOX-1", uid: 1 },
        { id: "imap-acc-1-INBOX-3", uid: 3 },
      ]); // after fetch: 2 still missing
    mockImapFetchAndStore.mockResolvedValue([header(1), header(3)]);
    // Simulate this UID having already reached the retry cap so it counts.
    vi.mocked(getUnfetchableCountForAccount).mockResolvedValue(1);

    const result = await imapDeltaSync("acc-1");

    // UID 2 stayed missing after a clean fetch → recorded as a failed attempt...
    expect(vi.mocked(recordUnfetchableAttempts)).toHaveBeenCalledWith("acc-1", "INBOX", [2]);
    // ...and the persistent skip-list count is surfaced for the UI.
    expect(result.unfetchableCount).toBe(1);
  });

  it("classifies served-but-deduped messages as duplicates, NOT unfetchable", async () => {
    // Server lists 1,2. Both are fetched fine, but UID 2's RFC Message-ID
    // already exists in another folder so the store layer dedups it: its
    // header comes back with stored=false and no row lands in this folder.
    // That must be recorded as a duplicate (skip future re-downloads), never
    // as a fetch failure — the server served it perfectly.
    mockImapRawSearchAllUids.mockResolvedValue([1, 2]);
    mockGetStoredImapUidsForFolder
      .mockResolvedValueOnce([]) // before fetch: nothing stored
      .mockResolvedValue([{ id: "imap-acc-1-INBOX-1", uid: 1 }]); // after: only UID 1 stored
    mockImapFetchAndStore.mockResolvedValue([
      header(1),
      { ...header(2), stored: false }, // dedup'd cross-folder duplicate
    ]);
    // Duplicates are excluded from the persistent unfetchable count.
    vi.mocked(getUnfetchableCountForAccount).mockResolvedValue(0);

    const result = await imapDeltaSync("acc-1");

    expect(vi.mocked(recordDuplicateUids)).toHaveBeenCalledWith("acc-1", "INBOX", [2]);
    expect(vi.mocked(recordUnfetchableAttempts)).toHaveBeenCalledWith("acc-1", "INBOX", []);
    expect(result.unfetchableCount).toBe(0);
  });
});

describe("imapDeltaSync — maintenance self-healing (DavMail range-miss quirk)", () => {
  const mockGetAccount = vi.mocked(getAccount);
  const mockImapListFolders = vi.mocked(imapListFolders);
  const mockGetAllFolderSyncStates = vi.mocked(getAllFolderSyncStates);
  const mockImapDeltaCheck = vi.mocked(imapDeltaCheck);
  const mockImapRawSearchAllUids = vi.mocked(imapRawSearchAllUids);
  const mockGetStoredImapUidsForFolder = vi.mocked(getStoredImapUidsForFolder);
  const mockImapFetchAndStore = vi.mocked(imapFetchAndStore);
  const mockImapStoreThreads = vi.mocked(imapStoreThreads);

  function header(uid: number): ImapSyncHeader {
    return {
      local_id: `imap-heal-INBOX-${uid}`, uid, message_id: `<m${uid}@t>`,
      in_reply_to: null, references: null, subject: `S${uid}`,
      date: Math.floor(Date.now() / 1000), label_id: "INBOX",
      is_read: true, is_starred: false, is_draft: false, has_attachments: false,
      snippet: "s", from_address: "a@b.com", from_name: "A", stored: true,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccount.mockResolvedValue(createMockImapAccount({ id: "acc-heal" }));
    mockImapListFolders.mockResolvedValue([createMockImapFolder({ path: "INBOX", raw_path: "INBOX" })]);
    // Healthy folder with an advanced cursor (normal delta operation).
    mockGetAllFolderSyncStates.mockResolvedValue([
      { account_id: "acc-heal", folder_path: "INBOX", uidvalidity: 1, last_uid: 50, modseq: null, last_sync_at: Math.floor(Date.now() / 1000) },
    ]);
    mockImapStoreThreads.mockResolvedValue(0);
  });

  it("catches a message the delta range search missed and fetches it via NOT DELETED diff", async () => {
    // The delta path (range search) reports nothing new — the DavMail quirk that
    // silently drops mail. But the authoritative NOT DELETED enumeration shows
    // UID 51 exists on the server. The maintenance self-heal must fetch it.
    mockImapDeltaCheck.mockResolvedValue([
      { folder: "INBOX", uidvalidity: 1, new_uids: [], uidvalidity_changed: false },
    ]);
    mockImapRawSearchAllUids.mockResolvedValue([50, 51]);
    mockGetStoredImapUidsForFolder
      .mockResolvedValueOnce([{ id: "imap-heal-INBOX-50", uid: 50 }]) // reconcileDeletedMessages
      .mockResolvedValueOnce([{ id: "imap-heal-INBOX-50", uid: 50 }]) // additions: before fetch
      .mockResolvedValue([
        { id: "imap-heal-INBOX-50", uid: 50 },
        { id: "imap-heal-INBOX-51", uid: 51 },
      ]); // additions: after fetch
    mockImapFetchAndStore.mockResolvedValue([header(51)]);

    // First delta call for a fresh account id === a maintenance cycle.
    await imapDeltaSync("acc-heal");

    expect(mockImapFetchAndStore).toHaveBeenCalledWith(
      expect.anything(), "acc-heal", "INBOX", "INBOX", [51], expect.any(Number),
    );
  });
});

describe("reconcileDeletedMessages — surviving-thread flag recompute", () => {
  const config = {
    host: "imap.example.com",
    port: 993,
    security: "ssl" as const,
    username: "user@example.com",
    password: "secret",
    auth_method: "password" as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: removing an orphaned message from a thread that still has other
  // messages must recompute the thread's is_read flag, not just message_count.
  // Otherwise, if the removed message was the unread one, is_read stays 0 on a
  // thread whose survivors are all read → phantom Inbox/badge count that no
  // message backs (the "unread" smart folder shows 0).
  it("recomputes is_read (not just message_count) for threads that survive the delete", async () => {
    vi.mocked(getStoredImapUidsForFolder).mockResolvedValue([
      { id: "imap-acc-INBOX-1", uid: 1 },
      { id: "imap-acc-INBOX-2", uid: 2 }, // uid 2 no longer on server → orphan
    ]);
    // Server still has uid 1 only.
    vi.mocked(imapRawSearchAllUids).mockResolvedValue([1]);

    // Affected thread query returns t1; surviving query ("NOT IN") returns t1 too.
    vi.mocked(getDb).mockResolvedValue({
      select: vi.fn(async (sql: string) =>
        sql.includes("NOT IN")
          ? [{ thread_id: "t1" }] // t1 survives the delete
          : [{ thread_id: "t1" }], // t1 is affected
      ),
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
    } as never);

    await reconcileDeletedMessages(config, "acc", "INBOX");

    expect(executeAtomicBatch).toHaveBeenCalledTimes(1);
    const statements = vi.mocked(executeAtomicBatch).mock.calls[0][0] as {
      sql: string;
    }[];
    const survivingUpdate = statements.find(
      (s) => s.sql.includes("UPDATE threads") && s.sql.includes("id IN"),
    );
    expect(survivingUpdate).toBeDefined();
    // The whole point of the fix: is_read is recomputed from surviving messages.
    expect(survivingUpdate!.sql).toContain("is_read = COALESCE");
    expect(survivingUpdate!.sql).toContain("MIN(is_read)");
    // ...alongside the message_count it already recomputed.
    expect(survivingUpdate!.sql).toContain("message_count = (SELECT COUNT(*)");
  });
});
