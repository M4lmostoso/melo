import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

// `downloadAttachmentsToFolder` joins paths via a dynamic import of the Tauri path API.
vi.mock("@tauri-apps/api/path", () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
  appDataDir: () => Promise.resolve("/appdata"),
}));

vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/plugin-fs")>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    stat: vi.fn(),
    copyFile: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
});

// The unified cache records local_path in the DB; tests control what the
// cached-rows and message-siblings queries return via dbSelect.
const { dbSelect, dbExecute } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbExecute: vi.fn(),
}));

vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn().mockResolvedValue({ select: dbSelect, execute: dbExecute }),
}));

vi.mock("./cacheManager", () => ({
  evictOldestCached: vi.fn().mockResolvedValue(undefined),
}));

import { getEmailProvider } from "@/services/email/providerFactory";
import {
  downloadAttachmentsToFolder,
  materializeEach,
  _resetMaterializeStateForTests,
  type AttachmentRef,
} from "./attachmentActions";

const makeRef = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  dbId: "db-1",
  accountId: "acc-1",
  messageId: "msg-1",
  attachmentId: "att-1",
  filename: "report.pdf",
  size: 100,
  ...over,
});

describe("downloadAttachmentsToFolder", () => {
  const downloadAttachmentToPath = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetMaterializeStateForTests();
    dbSelect.mockResolvedValue([]);
    dbExecute.mockResolvedValue(undefined);
    downloadAttachmentToPath.mockResolvedValue(undefined);
    vi.mocked(getEmailProvider).mockResolvedValue({ downloadAttachmentToPath } as never);
  });

  it("writes each attachment under the chosen directory with its real name", async () => {
    const res = await downloadAttachmentsToFolder(
      [makeRef({ dbId: "a", filename: "a.pdf" }), makeRef({ dbId: "b", filename: "b.txt" })],
      "/Users/me/Downloads",
    );

    expect(res).toEqual({ ok: 2, failed: 0, firstPath: "/Users/me/Downloads/a.pdf" });
    expect(downloadAttachmentToPath).toHaveBeenCalledTimes(2);
    expect(downloadAttachmentToPath).toHaveBeenNthCalledWith(1, "msg-1", "att-1", "/Users/me/Downloads/a.pdf", "a", 100);
    expect(downloadAttachmentToPath).toHaveBeenNthCalledWith(2, "msg-1", "att-1", "/Users/me/Downloads/b.txt", "b", 100);
  });

  it("de-duplicates colliding filenames within the batch", async () => {
    await downloadAttachmentsToFolder(
      [
        makeRef({ dbId: "a", filename: "report.pdf" }),
        makeRef({ dbId: "b", filename: "report.pdf" }),
        makeRef({ dbId: "c", filename: "report.pdf" }),
      ],
      "/dir",
    );

    const dests = downloadAttachmentToPath.mock.calls.map((c) => c[2]);
    expect(dests).toEqual(["/dir/report.pdf", "/dir/report (2).pdf", "/dir/report (3).pdf"]);
  });

  it("skips refs without a downloadable id and counts them as failed", async () => {
    const res = await downloadAttachmentsToFolder(
      [makeRef({ attachmentId: null }), makeRef({ dbId: "b", filename: "ok.pdf" })],
      "/dir",
    );

    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(downloadAttachmentToPath).toHaveBeenCalledTimes(1);
  });

  it("reports per-file progress before each download", async () => {
    const onProgress = vi.fn();
    await downloadAttachmentsToFolder(
      [makeRef({ dbId: "a", filename: "a.pdf" }), makeRef({ dbId: "b", filename: "b.pdf" })],
      "/dir",
      onProgress,
    );

    expect(onProgress).toHaveBeenNthCalledWith(1, { index: 0, total: 2, dbId: "a" });
    expect(onProgress).toHaveBeenNthCalledWith(2, { index: 1, total: 2, dbId: "b" });
  });

  it("continues after a failure and reports it", async () => {
    downloadAttachmentToPath
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const res = await downloadAttachmentsToFolder(
      [makeRef({ dbId: "a", filename: "a.pdf" }), makeRef({ dbId: "b", filename: "b.pdf" })],
      "/dir",
    );

    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.firstPath).toBe("/dir/b.pdf");
  });

  it("routes multi-attachment groups through the provider batch download", async () => {
    const downloadAttachmentsBatch = vi.fn(
      async (items: { dbId: string }[]) => items.map((i) => ({ dbId: i.dbId, ok: true, error: null })),
    );
    vi.mocked(getEmailProvider).mockResolvedValue({ downloadAttachmentToPath, downloadAttachmentsBatch } as never);

    const res = await downloadAttachmentsToFolder(
      [makeRef({ dbId: "a", filename: "a.pdf" }), makeRef({ dbId: "b", filename: "b.pdf" })],
      "/dir",
    );

    expect(res).toEqual({ ok: 2, failed: 0, firstPath: "/dir/a.pdf" });
    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentsBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(downloadAttachmentToPath).not.toHaveBeenCalled();
  });
});

describe("materializeEach (shared single-flight)", () => {
  const okBatch = (items: { dbId: string }[]) =>
    items.map((i) => ({ dbId: i.dbId, ok: true, error: null }));
  const downloadAttachmentsBatch = vi.fn();
  const downloadAttachmentToPath = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    _resetMaterializeStateForTests();
    dbSelect.mockResolvedValue([]);
    dbExecute.mockResolvedValue(undefined);
    downloadAttachmentsBatch.mockImplementation(async (items) => okBatch(items));
    downloadAttachmentToPath.mockResolvedValue(undefined);
    vi.mocked(getEmailProvider).mockResolvedValue({ downloadAttachmentsBatch, downloadAttachmentToPath } as never);
  });

  it("fetches attachments of the same message in one batch call", async () => {
    const map = materializeEach([
      makeRef({ dbId: "a", filename: "a.pdf" }),
      makeRef({ dbId: "b", filename: "b.pdf" }),
    ]);
    const paths = await Promise.all([map.get("a")!, map.get("b")!]);

    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentsBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(paths[0]).toContain("a.pdf");
    expect(paths[1]).toContain("b.pdf");
  });

  it("coalesces separate calls made within the batching window", async () => {
    const p1 = materializeEach([makeRef({ dbId: "a", filename: "a.pdf" })]).get("a")!;
    const p2 = materializeEach([makeRef({ dbId: "b", filename: "b.pdf" })]).get("b")!;
    await Promise.all([p1, p2]);

    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentsBatch.mock.calls[0]![0]).toHaveLength(2);
  });

  it("returns the same promise for an attachment already in flight", async () => {
    const ref = makeRef({ dbId: "a", filename: "a.pdf" });
    const p1 = materializeEach([ref]).get("a")!;
    const p2 = materializeEach([ref]).get("a")!;
    expect(p2).toBe(p1);

    await p1;
    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);
  });

  it("evicts failures so a retry can start fresh", async () => {
    downloadAttachmentsBatch.mockImplementationOnce(async (items: { dbId: string }[]) =>
      items.map((i) => ({ dbId: i.dbId, ok: false, error: "boom" })),
    );
    const ref = makeRef({ dbId: "a", filename: "a.pdf" });

    const p1 = materializeEach([ref]).get("a")!;
    await expect(p1).rejects.toThrow("boom");

    const p2 = materializeEach([ref]).get("a")!;
    expect(p2).not.toBe(p1);
    await expect(p2).resolves.toContain("a.pdf");
  });

  it("expands one requested attachment to every uncached sibling of the message (Thunderbird model)", async () => {
    dbSelect.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE account_id")) {
        return [
          { id: "a", imap_part_id: "2", filename: "a.pdf", size: 100, local_path: null },
          { id: "b", imap_part_id: "3", filename: "b.pdf", size: 200, local_path: null },
          { id: "c", imap_part_id: "4", filename: "c.pdf", size: 300, local_path: "attachment_cache/x/c.pdf" },
        ];
      }
      return [];
    });

    await materializeEach([makeRef({ dbId: "a", attachmentId: "2", filename: "a.pdf" })]).get("a")!;

    // ONE fetch, sliced for the requested file AND the uncached sibling;
    // the already-cached sibling is left alone.
    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);
    const payload = downloadAttachmentsBatch.mock.calls[0]![0] as { dbId: string }[];
    expect(payload.map((x) => x.dbId).sort()).toEqual(["a", "b"]);
  });

  it("download-to-folder copies from an in-flight prefetch instead of re-fetching", async () => {
    const ref = makeRef({ dbId: "a", filename: "a.pdf" });
    await materializeEach([ref]).get("a")!;
    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);

    const res = await downloadAttachmentsToFolder([ref], "/dl");

    expect(res).toEqual({ ok: 1, failed: 0, firstPath: "/dl/a.pdf" });
    // No second network fetch — the cached file was copied to the destination.
    expect(downloadAttachmentsBatch).toHaveBeenCalledTimes(1);
    expect(downloadAttachmentToPath).not.toHaveBeenCalled();
    const { copyFile } = await import("@tauri-apps/plugin-fs");
    expect(vi.mocked(copyFile)).toHaveBeenCalledWith(expect.stringContaining("a.pdf"), "/dl/a.pdf");
  });
});
