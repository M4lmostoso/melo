import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openAttachmentPreviewWindow } from "./previewWindow";
import type { DbAttachment } from "@/services/db/attachments";

const ctor = vi.fn();
const getByLabel = vi.fn();
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: Object.assign(
    function (this: unknown, ...args: unknown[]) {
      ctor(...args);
    },
    { getByLabel: (...args: unknown[]) => getByLabel(...args) },
  ),
}));

const makeAttachment = (overrides: Partial<DbAttachment> = {}): DbAttachment => ({
  id: "msg-1:att 1",
  message_id: "msg-1",
  account_id: "acc-1",
  filename: "photo.png",
  mime_type: "image/png",
  size: 1024,
  gmail_attachment_id: "gid-1",
  imap_part_id: null,
  content_id: null,
  is_inline: 0,
  local_path: null,
  ...overrides,
});

// Flush the fire-and-forget async window creation inside the helper.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("openAttachmentPreviewWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByLabel.mockResolvedValue(null);
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("returns false outside a Tauri context (caller falls back to the modal)", () => {
    expect(openAttachmentPreviewWindow(makeAttachment())).toBe(false);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("opens a preview-* window with the attachment id in the URL", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};

    expect(openAttachmentPreviewWindow(makeAttachment())).toBe(true);
    await flush();

    expect(ctor).toHaveBeenCalledTimes(1);
    const [label, opts] = ctor.mock.calls[0] as [string, { url: string; title: string }];
    // Label sanitized to Tauri's allowed charset; URL carries the raw id.
    expect(label).toBe("preview-msg-1:att_1");
    expect(opts.url).toBe(`index.html?preview=${encodeURIComponent("msg-1:att 1").replace(/%20/g, "+")}`);
    expect(opts.title).toBe("photo.png");
  });

  it("focuses the existing window instead of opening a duplicate", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const setFocus = vi.fn().mockResolvedValue(undefined);
    getByLabel.mockResolvedValue({ setFocus });

    expect(openAttachmentPreviewWindow(makeAttachment())).toBe(true);
    await flush();

    expect(setFocus).toHaveBeenCalled();
    expect(ctor).not.toHaveBeenCalled();
  });
});
