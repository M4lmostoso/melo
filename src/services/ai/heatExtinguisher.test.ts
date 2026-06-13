import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/services/db/threads", () => ({
  getThreadById: vi.fn(),
  setHeatExtinguished: vi.fn(() => Promise.resolve()),
  setManualUrgencyOverride: vi.fn(() => Promise.resolve()),
  setThreadUrgency: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn(() => Promise.resolve([])),
}));
vi.mock("./reputationEngine", () => ({ logInteraction: vi.fn(() => Promise.resolve()) }));
vi.mock("./aiService", () => ({ judgeUrgencyResolved: vi.fn() }));
vi.mock("./providerManager", () => ({ isAiAvailable: vi.fn() }));
vi.mock("@/stores/threadStore", () => ({
  useThreadStore: {
    getState: vi.fn(() => ({ updateThread: vi.fn(), threadMap: new Map() })),
  },
}));

import { autoExtinguishOnReply } from "./heatExtinguisher";
import { getSetting } from "@/services/db/settings";
import { getThreadById, setHeatExtinguished, setThreadUrgency } from "@/services/db/threads";
import { getMessagesForThread } from "@/services/db/messages";
import { judgeUrgencyResolved } from "./aiService";
import { isAiAvailable } from "./providerManager";

const urgentThread = {
  urgency_score: 0.8,
  is_heat_extinguished: 0,
  manual_urgency_override: 0,
  from_address: "a@b.com",
} as never;

// Two messages so fetchUrgentContext (which drops the last/just-sent reply) has context.
const withContext = [
  { subject: "Help", body_text: "something urgent", snippet: "something urgent" },
  { subject: "re: Help", body_text: "my reply", snippet: "my reply" },
] as never;

describe("autoExtinguishOnReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSetting).mockResolvedValue("true");
    vi.mocked(getMessagesForThread).mockResolvedValue(withContext);
    vi.mocked(isAiAvailable).mockResolvedValue(true);
  });

  it("brings urgency to ZERO when the AI judges the reply closes the topic", async () => {
    vi.mocked(getThreadById).mockResolvedValue(urgentThread);
    vi.mocked(judgeUrgencyResolved).mockResolvedValue(true);

    await autoExtinguishOnReply("acct-1", "t1", "all done, thanks");

    expect(setThreadUrgency).toHaveBeenCalledWith("acct-1", "t1", 0);
    expect(setHeatExtinguished).toHaveBeenCalledWith("acct-1", "t1", true);
  });

  it("reduces urgency by 30% when the AI judges the topic still open (PENDING)", async () => {
    vi.mocked(getThreadById).mockResolvedValue(urgentThread);
    vi.mocked(judgeUrgencyResolved).mockResolvedValue(false);

    await autoExtinguishOnReply("acct-1", "t1", "working on it");

    expect(setThreadUrgency).toHaveBeenCalledWith("acct-1", "t1", expect.closeTo(0.56, 5));
    expect(setHeatExtinguished).not.toHaveBeenCalled();
  });

  it("only reduces 30% (never zeroes) when AI is unavailable — no auto-resolve without evaluation", async () => {
    vi.mocked(getThreadById).mockResolvedValue(urgentThread);
    vi.mocked(isAiAvailable).mockResolvedValue(false);

    await autoExtinguishOnReply("acct-1", "t1");

    expect(judgeUrgencyResolved).not.toHaveBeenCalled();
    expect(setThreadUrgency).toHaveBeenCalledWith("acct-1", "t1", expect.closeTo(0.56, 5));
    expect(setHeatExtinguished).not.toHaveBeenCalled();
  });

  it("works off the DB even when the thread is NOT in the in-memory store (archived after send)", async () => {
    // threadMap is empty (default mock) — the DB is the source of truth, so it must still act.
    vi.mocked(getThreadById).mockResolvedValue({
      urgency_score: 0.9,
      is_heat_extinguished: 0,
      manual_urgency_override: 0,
      from_address: "x@y.com",
    } as never);
    vi.mocked(judgeUrgencyResolved).mockResolvedValue(true);

    await autoExtinguishOnReply("acct-1", "t1");

    expect(setThreadUrgency).toHaveBeenCalledWith("acct-1", "t1", 0);
    expect(setHeatExtinguished).toHaveBeenCalledWith("acct-1", "t1", true);
  });

  it("does nothing when the thread is no longer urgent in the DB", async () => {
    vi.mocked(getThreadById).mockResolvedValue({
      urgency_score: 0,
      is_heat_extinguished: 0,
      manual_urgency_override: 0,
    } as never);

    await autoExtinguishOnReply("acct-1", "t1");

    expect(setHeatExtinguished).not.toHaveBeenCalled();
    expect(setThreadUrgency).not.toHaveBeenCalled();
  });

  it("does nothing when urgency was manually overridden", async () => {
    vi.mocked(getThreadById).mockResolvedValue({
      urgency_score: 0.8,
      is_heat_extinguished: 0,
      manual_urgency_override: 1,
      from_address: "a@b.com",
    } as never);

    await autoExtinguishOnReply("acct-1", "t1");

    expect(setHeatExtinguished).not.toHaveBeenCalled();
    expect(setThreadUrgency).not.toHaveBeenCalled();
  });

  it("is a no-op when auto-extinguish is disabled", async () => {
    vi.mocked(getSetting).mockResolvedValue("false");

    await autoExtinguishOnReply("acct-1", "t1");

    expect(getThreadById).not.toHaveBeenCalled();
    expect(setHeatExtinguished).not.toHaveBeenCalled();
  });
});
