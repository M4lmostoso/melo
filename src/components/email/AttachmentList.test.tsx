import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AttachmentList } from "./AttachmentList";
import type { DbAttachment } from "@/services/db/attachments";

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("@/services/db/attachments", () => ({
  getAttachmentsForMessage: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

// Progress events listener used by the preview modal's useEffect.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// Reveal-in-folder after a successful download.
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

// Preview/download now go through the unified attachment cache: materialize to
// disk, then readFile (preview) or copyFile (save-as).
vi.mock("@/services/attachments/attachmentActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/attachments/attachmentActions")>();
  return {
    ...actual,
    materializeAttachment: vi.fn(),
    downloadAttachmentsToFolder: vi.fn(),
    openAttachmentWithDefaultApp: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/plugin-fs")>();
  return { ...actual, readFile: vi.fn(), copyFile: vi.fn() };
});

import { materializeAttachment } from "@/services/attachments/attachmentActions";
import { readFile, copyFile } from "@tauri-apps/plugin-fs";
import { save } from "@tauri-apps/plugin-dialog";

const makeAttachment = (overrides: Partial<DbAttachment> = {}): DbAttachment => ({
  id: "att-1",
  message_id: "msg-1",
  account_id: "acc-1",
  filename: "photo.png",
  mime_type: "image/png",
  size: 1024,
  gmail_attachment_id: "gmail-att-1",
  content_id: null,
  is_inline: 0,
  local_path: null,
  ...overrides,
});

describe("AttachmentList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(materializeAttachment).mockResolvedValue("/cache/att-1/photo.png");
    vi.mocked(readFile).mockResolvedValue(new Uint8Array([1, 2, 3]));
    vi.mocked(copyFile).mockResolvedValue(undefined);
    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();
  });

  it("renders nothing when no file attachments", () => {
    const { container } = render(<AttachmentList attachments={[]} />);

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when all attachments are true inline (no filename)", () => {
    const { container } = render(
      <AttachmentList attachments={[makeAttachment({ is_inline: 1, filename: null })]} />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("shows attachment with is_inline flag if it has a filename", () => {
    render(
      <AttachmentList
        attachments={[makeAttachment({ is_inline: 1, filename: "report.pdf", mime_type: "application/pdf" })]}
      />,
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("renders attachment count and names", () => {
    const attachments = [
      makeAttachment({ id: "att-1", gmail_attachment_id: "gid-1", filename: "photo.png" }),
      makeAttachment({ id: "att-2", gmail_attachment_id: "gid-2", filename: "doc.pdf", mime_type: "application/pdf" }),
    ];

    render(<AttachmentList attachments={attachments} />);

    expect(screen.getByText("2 attachments")).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("doc.pdf")).toBeInTheDocument();
  });

  it("renders file size for attachments", () => {
    render(<AttachmentList attachments={[makeAttachment({ size: 2048 })]} />);

    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("selects an attachment on single click (does not open preview)", () => {
    render(<AttachmentList attachments={[makeAttachment()]} />);

    const item = screen.getByText("photo.png").closest('[role="button"]')!;
    expect(item).toHaveAttribute("aria-selected", "false");

    fireEvent.click(item);

    expect(item).toHaveAttribute("aria-selected", "true");
    // Single click must NOT materialize/preview
    expect(materializeAttachment).not.toHaveBeenCalled();
  });

  it("opens preview modal when pressing space and loads bytes from the cache", async () => {
    render(<AttachmentList attachments={[makeAttachment()]} />);

    fireEvent.keyDown(screen.getByText("photo.png"), { key: " " });

    await waitFor(() => {
      expect(materializeAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ dbId: "att-1", attachmentId: "gmail-att-1" }),
      );
      expect(readFile).toHaveBeenCalledWith("/cache/att-1/photo.png");
    });
  });

  it("opens a dedicated preview window (no modal) when a Tauri context is present", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    try {
      render(<AttachmentList attachments={[makeAttachment()]} />);

      fireEvent.keyDown(screen.getByText("photo.png"), { key: " " });

      // The preview is handed to the preview-* WebviewWindow: the in-page
      // modal must not open, so nothing is materialized in this window.
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByText("Download")).not.toBeInTheDocument();
      expect(materializeAttachment).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });

  it("materializes IMAP part ids through the same cache path", async () => {
    render(
      <AttachmentList
        attachments={[makeAttachment({
          account_id: "imap-acc",
          message_id: "imap-msg-1",
          gmail_attachment_id: null,
          imap_part_id: "1.2",
        } as Partial<DbAttachment>)]}
      />,
    );

    fireEvent.keyDown(screen.getByText("photo.png"), { key: " " });

    await waitFor(() => {
      expect(materializeAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "imap-acc", messageId: "imap-msg-1", attachmentId: "1.2" }),
      );
    });
  });

  it("saves via cache copy on download", async () => {
    vi.mocked(save).mockResolvedValue("/downloads/photo.png");

    render(<AttachmentList attachments={[makeAttachment()]} />);

    // Open the preview modal first (Space = Quick Look preview)
    fireEvent.keyDown(screen.getByText("photo.png"), { key: " " });

    await waitFor(() => {
      expect(screen.getByText("Download")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Download"));

    // The cached file is copied to the chosen destination — no re-fetch.
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
      expect(copyFile).toHaveBeenCalledWith("/cache/att-1/photo.png", "/downloads/photo.png");
    });
  });

  it("hides attachments whose CID is referenced in the HTML body", () => {
    const referencedCids = new Set(["img001@example.com"]);
    const { container } = render(
      <AttachmentList
        attachments={[makeAttachment({ content_id: "img001@example.com", filename: "photo.png", mime_type: "image/png" })]}
        referencedCids={referencedCids}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("shows attachments with content_id when not referenced in HTML body", () => {
    const referencedCids = new Set<string>();
    render(
      <AttachmentList
        attachments={[makeAttachment({ content_id: "img001@example.com", filename: "photo.png", mime_type: "image/png" })]}
        referencedCids={referencedCids}
      />,
    );

    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("shows non-image CID attachments with real filename when not referenced", () => {
    render(
      <AttachmentList
        attachments={[makeAttachment({ content_id: "part1@example.com", mime_type: "application/pdf", filename: "report.pdf" })]}
      />,
    );

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("deduplicates attachments by filename+size (different gmail_attachment_id)", () => {
    render(
      <AttachmentList
        attachments={[
          makeAttachment({ id: "att-1", gmail_attachment_id: "gid-1", filename: "photo.png", size: 1024 }),
          makeAttachment({ id: "att-2", gmail_attachment_id: "gid-2", filename: "photo.png", size: 1024 }),
        ]}
      />,
    );

    expect(screen.getByText("1 attachment")).toBeInTheDocument();
  });

  it("does not dedup attachments with different filenames", () => {
    render(
      <AttachmentList
        attachments={[
          makeAttachment({ id: "att-1", gmail_attachment_id: "gid-1", filename: "photo.png", size: 1024 }),
          makeAttachment({ id: "att-2", gmail_attachment_id: "gid-2", filename: "photo2.png", size: 1024 }),
        ]}
      />,
    );

    expect(screen.getByText("2 attachments")).toBeInTheDocument();
  });

  it("shows error state when materialization fails", async () => {
    vi.mocked(materializeAttachment).mockRejectedValue(new Error("Network error"));

    render(<AttachmentList attachments={[makeAttachment()]} />);

    fireEvent.keyDown(screen.getByText("photo.png"), { key: " " });

    await waitFor(() => {
      expect(screen.getByText("Failed to load preview")).toBeInTheDocument();
    });
  });
});
