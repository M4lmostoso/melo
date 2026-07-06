import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentLibrary } from "./AttachmentLibrary";
import type { AttachmentWithContext, AttachmentSender } from "@/services/db/attachments";

// Mock dependencies
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: vi.fn(
    (
      selector: (s: {
        accounts: { id: string; includeInGlobal: boolean; color: string | null; label: string | null; displayName: string | null; email: string }[];
        activeAccountId: string | null;
      }) => unknown,
    ) =>
      selector({
        accounts: [
          { id: "acc-1", includeInGlobal: true, color: null, label: null, displayName: "Acc One", email: "one@example.com" },
        ],
        activeAccountId: "acc-1",
      }),
  ),
}));

vi.mock("@/services/db/attachments", () => ({
  getAttachmentsForAccount: vi.fn(() => Promise.resolve([])),
  getAttachmentsForAccounts: vi.fn(() => Promise.resolve([])),
  getAttachmentSenders: vi.fn(() => Promise.resolve([])),
  getAttachmentSendersForAccounts: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("@/components/email/AttachmentList", () => ({
  AttachmentPreview: vi.fn(() => null),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/plugin-fs")>();
  return { ...actual, writeFile: vi.fn() };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
}));

import {
  getAttachmentsForAccount,
  getAttachmentsForAccounts,
  getAttachmentSenders,
  getAttachmentSendersForAccounts,
} from "@/services/db/attachments";
import { useAccountStore } from "@/stores/accountStore";

const mockAttachments: AttachmentWithContext[] = [
  {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: "report.pdf",
    mime_type: "application/pdf",
    size: 2_000_000,
    gmail_attachment_id: "gid-1",
    content_id: null,
    is_inline: 0,
    local_path: null,
    from_address: "alice@example.com",
    from_name: "Alice",
    date: Date.now() - 3600000,
    subject: "Q4 Report",
    thread_id: "thread-1",
  },
  {
    id: "att-2",
    message_id: "msg-2",
    account_id: "acc-1",
    filename: "photo.png",
    mime_type: "image/png",
    size: 500_000,
    gmail_attachment_id: "gid-2",
    content_id: null,
    is_inline: 0,
    local_path: null,
    from_address: "bob@example.com",
    from_name: "Bob",
    date: Date.now() - 86400000,
    subject: "Photos",
    thread_id: "thread-2",
  },
];

const mockSenders: AttachmentSender[] = [
  { from_address: "alice@example.com", from_name: "Alice", count: 3 },
  { from_address: "bob@example.com", from_name: "Bob", count: 1 },
];

describe("AttachmentLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state when no attachments", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue([]);
    vi.mocked(getAttachmentSenders).mockResolvedValue([]);

    render(<AttachmentLibrary />);

    expect(await screen.findByText("No attachments found")).toBeInTheDocument();
  });

  it("renders attachments in grid view", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue(mockAttachments);
    vi.mocked(getAttachmentSenders).mockResolvedValue(mockSenders);

    render(<AttachmentLibrary />);

    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("switches to list view", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue(mockAttachments);
    vi.mocked(getAttachmentSenders).mockResolvedValue(mockSenders);

    render(<AttachmentLibrary />);
    await screen.findByText("report.pdf");

    fireEvent.click(screen.getByTitle("List view"));

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("filters by search query", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue(mockAttachments);
    vi.mocked(getAttachmentSenders).mockResolvedValue(mockSenders);

    render(<AttachmentLibrary />);
    await screen.findByText("report.pdf");

    fireEvent.change(screen.getByPlaceholderText("Search attachments..."), {
      target: { value: "report" },
    });

    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByText("photo.png")).not.toBeInTheDocument();
  });

  it("filters by type", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue(mockAttachments);
    vi.mocked(getAttachmentSenders).mockResolvedValue(mockSenders);

    render(<AttachmentLibrary />);
    await screen.findByText("report.pdf");

    // Select "Images" type filter
    const typeSelect = screen.getByDisplayValue("All types");
    fireEvent.change(typeSelect, { target: { value: "images" } });

    expect(screen.queryByText("report.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("photo.png")).toBeInTheDocument();
  });

  it("shows correct count", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue(mockAttachments);
    vi.mocked(getAttachmentSenders).mockResolvedValue(mockSenders);

    render(<AttachmentLibrary />);
    await screen.findByText("report.pdf");

    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  it("renders header with title", async () => {
    vi.mocked(getAttachmentsForAccount).mockResolvedValue([]);
    vi.mocked(getAttachmentSenders).mockResolvedValue([]);

    render(<AttachmentLibrary />);

    expect(await screen.findByText("Attachments")).toBeInTheDocument();
  });

  it("loads attachments across all global accounts in unified view", async () => {
    // activeAccountId null = unified; two accounts included in global.
    vi.mocked(useAccountStore).mockImplementation((selector: (s: unknown) => unknown) =>
      selector({
        accounts: [
          { id: "acc-1", includeInGlobal: true, color: "#f00", label: "Work", displayName: null, email: "one@example.com" },
          { id: "acc-2", includeInGlobal: true, color: "#00f", label: "Personal", displayName: null, email: "two@example.com" },
        ],
        activeAccountId: null,
      }),
    );
    vi.mocked(getAttachmentsForAccounts).mockResolvedValue(mockAttachments);
    vi.mocked(getAttachmentSendersForAccounts).mockResolvedValue(mockSenders);

    render(<AttachmentLibrary />);
    await screen.findByText("report.pdf");

    expect(getAttachmentsForAccounts).toHaveBeenCalledWith(["acc-1", "acc-2"]);
    // Per-account subdivision filter is offered.
    expect(screen.getByText("All accounts")).toBeInTheDocument();
  });
});
