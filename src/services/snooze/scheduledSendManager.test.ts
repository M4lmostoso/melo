import { describe, it, expect, beforeEach, vi } from "vitest";

const checkerFns = vi.hoisted(() => [] as Array<() => Promise<void>>);

vi.mock("../backgroundCheckers", () => ({
  createBackgroundChecker: vi.fn((_name: string, fn: () => Promise<void>) => {
    checkerFns.push(fn);
    return { start: vi.fn(), stop: vi.fn() };
  }),
}));
vi.mock("../db/scheduledEmails", () => ({
  getPendingScheduledEmails: vi.fn(),
  handOffScheduledToOutgoing: vi.fn(),
  updateScheduledEmailStatus: vi.fn(() => Promise.resolve()),
}));
vi.mock("../db/pendingOperations", () => ({
  deleteOperation: vi.fn(() => Promise.resolve()),
  patchOperationParams: vi.fn(() => Promise.resolve()),
  updateOperationStatus: vi.fn(() => Promise.resolve()),
}));
vi.mock("../db/accounts", () => ({ getAccount: vi.fn() }));
vi.mock("../emailActions", () => ({ sendEmail: vi.fn() }));
vi.mock("@/utils/emailBuilder", () => ({ buildRawEmail: vi.fn(() => "RAW") }));
vi.mock("../soundService", () => ({ playSound: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({ sendNotification: vi.fn() }));
vi.mock("@/i18n", () => ({ t: vi.fn((key: string) => key) }));

import "./scheduledSendManager";
import {
  getPendingScheduledEmails,
  handOffScheduledToOutgoing,
  updateScheduledEmailStatus,
  type DbScheduledEmail,
} from "../db/scheduledEmails";
import {
  deleteOperation,
  patchOperationParams,
  updateOperationStatus,
} from "../db/pendingOperations";
import { getAccount } from "../db/accounts";
import { sendEmail } from "../emailActions";
import { buildRawEmail } from "@/utils/emailBuilder";
import { useOutgoingStore } from "@/stores/outgoingStore";
import { useToastStore } from "@/stores/toastStore";

const runCheck = () => checkerFns[0]!();

const scheduled: DbScheduledEmail = {
  id: "sched-1",
  account_id: "acc-1",
  to_addresses: "bob@example.com",
  cc_addresses: null,
  bcc_addresses: null,
  subject: "Parigi",
  body_html: "<p>hi</p>",
  reply_to_message_id: null,
  thread_id: "thread-1",
  scheduled_at: 0,
  signature_id: null,
  attachment_paths: null,
  status: "pending",
  created_at: 0,
};

describe("scheduled send → Outgoing hand-off", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOutgoingStore.setState({ emails: [] });
    useToastStore.setState({ toasts: [] } as never);
    vi.mocked(getPendingScheduledEmails).mockResolvedValue([scheduled]);
    vi.mocked(getAccount).mockResolvedValue({ id: "acc-1", email: "me@example.com" } as never);
    vi.mocked(handOffScheduledToOutgoing).mockResolvedValue("op-1");
  });

  it("hands the raw to Outgoing before sending", async () => {
    vi.mocked(sendEmail).mockImplementation(async () => {
      expect(handOffScheduledToOutgoing).toHaveBeenCalledWith("sched-1", "acc-1", "thread-1", {
        rawBase64Url: "RAW",
        threadId: "thread-1",
      });
      return { success: true };
    });
    await runCheck();
    expect(sendEmail).toHaveBeenCalledWith("acc-1", "RAW", "thread-1");
  });

  it("drops the Outgoing row once the send is confirmed", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, sentCopyDurable: true });
    await runCheck();
    expect(deleteOperation).toHaveBeenCalledWith("op-1");
    expect(updateOperationStatus).not.toHaveBeenCalled();
    expect(useOutgoingStore.getState().emails).toHaveLength(0);
  });

  it("keeps a refused send in Outgoing as failed — never back in Scheduled", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: false, error: "451 ErrorMimeContentInvalid" });
    await runCheck();
    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "failed", "451 ErrorMimeContentInvalid");
    expect(deleteOperation).not.toHaveBeenCalled();
    expect(updateScheduledEmailStatus).not.toHaveBeenCalledWith("sched-1", "failed");
    expect(updateScheduledEmailStatus).not.toHaveBeenCalledWith("sched-1", "pending");
    expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
  });

  it("treats a thrown send like a refused one", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("boom"));
    await runCheck();
    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "failed", "boom");
    expect(updateScheduledEmailStatus).not.toHaveBeenCalledWith("sched-1", "failed");
  });

  it("drops its own row when executeEmailAction queued a retry", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, queued: true });
    await runCheck();
    expect(deleteOperation).toHaveBeenCalledWith("op-1");
  });

  it("parks an unconfirmed send as failed without deliveredNoCopy", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, sendUnconfirmed: true });
    await runCheck();
    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "failed", "outgoing.sendUnconfirmedBody");
    expect(patchOperationParams).not.toHaveBeenCalled();
    expect(deleteOperation).not.toHaveBeenCalled();
  });

  it("flags a delivered send whose copy is missing so a retry only files it", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true, sentCopyDurable: false });
    await runCheck();
    expect(patchOperationParams).toHaveBeenCalledWith("op-1", { deliveredNoCopy: true });
    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "failed", "outgoing.sentCopyMissingBody");
  });

  it("keeps the email in Scheduled when it fails before the hand-off", async () => {
    vi.mocked(buildRawEmail).mockImplementationOnce(() => {
      throw new Error("bad address");
    });
    await runCheck();
    expect(handOffScheduledToOutgoing).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(updateScheduledEmailStatus).toHaveBeenCalledWith("sched-1", "failed");
  });

  it("never revives the scheduled row if bookkeeping fails after the hand-off", async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: true });
    vi.mocked(deleteOperation).mockRejectedValueOnce(new Error("db locked"));
    await runCheck();
    expect(updateScheduledEmailStatus).not.toHaveBeenCalledWith("sched-1", "failed");
    expect(updateOperationStatus).toHaveBeenCalledWith("op-1", "failed", "outgoing.interruptedBody");
  });
});
