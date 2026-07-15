import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn(async () => ({ rowsAffected: 1 }));
vi.mock("./connection", () => ({
  getDb: vi.fn(async () => ({ execute: mockExecute, select: vi.fn(async () => []) })),
}));

import {
  extractRfcMessageId,
  recordDraftKill,
  registerAppendedDraftMsgId,
  getAppendedDraftMsgId,
} from "./draftKillList";

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("extractRfcMessageId", () => {
  it("extracts and strips angle brackets from a raw email", () => {
    const raw = "From: a@b.com\r\nMessage-ID: <1784125761717.tk909lwf@termomeccanica.com>\r\nSubject: x\r\n\r\nbody";
    expect(extractRfcMessageId(toBase64Url(raw))).toBe(
      "1784125761717.tk909lwf@termomeccanica.com",
    );
  });

  it("handles bracket-less Message-IDs and case-insensitive header names", () => {
    const raw = "message-id: abc@host.com\r\n\r\nbody";
    expect(extractRfcMessageId(toBase64Url(raw))).toBe("abc@host.com");
  });

  it("returns null when the header is missing or input is not base64", () => {
    expect(extractRfcMessageId(toBase64Url("Subject: no id\r\n\r\nbody"))).toBeNull();
    expect(extractRfcMessageId("%%%not-base64%%%")).toBeNull();
  });
});

describe("recordDraftKill", () => {
  beforeEach(() => mockExecute.mockClear());

  it("normalizes the Message-ID like Rust's normalize_message_id (strip brackets + trim)", async () => {
    await recordDraftKill("acc-1", "  <abc@host.com>  ");
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("draft_kill_list"), [
      "acc-1",
      "abc@host.com",
    ]);
  });

  it("handles the DavMail stray-trailing-bracket form", async () => {
    await recordDraftKill("acc-1", "abc@host.com>");
    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), ["acc-1", "abc@host.com"]);
  });

  it("is a no-op for null/empty Message-IDs", async () => {
    await recordDraftKill("acc-1", null);
    await recordDraftKill("acc-1", "<>");
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe("appended-draft Message-ID registry", () => {
  it("stores and returns the msgid for a draftId; null for unknown ids", () => {
    registerAppendedDraftMsgId("imap-acc-1-Drafts-3513", "1784125761717.tk909lwf@termomeccanica.com");
    expect(getAppendedDraftMsgId("imap-acc-1-Drafts-3513")).toBe(
      "1784125761717.tk909lwf@termomeccanica.com",
    );
    expect(getAppendedDraftMsgId("imap-acc-1-Drafts-9999")).toBeNull();
  });

  it("ignores null msgids", () => {
    registerAppendedDraftMsgId("imap-acc-1-Drafts-1", null);
    expect(getAppendedDraftMsgId("imap-acc-1-Drafts-1")).toBeNull();
  });
});
