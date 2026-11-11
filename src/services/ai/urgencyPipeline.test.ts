import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  threads: [] as { id: string; account_id: string; last_message_at: number; urgency_score: number }[],
  backfillQueries: [] as unknown[][],
  score: vi.fn(),
  judge: vi.fn(),
  extinguishRows: [] as unknown[],
  store: new Map<string, string>(),
  latest: [] as { email: string; from_address: string }[],
}));

vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void h.store.set(k, v)),
}));
vi.mock("@/utils/fileLog", () => ({ logToFile: vi.fn() }));
vi.mock("./providerManager", () => ({ isAiAvailable: vi.fn(async () => true) }));
vi.mock("./aiService", () => ({ scoreUrgencyWithAi: h.score, judgeUrgencyResolved: h.judge }));
vi.mock("./reputationEngine", () => ({
  scoreUrgencyFromText: vi.fn(() => 0),
  adjustUrgencyWithReputation: vi.fn(async (_a: string, _f: string, s: number) => s),
  ragPriorityDomainBoost: vi.fn(() => 0),
  sanitizeForUrgencyScoring: vi.fn((t: string) => t),
  logInteraction: vi.fn(),
}));
vi.mock("@/services/db/threads", () => ({
  setThreadUrgency: vi.fn(async (_a: string, id: string, s: number) => {
    const t = h.threads.find((x) => x.id === id);
    if (t) t.urgency_score = s;
  }),
  setHeatExtinguished: vi.fn(),
  setThreadUrgencyReason: vi.fn(),
  setUrgencyReplyDecayed: vi.fn(),
}));
vi.mock("@/services/db/connection", () => ({
  getDb: vi.fn(async () => ({
    select: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("t.is_heat_extinguished = 0")) return h.extinguishRows;
      if (sql.includes("FROM accounts a")) return h.latest;
      if (!sql.includes("t.urgency_score = 0")) return [];
      h.backfillQueries.push(params);
      const [, cursorAt, cursorId, limit] = params as [number, number | null, string, number];
      return h.threads
        .filter((t) => t.urgency_score === 0)
        .filter((t) => cursorAt === null || t.last_message_at < cursorAt || (t.last_message_at === cursorAt && t.id < cursorId))
        .sort((a, b) => b.last_message_at - a.last_message_at || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map((t) => ({ ...t, subject: "s", from_address: "x@y.z", from_name: "", body_text: "b", label_ids: "INBOX" }));
    }),
  })),
}));

import { runUrgencyBackfill, runExtinguishBackfill, processThreadUrgency } from "./urgencyPipeline";
import { setThreadUrgency, setHeatExtinguished } from "@/services/db/threads";
import { report429, isLaneOpen, __resetForTests } from "./rateLimiter";
import { AiError } from "./errors";

const HOUR = 3_600_000;

describe("runUrgencyBackfill under rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    __resetForTests();
    h.store.clear();
    h.backfillQueries.length = 0;
    h.score.mockReset();
    const now = Date.now();
    h.threads = [
      { id: "old", account_id: "a", last_message_at: now - 10 * 24 * HOUR, urgency_score: 0 },
      { id: "mid", account_id: "a", last_message_at: now - 3 * 24 * HOUR, urgency_score: 0 },
      { id: "new", account_id: "a", last_message_at: now - 2 * HOUR, urgency_score: 0 },
    ];
  });
  afterEach(() => vi.useRealTimers());

  it("scores newest first and uses the backlog lane for every backfilled thread", async () => {
    h.score.mockResolvedValue({ score: 0.5 });
    const run = runUrgencyBackfill();
    await vi.runAllTimersAsync();
    await run;

    expect(h.score.mock.calls.map((c) => c[1])).toEqual(["new", "mid", "old"]);
    expect(h.score.mock.calls.every((c) => c[7] === "backfill")).toBe(true);
    expect(h.threads.every((t) => t.urgency_score === 0.5)).toBe(true);
  });

  it("on a 429 it waits for the backlog lane and retries the SAME thread, then carries on", async () => {
    let hit = false;
    h.score.mockImplementation(async (_a: string, id: string) => {
      if (id === "mid" && !hit) {
        hit = true;
        report429(Object.assign(new Error("429"), { status: 429 }));
        throw new AiError("RATE_LIMITED", "limited");
      }
      return { score: 0.4 };
    });

    const run = runUrgencyBackfill();
    await vi.advanceTimersByTimeAsync(1_000);
    // paused: "new" done, "mid" refused, "old" not attempted yet
    expect(isLaneOpen("backfill")).toBe(false);
    expect(h.score.mock.calls.map((c) => c[1])).toEqual(["new", "mid"]);

    await vi.runAllTimersAsync();
    await run;
    expect(h.score.mock.calls.map((c) => c[1])).toEqual(["new", "mid", "mid", "old"]);
    expect(h.threads.every((t) => t.urgency_score === 0.4)).toBe(true);
  });

  it("paginates with a keyset cursor, never OFFSET", async () => {
    h.score.mockResolvedValue({ score: 0 }); // nothing scored → rows stay in the set
    const now = Date.now();
    h.threads = Array.from({ length: 45 }, (_, i) => ({
      id: `t${String(i).padStart(2, "0")}`,
      account_id: "a",
      last_message_at: now - i * HOUR,
      urgency_score: 0,
    }));
    const run = runUrgencyBackfill();
    await vi.runAllTimersAsync();
    await run;

    expect(h.score).toHaveBeenCalledTimes(45); // every thread exactly once
    expect(new Set(h.score.mock.calls.map((c) => c[1])).size).toBe(45);
    expect(h.backfillQueries[0]![1]).toBeNull();
    expect(h.backfillQueries[1]![1]).toBe(now - 19 * HOUR);
  });
});

describe("runExtinguishBackfill under rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetForTests();
    h.store.clear();
    h.store.set("ai_urgency_auto_extinguish", "true");
    h.judge.mockReset();
    vi.mocked(setThreadUrgency).mockClear();
    vi.mocked(setHeatExtinguished).mockClear();
    const row = (id: string) => ({
      thread_id: id,
      account_id: "a",
      urgency_score: 0.9,
      from_address: "x@y.z",
      received_subject: "Need this today",
      received_text: "please send the contract",
      reply_text: "I'll look into it tomorrow, thanks",
    });
    h.extinguishRows = [row("t1"), row("t2")];
  });
  afterEach(() => vi.useRealTimers());

  it("a rate-limited verdict neither extinguishes nor decays — the thread is left for a later run", async () => {
    h.judge.mockImplementation(async () => {
      report429(Object.assign(new Error("429"), { status: 429 }));
      throw new AiError("RATE_LIMITED", "limited");
    });
    const run = runExtinguishBackfill();
    await vi.runAllTimersAsync();
    await run;

    expect(h.judge).toHaveBeenCalledTimes(1); // stopped at the first refusal
    expect(h.judge.mock.calls[0]![2]).toBe("backfill");
    expect(setThreadUrgency).not.toHaveBeenCalled();
    expect(setHeatExtinguished).not.toHaveBeenCalled();
  });
});

describe("processThreadUrgency cache freshness", () => {
  beforeEach(() => {
    __resetForTests();
    h.score.mockReset();
    h.score.mockResolvedValue({ score: 0.5 });
  });

  const params = {
    accountId: "a",
    threadId: "t",
    subject: "s",
    bodyText: "b",
    fromAddress: "boss@x.it",
    fromName: "",
    lastMessageAt: Date.now() - 60_000,
    labelIds: ["INBOX"],
  };

  it("asks for a score newer than the latest INBOUND message (a reminder re-scores the thread)", async () => {
    h.latest = [{ email: "me@x.it", from_address: "boss@x.it" }];
    await processThreadUrgency(params);
    expect(h.score.mock.calls[0]![8]).toBe(params.lastMessageAt);
  });

  it("does not re-score a thread whose latest message is our own reply", async () => {
    h.latest = [{ email: "me@x.it", from_address: "ME@x.it" }];
    await processThreadUrgency(params);
    expect(h.score).not.toHaveBeenCalled();
  });

  it("scores a conversation the user has replied to before (thread labels are a union: INBOX + SENT)", async () => {
    h.latest = [{ email: "me@x.it", from_address: "boss@x.it" }];
    await processThreadUrgency({ ...params, labelIds: ["INBOX", "SENT", "UNREAD"] });
    await processThreadUrgency({ ...params, labelIds: ["INBOX", "TRASH"] });
    expect(h.score).toHaveBeenCalledTimes(2);
  });

  it("still skips spam and threads that are not in the inbox at all", async () => {
    h.latest = [{ email: "me@x.it", from_address: "boss@x.it" }];
    await processThreadUrgency({ ...params, labelIds: ["INBOX", "SPAM"] });
    await processThreadUrgency({ ...params, labelIds: ["SENT"] });
    await processThreadUrgency({ ...params, labelIds: ["TRASH", "IMPORTANT"] });
    expect(h.score).not.toHaveBeenCalled();
  });
});
