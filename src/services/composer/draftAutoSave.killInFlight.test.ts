import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useComposerStore } from "@/stores/composerStore";
import {
  startAutoSave,
  stopAutoSave,
  startDiscard,
  killInFlightServerAppend,
} from "./draftAutoSave";
import { recordDraftKill } from "@/services/db/draftKillList";
// Pre-load the modules saveServer()/saveLocal() import dynamically: with fake
// timers active, an uncached dynamic import (async vitest module-runner fetch)
// never resolves inside advanceTimersByTimeAsync, so the APPEND would never start.
import "@/services/email/providerFactory";
import "@/services/db/messages";
import "@/services/db/threads";
import "@/services/db/connection";

// IMAP two-tier path: saveServer() APPENDs via the provider. createDraft is a
// controllable pending promise so tests can hold the APPEND "in flight".
let resolveCreateDraft: ((v: { draftId: string }) => void) | null = null;
vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn().mockResolvedValue({
    createDraft: vi.fn(
      () =>
        new Promise<{ draftId: string }>((r) => {
          resolveCreateDraft = r;
        }),
    ),
    updateDraft: vi.fn(),
  }),
}));

vi.mock("@/services/db/draftKillList", () => ({
  registerAppendedDraftMsgId: vi.fn(),
  getAppendedDraftMsgId: vi.fn().mockReturnValue(null),
  extractRfcMessageId: vi.fn().mockReturnValue("in-flight-msg-id@melo.test"),
  recordDraftKill: vi.fn().mockResolvedValue(undefined),
  pruneDraftKillList: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/emailActions", () => ({
  tombstoneImapDraft: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  deleteSetting: vi.fn().mockResolvedValue(undefined),
}));

// saveLocal (3s tier) fires before the 18s server tier — stub its DB touchpoints.
vi.mock("@/services/db/messages", () => ({
  upsertMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/db/threads", () => ({
  upsertThread: vi.fn().mockResolvedValue(undefined),
  getThreadLabelIds: vi.fn().mockResolvedValue([]),
  setThreadLabels: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn().mockResolvedValue({
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn().mockResolvedValue([]),
  }),
}));

import { createMockAccountStoreState } from "@/test/mocks";

vi.mock("@/stores/accountStore", () => ({
  useAccountStore: {
    getState: () =>
      createMockAccountStoreState({
        accounts: [{ id: "account-1", email: "test@example.com", provider: "imap" }],
      }),
  },
}));

describe("draftAutoSave — killInFlightServerAppend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resolveCreateDraft = null;
    useComposerStore.setState({
      isOpen: true,
      mode: "new",
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      subject: "Big attachment",
      bodyHtml: "<p>Hello</p>",
      threadId: null,
      inReplyToMessageId: null,
      showCcBcc: false,
      draftId: null,
      localDraftId: "local-uuid-1",
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

  afterEach(async () => {
    // Settle a still-pending APPEND so module state (isSaveServerInFlight) resets
    // and doesn't leak into other tests.
    if (resolveCreateDraft) {
      resolveCreateDraft({ draftId: "imap-account-1-Drafts-99" });
      await vi.advanceTimersByTimeAsync(0);
    }
    stopAutoSave();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is a no-op when no server APPEND is in flight", async () => {
    startAutoSave("account-1");

    await killInFlightServerAppend("account-1");

    expect(recordDraftKill).not.toHaveBeenCalled();
  });

  it("records the in-flight APPEND's Message-ID in the kill-list (send while a large upload is running)", async () => {
    startAutoSave("account-1");

    // Trigger the two-tier autosave and advance past the 18s server debounce:
    // saveServer() starts and its APPEND (createDraft) stays pending — the
    // "10MB attachment still uploading" state.
    useComposerStore.getState().setBodyHtml("<p>Updated with big attachment</p>");
    await vi.advanceTimersByTimeAsync(18500);
    expect(resolveCreateDraft).not.toBeNull();

    // Send: discard starts, the capped waitForSave race expires, then the
    // composer persists the doomed copy's Message-ID before the window closes.
    startDiscard();
    await killInFlightServerAppend("account-1");

    expect(recordDraftKill).toHaveBeenCalledWith(
      "account-1",
      "in-flight-msg-id@melo.test",
    );
  });

  it("does not record again after the APPEND settles", async () => {
    startAutoSave("account-1");

    useComposerStore.getState().setBodyHtml("<p>Updated</p>");
    await vi.advanceTimersByTimeAsync(18500);
    expect(resolveCreateDraft).not.toBeNull();

    resolveCreateDraft!({ draftId: "imap-account-1-Drafts-42" });
    resolveCreateDraft = null;
    await vi.advanceTimersByTimeAsync(0);

    await killInFlightServerAppend("account-1");

    expect(recordDraftKill).not.toHaveBeenCalled();
  });
});
