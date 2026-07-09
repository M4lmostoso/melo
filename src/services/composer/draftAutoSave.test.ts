import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useComposerStore } from "@/stores/composerStore";
import { startAutoSave, stopAutoSave, discardCurrentAccountDraft } from "./draftAutoSave";
import { deleteDraft as deleteDraftAction } from "@/services/emailActions";

// Mock emailActions instead of getGmailClient
vi.mock("@/services/emailActions", () => ({
  createDraft: vi.fn().mockResolvedValue({ success: true, data: { draftId: "draft-1" } }),
  updateDraft: vi.fn().mockResolvedValue({ success: true }),
  deleteDraft: vi.fn().mockResolvedValue({ success: true }),
}));

// The Gmail autosave path persists the draft id via the settings table — stub it out.
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

import { createMockAccountStoreState } from "@/test/mocks";

// provider "gmail_api" routes autosave through the Gmail (single-tier) path, which is
// what this test asserts. IMAP accounts use the two-tier local+server path instead.
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: {
    getState: () => createMockAccountStoreState({
      accounts: [{ id: "account-1", email: "test@example.com", provider: "gmail_api" }],
    }),
  },
}));

describe("draftAutoSave", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    useComposerStore.setState({
      isOpen: true,
      mode: "new",
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      subject: "Test",
      bodyHtml: "<p>Hello</p>",
      threadId: null,
      inReplyToMessageId: null,
      showCcBcc: false,
      draftId: null,
      undoSendTimer: null,
      undoSendVisible: false,
      attachments: [],
      lastSavedAt: null,
      isSaving: false,
      isSending: false,
      signatureHtml: "",
      signatureId: null,
    });
  });

  afterEach(() => {
    stopAutoSave();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts and stops without error", () => {
    startAutoSave("account-1");
    stopAutoSave();
  });

  it("triggers save after debounce when body changes", async () => {
    startAutoSave("account-1");

    // Simulate a body change
    useComposerStore.getState().setBodyHtml("<p>Updated</p>");

    // Before debounce, draft should not be saved
    expect(useComposerStore.getState().draftId).toBeNull();

    // Advance past debounce
    await vi.advanceTimersByTimeAsync(3500);

    // Draft should now be saved
    expect(useComposerStore.getState().draftId).toBe("draft-1");
    expect(useComposerStore.getState().lastSavedAt).not.toBeNull();
  });

  it("does not save when composer is closed", async () => {
    startAutoSave("account-1");

    useComposerStore.setState({ isOpen: false });
    useComposerStore.getState().setSubject("Changed");

    await vi.advanceTimersByTimeAsync(3500);

    expect(useComposerStore.getState().draftId).toBeNull();
  });

  it("discards the old account's draft when switching accounts (Gmail)", async () => {
    startAutoSave("account-1");

    // Simulate a saved Gmail draft on the current account
    useComposerStore.getState().setDraftId("draft-1");

    await discardCurrentAccountDraft();

    // The previous account's draft must be deleted so it isn't orphaned/re-imported
    expect(deleteDraftAction).toHaveBeenCalledWith("account-1", "draft-1", undefined);
  });

  it("does nothing on switch when no autosave session is active", async () => {
    // No startAutoSave() call → currentAccountId is null
    useComposerStore.getState().setDraftId("draft-1");

    await discardCurrentAccountDraft();

    expect(deleteDraftAction).not.toHaveBeenCalled();
  });
});
