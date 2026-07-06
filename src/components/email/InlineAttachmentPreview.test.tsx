import { render, screen, waitFor } from "@testing-library/react";
import { InlineAttachmentPreview } from "./InlineAttachmentPreview";
import type { DbAttachment } from "@/services/db/attachments";

// Thumbnails materialize through the unified attachment cache and are served
// natively via the asset protocol.
vi.mock("@/services/attachments/attachmentActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/attachments/attachmentActions")>();
  return {
    ...actual,
    materializeAttachment: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
}));

import { materializeAttachment } from "@/services/attachments/attachmentActions";

// Mock IntersectionObserver to trigger immediately
beforeAll(() => {
  class MockIntersectionObserver {
    constructor(callback: IntersectionObserverCallback) {
      // Trigger immediately with isIntersecting: true
      setTimeout(() => {
        callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }, 0);
    }
    observe = vi.fn();
    disconnect = vi.fn();
    unobserve = vi.fn();
  }
  window.IntersectionObserver = MockIntersectionObserver as never;
});

const makeAttachment = (overrides: Partial<DbAttachment> = {}): DbAttachment => ({
  id: "att-1",
  message_id: "msg-1",
  account_id: "acc-1",
  filename: "photo.png",
  mime_type: "image/png",
  size: 2048,
  gmail_attachment_id: "gmail-att-1",
  content_id: null,
  is_inline: 0,
  local_path: null,
  ...overrides,
});

describe("InlineAttachmentPreview", () => {
  const onAttachmentClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(materializeAttachment).mockResolvedValue("/cache/att-1/photo.png");
  });

  it("renders nothing when no previewable attachments", () => {
    const { container } = render(
      <InlineAttachmentPreview
        attachments={[makeAttachment({ mime_type: "application/zip", filename: "archive.zip" })]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when all attachments are true inline (no filename)", () => {
    const { container } = render(
      <InlineAttachmentPreview
        attachments={[makeAttachment({ is_inline: 1, filename: null })]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when all attachments have CIDs referenced in the HTML body", () => {
    const referencedCids = new Set(["img001@example.com"]);
    const { container } = render(
      <InlineAttachmentPreview
        attachments={[makeAttachment({ content_id: "img001@example.com", filename: "photo.png", mime_type: "image/png" })]}
        referencedCids={referencedCids}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders image thumbnails for image attachments", () => {
    render(
      <InlineAttachmentPreview
        attachments={[makeAttachment()]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    // Should have an image button (thumbnail container)
    expect(screen.getByTitle("photo.png")).toBeInTheDocument();
  });

  it("does not render PDF attachments (handled by AttachmentList)", () => {
    const { container } = render(
      <InlineAttachmentPreview
        attachments={[makeAttachment({
          mime_type: "application/pdf",
          filename: "report.pdf",
        })]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("materializes the thumbnail through the unified cache", async () => {
    render(
      <InlineAttachmentPreview
        attachments={[makeAttachment()]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    await waitFor(() => {
      expect(materializeAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ dbId: "att-1", accountId: "acc-1", attachmentId: "gmail-att-1" }),
      );
    });
  });

  it("works with IMAP account attachments", async () => {
    render(
      <InlineAttachmentPreview
        attachments={[makeAttachment({
          account_id: "imap-acc",
          message_id: "imap-inbox-42",
          gmail_attachment_id: null,
          imap_part_id: "1.2",
        } as Partial<DbAttachment>)]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    await waitFor(() => {
      expect(materializeAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "imap-acc", messageId: "imap-inbox-42", attachmentId: "1.2" }),
      );
    });
  });

  it("calls onAttachmentClick when image thumbnail is clicked", async () => {
    const att = makeAttachment();

    render(
      <InlineAttachmentPreview
        attachments={[att]}
        onAttachmentClick={onAttachmentClick}
      />,
    );

    await waitFor(() => {
      const thumbnail = screen.getByTitle("photo.png");
      thumbnail.click();
    });

    expect(onAttachmentClick).toHaveBeenCalledWith(att);
  });

});
