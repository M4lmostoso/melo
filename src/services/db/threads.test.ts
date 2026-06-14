import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
    withTransaction: vi.fn(async (fn: (db: any) => Promise<any>) => fn(mockDb)),
  };
});

import { getDb } from "@/services/db/connection";
import { muteThread, unmuteThread, getMutedThreadIds, deleteAllThreadsForAccount, recalculateThreadStats } from "./threads";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("threads service - recalculateThreadStats IMAP label derivation", () => {
  // Drives the IMAP branch by stubbing select() per SQL. Verifies that a message
  // trashed in-place (still in a non-Trash folder) does NOT keep its thread in
  // INBOX/SENT — which previously left a ghost thread rendering as "unknown sender".
  function stubSelect(opts: { nonTrashedFolderLabels: string[]; trashedCount: number }) {
    let capturedFolderSql = "";
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
    mockDb.select.mockImplementation((sql: string) => {
      if (sql.includes("gmail_label_ids FROM messages")) return Promise.resolve([]); // → IMAP branch
      if (sql.includes("l.imap_folder_path = m.imap_folder")) {
        capturedFolderSql = sql;
        return Promise.resolve(opts.nonTrashedFolderLabels.map((id) => ({ id })));
      }
      if (sql.includes("COUNT(*) AS n") && sql.includes("is_trashed = 1")) {
        return Promise.resolve([{ n: opts.trashedCount }]);
      }
      if (sql.includes("SELECT is_read, is_starred FROM threads")) {
        return Promise.resolve([{ is_read: 1, is_starred: 0 }]);
      }
      return Promise.resolve([]);
    });
    return () => capturedFolderSql;
  }

  function insertedLabels(): string[] {
    return mockDb.execute.mock.calls
      .filter((c) => String(c[0]).includes("INSERT OR IGNORE INTO thread_labels"))
      .map((c) => (c[1] as unknown[])[2] as string);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only the TRASH label remains when the sole message is trashed in-place", async () => {
    const getFolderSql = stubSelect({ nonTrashedFolderLabels: [], trashedCount: 1 });

    await recalculateThreadStats("acc-1", "th-1");

    // Folder→label derivation must exclude trashed messages.
    expect(getFolderSql()).toContain("is_trashed = 0");
    const labels = insertedLabels();
    expect(labels).toContain("TRASH");
    expect(labels).not.toContain("INBOX");
  });

  it("keeps INBOX (from the surviving message) and adds TRASH when one of several is trashed", async () => {
    stubSelect({ nonTrashedFolderLabels: ["INBOX"], trashedCount: 1 });

    await recalculateThreadStats("acc-1", "th-1");

    const labels = insertedLabels();
    expect(labels).toContain("INBOX");
    expect(labels).toContain("TRASH");
  });
});

describe("threads service - deleteAllThreadsForAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it("deletes all threads for the given account", async () => {
    await deleteAllThreadsForAccount("acc-1");

    expect(mockDb.execute).toHaveBeenCalledWith(
      "DELETE FROM threads WHERE account_id = $1",
      ["acc-1"],
    );
  });
});

describe("threads service - mute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  describe("muteThread", () => {
    it("calls db.execute with correct SQL to set is_muted = 1", async () => {
      await muteThread("acc-1", "thread-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE threads SET is_muted = 1, urgency_score = 0.05 WHERE account_id = $1 AND id = $2",
        ["acc-1", "thread-1"],
      );
    });
  });

  describe("unmuteThread", () => {
    it("calls db.execute with correct SQL to set is_muted = 0", async () => {
      await unmuteThread("acc-1", "thread-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE threads SET is_muted = 0 WHERE account_id = $1 AND id = $2",
        ["acc-1", "thread-1"],
      );
    });
  });

  describe("getMutedThreadIds", () => {
    it("returns a Set of muted thread IDs", async () => {
      mockDb.select.mockResolvedValueOnce([
        { id: "thread-1" },
        { id: "thread-3" },
      ]);

      const result = await getMutedThreadIds("acc-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        "SELECT id FROM threads WHERE account_id = $1 AND is_muted = 1",
        ["acc-1"],
      );
      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(2);
      expect(result.has("thread-1")).toBe(true);
      expect(result.has("thread-3")).toBe(true);
    });

    it("returns an empty Set when no threads are muted", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const result = await getMutedThreadIds("acc-1");

      expect(result.size).toBe(0);
    });
  });
});
