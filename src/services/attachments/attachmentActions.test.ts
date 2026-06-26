import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

// `downloadAttachmentsToFolder` joins paths via a dynamic import of the Tauri path API.
vi.mock("@tauri-apps/api/path", () => ({
  join: (...parts: string[]) => Promise.resolve(parts.join("/")),
}));

import { getEmailProvider } from "@/services/email/providerFactory";
import {
  downloadAttachmentsToFolder,
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
});
