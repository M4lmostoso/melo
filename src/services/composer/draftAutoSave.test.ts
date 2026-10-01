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
      localDraftId: "session-1",
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

  it("creates a fresh draft when the persisted draft id is dead (Gmail 404)", async () => {
    const { getSetting, setSetting } = await import("@/services/db/settings");
    const { updateDraft, createDraft } = await import("@/services/emailActions");
    vi.mocked(getSetting).mockResolvedValueOnce("r-dead");
    vi.mocked(updateDraft).mockResolvedValueOnce({ success: false, error: "404 notFound" });

    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>Updated</p>");
    await vi.advanceTimersByTimeAsync(3500);

    expect(updateDraft).toHaveBeenCalledWith("account-1", "r-dead", expect.any(String), undefined);
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(useComposerStore.getState().draftId).toBe("draft-1");
    expect(setSetting).toHaveBeenCalledWith("v_draft_account-1_session-1", "draft-1");
    expect(useComposerStore.getState().lastSavedAt).not.toBeNull();

    // The next autosave updates the new draft, not the dead one
    vi.mocked(updateDraft).mockClear();
    useComposerStore.getState().setBodyHtml("<p>Again</p>");
    await vi.advanceTimersByTimeAsync(3500);
    expect(updateDraft).toHaveBeenCalledWith("account-1", "draft-1", expect.any(String), undefined);
  });

  it("never adopts a draft id persisted by another composer session", async () => {
    const { getSetting } = await import("@/services/db/settings");
    const { updateDraft, createDraft } = await import("@/services/emailActions");
    // A leftover from a composer that died without cleanup: under the old
    // thread/"new" keying the next new message would have overwritten that draft.
    vi.mocked(getSetting).mockImplementation(async (key: string) =>
      key === "v_draft_account-1_new" ? "r-someone-elses-draft" : null,
    );

    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>Updated</p>");
    await vi.advanceTimersByTimeAsync(3500);

    expect(getSetting).toHaveBeenCalledWith("v_draft_account-1_session-1");
    expect(updateDraft).not.toHaveBeenCalled();
    expect(createDraft).toHaveBeenCalledTimes(1);
    vi.mocked(getSetting).mockReset().mockResolvedValue(null);
  });

  it("does not report the draft as saved when the save fails", async () => {
    const { createDraft } = await import("@/services/emailActions");
    vi.mocked(createDraft).mockResolvedValueOnce({ success: false, error: "403" });
    useComposerStore.setState({ lastSavedAt: 123 });

    startAutoSave("account-1");
    useComposerStore.getState().setBodyHtml("<p>Updated</p>");
    await vi.advanceTimersByTimeAsync(3500);

    expect(useComposerStore.getState().draftId).toBeNull();
    expect(useComposerStore.getState().lastSavedAt).toBeNull();
  });

  it("does nothing on switch when no autosave session is active", async () => {
    // No startAutoSave() call → currentAccountId is null
    useComposerStore.getState().setDraftId("draft-1");

    await discardCurrentAccountDraft();

    expect(deleteDraftAction).not.toHaveBeenCalled();
  });
});
