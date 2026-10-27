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
import { searchAttachments, countAttachments, foldForSearch, getAttachmentSenders, upsertAttachment, getAttachmentsForMessage } from "./attachments";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("attachments DB service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  describe("searchAttachments", () => {
    it("queries with correct SQL joining messages", async () => {
      const mockData = [
        { id: "att-1", filename: "test.pdf", from_address: "alice@example.com", date: 1000 },
      ];
      mockDb.select.mockResolvedValueOnce(mockData);

      const result = await searchAttachments(["acc-1"]);

      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDb.select.mock.calls[0]!;
      expect(sql).toContain("JOIN messages m");
      expect(sql).toContain("a.account_id IN ($1)");
      expect(sql).toContain("filename IS NOT NULL");
      expect(sql).toContain("ORDER BY m.date DESC");
      expect(params).toEqual(["acc-1", 200, 0]);
      expect(result).toEqual(mockData);
    });

    it("supports custom limit and offset", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      await searchAttachments(["acc-1"], {}, 50, 100);

      const [, params] = mockDb.select.mock.calls[0]!;
      expect(params).toEqual(["acc-1", 50, 100]);
    });

    it("filters in SQL before paging, one LIKE clause per search word", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      await searchAttachments(["acc-1", "acc-2"], { query: "  Fattura  Marzo ", sender: "bob@x.it", type: "pdfs" });

      const [sql, params] = mockDb.select.mock.calls[0]!;
      expect(sql).toContain("LIKE $3 ESCAPE");
      expect(sql).toContain("LIKE $4 ESCAPE");
      expect(sql).toContain("m.from_address = $5");
      expect(sql).toContain("'%.pdf'");
      expect(sql.indexOf("LIKE $3")).toBeLessThan(sql.indexOf("LIMIT"));
      expect(params).toEqual(["acc-1", "acc-2", "%fattura%", "%marzo%", "bob@x.it", 200, 0]);
    });

    it("folds accents and case in the search text", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      await searchAttachments(["acc-1"], { query: "PERCHÉ Città" });

      const [sql, params] = mockDb.select.mock.calls[0]!;
      expect(params).toEqual(["acc-1", "%perche%", "%citta%", 200, 0]);
      // The columns are folded the same way in SQL.
      expect(sql).toContain("'é', 'e'");
      expect(sql).toContain("'É', 'e'");
      expect(sql).toContain("'\u0301', ''");
    });

    it("escapes LIKE wildcards in the search text", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      await searchAttachments(["acc-1"], { query: "50%_off" });

      const [sql, params] = mockDb.select.mock.calls[0]!;
      expect(sql).toContain("ESCAPE '\\'");
      expect(params[1]).toBe("%50\\%\\_off%");
    });

    it("excludes attachments of mail in Trash or Spam", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      await searchAttachments(["acc-1"]);

      const [sql] = mockDb.select.mock.calls[0]!;
      expect(sql).toContain("m.is_trashed = 0");
      expect(sql).toContain("l.id IN ('TRASH', 'SPAM') AND l.imap_folder_path = m.imap_folder");
      expect(sql).toContain(`NOT LIKE '%"SPAM"%'`);
    });

    it("returns nothing without touching the DB when no account is given", async () => {
      expect(await searchAttachments([])).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("countAttachments", () => {
    it("counts with the same filters and no paging", async () => {
      mockDb.select.mockResolvedValueOnce([{ count: 3622 }]);

      const total = await countAttachments(["acc-1"], { size: "large" });

      const [sql, params] = mockDb.select.mock.calls[0]!;
      expect(sql).toContain("SELECT COUNT(*)");
      expect(sql).toContain("COALESCE(a.size, 0) > 10485760");
      expect(sql).not.toContain("LIMIT");
      expect(params).toEqual(["acc-1"]);
      expect(total).toBe(3622);
    });
  });

  describe("getAttachmentSenders", () => {
    it("queries distinct senders with counts", async () => {
      const mockSenders = [
        { from_address: "alice@example.com", from_name: "Alice", count: 5 },
      ];
      mockDb.select.mockResolvedValueOnce(mockSenders);

      const result = await getAttachmentSenders("acc-1");

      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDb.select.mock.calls[0]!;
      expect(sql).toContain("GROUP BY m.from_address");
      expect(sql).toContain("ORDER BY count DESC");
      expect(sql).toContain("m.is_trashed = 0");
      expect(params).toEqual(["acc-1"]);
      expect(result).toEqual(mockSenders);
    });
  });

  describe("upsertAttachment", () => {
    it("executes upsert with correct params", async () => {
      await upsertAttachment({
        id: "att-1",
        messageId: "msg-1",
        accountId: "acc-1",
        filename: "test.pdf",
        mimeType: "application/pdf",
        size: 1024,
        gmailAttachmentId: "gid-1",
        imapPartId: null,
        contentId: null,
        isInline: false,
      });

      expect(mockDb.execute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockDb.execute.mock.calls[0]!;
      expect(sql).toContain("INSERT INTO attachments");
      expect(sql).toContain("ON CONFLICT");
      expect(params).toEqual(["att-1", "msg-1", "acc-1", "test.pdf", "application/pdf", 1024, "gid-1", null, null, 0]);
    });
  });

  describe("getAttachmentsForMessage", () => {
    it("queries attachments for a specific message", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      await getAttachmentsForMessage("acc-1", "msg-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        "SELECT * FROM attachments WHERE account_id = $1 AND message_id = $2 ORDER BY filename ASC",
        ["acc-1", "msg-1"],
      );
    });
  });

  describe("foldForSearch", () => {
    it("strips accents from precomposed and decomposed text and lowercases", () => {
      expect(foldForSearch("Perché")).toBe("perche");
      expect(foldForSearch("Perche\u0301")).toBe("perche");
      expect(foldForSearch("ÀÈÌÒÙ ñ ç")).toBe("aeiou n c");
      expect(foldForSearch("Øresund Łódź Straße")).toBe("oresund lodz strasse");
    });
  });
});
