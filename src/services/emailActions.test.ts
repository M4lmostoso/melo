import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies
vi.mock("@/stores/uiStore", () => ({
  useUIStore: {
    getState: vi.fn(() => ({ isOnline: true })),
  },
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: vi.fn(() => ({
      updateThread: vi.fn(),
      removeThread: vi.fn(),
    })),
  },
}));

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("@/services/db/pendingOperations", () => ({
  enqueuePendingOperation: vi.fn(() => Promise.resolve("op-1")),
}));

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(() => Promise.resolve()),
    select: vi.fn(() => Promise.resolve([] as unknown[])),
  },
}));

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
}));

vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(() => Promise.resolve()),
  navigateBack: vi.fn(() => Promise.resolve()),
  getSelectedThreadId: vi.fn(() => null),
}));

import { useUIStore } from "@/stores/uiStore";
import { useThreadStore } from "@/stores/threadStore";
import { getEmailProvider } from "@/services/email/providerFactory";
import { enqueuePendingOperation } from "@/services/db/pendingOperations";
import {
  archiveThread,
  trashThread,
  permanentDeleteThread,
  starThread,
  markThreadRead,
  spamThread,
  moveThread,
  executeEmailAction,
  executeQueuedAction,
  emptyTrash,
  trashAllSpam,
  markAllSpamRead,
  rfcMessageIdOfRaw,
} from "./emailActions";
import { navigateToThread, navigateBack, getSelectedThreadId } from "@/router/navigate";
import { createMockEmailProvider, createMockUIStoreState, createMockThreadStoreState } from "@/test/mocks";

const mockProvider = createMockEmailProvider();

/** base64url-encode a minimal raw email carrying the given Message-ID. */
function rawWithMessageId(id: string): string {
  const raw = `Message-ID: <${id}>\r\nFrom: a@b.c\r\nTo: d@e.f\r\nSubject: x\r\n\r\nbody`;
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const mockUpdateThread = vi.fn();
const mockRemoveThread = vi.fn();

describe("emailActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReset();
    mockDb.select.mockResolvedValue([]);
    mockDb.execute.mockReset();
    mockDb.execute.mockResolvedValue(undefined as never);
    vi.mocked(getEmailProvider).mockResolvedValue(mockProvider as never);
    vi.mocked(useUIStore.getState).mockReturnValue(createMockUIStoreState() as never);
    vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
      updateThread: mockUpdateThread,
      removeThread: mockRemoveThread,
    }) as never);
  });

  describe("online execution", () => {
    it("archives a thread via provider", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBeUndefined();
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
      expect(mockProvider.archive).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("trashes a thread via provider", async () => {
      const result = await trashThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(mockProvider.trash).toHaveBeenCalledWith("t1", ["m1"]);
    });

    it("stars a thread via provider", async () => {
      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: true });
      expect(mockProvider.star).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("marks thread read via provider", async () => {
      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isRead: true, unreadCount: 0 });
      expect(mockProvider.markRead).toHaveBeenCalledWith("t1", ["m1"], true);
    });

    it("reports spam via provider", async () => {
      const result = await spamThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(true);
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
      expect(mockProvider.spam).toHaveBeenCalledWith("t1", ["m1"], true);
    });
  });

  describe("queued sendMessage retry cleans up the leftover draft", () => {
    it("purges the local draft row after a successful retry", async () => {
      mockDb.select.mockResolvedValue([{ thread_id: "t1" }]);

      await executeQueuedAction("acct-1", "sendMessage", {
        rawBase64Url: "RAW",
        threadId: "t1",
        cleanupLocalDraftId: "local-draft-1",
      });

      expect(mockProvider.sendMessage).toHaveBeenCalledWith("RAW", "t1");
      // purgeDraftFromDb deletes the stranded draft message row by id.
      expect(mockDb.execute).toHaveBeenCalledWith(
        "DELETE FROM messages WHERE account_id = $1 AND id = $2",
        ["acct-1", "local-draft-1"],
      );
    });

    it("skips the resend when the message is already on the server", async () => {
      // Ambiguous SMTP failure: the server took the mail but the response never
      // came back. Re-sending would deliver a second copy.
      const raw = rawWithMessageId("dup-guard-1@melo.test");
      vi.mocked(mockProvider.isMessageOnServer!).mockResolvedValue(true);

      await executeQueuedAction("acct-1", "sendMessage", {
        rawBase64Url: raw,
        threadId: "t1",
        cleanupLocalDraftId: "local-draft-1",
      });

      expect(mockProvider.isMessageOnServer).toHaveBeenCalledWith("dup-guard-1@melo.test");
      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
      // The draft the failed send left behind is still cleaned up.
      expect(mockDb.execute).toHaveBeenCalledWith(
        "DELETE FROM messages WHERE account_id = $1 AND id = $2",
        ["acct-1", "local-draft-1"],
      );
    });

    it("skips the resend when a synced Sent copy already exists locally", async () => {
      const raw = rawWithMessageId("dup-guard-2@melo.test");
      mockDb.select.mockResolvedValue([{ id: "imap-acct-1-Sent-42" }]);

      await executeQueuedAction("acct-1", "sendMessage", { rawBase64Url: raw, threadId: "t1" });

      expect(mockProvider.sendMessage).not.toHaveBeenCalled();
      expect(mockProvider.isMessageOnServer).not.toHaveBeenCalled();
    });

    it("still sends when the server says the message is not there", async () => {
      const raw = rawWithMessageId("dup-guard-3@melo.test");
      vi.mocked(mockProvider.isMessageOnServer!).mockResolvedValue(false);

      await executeQueuedAction("acct-1", "sendMessage", { rawBase64Url: raw, threadId: "t1" });

      expect(mockProvider.sendMessage).toHaveBeenCalledWith(raw, "t1");
    });

    it("sends rather than dropping the email when the guard check itself fails", async () => {
      const raw = rawWithMessageId("dup-guard-4@melo.test");
      vi.mocked(mockProvider.isMessageOnServer!).mockRejectedValue(new Error("offline"));

      await executeQueuedAction("acct-1", "sendMessage", { rawBase64Url: raw, threadId: "t1" });

      expect(mockProvider.sendMessage).toHaveBeenCalledWith(raw, "t1");
    });

    it("does not touch any draft when no cleanup hints are present", async () => {
      await executeQueuedAction("acct-1", "sendMessage", {
        rawBase64Url: "RAW",
        threadId: "t1",
      });

      expect(mockProvider.sendMessage).toHaveBeenCalledWith("RAW", "t1");
      expect(mockProvider.deleteDraft).not.toHaveBeenCalled();
      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });

  describe("offline queueing", () => {
    beforeEach(() => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);
    });

    it("queues archive when offline", async () => {
      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(mockProvider.archive).not.toHaveBeenCalled();
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "archive",
        "t1",
        expect.objectContaining({ threadId: "t1", messageIds: ["m1"] }),
      );
    });

    it("still applies optimistic UI update when offline", async () => {
      await starThread("acct-1", "t1", ["m1"], true);
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: true });
    });
  });

  describe("network error → queue fallback", () => {
    it("queues on retryable network error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.archive.mockRejectedValueOnce(new Error("Failed to fetch"));

      const result = await archiveThread("acct-1", "t1", ["m1"]);
      expect(result.success).toBe(true);
      expect(result.queued).toBe(true);
      expect(enqueuePendingOperation).toHaveBeenCalled();
    });
  });

  describe("permanent error → revert", () => {
    it("reverts star on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.star.mockRejectedValueOnce(new Error("Invalid request"));

      const result = await starThread("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      // Revert: set starred to false
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isStarred: false });
    });

    it("reverts markRead on permanent error", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockProvider.markRead.mockRejectedValueOnce(new Error("Bad request"));

      const result = await markThreadRead("acct-1", "t1", ["m1"], true);
      expect(result.success).toBe(false);
      // Revert: set read to false
      expect(mockUpdateThread).toHaveBeenCalledWith("t1", { isRead: false });
    });
  });

  describe("auto-advance after removal", () => {
    const threads = [
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ];

    it("navigates to next thread when archiving the viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });

    it("navigates to previous thread when archiving the last thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t3");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t3", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("does not navigate when archiving a non-viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
    });

    it("navigates back (deselects) when archiving the only viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads: [{ id: "t1" }],
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t1", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
      // No sibling to advance to → deselect so the reading pane empties and the
      // deep-link safety net doesn't re-fetch the removed thread.
      expect(navigateBack).toHaveBeenCalled();
    });

    it("does not navigate back when trashing a non-viewed thread", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await archiveThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).not.toHaveBeenCalled();
      expect(navigateBack).not.toHaveBeenCalled();
    });

    it("navigates on trash action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await trashThread("acct-1", "t1", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("navigates on spam action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t1");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await spamThread("acct-1", "t1", ["m1"], true);
      expect(navigateToThread).toHaveBeenCalledWith("t2");
    });

    it("navigates on permanentDelete action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await permanentDeleteThread("acct-1", "t2", ["m1"]);
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });

    it("navigates on moveToFolder action", async () => {
      vi.mocked(getSelectedThreadId).mockReturnValue("t2");
      vi.mocked(useThreadStore.getState).mockReturnValue(createMockThreadStoreState({
        threads,
        updateThread: mockUpdateThread,
        removeThread: mockRemoveThread,
      }) as never);

      await moveThread("acct-1", "t2", ["m1"], "Archive");
      expect(navigateToThread).toHaveBeenCalledWith("t3");
    });
  });

  describe("bulk trash/spam actions", () => {
    it("emptyTrash permanently deletes trashed messages grouped by thread and removes fully-trashed threads", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      // 1st select: trashed messages; 2nd select: remaining count for thread t1 → 0
      mockDb.select
        .mockResolvedValueOnce([
          { id: "m1", thread_id: "t1" },
          { id: "m2", thread_id: "t1" },
        ])
        .mockResolvedValueOnce([{ cnt: 0 }]);

      const result = await emptyTrash(["acct-1"]);

      expect(result.success).toBe(true);
      expect(mockProvider.permanentDelete).toHaveBeenCalledWith("t1", ["m1", "m2"]);
      // Thread had no surviving messages → removed from store
      expect(mockRemoveThread).toHaveBeenCalledWith("t1");
    });

    it("emptyTrash issues ONE server delete for all threads and reports progress", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockDb.select
        .mockResolvedValueOnce([
          { id: "m1", thread_id: "t1" },
          { id: "m2", thread_id: "t2" },
          { id: "m3", thread_id: "t2" },
        ])
        .mockResolvedValueOnce([{ cnt: 0 }])
        .mockResolvedValueOnce([{ cnt: 0 }]);

      const progress: { phase: string; done: number; total: number }[] = [];
      const result = await emptyTrash(["acct-1"], (p) => progress.push(p));

      expect(result.success).toBe(true);
      // Single batched round-trip — not one connection per thread
      expect(mockProvider.permanentDelete).toHaveBeenCalledTimes(1);
      expect(mockProvider.permanentDelete).toHaveBeenCalledWith("t1", ["m1", "m2", "m3"]);
      expect(progress[0]).toEqual({ phase: "server", done: 0, total: 3 });
      expect(progress[progress.length - 1]).toEqual({ phase: "local", done: 3, total: 3 });
      expect(result.data).toEqual({ deleted: 3, queued: false });
    });

    it("emptyTrash queues the permanent delete when offline", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: false } as never);
      mockDb.select
        .mockResolvedValueOnce([{ id: "m1", thread_id: "t1" }])
        .mockResolvedValueOnce([{ cnt: 0 }]);

      const result = await emptyTrash(["acct-1"]);

      expect(result.success).toBe(true);
      expect(mockProvider.permanentDelete).not.toHaveBeenCalled();
      expect(enqueuePendingOperation).toHaveBeenCalledWith(
        "acct-1",
        "permanentDelete",
        "t1",
        expect.objectContaining({ threadId: "t1", messageIds: ["m1"] }),
      );
    });

    it("trashAllSpam moves every spam thread to trash via provider", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockDb.select.mockResolvedValueOnce([
        { thread_id: "s1" },
        { thread_id: "s2" },
      ]);

      const result = await trashAllSpam(["acct-1"]);

      expect(result.success).toBe(true);
      expect(mockProvider.trash).toHaveBeenCalledWith("s1", []);
      expect(mockProvider.trash).toHaveBeenCalledWith("s2", []);
    });

    it("markAllSpamRead marks every spam thread read via provider", async () => {
      vi.mocked(useUIStore.getState).mockReturnValue({ isOnline: true } as never);
      mockDb.select.mockResolvedValueOnce([{ thread_id: "s1" }]);

      const result = await markAllSpamRead(["acct-1"]);

      expect(result.success).toBe(true);
      expect(mockProvider.markRead).toHaveBeenCalledWith("s1", [], true);
    });
  });

  describe("executeEmailAction with draft actions", () => {
    it("sends a message via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "sendMessage",
        rawBase64Url: "base64data",
        threadId: "t1",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.sendMessage).toHaveBeenCalledWith("base64data", "t1");
    });

    it("creates a draft via provider", async () => {
      const result = await executeEmailAction("acct-1", {
        type: "createDraft",
        rawBase64Url: "base64data",
      });
      expect(result.success).toBe(true);
      expect(mockProvider.createDraft).toHaveBeenCalledWith("base64data", undefined);
    });
  });
});

describe("rfcMessageIdOfRaw", () => {
  it("extracts the bare Message-ID from a base64url raw email", () => {
    expect(rfcMessageIdOfRaw(rawWithMessageId("abc@melo.test"))).toBe("abc@melo.test");
  });

  it("returns null for undecodable or header-less input", () => {
    expect(rfcMessageIdOfRaw("RAW")).toBeNull();
    expect(rfcMessageIdOfRaw(btoa("From: a@b.c\r\n\r\nbody"))).toBeNull();
  });
});
