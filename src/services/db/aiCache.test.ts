import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/connection")>();
  return {
    ...actual,
    getDb: vi.fn(),
  };
});

import { getDb } from "@/services/db/connection";
import { getAiCache, setAiCache, deleteAiCache, pruneAiCache } from "./aiCache";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

describe("aiCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it("getAiCache returns the stored content or null", async () => {
    mockDb.select.mockResolvedValueOnce([{ content: "cached summary" }]);
    expect(await getAiCache("acc-1", "thread-1", "summary")).toBe("cached summary");

    mockDb.select.mockResolvedValueOnce([]);
    expect(await getAiCache("acc-1", "thread-1", "summary")).toBeNull();
  });

  it("setAiCache upserts by (account, thread, type)", async () => {
    await setAiCache("acc-1", "thread-1", "summary", "hello");
    const [sql, params] = mockDb.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO ai_cache");
    expect(params).toContain("acc-1");
    expect(params).toContain("thread-1");
    expect(params).toContain("summary");
    expect(params).toContain("hello");
  });

  it("deleteAiCache scopes the delete to one entry", async () => {
    await deleteAiCache("acc-1", "thread-1", "summary");
    const [sql, params] = mockDb.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("DELETE FROM ai_cache");
    expect(params).toEqual(["acc-1", "thread-1", "summary"]);
  });

  it("pruneAiCache deletes only rows orphaned from threads", async () => {
    await pruneAiCache();
    const [sql] = mockDb.execute.mock.calls[0] as [string];
    expect(sql).toContain("DELETE FROM ai_cache");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("FROM threads");
  });
});
