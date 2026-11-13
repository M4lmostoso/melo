import { describe, it, expect, beforeEach, vi } from "vitest";

const mockComplete = vi.fn();

vi.mock("./providerManager", () => ({
  getActiveProvider: vi.fn(() => ({
    complete: mockComplete,
    testConnection: vi.fn(() => Promise.resolve(true)),
  })),
}));

const { cacheEntry } = vi.hoisted(() => ({ cacheEntry: vi.fn() }));

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(() => Promise.resolve(null)),
  getAiCacheEntry: cacheEntry,
  setAiCache: vi.fn(),
}));

vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn(async () => null) }));

import {
  classifyThreadsBySmartLabels,
  judgePhishingRisk,
  judgeUrgencyResolved,
  categorizeThreads,
  scoreUrgencyWithAi,
  modifyEmailContent,
  generateReply,
  categorizeThreads as categorize,
  testConnection,
} from "./aiService";
import { getActiveProvider } from "./providerManager";
import { SIGNATURE_APPENDED_RULE } from "./prompts";
import { AiError } from "./errors";

describe("classifyThreadsBySmartLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const threads = [
    { id: "t1", subject: "Software Engineer Position", snippet: "We're hiring...", fromAddress: "recruiter@company.com" },
    { id: "t2", subject: "Your order shipped", snippet: "Package tracking...", fromAddress: "orders@shop.com" },
    { id: "t3", subject: "Team standup notes", snippet: "Meeting recap...", fromAddress: "pm@work.com" },
  ];

  const labelRules = [
    { labelId: "label-jobs", description: "Job applications and career opportunities" },
    { labelId: "label-orders", description: "Shopping orders and delivery updates" },
  ];

  it("parses valid AI response into assignments map", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs\nt2:label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
    expect(result.has("t3")).toBe(false);
  });

  it("supports multi-label assignments", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs,label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs", "label-orders"]);
  });

  it("ignores invalid thread IDs", async () => {
    mockComplete.mockResolvedValueOnce("invalid-id:label-jobs\nt1:label-jobs");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(1);
    expect(result.has("invalid-id")).toBe(false);
    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("ignores invalid label IDs", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs,fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("skips threads where all labels are invalid", async () => {
    mockComplete.mockResolvedValueOnce("t1:fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles empty AI response", async () => {
    mockComplete.mockResolvedValueOnce("");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles blank lines and whitespace in response", async () => {
    mockComplete.mockResolvedValueOnce("\n  t1:label-jobs  \n\n  t2:label-orders\n");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(2);
    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
  });

  it("passes label definitions and thread data to AI", async () => {
    mockComplete.mockResolvedValueOnce("");

    await classifyThreadsBySmartLabels(threads, labelRules);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0]![0] as { userContent: string };
    expect(callArgs.userContent).toContain("label-jobs");
    expect(callArgs.userContent).toContain("Job applications");
    expect(callArgs.userContent).toContain("t1");
    expect(callArgs.userContent).toContain("recruiter@company.com");
  });
});

describe("judgePhishingRisk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a PHISHING verdict with reason", async () => {
    mockComplete.mockResolvedValueOnce("PHISHING — link text impersonates paypal but points elsewhere");
    const { verdict, reason } = await judgePhishingRisk("ctx");
    expect(verdict).toBe("phishing");
    expect(reason).toContain("impersonates paypal");
  });

  it("parses a SAFE verdict (false positive cleared)", async () => {
    mockComplete.mockResolvedValueOnce("SAFE — legitimate newsletter with tracking links");
    const { verdict } = await judgePhishingRisk("ctx");
    expect(verdict).toBe("safe");
  });

  it("parses a SUSPICIOUS verdict with colon separator", async () => {
    mockComplete.mockResolvedValueOnce("SUSPICIOUS: unusual sender domain");
    const { verdict, reason } = await judgePhishingRisk("ctx");
    expect(verdict).toBe("suspicious");
    expect(reason).toBe("unusual sender domain");
  });

  it("is case-insensitive and defaults to safe on unrecognized output", async () => {
    mockComplete.mockResolvedValueOnce("phishing - lowercase still works");
    expect((await judgePhishingRisk("ctx")).verdict).toBe("phishing");

    mockComplete.mockResolvedValueOnce("I think this is fine");
    expect((await judgePhishingRisk("ctx")).verdict).toBe("safe");
  });
});

describe("rate-limit handling in aiService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("judgeUrgencyResolved rethrows a rate limit instead of answering RESOLVED", async () => {
    mockComplete.mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { status: 429 }));
    await expect(judgeUrgencyResolved("urgent", "reply", "backfill")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("judgeUrgencyResolved keeps its lenient fallback for other failures", async () => {
    mockComplete.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await judgeUrgencyResolved("urgent")).toBe(true);
  });

  it("passes the lane to the provider (categorisation = live by default)", async () => {
    mockComplete.mockResolvedValueOnce("");
    await categorizeThreads([{ id: "t1", subject: "s", snippet: "x", fromAddress: "a@b.c" }]);
    expect(mockComplete.mock.calls[0]![0]).toMatchObject({ priority: "live" });

    mockComplete.mockResolvedValueOnce("SAFE");
    await judgePhishingRisk("ctx");
    expect(mockComplete.mock.calls[1]![0]).toMatchObject({ priority: "live" });
  });

  it("a 'generate…' failure is not mistaken for a rate limit any more", async () => {
    mockComplete.mockRejectedValueOnce(new Error("failed to generate content: model overloaded"));
    await expect(judgePhishingRisk("ctx")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(AiError).toBeDefined();
  });
});

describe("scoreUrgencyWithAi cache freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const cached = (createdAt: number) => ({ content: JSON.stringify({ score: 0.2, reason: "old" }), createdAt });

  it("re-scores when a new inbound message arrived after the cached score", async () => {
    cacheEntry.mockResolvedValue(cached(1_000));
    mockComplete.mockResolvedValue('{"score": 0.8, "reason": "sollecito"}');

    const r = await scoreUrgencyWithAi("a", "t", "s", "b", "x@y.z", "", undefined, "live", 2_000);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ score: 0.8, reason: "sollecito" });
  });

  it("keeps the cached score when it is newer than the latest inbound message, or no stamp is given", async () => {
    cacheEntry.mockResolvedValue(cached(5_000));
    expect(await scoreUrgencyWithAi("a", "t", "s", "b", "x@y.z", "", undefined, "live", 2_000)).toMatchObject({ score: 0.2 });
    cacheEntry.mockResolvedValue(cached(1_000));
    expect(await scoreUrgencyWithAi("a", "t", "s", "b", "x@y.z", "")).toMatchObject({ score: 0.2 });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("logs a model answer without JSON instead of failing silently", async () => {
    cacheEntry.mockResolvedValue(null);
    mockComplete.mockResolvedValue("<tool_call>PSC.sup puł");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await scoreUrgencyWithAi("a", "t", "s", "b", "x@y.z", "")).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no JSON"));
  });
});

describe("composer calls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("run on the composer model and, with a signature selected, forbid writing it", async () => {
    mockComplete.mockResolvedValue("<p>ok</p>");
    await modifyEmailContent("<p>bozza</p>", "accorcia", [], { signatureAppended: true });
    expect(getActiveProvider).toHaveBeenLastCalledWith("composer");
    expect(mockComplete.mock.calls[0]![0].systemPrompt).toContain(SIGNATURE_APPENDED_RULE.trim());

    await generateReply(["mail"], "ringrazia", undefined, []);
    expect(getActiveProvider).toHaveBeenLastCalledWith("composer");
    expect(mockComplete.mock.calls[1]![0].systemPrompt).not.toContain("SIGNATURE:");
  });

  it("the composer Test connection button tests the composer provider, not the main one", async () => {
    expect(await testConnection("composer")).toBe(true);
    expect(getActiveProvider).toHaveBeenLastCalledWith("composer");
    await testConnection();
    expect(getActiveProvider).toHaveBeenLastCalledWith(undefined);
  });

  it("background work stays on the main model", async () => {
    mockComplete.mockResolvedValue("t1: Primary");
    await categorize([{ id: "t1", subject: "s", snippet: "x", fromAddress: "a@b.c" }]);
    expect(getActiveProvider).toHaveBeenLastCalledWith(undefined);
  });
});
